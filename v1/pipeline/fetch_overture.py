"""Fetches Overture Maps buildings (and building parts) for one area from the public GeoParquet release.

    uv run python -m pipeline.fetch_overture                  # pilot area, pinned release
    uv run python -m pipeline.fetch_overture --release 2026-10-21.0

Only rows whose bounding box intersects the area are read; Parquet row-group pushdown keeps the transfer small.
"""

import argparse

import duckdb

from pipeline.common import AREA, RAW, area, record

RELEASE = "2026-10-21.0"
LICENCE = "Overture Maps data; per-feature source licences in the `sources` column (OSM-derived parts are ODbL)"


def fetch(release, area_name):
    west, south, east, north = area(area_name)["bbox_wgs84"]
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    out_dir = RAW / "overture"
    out_dir.mkdir(parents=True, exist_ok=True)
    for kind in ("building", "building_part"):
        target = out_dir / f"{kind}s_{release}_{area_name}.parquet"
        source = f"s3://overturemaps-us-west-2/release/{release}/theme=buildings/type={kind}/*"
        # ORDER BY id keeps the file deterministic between runs.
        con.sql(f"""
            COPY (
                SELECT * FROM read_parquet('{source}', hive_partitioning=1)
                WHERE bbox.xmin <= {east} AND bbox.xmax >= {west} AND bbox.ymin <= {north} AND bbox.ymax >= {south}
                ORDER BY id
            ) TO '{target}' (FORMAT parquet)
        """)
        count = con.execute(f"SELECT count(*) FROM read_parquet('{target}')").fetchall()[0][0]
        entry = record(
            f"overture_{kind}_{area_name}",
            target,
            url=f"https://docs.overturemaps.org/guides/buildings (release {release}, {source})",
            licence=LICENCE,
            notes=f"{count} rows; bbox {west},{south},{east},{north}",
        )
        print(f"{kind}: {count} rows, {entry['bytes'] / 1e6:.1f} MB -> {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", default=RELEASE)
    parser.add_argument("--area", default=AREA)
    args = parser.parse_args()
    fetch(args.release, args.area)
