"""Fetches the drivable OpenStreetMap road network (with geometry) and traffic signals for one area through Overpass.

    uv run python -m pipeline.fetch_osm_roads

Input for the simulated cars (pipeline/stage08_roads.py). Ways come with their node ids (`out body geom`) so roads can be split at
junctions. The class list is config/roads.yaml.
"""

import json
import time

import yaml

from pipeline.common import AREA, RAW, ROOT, merge_elements, overpass_boxes, overpass_post, record

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
LICENCE = "ODbL 1.0, (c) OpenStreetMap contributors"


def query(box, classes):
    pattern = "|".join(classes)
    return f'[out:json][timeout:240];\n(\n  way["highway"~"^({pattern})$"]({box});\n  node["highway"="traffic_signals"]({box});\n);\nout body geom;'


def fetch(area_name=AREA):
    classes = yaml.safe_load((ROOT / "config" / "roads.yaml").read_text())["classes"]
    payloads, endpoint = [], None
    boxes = overpass_boxes(area_name)
    for i, (south, west, north, east) in enumerate(boxes, 1):
        payload, endpoint = overpass_post(query(f"{south},{west},{north},{east}", classes), ENDPOINTS, timeout=300)
        payloads.append(payload)
        print(f"  box {i}/{len(boxes)}: {len(payload['elements'])} elements", flush=True)
        if len(boxes) > 1:
            time.sleep(5)  # be polite to the public Overpass servers
    elements = merge_elements(payloads)
    target = RAW / "osm" / f"osm_roads_{area_name}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"elements": elements}, separators=(",", ":")))
    kinds = {}
    for e in elements:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    snapshot = payloads[0].get("osm3s", {}).get("timestamp_osm_base", "unknown")
    entry = record(
        f"osm_roads_{area_name}", target, url=endpoint, licence=LICENCE,
        notes=f"Overpass snapshot {snapshot}; elements {kinds}; highway classes {','.join(classes)} plus traffic_signals nodes; {len(boxes)} query box(es)",
    )  # fmt: skip
    print(f"{len(elements)} elements {kinds}, {entry['bytes'] / 1e6:.2f} MB -> {target}")


if __name__ == "__main__":
    fetch()
