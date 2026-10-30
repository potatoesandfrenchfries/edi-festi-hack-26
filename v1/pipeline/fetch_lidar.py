"""Fetches a LiDAR for Scotland DSM and DTM window for one area, without downloading whole tiles.

    uv run python -m pipeline.fetch_lidar                 # pilot area, Phase 5
    PRESENCE_AREA=full uv run python -m pipeline.fetch_lidar       # every 2.5 km tile of the council area, a few at a time
    uv run python -m pipeline.fetch_lidar --phase phase-3

The tiles are 5 km, 0.5 m, tiled GeoTIFFs on a public S3 bucket, so only the blocks inside the area (plus a
buffer, so the ground reference around edge buildings is available) are read over HTTP range requests.
"""

import argparse
import json
import math
from concurrent.futures import ProcessPoolExecutor, as_completed

import rasterio
import requests
from rasterio.merge import merge

from pipeline.common import AREA, MANIFEST, lidar_path, record, work_tiles

BUCKET = "https://srsp-open-data.s3.eu-west-2.amazonaws.com/lidar"
LICENCE = "Open Government Licence v3.0 (Scottish Government and partners)"
GDAL_ENV = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif", "GDAL_HTTP_MAX_RETRY": "3"}


def tile_names(bbox):
    """5 km OS tile names (for example NT27SW) intersecting a BNG bbox. Edinburgh is entirely in square NT."""
    min_e, min_n, max_e, max_n = bbox
    names = set()
    for e in range(math.floor(min_e / 5000) * 5000, math.ceil(max_e / 5000) * 5000, 5000):
        for n in range(math.floor(min_n / 5000) * 5000, math.ceil(max_n / 5000) * 5000, 5000):
            assert 300000 <= e < 400000 and 600000 <= n < 700000, "tile logic only covers OS square NT"
            names.add(
                f"NT{(e % 100000) // 10000}{(n % 100000) // 10000}{'N' if n % 10000 >= 5000 else 'S'}{'E' if e % 10000 >= 5000 else 'W'}"
            )
    return sorted(names)


def available(urls):
    """The URLs that exist. A tile's LiDAR buffer can reach into a source tile that was never flown or published (beyond the coast
    or the area's edge); those parts are simply no data, and the tile is read from the source tiles that do exist."""
    return [u for u in urls if requests.head(u, timeout=60).status_code == 200]


def read_tile(phase, tile, area_name):
    """Windowed read of one tile's DSM and DTM into data/raw/lidar/. Cached: a tile that is already on disk is not read again.

    Returns a list of (kind, path, urls, bounds, shape, nodata_share) for the files this call wrote (empty if all were cached).
    """
    tiles = tile_names(tile.read)
    label = phase.replace("-", "")
    written = []
    with rasterio.Env(**GDAL_ENV):
        for kind in ("dsm", "dtm"):
            target = lidar_path(kind, tile, area_name)
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            urls = available(
                [f"{BUCKET}/{phase}/{kind}/27700/gridded/{t}_50CM_{kind.upper()}_{label.upper()}.tif" for t in tiles]
            )
            if not urls:
                raise SystemExit(f"no {phase} {kind} source tile exists for work tile {tile.name}")
            sources = [rasterio.open(f"/vsicurl/{u}") for u in urls]
            try:
                mosaic, transform = merge(sources, bounds=tile.read, nodata=-9999.0)
                profile = {
                    "driver": "GTiff",
                    "height": mosaic.shape[1],
                    "width": mosaic.shape[2],
                    "count": 1,
                    "dtype": "float32",
                    "crs": "EPSG:27700",
                    "transform": transform,
                    "nodata": -9999.0,
                    "compress": "deflate",
                    "predictor": 3,
                    "tiled": True,
                }
                part = target.with_suffix(".tif.part")  # a partial file never masquerades as a finished tile
                with rasterio.open(part, "w", **profile) as dst:
                    dst.write(mosaic[0], 1)
                part.replace(target)
            finally:
                for s in sources:
                    s.close()
            written.append((kind, target, urls, tile.read, mosaic.shape, float((mosaic == -9999.0).mean())))
    return written


def record_cached(phase, tiles, area_name):
    """Adds a manifest entry for any tile file that is on disk but not recorded (a run that stopped after writing it). Returns how many."""
    label = phase.replace("-", "")
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    added = 0
    for tile in tiles:
        for kind in ("dsm", "dtm"):
            key = f"lidar_{label}_{kind}_{area_name}_{tile.name}" if area_name != "pilot" else f"lidar_{label}_{kind}_{area_name}"
            path = lidar_path(kind, tile, area_name)
            if path.exists() and key not in manifest:
                urls = [
                    f"{BUCKET}/{phase}/{kind}/27700/gridded/{t}_50CM_{kind.upper()}_{label.upper()}.tif"
                    for t in tile_names(tile.read)
                ]
                record(
                    key,
                    path,
                    url="\n".join(urls),
                    licence=LICENCE,
                    notes=f"windowed read, bounds {tile.read}; recorded from the cached file",
                )
                added += 1
    return added


def fetch(phase, area_name, workers=4):
    tiles = work_tiles(area_name)
    print(f"{phase}: {len(tiles)} work tile(s) for {area_name}")
    label = phase.replace("-", "")
    done = bytes_written = 0
    with ProcessPoolExecutor(max_workers=min(workers, len(tiles))) as pool:
        futures = {pool.submit(read_tile, phase, t, area_name): t for t in tiles}
        for future in as_completed(futures):
            tile = futures[future]
            for kind, target, urls, bounds, shape, nodata_share in future.result():
                # The manifest is written from this process only, so parallel workers cannot corrupt it.
                entry = record(
                    f"lidar_{label}_{kind}_{area_name}_{tile.name}"
                    if area_name != "pilot"
                    else f"lidar_{label}_{kind}_{area_name}",
                    target,
                    url="\n".join(urls),
                    licence=LICENCE,
                    notes=f"windowed read, bounds {bounds}, {shape[2]}x{shape[1]} px at 0.5 m, nodata share {nodata_share:.4f}",
                )
                bytes_written += entry["bytes"]
                print(f"{tile.name} {kind}: {entry['bytes'] / 1e6:.1f} MB, nodata {nodata_share:.2%}", flush=True)
            done += 1
            print(f"  {done}/{len(tiles)} tiles done", flush=True)
    recorded = record_cached(phase, tiles, area_name)
    if recorded:
        print(f"recorded {recorded} cached file(s) that were missing from the manifest")
    print(f"fetched {bytes_written / 1e9:.2f} GB this run (cached tiles are skipped)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--phase", default="phase-5")
    parser.add_argument("--area", default=AREA)
    args = parser.parse_args()
    fetch(args.phase, args.area)
