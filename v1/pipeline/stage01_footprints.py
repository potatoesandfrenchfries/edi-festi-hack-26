"""Stage 01: building footprints from Overture, joined to OSM tags.

    uv run python -m pipeline.stage01_footprints

Reads the raw Overture and OSM snapshots, keeps non-underground polygons whose centroid lies in the area and which
are not tiny, reprojects to EPSG:27700 and writes data/interim/footprints.parquet (sorted by id, so reruns are identical).
"""

import pyarrow.parquet as pq
import yaml

from pipeline.common import AREA, RAW, ROOT, scoped, work_tiles
from pipeline.footprints import build_footprints, load_osm_tags, read_overture

OVERTURE = RAW / "overture" / f"buildings_2026-10-21.0_{AREA}.parquet"
OSM = RAW / "osm" / f"osm_tags_{AREA}.json"
OUT = scoped(ROOT / "data" / "interim") / "footprints.parquet"


def main():
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    table, dropped = build_footprints(
        read_overture(OVERTURE), load_osm_tags(OSM), [t.core for t in work_tiles()], model["heights"]["min_footprint_m2"]
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table.sort_by("id"), OUT, compression="zstd")
    with_osm = sum(1 for v in table["osm_id"].to_pylist() if v is not None)
    print(f"{table.num_rows} footprints ({with_osm} joined to OSM) -> {OUT}; dropped {dropped}")


if __name__ == "__main__":
    main()
