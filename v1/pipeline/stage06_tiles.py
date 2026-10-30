"""Stage 06: building table and PMTiles for the web app.

    uv run python -m pipeline.stage06_tiles

Joins data/interim/footprints.parquet and heights.parquet into data/out/buildings.parquet and copies the landmark tower
parts and the inferred buildings (stage 02b) to data/out/. Builds data/out/buildings.pmtiles with tippecanoe (layers
`buildings`, `landmark_parts` and `inferred_buildings`) and copies it to web/public/data/ for the dev server. Needs tippecanoe on PATH
(brew install tippecanoe).

Each building also gets `use_class`, `res_pop` and `work_pop`. While the census allocation (M2) is paused these are TEMPLATE
values: a class from OSM and Overture tags and populations proportional to floor area (pipeline/template_values.py). They are
placeholder estimates, not census figures. The stage also writes web/public/data/profiles.json (the hourly curves, festival range
and colour breaks for the web app) and data/out/oracle.json (sampled buildings with expected values for the web tests).
"""

import json
import shutil
import subprocess

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely
import yaml
from pyproj import Transformer

from pipeline import accommodation
from pipeline.common import ROOT, scoped
from pipeline.presence import density_per_1000_m2, load_profiles, presence
from pipeline.template_values import template_values
from pipeline.use_class import classify
from pipeline.venues import PUBLIC_BUILDINGS, TO_BNG, load_venues, public_ids, venue_ids

INTERIM = scoped(ROOT / "data" / "interim")
OUT = scoped(ROOT / "data" / "out")
WEB_DATA = ROOT / "web" / "public" / "data"
STL_BEDS = ROOT / "data" / "interim" / "stl_beds.json"  # city-wide, so not scoped to the area being built
TO_WGS84 = Transformer.from_crs(27700, 4326, always_xy=True)

CONFIG = ROOT / "config"
ORACLE_SIZE = 20  # buildings sampled for the web tests (plan M3 acceptance)
ORACLE_CASES = [
    ("weekday", 3, 1.0),
    ("weekday", 10, 1.0),
    ("weekday", 21, 1.25),
    ("saturday", 14, 1.0),
    ("sunday", 19, 1.5),
]  # (day, hour, festival)
TAG_COLUMNS = ["osm_building", "osm_amenity", "osm_shop", "osm_office", "osm_tourism", "overture_subtype", "overture_class"]
HEIGHT_COLUMNS = ["height_m", "height_src", "height_conf", "height_flag", "floors_est", "floor_area_m2"]


def join_buildings():
    """Footprints plus heights, one row per building, sorted by id. Contains no rent, rateable-value or price fields."""
    footprints, heights = pq.read_table(INTERIM / "footprints.parquet"), pq.read_table(INTERIM / "heights.parquet")
    table = footprints.join(heights.select(["id", *HEIGHT_COLUMNS]), keys="id", join_type="inner")
    assert table.num_rows == footprints.num_rows == heights.num_rows, "footprints and heights must cover the same buildings"
    return add_accommodation(add_template_values(table.sort_by("id")))


def add_template_values(table):
    """Appends use_class, use_src, res_pop and work_pop. TEMPLATE values: placeholder estimates from floor area, not census figures."""
    model = yaml.safe_load((CONFIG / "model.yaml").read_text())
    weights = yaml.safe_load((CONFIG / "use_weights.yaml").read_text())
    tags = table.select(TAG_COLUMNS).to_pylist()
    classified = [classify(**row) for row in tags]
    areas = table.column("floor_area_m2").to_pylist()
    values = [template_values(use_class, area, model, weights) for (use_class, _), area in zip(classified, areas, strict=True)]
    return (
        table.append_column("use_class", pa.array([c for c, _ in classified], pa.string()))
        .append_column("use_src", pa.array([s for _, s in classified], pa.string()))
        .append_column("res_pop", pa.array([r for r, _ in values], pa.float64()))
        .append_column("work_pop", pa.array([w for _, w in values], pa.float64()))
    )


def add_accommodation(table):
    """Appends `stay_kind` ("hotel", "halls", "str" or None) and `beds`: visitor bed-spaces per building (config/accommodation.yaml).

    Hotels and halls get beds from floor area; licensed short-term lets (stage 11) are put on the nearest few other buildings to their
    postcode. Estimates: the tags carry no room counts and a postcode is not an address.
    """
    cfg = accommodation.load_config()
    kinds = [accommodation.stay_kind(t, c, cfg) for t, c in zip(table.column("osm_tourism").to_pylist(), table.column("overture_class").to_pylist(), strict=True)]
    areas = table.column("floor_area_m2").to_pylist()
    beds = [accommodation.tag_beds(kind, area, cfg) for kind, area in zip(kinds, areas, strict=True)]
    stl_path = STL_BEDS
    lost = 0.0
    if stl_path.exists():
        stl = json.loads(stl_path.read_text())
        points = [(*TO_BNG.transform(p["lon"], p["lat"]), p["beds"]) for p in stl["postcodes"]]
        footprints = [shapely.from_wkb(w) for w in table.column("geom_wkb").to_pylist()]
        placed, lost = accommodation.place_beds(points, footprints, areas, [k is not None for k in kinds], cfg)
        kinds = [k or ("str" if b > 0 else None) for k, b in zip(kinds, placed, strict=True)]
        beds = [b + p for b, p in zip(beds, placed, strict=True)]
    else:
        print("data/interim/stl_beds.json is missing: run `make accommodation` for the short-term-let beds. Hotels and halls only.")
    print(f"{round(sum(beds))} visitor bed-spaces on {sum(1 for b in beds if b >= 1)} buildings ({round(lost)} short-term-let beds outside the area)")
    return table.append_column("stay_kind", pa.array(kinds, pa.string())).append_column("beds", pa.array(beds, pa.float64()))


def accommodation_payload(table):
    """What the web app loads: occupancy rules, the hour-of-day profile and bed totals for the area built (pilot or whole council) and the city."""
    cfg = accommodation.load_config()
    totals = {}
    for kind, beds in zip(table.column("stay_kind").to_pylist(), table.column("beds").to_pylist(), strict=True):
        if kind:
            totals[kind] = totals.get(kind, 0.0) + beds
    stl_path = STL_BEDS
    city_str = json.loads(stl_path.read_text())["beds"] if stl_path.exists() else 0
    return {
        "status": cfg["status"],
        "occupancy": cfg["occupancy"],
        "night_profile": cfg["night_profile"],
        "area_beds": {kind: round(total) for kind, total in sorted(totals.items())},
        "city_beds": {"str": city_str, "hotel": cfg["citywide"]["hotel_beds"]},
    }


def to_feature(rec):
    """GeoJSON feature in WGS84 for one building row. Properties are kept small and None values are left out."""
    geom = shapely.transform(shapely.from_wkb(rec["geom_wkb"]), _lonlat)
    props = {
        "id": rec["id"],
        "height_m": round(rec["height_m"], 1),
        "height_src": rec["height_src"],
        "height_conf": rec["height_conf"],
        "floors_est": round(rec["floors_est"], 1),
        **value_props(rec),
    }
    if rec["use_src"]:
        props["use_src"] = rec["use_src"]
    if rec["height_flag"]:
        props["height_flag"] = rec["height_flag"]
    if rec["osm_name"]:
        props["name"] = rec["osm_name"]
    if rec.get("is_venue"):
        props["is_venue"] = True
    if rec.get("is_public"):
        props["is_public"] = True
    if rec.get("venue_key"):
        props["venue"] = rec["venue_key"]
    if (rec.get("beds") or 0) >= 1:
        props["beds"] = round(rec["beds"])
        props["stay"] = rec["stay_kind"]
    return {"type": "Feature", "properties": props, "geometry": json.loads(shapely.to_geojson(shapely.set_precision(geom, 1e-7)))}


def value_props(rec):
    """The properties the web app's hourly expression reads. Rounded as written to the tiles, so the oracle uses the same numbers."""
    return {
        "use_class": rec["use_class"],
        "res_pop": round(rec["res_pop"], 2),
        "work_pop": round(rec["work_pop"], 2),
        "floor_area_m2": round(rec["floor_area_m2"]),
    }


def part_feature(rec, parents):
    """GeoJSON feature in WGS84 for one landmark tower part. A part is drawn in its building's colour, so it carries the parent's values."""
    geom = shapely.transform(shapely.from_wkb(rec["geom_wkb"]), _lonlat)
    props = {
        "id": rec["id"],
        "parent_id": rec["parent_id"],
        "height_m": round(rec["height_m"], 1),
        **value_props(parents[rec["parent_id"]]),
    }
    return {"type": "Feature", "properties": props, "geometry": json.loads(shapely.to_geojson(shapely.set_precision(geom, 1e-7)))}


def inferred_feature(rec):
    """GeoJSON feature in WGS84 for one inferred building. `basis` says how it was inferred."""
    geom = shapely.transform(shapely.from_wkb(rec["geom_wkb"]), _lonlat)
    props = {"id": rec["id"], "basis": rec["basis"], "height_m": round(rec["height_m"], 1)}
    return {"type": "Feature", "properties": props, "geometry": json.loads(shapely.to_geojson(shapely.set_precision(geom, 1e-7)))}


def _lonlat(xy):
    return np.column_stack(TO_WGS84.transform(xy[:, 0], xy[:, 1]))


def oracle_cases(table, profiles):
    """ORACLE_SIZE buildings spread evenly through the id-sorted table, with expected people for each case. Uses tile-rounded inputs."""
    populated = [rec for rec in table.to_pylist() if rec["res_pop"] + rec["work_pop"] > 0]
    step = max(len(populated) // ORACLE_SIZE, 1)
    cases = []
    for rec in populated[::step][:ORACLE_SIZE]:
        props = value_props(rec)
        expected = []
        for day, hour, festival in ORACLE_CASES:
            people = presence(props["res_pop"], props["work_pop"], props["use_class"], hour, day, profiles, festival)
            expected.append({"day": day, "hour": hour, "festival": festival, "people": round(people, 6),
                             "density": round(density_per_1000_m2(people, props["floor_area_m2"]), 6)})  # fmt: skip
        cases.append({"id": rec["id"], **props, "expected": expected})
    return cases


def class_totals(table):
    """Pilot-wide template totals the web app turns into hourly headline numbers: residents, and workers per use class."""
    workers = {}
    for use_class, work_pop in zip(table.column("use_class").to_pylist(), table.column("work_pop").to_pylist(), strict=True):
        workers[use_class] = workers.get(use_class, 0.0) + work_pop
    return {
        "buildings": table.num_rows,
        "residents": round(sum(table.column("res_pop").to_pylist()), 1),
        "workers": {use_class: round(total, 1) for use_class, total in sorted(workers.items())},
    }


def profiles_payload(profiles, table):
    """What the web app loads: expanded curves, festival range, the fixed colour break points and the pilot-wide totals."""
    model = yaml.safe_load((CONFIG / "model.yaml").read_text())
    festival = {k: model["seasonality"][f"festival_{k}"] for k in ("min", "max", "step")} | {
        "default": model["seasonality"]["festival_scalar"]
    }
    return {
        **profiles,
        "values": "template",  # building values are placeholders, not the census allocation
        "festival": festival,
        "scale": model["colour_scale"],
        "totals": class_totals(table),
    }


def build_tiles(table, parts, inferred, workdir):
    if not shutil.which("tippecanoe"):
        raise SystemExit("tippecanoe not found on PATH. Install it with: brew install tippecanoe")
    source = workdir / "buildings.geojsonl"
    with open(source, "w") as f:
        ids = table.column("id").to_pylist()
        names = dict(zip(ids, table.column("osm_name").to_pylist(), strict=True))
        venues, missed = venue_ids(load_venues(), ids, table.column("geom_wkb").to_pylist(), names)
        print(f"{len(venues)} festival venue buildings flagged; no building for: {', '.join(missed) or 'none'}")
        public, missed = public_ids(load_venues(PUBLIC_BUILDINGS), ids, table.column("geom_wkb").to_pylist(), names)
        print(f"{len(public)} public building footprints flagged; no building for: {', '.join(missed) or 'none'}")
        keys = {v["name"]: v["key"] for v in load_venues()}
        f.writelines(
            json.dumps(
                to_feature({**rec, "is_venue": rec["id"] in venues, "venue_key": keys.get(venues.get(rec["id"])), "is_public": rec["id"] in public}),
                separators=(",", ":"),
            )
            + "\n"
            for rec in table.to_pylist()
        )
    parts_source = workdir / "landmark_parts.geojsonl"
    with open(parts_source, "w") as f:
        parents = {rec["id"]: rec for rec in table.to_pylist()}
        f.writelines(json.dumps(part_feature(rec, parents), separators=(",", ":")) + "\n" for rec in parts.to_pylist())
    inferred_source = workdir / "inferred_buildings.geojsonl"
    with open(inferred_source, "w") as f:
        f.writelines(json.dumps(inferred_feature(rec), separators=(",", ":")) + "\n" for rec in inferred.to_pylist())
    target = OUT / "buildings.pmtiles"
    subprocess.run(
        [
            "tippecanoe", "-o", str(target), "-f", "-Z", "13", "-z", "16", "--no-tile-size-limit", "--no-feature-limit",
            "--no-tile-stats", "-q", "-L", f"buildings:{source}", "-L", f"landmark_parts:{parts_source}", "-L", f"inferred_buildings:{inferred_source}",
        ],
        check=True,
    )  # fmt: skip
    return target


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    table = join_buildings()
    pq.write_table(table, OUT / "buildings.parquet", compression="zstd")
    parts = pq.read_table(INTERIM / "landmark_parts.parquet")
    pq.write_table(parts, OUT / "landmark_parts.parquet", compression="zstd")
    if not (INTERIM / "inferred_buildings.parquet").exists():
        raise SystemExit("data/interim/inferred_buildings.parquet is missing: run `make infill` first")
    inferred = pq.read_table(INTERIM / "inferred_buildings.parquet")
    pq.write_table(inferred, OUT / "inferred_buildings.parquet", compression="zstd")
    target = build_tiles(table, parts, inferred, OUT)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    shutil.copy(target, WEB_DATA / "buildings.pmtiles")
    profiles = load_profiles()
    (WEB_DATA / "profiles.json").write_text(
        json.dumps(profiles_payload(profiles, table), separators=(",", ":"), sort_keys=True) + "\n"
    )
    (WEB_DATA / "accommodation.json").write_text(json.dumps(accommodation_payload(table), separators=(",", ":"), sort_keys=True) + "\n")
    (OUT / "oracle.json").write_text(json.dumps(oracle_cases(table, profiles), indent=1, sort_keys=True) + "\n")
    print(
        f"{table.num_rows} buildings, {parts.num_rows} landmark parts and {inferred.num_rows} inferred buildings -> {OUT / 'buildings.parquet'}, {target} ({target.stat().st_size / 1e6:.2f} MB), copied to {WEB_DATA}"
    )


if __name__ == "__main__":
    main()
