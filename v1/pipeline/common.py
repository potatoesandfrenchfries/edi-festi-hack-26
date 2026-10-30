"""Shared helpers for pipeline stages: paths, area config, cached downloads and the download manifest."""

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
MANIFEST = RAW / "manifest.json"


def area(name="pilot"):
    return json.loads((ROOT / "config" / "area.json").read_text())[name]


def sha256(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def download(url, target, headers=None):
    """Downloads once to a cache path. A partial file never masquerades as complete."""
    target = Path(target)
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    with requests.get(url, stream=True, timeout=60, headers=headers) as response:
        response.raise_for_status()
        with open(part, "wb") as out:
            # iter_content undoes any Content-Encoding (gzip) the server applied; response.raw would not.
            out.writelines(response.iter_content(chunk_size=1 << 20))
    part.replace(target)
    return target


def record(key, path, *, url, licence, notes=""):
    """Adds or replaces a dataset entry in data/raw/manifest.json, with checksum and access date."""
    path = Path(path)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    manifest[key] = {
        "path": str(path.relative_to(ROOT)),
        "url": url,
        "licence": licence,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "fetched": datetime.now(UTC).strftime("%Y-%m-%d"),
        "notes": notes,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest[key]


def not_implemented(stage, milestone):
    """Exit message for a stage whose logic has not been written yet."""
    raise SystemExit(f"{stage}: not implemented yet (planned for {milestone})")


AREA = os.environ.get("PRESENCE_AREA", "pilot")  # `AREA=full make ...` runs the whole council area; outputs go to data/*/full/


def scoped(directory):
    """data/interim or data/out for the area being processed. The pilot keeps the original paths, other areas get a subfolder."""
    return directory if AREA == "pilot" else directory / AREA


@dataclass(frozen=True)
class Tile:
    """One unit of work: `core` is the ground the tile owns, `read` adds a buffer so edge buildings see their surroundings."""

    name: str
    core: tuple[float, float, float, float]
    read: tuple[float, float, float, float]


def work_tiles(area_name=None):
    """The pilot is a single tile. Any other area is its list of 2.5 km tiles from config/full_tiles.json, ordered south-west first."""
    name = area_name or AREA
    cfg = area(name)
    buf = cfg["lidar_buffer_m"]

    def tile(label, core):
        return Tile(label, tuple(core), (core[0] - buf, core[1] - buf, core[2] + buf, core[3] + buf))

    if name == "pilot":
        return [tile("pilot", cfg["bbox_bng"])]
    listed = json.loads((ROOT / "config" / "full_tiles.json").read_text())
    size = listed["tile_m"]
    return [tile(f"E{e // 100}N{n // 100}", (e, n, e + size, n + size)) for e, n in listed["tiles"]]


def lidar_path(kind, tile, area_name=None):
    """Where the DSM or DTM window of a tile lives. The pilot keeps its original single-file names."""
    name = area_name or AREA
    suffix = name if name == "pilot" else f"{name}_{tile.name}"
    return RAW / "lidar" / f"phase5_{kind}_{suffix}.tif"


def overpass_boxes(area_name=None, size_m=5000, margin_m=50):
    """WGS84 (south, west, north, east) boxes for Overpass queries. The pilot is one box; a larger area is split into `size_m` squares
    (a whole-city query would time out), each holding the work tiles that fall in it, with a small margin so no feature on a seam is missed."""
    from pyproj import Transformer

    name = area_name or AREA
    if name == "pilot":
        west, south, east, north = area(name)["bbox_wgs84"]
        return [(south, west, north, east)]
    to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)
    squares = {(t.core[0] // size_m, t.core[1] // size_m) for t in work_tiles(name)}
    boxes = []
    for ie, inn in sorted(squares):
        e0, n0 = ie * size_m - margin_m, inn * size_m - margin_m
        corners = [to_wgs84.transform(x, y) for x in (e0, e0 + size_m + 2 * margin_m) for y in (n0, n0 + size_m + 2 * margin_m)]
        boxes.append(
            (min(c[1] for c in corners), min(c[0] for c in corners), max(c[1] for c in corners), max(c[0] for c in corners))
        )
    return boxes


def overpass_post(query, endpoints, timeout, user_agent="edinburgh-presence-pipeline/0.1", attempts=4):
    """POST an Overpass query, trying each endpoint in turn with a growing pause. Returns (payload, endpoint)."""
    import time

    last = None
    for attempt in range(attempts):
        for endpoint in endpoints:
            try:
                response = requests.post(endpoint, data={"data": query}, timeout=timeout, headers={"User-Agent": user_agent})
                response.raise_for_status()
                return response.json(), endpoint
            except (requests.RequestException, ValueError) as error:
                last = error
                print(f"{endpoint}: {error}", flush=True)
        time.sleep(10 * (attempt + 1))
    raise SystemExit(f"Overpass unavailable: {last}")


def merge_elements(payloads):
    """Elements of several Overpass responses with each (type, id) kept once, sorted so identical OSM state gives an identical file."""
    seen = {}
    for payload in payloads:
        for element in payload["elements"]:
            seen.setdefault((element["type"], element["id"]), element)
    return [seen[key] for key in sorted(seen)]
