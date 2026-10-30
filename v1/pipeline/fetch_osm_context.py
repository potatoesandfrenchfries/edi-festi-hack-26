"""Fetches OpenStreetMap land-use context (with geometry) for one area through Overpass.

    uv run python -m pipeline.fetch_osm_context

Land use, parks, water, railways and roads tell us which empty ground is genuinely not built on (gardens, rail, streets,
water) and which might be missing buildings. Only features that explain empty space are requested, not buildings.
"""

import json
import time

from pipeline.common import AREA, RAW, merge_elements, overpass_boxes, overpass_post, record

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
LICENCE = "ODbL 1.0, (c) OpenStreetMap contributors"
KEYS = ("landuse", "leisure", "natural", "waterway", "water", "railway", "highway", "place", "man_made", "amenity", "tourism")


def query(box):
    selectors = "\n".join(f'  nwr["{k}"]({box});' for k in KEYS)
    return f"[out:json][timeout:240];\n(\n{selectors}\n);\nout geom tags;"


def fetch(area_name=AREA):
    payloads, endpoint = [], None
    boxes = overpass_boxes(area_name)
    for i, (south, west, north, east) in enumerate(boxes, 1):
        payload, endpoint = overpass_post(query(f"{south},{west},{north},{east}"), ENDPOINTS, timeout=300)
        payloads.append(payload)
        print(f"  box {i}/{len(boxes)}: {len(payload['elements'])} elements", flush=True)
        if len(boxes) > 1:
            time.sleep(5)  # be polite to the public Overpass servers
    elements = merge_elements(payloads)
    target = RAW / "osm" / f"osm_context_{area_name}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"elements": elements}, separators=(",", ":")))
    kinds = {}
    for e in elements:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    snapshot = payloads[0].get("osm3s", {}).get("timestamp_osm_base", "unknown")
    entry = record(
        f"osm_context_{area_name}", target, url=endpoint, licence=LICENCE,
        notes=f"Overpass snapshot {snapshot}; elements {kinds}; keys {','.join(KEYS)}; {len(boxes)} query box(es)",
    )  # fmt: skip
    print(f"{len(elements)} elements {kinds}, {entry['bytes'] / 1e6:.2f} MB -> {target}")


if __name__ == "__main__":
    fetch()
