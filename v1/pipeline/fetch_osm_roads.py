"""Fetches the drivable OpenStreetMap road network (with geometry) and traffic signals for one area through Overpass.

    uv run python -m pipeline.fetch_osm_roads

Input for the simulated cars (pipeline/stage08_roads.py). Ways come with their node ids (`out body geom`) so roads can be split at
junctions. The class list is config/roads.yaml. The pilot is one query. A council-area fetch is three nested ones (config/roads.yaml `zones`):
every road class in the core box, the ring's classes in the ring box, the outer classes over the whole area; the raw file is cached, set
REFETCH=1 to download it again.
"""

import json
import os
import time

import yaml

from pipeline.common import AREA, RAW, ROOT, area, merge_elements, overpass_boxes, overpass_post, record
from pipeline.roads import bng_box_to_wgs84, zone_boxes, zone_queries

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
LICENCE = "ODbL 1.0, (c) OpenStreetMap contributors"


def query(box, classes):
    pattern = "|".join(classes)
    return f'[out:json][timeout:240];\n(\n  way["highway"~"^({pattern})$"]({box});\n  node["highway"="traffic_signals"]({box});\n);\nout body geom;'


def jobs(area_name, config):
    """[(label, (south, west, north, east), classes)] Overpass queries for the area."""
    if area_name == "pilot":
        return [("pilot", box, config["classes"]) for box in overpass_boxes("pilot")]
    zones = config["zones"]
    core, ring = zone_boxes(area("pilot")["bbox_bng"], zones["core_buffer_m"], zones["ring_buffer_m"])
    queries = zone_queries(config["classes"], {"ring": zones["ring_classes"], "outer": zones["outer_classes"]})
    boxes = {"outer": overpass_boxes(area_name), "ring": [bng_box_to_wgs84(ring)], "core": [bng_box_to_wgs84(core)]}
    return [(zone, box, names) for zone, names in queries for box in boxes[zone]]


def fetch(area_name=AREA):
    config = yaml.safe_load((ROOT / "config" / "roads.yaml").read_text())
    target = RAW / "osm" / f"osm_roads_{area_name}.json"
    if area_name != "pilot" and target.exists() and not os.environ.get("REFETCH"):
        print(f"{target} is cached; REFETCH=1 downloads it again")
        return
    payloads, endpoint = [], None
    todo = jobs(area_name, config)
    for i, (label, (south, west, north, east), classes) in enumerate(todo, 1):
        payload, endpoint = overpass_post(query(f"{south},{west},{north},{east}", classes), ENDPOINTS, timeout=300)
        payloads.append(payload)
        print(f"  query {i}/{len(todo)} ({label}, {len(classes)} classes): {len(payload['elements'])} elements", flush=True)
        if len(todo) > 1:
            time.sleep(5)  # be polite to the public Overpass servers
    elements = merge_elements(payloads)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"elements": elements}, separators=(",", ":")))
    kinds = {}
    for e in elements:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    snapshot = payloads[0].get("osm3s", {}).get("timestamp_osm_base", "unknown")
    entry = record(
        f"osm_roads_{area_name}", target, url=endpoint, licence=LICENCE,
        notes=f"Overpass snapshot {snapshot}; elements {kinds}; highway classes {','.join(config['classes'])} plus traffic_signals nodes; {len(todo)} query box(es)",
    )  # fmt: skip
    print(f"{len(elements)} elements {kinds}, {entry['bytes'] / 1e6:.2f} MB -> {target}")


if __name__ == "__main__":
    fetch()
