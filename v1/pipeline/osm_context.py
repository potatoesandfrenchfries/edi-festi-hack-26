"""OpenStreetMap land-use context as classified ground geometry (library for stage 02b).

Turns an Overpass `out geom` snapshot into British National Grid polygons for the ground that is *not* available to
buildings: streets, railways, water, green space, surface parking and plazas. What these classes leave empty is what the
infill stage looks at.
"""

from dataclasses import dataclass

import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)

GREEN = {
    "leisure": {
        "park",
        "garden",
        "pitch",
        "playground",
        "golf_course",
        "common",
        "recreation_ground",
        "nature_reserve",
        "sports_centre",
        "track",
        "dog_park",
        "fitness_station",
        "stadium",
    },
    "natural": {
        "wood",
        "grassland",
        "scrub",
        "heath",
        "wetland",
        "bare_rock",
        "scree",
        "fell",
        "tree_row",
        "moor",
        "shrubbery",
        "cliff",
    },
    "amenity": {"grave_yard"},
    "landuse": {
        "grass",
        "forest",
        "cemetery",
        "recreation_ground",
        "meadow",
        "greenfield",
        "village_green",
        "allotments",
        "orchard",
        "flowerbed",
        "greenery",
    },
}
# Buildings front these streets. Footpaths, steps, cycleways, tracks and service lanes take up ground but have no frontage.
FRONTAGE_HIGHWAYS = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
}
AREA_KEYS = ("landuse", "leisure", "natural", "water", "amenity", "tourism", "place", "man_made")


@dataclass(frozen=True)
class Context:
    street: shapely.Geometry  # all ground taken by ways: roads, paths, steps
    frontage: shapely.Geometry  # the part of that which buildings front onto
    rail: shapely.Geometry
    water: shapely.Geometry
    green: shapely.Geometry
    parking: shapely.Geometry
    plaza: shapely.Geometry

    def unavailable(self):
        """Everything OSM says is not building ground, other than the streets themselves."""
        return unary_union([self.rail, self.water, self.green, self.parking, self.plaza])


def _pts(coords):
    xs, ys = TO_BNG.transform([c["lon"] for c in coords], [c["lat"] for c in coords])
    return list(zip(xs, ys, strict=True))


def _relation_polygon(el):
    """A multipolygon relation as a polygon with holes, or None when its member rings cannot be closed."""
    parts = {"outer": [], "inner": []}
    for m in el.get("members", []):
        if m.get("role") in parts and len(m.get("geometry") or []) > 1:
            parts[m["role"]].append(LineString(_pts(m["geometry"])))
    outers = list(polygonize(unary_union(parts["outer"]))) if parts["outer"] else []
    if not outers:
        return None
    geom = unary_union(outers)
    inners = list(polygonize(unary_union(parts["inner"]))) if parts["inner"] else []
    return geom.difference(unary_union(inners)) if inners else geom


def _category(tags):
    """Which ground class an area feature belongs to, or None when it does not take ground from buildings."""
    if tags.get("amenity") == "parking" or tags.get("landuse") == "garages":
        return "parking"
    if tags.get("natural") == "water" or "water" in tags or tags.get("waterway") == "riverbank" or tags.get("landuse") == "basin":
        return "water"
    if tags.get("landuse") == "railway" or "railway" in tags:
        return "rail"
    if tags.get("highway") or tags.get("place") == "square" or tags.get("man_made") in {"bridge", "pier"}:
        return "plaza"
    if any(tags.get(k) in v for k, v in GREEN.items()):
        return "green"
    return None


def elements_in(elements, west, south, east, north):
    """Overpass elements (fetched with `out geom`) whose extent touches a WGS84 box, so a tile parses only its own surroundings."""
    keep = []
    for el in elements:
        b = el.get("bounds")
        if b:
            touches = b["maxlon"] >= west and b["minlon"] <= east and b["maxlat"] >= south and b["minlat"] <= north
        elif "lat" in el:
            touches = west <= el["lon"] <= east and south <= el["lat"] <= north
        else:  # a relation without bounds: judge it by its member geometry
            pts = [pt for m in el.get("members", []) for pt in (m.get("geometry") or [])]
            touches = any(west <= pt["lon"] <= east and south <= pt["lat"] <= north for pt in pts)
        if touches:
            keep.append(el)
    return keep


def parse(elements, *, street_half_width, rail_half_width, waterway_half_width) -> Context:
    """Classify Overpass elements. `street_half_width` maps highway type to metres and has a `default` entry."""
    bucket = {"street": [], "frontage": [], "rail": [], "water": [], "green": [], "parking": [], "plaza": []}
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "way" and el.get("geometry"):
            pts = _pts(el["geometry"])
            if len(pts) < 2:
                continue
            closed = len(pts) > 3 and pts[0] == pts[-1]
            is_area = closed and (tags.get("area") == "yes" or any(k in tags for k in AREA_KEYS))
            if "highway" in tags and not (closed and tags.get("area") == "yes"):
                width = street_half_width.get(tags["highway"], street_half_width["default"])
                corridor = LineString(pts).buffer(width, cap_style="flat")
                bucket["street"].append(corridor)
                if tags["highway"] in FRONTAGE_HIGHWAYS:
                    bucket["frontage"].append(corridor)
            elif "railway" in tags and not closed:
                bucket["rail"].append(LineString(pts).buffer(rail_half_width, cap_style="flat"))
            elif "waterway" in tags and not closed:
                bucket["water"].append(LineString(pts).buffer(waterway_half_width, cap_style="flat"))
            elif is_area or (closed and "highway" in tags and tags.get("area") == "yes"):
                category = _category(tags)
                if category:
                    bucket[category].append(Polygon(pts).buffer(0))
        elif el["type"] == "relation" and tags.get("type") == "multipolygon":
            geom, category = _relation_polygon(el), _category(tags)
            if geom is not None and category:
                bucket[category].append(geom.buffer(0))
    return Context(**{k: unary_union(v) if v else Polygon() for k, v in bucket.items()})
