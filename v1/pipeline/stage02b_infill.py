"""Stage 02b: inferred buildings for ground that OSM and the footprint data leave empty.

    uv run python -m pipeline.stage02b_infill

Reads the footprints and heights, the OSM land-use context (make fetch) and the LiDAR surface, and writes
data/interim/inferred_buildings.parquet plus a report, docs/infill.md. These buildings are inferred, not mapped: they are kept
out of the `buildings` table and out of the census allocation unless that is decided later.
"""

import hashlib
import json
import pickle
import statistics
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

import pyarrow as pa
import pyarrow.parquet as pq
import rasterio
import shapely
import yaml
from pyproj import Transformer
from shapely.geometry import box

from pipeline.common import AREA, RAW, ROOT, area, lidar_path, scoped, work_tiles
from pipeline.infill import Params, infer, surface
from pipeline.osm_context import elements_in, parse

INTERIM = scoped(ROOT / "data" / "interim")
OUT = INTERIM / "inferred_buildings.parquet"
REPORT = ROOT / "docs" / ("infill.md" if AREA == "pilot" else f"infill_{AREA}.md")
CONTEXT = RAW / "osm" / f"osm_context_{AREA}.json"

SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("basis", pa.string()),  # lidar: a real structure seen in the surface model; osm_context: a standard frontage building
        ("geom_wkb", pa.binary()),
        ("footprint_area_m2", pa.float64()),
        ("height_m", pa.float64()),
        ("n_neighbours", pa.int32()),
    ]
)


def read_surface(tile):
    with rasterio.open(lidar_path("dsm", tile)) as d, rasterio.open(lidar_path("dtm", tile)) as t:
        return surface(d.read(1), t.read(1), d.transform)


def infill_tile(tile, single, mapped_wkb, ordinary_wkb, ordinary_heights, elements, model):
    """Inferred buildings for one work tile. Returns (records as dicts with WKB, accounting, number of patches examined).

    A single-tile area (the pilot) works on exactly its own ground. Otherwise the tile also looks at its LiDAR buffer and keeps only
    the patches centred in its own ground, so no patch is cut or drawn twice.
    """
    p = Params.from_config(model)
    ctx = parse(
        elements,
        street_half_width=model["street_half_width_m"],
        rail_half_width=model["rail_half_width_m"],
        waterway_half_width=model["waterway_half_width_m"],
    )
    area_geom, own = (box(*tile.core), None) if single else (box(*tile.read), box(*tile.core))
    records, accounting, blobs = infer(
        area_geom,
        [shapely.from_wkb(w) for w in mapped_wkb],
        [shapely.from_wkb(w) for w in ordinary_wkb],
        ordinary_heights,
        ctx,
        read_surface(tile),
        p,
        own,
    )
    rows = [
        {
            "geom_wkb": shapely.to_wkb(r["geom"]),
            "basis": r["basis"],
            "footprint_area_m2": float(r["geom"].area),
            "height_m": float(r["height_m"]),
            "n_neighbours": r["n_neighbours"],
            "cx": round(r["geom"].centroid.x, 1),  # sort key
            "cy": round(r["geom"].centroid.y, 1),
            "ix": round(r["geom"].centroid.x),  # id key
            "iy": round(r["geom"].centroid.y),
        }
        for r in records
    ]
    return rows, accounting, len(blobs)


def tile_jobs(tiles, model):
    """Per tile: the mapped footprints near it, the ordinary ones with heights (no sheds, no landmarks), and the OSM context near it."""
    p = Params.from_config(model)
    footprints, heights = pq.read_table(INTERIM / "footprints.parquet"), pq.read_table(INTERIM / "heights.parquet")
    h = {r["id"]: r for r in heights.to_pylist()}
    wkb = footprints["geom_wkb"].to_pylist()
    geoms = shapely.from_wkb(wkb)
    ordinary = [
        h[i]["height_src"] != "manual" and h[i]["height_m"] >= p.neighbour_min_height_m for i in footprints["id"].to_pylist()
    ]
    height_of = [h[i]["height_m"] for i in footprints["id"].to_pylist()]
    tree = shapely.STRtree(geoms)
    elements = json.loads(CONTEXT.read_text())["elements"]
    to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)
    for tile in tiles:
        near = sorted(tree.query(box(*tile.read)))
        corners = [to_wgs84.transform(x, y) for x in (tile.read[0], tile.read[2]) for y in (tile.read[1], tile.read[3])]
        around = elements_in(
            elements,
            min(c[0] for c in corners),
            min(c[1] for c in corners),
            max(c[0] for c in corners),
            max(c[1] for c in corners),
        )
        yield (
            tile,
            [wkb[i] for i in near],
            [wkb[i] for i in near if ordinary[i]],
            [height_of[i] for i in near if ordinary[i]],
            around,
        )


def cache_key(tile, args, model):
    """Identifies a tile's inputs, so a cached result is reused only when nothing it depends on has changed."""
    stats = [(lidar_path(kind, tile).stat().st_size, lidar_path(kind, tile).stat().st_mtime_ns) for kind in ("dsm", "dtm")]
    blob = pickle.dumps(
        (
            tile,
            args,
            stats,
            model["infill"],
            model["floor_height_m"],
            model["street_half_width_m"],
            model["rail_half_width_m"],
            model["waterway_half_width_m"],
        )
    )
    return hashlib.sha256(blob).hexdigest()[:16]


def main(workers=2):
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    INTERIM.mkdir(parents=True, exist_ok=True)
    if not model["infill"]["enabled"]:
        pq.write_table(pa.Table.from_pylist([], schema=SCHEMA), OUT, compression="zstd")
        print("infill disabled in config/model.yaml: wrote an empty table")
        return
    tiles = work_tiles()
    single = len(tiles) == 1
    jobs = tile_jobs(tiles, model)
    if single:
        tile, *rest = next(jobs)
        results = [infill_tile(tile, True, *rest, model)]
    else:
        cache_dir = INTERIM / "infill_tiles"  # one file per tile: a stopped run resumes where it left off
        cache_dir.mkdir(exist_ok=True)
        results, pending = {}, {}
        for tile, *rest in jobs:
            key = cache_key(tile, rest, model)
            cached = cache_dir / f"{tile.name}-{key}.pkl"
            if cached.exists():
                results[tile.name] = pickle.loads(cached.read_bytes())
            else:
                pending[tile.name] = (tile, rest, cached)
        print(f"{len(results)} tile(s) cached, {len(pending)} to infill with {workers} worker(s)", flush=True)
        started = time.time()
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(infill_tile, tile, False, *rest, model): (name, cached)
                for name, (tile, rest, cached) in pending.items()
            }
            for future in as_completed(futures):
                name, cached = futures[future]
                results[name] = future.result()
                tmp = cached.with_suffix(".tmp")
                tmp.write_bytes(pickle.dumps(results[name]))
                tmp.replace(cached)
                print(f"  {len(results)}/{len(tiles)} tiles infilled ({name}, {time.time() - started:.0f}s elapsed)", flush=True)
        results = [results[tile.name] for tile in tiles]
    records = sorted((r for rows, _, _ in results for r in rows), key=lambda r: (r["basis"], r["cx"], r["cy"]))
    accounting = {}
    for _, acc, _ in results:
        for k, v in acc.items():
            accounting[k] = round(accounting.get(k, 0) + v, 2)
    n_blobs = sum(n for _, _, n in results)
    rows, seen = [], {}
    for r in records:
        key = f"inf-{r['ix']}-{r['iy']}"
        seen[key] = seen.get(key, 0) + 1
        rows.append(
            {
                "id": key if seen[key] == 1 else f"{key}-{seen[key]}",
                **{k: r[k] for k in ("basis", "geom_wkb", "footprint_area_m2", "height_m", "n_neighbours")},
            }
        )
    table = pa.Table.from_pylist(rows, schema=SCHEMA).sort_by("id")
    pq.write_table(table, OUT, compression="zstd")
    write_report(model, rows, accounting, n_blobs, area(AREA))
    by = {b: sum(1 for r in rows if r["basis"] == b) for b in ("lidar", "osm_context")}
    print(f"{len(rows)} inferred buildings {by} -> {OUT}\n  {accounting}")


def write_report(model, rows, accounting, n_blobs, pilot):
    cfg = model["infill"]
    L = ["# Inferred buildings\n", "Generated by `pipeline/stage02b_infill.py`. Do not edit by hand.\n"]
    a = L.append
    a("## What this is\n")
    a(
        f"Some ground in the {AREA} area has no building, street, railway, water, park or car park on it according to OpenStreetMap and the "
        "footprint data. This stage looks at what the LiDAR sees there and adds buildings of two kinds. **They are inferred, not mapped**: "
        "the map draws them in a lighter tone, they are kept out of the `buildings` table, and no census population is allocated to them "
        "until that is decided (PLAN.md A11).\n"
    )
    a("| Basis | Meaning | Buildings | Footprint ha | Median height m |")
    a("|---|---|---:|---:|---:|")
    for basis, meaning in (
        ("lidar", "A real structure the maps lack: smooth, standing well above the ground in the LiDAR. Footprint and height are measured."),
        ("osm_context", "A standard building on bare flat ground beside a street and mapped buildings. An assumption: one plot deep, as tall as its mapped neighbours."),
    ):  # fmt: skip
        sel = [r for r in rows if r["basis"] == basis]
        med = statistics.median([r["height_m"] for r in sel]) if sel else 0
        a(f"| {basis} | {meaning} | {len(sel)} | {sum(r['footprint_area_m2'] for r in sel) / 1e4:.2f} | {med:.1f} |")
    a(
        f"\n## What was left empty, and why\n\n{n_blobs} patches of empty ground at least {cfg['min_blob_m2']} m² and {2 * cfg['opening_m']:.0f} m wide were examined (hectares):\n"
    )
    a("| Outcome | Hectares |\n|---|---:|")
    for k, v in accounting.items():
        a(f"| {k} | {v} |")
    a(
        "\nParks, gardens, water, railways, car parks, plazas and streets are never filled: OpenStreetMap says what they are. "
        "Trees and steep ground are recognised from the LiDAR and left alone, so the slopes of the Castle and Calton Hill stay open.\n"
    )
    a("## How the standard buildings are made\n")
    a(
        f"- Ground within {cfg['frontage_depth_m']:g} m of a street, within {cfg['neighbour_reach_m']:g} m of a mapped building, flat (under {cfg['flat_max_height_m']:g} m "
        f"above the ground model) and not steeper than {cfg['max_slope_pct']}% is split into plots about {cfg['plot_width_m']:g} m wide with {cfg['party_gap_m']:g} m between them."
    )
    a(
        f"- Height is the median of mapped buildings within {cfg['neighbour_radius_m']:g} m (those at least {cfg['neighbour_min_height_m']:g} m tall, landmarks excluded), "
        f"kept between {cfg['min_storeys']:g} and {cfg['max_storeys']:g} storeys of {model['floor_height_m']:g} m. Every tunable is in `config/model.yaml` under `infill`."
    )
    a("- Interior courtyards and lone patches are left empty. Output is deterministic: no randomness is used.\n")
    a("## Limitations\n")
    a(
        "- The LiDAR was flown in 2020 to 2022. Ground that was bare then may have been built on since, and structures seen then may be gone."
    )
    a(
        "- Bare flat ground that OSM does not label may really be open (a yard, a lot, a lawn). The standard buildings there are a visual assumption, "
        "and `infill.fill_open_ground: false` removes them while keeping the LiDAR-detected structures."
    )
    a(
        "- Street widths come from OSM centre lines and per-class half-widths, so narrow lanes and wide boulevards are approximate."
    )
    REPORT.write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
