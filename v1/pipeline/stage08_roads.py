"""Stage 08: the directed road graph for the simulated cars.

    uv run python -m pipeline.stage08_roads

Reads data/raw/osm/osm_roads_<area>.json (pipeline/fetch_osm_roads.py) and writes web/public/data/roads.json, the file the web app's
Simulated cars layer loads. Also writes the car population to use, from config/roads.yaml, into the same file.
"""

import json

import yaml

from pipeline.common import AREA, RAW, ROOT, area
from pipeline.roads import build_graph

OUT = ROOT / "web" / "public" / "data" / "roads.json"
LANE_SLOT_M = 7.5  # lane metres one car occupies at the engine's safe seeding spacing (car 4.5 m + gap 2 m + 1 m)


def population(roads, share, cap):
    """Cars to simulate: a share of the network's safe capacity, capped. Capacity mirrors the engine's `capacity()`."""
    capacity = sum(int(e[7] // LANE_SLOT_M) * max(1, e[3]) for e in roads["edges"])
    return capacity, min(cap, int(capacity * share))


def main():
    config = yaml.safe_load((ROOT / "config" / "roads.yaml").read_text())
    source = RAW / "osm" / f"osm_roads_{AREA}.json"
    if not source.exists():
        raise SystemExit(f"{source} not found. Run: uv run python -m pipeline.fetch_osm_roads")
    elements = json.loads(source.read_text())["elements"]
    bbox = area(AREA)["bbox_wgs84"]
    roads, stats = build_graph(
        elements, bbox, set(config["classes"]), config["speed_defaults_mph"], config["signals"]["snap_metres"]
    )
    capacity, cars = population(roads, config["cars"]["population_share"], config["cars"]["max_population"])
    roads["sim"] = {"area": AREA, "capacity": capacity, "population": cars, "seed": config["cars"]["seed"]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(roads, separators=(",", ":")))
    print(
        json.dumps(
            {**stats, "capacity": capacity, "population": cars, "megabytes": round(OUT.stat().st_size / 2**20, 2)}, indent=2
        )
    )


if __name__ == "__main__":
    main()
