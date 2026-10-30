"""Building footprints: Overture geometry joined to OpenStreetMap tags (library for stage 01)."""

import json
import re

import duckdb
import numpy as np
import pyarrow as pa
import shapely
from pyproj import Transformer

TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
OSM_TYPES = {"n": "node", "w": "way", "r": "relation"}
# Only these tags are kept from OSM. Anything else (including any cost-like field) is dropped here.
OSM_KEEP = ("height", "building:levels", "building", "amenity", "shop", "office", "tourism", "name")

_LENGTH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?\s*$", re.IGNORECASE)
_LEVELS = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*$")
FEET = 0.3048


def parse_height_m(raw):
    """OSM height tag to metres, or None when missing, malformed, non-positive or implausible (>1000 m)."""
    match = _LENGTH.match(raw or "")
    if not match:
        return None
    value = float(match.group(1))
    if (match.group(2) or "").lower() in ("ft", "feet", "'"):
        value *= FEET
    return value if 0 < value <= 1000 else None


def parse_levels(raw):
    """OSM building:levels to a float, or None when missing, malformed or implausible (>200)."""
    match = _LEVELS.match(raw or "")
    if not match:
        return None
    value = float(match.group(1))
    return value if 0 < value <= 200 else None


def osm_ref(sources):
    """(osm_type, osm_id) from the first OpenStreetMap entry in an Overture `sources` list, else None."""
    for source in sources or []:
        if source.get("dataset") == "OpenStreetMap":
            match = re.match(r"([nwr])(\d+)", source.get("record_id") or "")
            if match:
                return OSM_TYPES[match.group(1)], int(match.group(2))
    return None


def load_osm_tags(path):
    """{(type, id): kept tags} from an Overpass JSON snapshot."""
    with open(path) as f:
        elements = json.load(f)["elements"]
    return {(e["type"], e["id"]): {k: e["tags"][k] for k in OSM_KEEP if k in e.get("tags", {})} for e in elements if "tags" in e}


def read_overture(path):
    """Overture building rows as dicts, with geometry as WKB in WGS84, ordered by id."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    cursor = con.execute(
        f"""SELECT id, height, num_floors, subtype, class, coalesce(is_underground, false) AS is_underground,
                   sources, ST_AsWKB(geometry) AS wkb
            FROM read_parquet('{path}') ORDER BY id"""
    )
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def project_to_bng(geoms):
    """Reproject an array of WGS84 shapely geometries to British National Grid."""
    return shapely.transform(geoms, lambda xy: np.column_stack(TO_BNG.transform(xy[:, 0], xy[:, 1])))


def build_footprints(rows, osm_tags, bbox_bng, min_area_m2):
    """Filtered, projected footprints joined to OSM tags. Returns (pyarrow Table, drop counts).

    `bbox_bng` is one [min_e, min_n, max_e, max_n] box, or a list of such boxes (the work tiles of a larger area): a building is kept
    when its centroid is in any of them, so a building on a seam belongs to exactly one box.
    """
    dropped = {"underground": 0, "not_polygon": 0, "outside_area": 0, "too_small": 0}
    kept, geoms = [], []
    for row in rows:
        if row["is_underground"]:
            dropped["underground"] += 1
            continue
        geom = shapely.from_wkb(row["wkb"])
        if geom.geom_type not in ("Polygon", "MultiPolygon"):
            dropped["not_polygon"] += 1
            continue
        kept.append(row)
        geoms.append(geom)
    geoms = shapely.make_valid(project_to_bng(np.array(geoms, dtype=object)))
    boxes = [bbox_bng] if not isinstance(bbox_bng[0], (list, tuple)) else bbox_bng
    records = []
    for row, geom in zip(kept, geoms, strict=True):
        centre = geom.centroid
        if not any(min_e <= centre.x < max_e and min_n <= centre.y < max_n for min_e, min_n, max_e, max_n in boxes):
            dropped["outside_area"] += 1
            continue
        if geom.area < min_area_m2:
            dropped["too_small"] += 1
            continue
        ref = osm_ref(row["sources"])
        tags = osm_tags.get(ref, {}) if ref else {}
        records.append(
            {
                "id": row["id"],
                "osm_type": ref[0] if ref else None,
                "osm_id": ref[1] if ref else None,
                "geom_wkb": shapely.to_wkb(geom),
                "footprint_area_m2": float(geom.area),
                "overture_height_m": row["height"],
                "overture_num_floors": row["num_floors"],
                "overture_subtype": row["subtype"],
                "overture_class": row["class"],
                "osm_height_m": parse_height_m(tags.get("height")),
                "osm_levels": parse_levels(tags.get("building:levels")),
                "osm_building": tags.get("building"),
                "osm_amenity": tags.get("amenity"),
                "osm_shop": tags.get("shop"),
                "osm_office": tags.get("office"),
                "osm_tourism": tags.get("tourism"),
                "osm_name": tags.get("name"),
            }
        )
    return pa.Table.from_pylist(records, schema=SCHEMA), dropped


SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("osm_type", pa.string()),
        ("osm_id", pa.int64()),
        ("geom_wkb", pa.binary()),
        ("footprint_area_m2", pa.float64()),
        ("overture_height_m", pa.float64()),
        ("overture_num_floors", pa.int32()),
        ("overture_subtype", pa.string()),
        ("overture_class", pa.string()),
        ("osm_height_m", pa.float64()),
        ("osm_levels", pa.float64()),
        ("osm_building", pa.string()),
        ("osm_amenity", pa.string()),
        ("osm_shop", pa.string()),
        ("osm_office", pa.string()),
        ("osm_tourism", pa.string()),
        ("osm_name", pa.string()),
    ]
)
