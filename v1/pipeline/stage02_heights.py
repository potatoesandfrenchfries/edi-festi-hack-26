"""Stage 02: per-building height from OSM tags, LiDAR, Overture and fallbacks.

    uv run python -m pipeline.stage02_heights

Measures DSM minus local ground for every footprint in data/interim/footprints.parquet, merges the sources by design
decision D7 and writes data/interim/heights.parquet (sorted by id). Thresholds come from config/model.yaml.
"""

import collections
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio
import shapely
import yaml
from pyproj import Transformer
from shapely.geometry import Point

from pipeline.common import AREA, ROOT, lidar_path, scoped, work_tiles
from pipeline.heights import measure, merge_height
from pipeline.landmarks import build_landmark, ground_at, load_landmarks, match_footprint

INTERIM = scoped(ROOT / "data" / "interim")
FOOTPRINTS = INTERIM / "footprints.parquet"
OUT = INTERIM / "heights.parquet"
PARTS_OUT = INTERIM / "landmark_parts.parquet"
LANDMARKS = ROOT / "config" / "landmarks.csv"
TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
DSM = lidar_path("dsm", work_tiles("pilot")[0], "pilot")  # the pilot's rasters; other areas have one pair per work tile
DTM = lidar_path("dtm", work_tiles("pilot")[0], "pilot")

PARTS_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("parent_id", pa.string()),
        ("level", pa.int32()),
        ("geom_wkb", pa.binary()),
        ("height_m", pa.float64()),
    ]
)

SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("lidar_roof_z", pa.float64()),
        ("lidar_ground_z", pa.float64()),
        ("lidar_height_m", pa.float64()),
        ("lidar_ground_range_m", pa.float64()),
        ("lidar_pixels", pa.int32()),
        ("lidar_valid_fraction", pa.float64()),
        ("auto_height_m", pa.float64()),
        ("auto_height_src", pa.string()),
        ("height_m", pa.float64()),
        ("height_src", pa.string()),
        ("height_conf", pa.string()),
        ("height_flag", pa.string()),
        ("floors_est", pa.float64()),
        ("floor_area_m2", pa.float64()),
    ]
)


def compute(footprints, dsm, dtm, transform, model):
    cfg, floor_height = model["heights"], model["floor_height_m"]
    rows = []
    for rec in footprints.to_pylist():
        geom = shapely.from_wkb(rec["geom_wkb"])
        m = measure(
            dsm,
            dtm,
            transform,
            geom,
            roof_percentile=cfg["footprint_percentile"],
            ground_percentile=cfg["ground_percentile"],
            ring_width_m=cfg["perimeter_buffer_m"],
        )
        floors = rec["osm_levels"] or rec["overture_num_floors"]
        h = merge_height(
            osm_height=rec["osm_height_m"],
            lidar=m,
            overture_height=rec["overture_height_m"],
            floors=floors,
            floor_height_m=floor_height,
            cfg=cfg,
        )
        floors_est = h.height_m / floor_height
        rows.append(
            {
                "id": rec["id"],
                "lidar_roof_z": m.roof_z,
                "lidar_ground_z": m.ground_z,
                "lidar_height_m": m.height,
                "lidar_ground_range_m": m.ground_range,
                "lidar_pixels": m.n_pixels,
                "lidar_valid_fraction": m.valid_fraction,
                "auto_height_m": h.height_m,
                "auto_height_src": h.src,
                "height_m": h.height_m,
                "height_src": h.src,
                "height_conf": h.conf,
                "height_flag": h.flag,
                "floors_est": floors_est,
                "floor_area_m2": rec["footprint_area_m2"] * floors_est,
            }
        )
    return pa.Table.from_pylist(rows, schema=SCHEMA)


def apply_landmarks(table, footprints, dsm, dtm, transform, model, landmarks=None):
    """Replace heights of the curated landmarks and build their tower parts. Returns (new heights table, parts table).

    Every landmark given must match a footprint: a silent miss would leave an iconic building flat, so it is an error instead.
    `landmarks` defaults to the whole curated list; a tiled run passes only those that stand in the tile.
    """
    cfg = model["landmarks"]
    geoms = [shapely.from_wkb(w) for w in footprints["geom_wkb"].to_pylist()]
    tree = shapely.STRtree(geoms)
    ids = footprints["id"].to_pylist()
    index = {id_: i for i, id_ in enumerate(table["id"].to_pylist())}
    rows = table.to_pylist()
    parts = []
    for lm in load_landmarks(LANDMARKS) if landmarks is None else landmarks:
        i = match_footprint(Point(*TO_BNG.transform(lm.lon, lm.lat)), geoms, tree)
        if i is None:
            raise SystemExit(f"landmark {lm.name!r} matches no footprint within 5 m; check config/landmarks.csv")
        ground = (
            ground_at(dtm, transform, *TO_BNG.transform(lm.ground_lon, lm.ground_lat))
            if lm.ground_lon is not None
            else measure(dsm, dtm, transform, geoms[i], ground_percentile=model["heights"]["ground_percentile"]).ground_z
        )
        built = build_landmark(
            dsm, transform, geoms[i], ground, lm,
            body_percentile=cfg["body_percentile"], steps=cfg["steps"], margin_m=cfg["margin_m"],
            min_part_m2=cfg["min_part_m2"], simplify_m=cfg["simplify_m"],
        )  # fmt: skip
        if built is None:
            raise SystemExit(f"landmark {lm.name!r} has no surface data inside its footprint")
        row = rows[index[ids[i]]]
        row.update(height_m=built.body_height_m, height_src="manual", height_conf="medium", height_flag="landmark")
        row["floors_est"] = row["height_m"] / model["floor_height_m"]
        row["floor_area_m2"] = float(geoms[i].area) * row["floors_est"]
        for n, part in enumerate(built.parts):
            parts.append(
                {
                    "id": f"{ids[i]}#{n}",
                    "parent_id": ids[i],
                    "level": part.level,
                    "geom_wkb": shapely.to_wkb(part.polygon),
                    "height_m": part.height_m,
                }
            )
    return pa.Table.from_pylist(rows, schema=SCHEMA), pa.Table.from_pylist(parts, schema=PARTS_SCHEMA)


def in_core(tile, x, y):
    e0, n0, e1, n1 = tile.core
    return (x >= e0) & (x < e1) & (y >= n0) & (y < n1)


def process_tile(tile, footprints, landmarks, model):
    """Heights and landmark parts for the footprints whose centroid lies in the tile, read from that tile's LiDAR windows."""
    with rasterio.open(lidar_path("dsm", tile)) as d, rasterio.open(lidar_path("dtm", tile)) as t:
        assert d.transform == t.transform and d.shape == t.shape, f"DSM and DTM of tile {tile.name} must share a grid"
        dsm, dtm = d.read(1), t.read(1)
        table = compute(footprints, dsm, dtm, d.transform, model)
        return apply_landmarks(table, footprints, dsm, dtm, d.transform, model, landmarks)


def split_by_tile(footprints, tiles):
    """[(tile, footprints in tile)] using each footprint's centroid, so every building is measured in exactly one tile."""
    centres = shapely.centroid(shapely.from_wkb(np.array(footprints["geom_wkb"].to_pylist(), dtype=object)))
    x, y = shapely.get_x(centres), shapely.get_y(centres)
    parts = [(tile, footprints.filter(pa.array(in_core(tile, x, y)))) for tile in tiles]
    covered = sum(part.num_rows for _, part in parts)
    assert covered == footprints.num_rows, f"{footprints.num_rows - covered} footprints lie outside every work tile"
    return parts


def landmarks_by_tile(tiles):
    """Each curated landmark goes to the tile that contains it. A landmark outside every tile is an error."""
    everything = load_landmarks(LANDMARKS)
    placed = {tile.name: [] for tile in tiles}
    for lm in everything:
        x, y = TO_BNG.transform(lm.lon, lm.lat)
        owners = [tile for tile in tiles if in_core(tile, x, y)]
        if not owners:
            raise SystemExit(f"landmark {lm.name!r} lies outside the area being processed")
        placed[owners[0].name].append(lm)
    return placed


def main(workers=4):
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    footprints = pq.read_table(FOOTPRINTS)
    tiles = work_tiles()
    work = [(tile, part) for tile, part in split_by_tile(footprints, tiles) if part.num_rows]
    placed = landmarks_by_tile(tiles)
    print(f"{footprints.num_rows} footprints in {len(work)} of {len(tiles)} tile(s) of {AREA}", flush=True)
    results = []
    if len(work) == 1:
        tile, part = work[0]
        results.append(process_tile(tile, part, placed[tile.name], model))
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(process_tile, tile, part, placed[tile.name], model) for tile, part in work]
            for i, future in enumerate(futures, 1):
                results.append(future.result())
                print(f"  {i}/{len(work)} tiles measured", flush=True)
    table = pa.concat_tables([r[0] for r in results])
    parts = pa.concat_tables([r[1] for r in results])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table.sort_by("id"), OUT, compression="zstd")
    pq.write_table(parts.sort_by("id"), PARTS_OUT, compression="zstd")
    src = collections.Counter(table["height_src"].to_pylist())
    conf = collections.Counter(table["height_conf"].to_pylist())
    flag = collections.Counter(table["height_flag"].to_pylist())
    print(
        f"{table.num_rows} heights -> {OUT}; {parts.num_rows} landmark parts -> {PARTS_OUT}\n  source {dict(src)}\n  confidence {dict(conf)}\n  flags {dict(flag)}"
    )


if __name__ == "__main__":
    main()
