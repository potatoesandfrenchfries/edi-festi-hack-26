"""Festival venues: which building footprints host festival events.

config/venues.csv lists venue points (from the Edinburgh festivals MCP). Each `building` point is matched to a building footprint,
and stage 06 writes `is_venue` on the matched buildings so the web app can draw them in the venue colour. A `tent` is not a
building: no footprint is flagged, and the web app draws it as a model (web/src/tent.ts, which holds its position).
"""

import csv
import re

import shapely
from pyproj import Transformer

from pipeline.common import ROOT

VENUES = ROOT / "config" / "venues.csv"
PUBLIC_BUILDINGS = ROOT / "config" / "public_buildings.csv"
TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
NEAREST_M = 15  # assumption: a venue point that falls in no footprint snaps to a footprint at most this far away
NAME_M = 45  # assumption: a footprint whose OSM name matches the venue name wins if it is at most this far from the venue point
MIN_NAME_CHARS = 6  # assumption: a shorter name only counts as a match when it equals the venue name, so "hall" never matches


def load_venues(path=VENUES):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def normalise(name):
    """Lower case letters and digits only, without a leading "the", so "The Queen's Hall" and "Queens Hall" compare equal."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^the\s+", "", (name or "").lower().replace("'", "")))


def names_match(venue, osm):
    """True when the OSM name is the venue name, or one contains the other ("Central Hall" in "Methodist Central Halls")."""
    venue, osm = normalise(venue), normalise(osm)
    if not venue or not osm:
        return False
    return venue == osm or (min(len(venue), len(osm)) >= MIN_NAME_CHARS and (venue in osm or osm in venue))


def match_venue(point, footprints, names=None, venue_name=""):
    """Index of the footprint for a venue point in EPSG:27700, or None.

    `footprints` is a list of shapely geometries and `names` their OSM names. A footprint named like the venue within NAME_M
    wins, the nearest if several. Otherwise a footprint that contains the point wins, the largest if several overlap (a hall
    and its annexe), then the nearest footprint within NEAREST_M. A point in the gap beside a building is common because venue
    coordinates are often the street door, not the centroid, and the nearest building is often a neighbour, hence the name check.
    """
    named = [(footprints[i].distance(point), i) for i, name in enumerate(names or []) if names_match(venue_name, name)]
    named = [(d, i) for d, i in named if d <= NAME_M]
    if named:
        return min(named)[1]
    containing = [i for i, geom in enumerate(footprints) if geom.contains(point)]
    if containing:
        return max(containing, key=lambda i: footprints[i].area)
    near = [(geom.distance(point), i) for i, geom in enumerate(footprints) if geom.distance(point) <= NEAREST_M]
    return min(near)[1] if near else None


def venue_ids(venues, ids, geoms_wkb, osm_names=None):
    """Maps building id -> venue name for the venues that land on a footprint. Also returns the names that matched nothing."""
    footprints = [shapely.from_wkb(wkb) for wkb in geoms_wkb]
    tree = shapely.STRtree(footprints)
    flagged, missed = {}, []
    for venue in venues:
        if venue.get("kind", "building") != "building":
            continue
        x, y = TO_BNG.transform(float(venue["lon"]), float(venue["lat"]))
        point = shapely.Point(x, y)
        candidates = tree.query(point.buffer(NAME_M)).tolist()
        names = [(osm_names or {}).get(ids[i]) for i in candidates]
        index = match_venue(point, [footprints[i] for i in candidates], names, venue["name"])
        if index is None:
            missed.append(venue["name"])
        else:
            flagged.setdefault(ids[candidates[index]], venue["name"])
    return flagged, missed


def public_ids(places, ids, geoms_wkb, osm_names=None):
    """Set of building ids for the public buildings, and the names that matched nothing.

    Like `venue_ids`, but every footprint named like the place within NAME_M of its point is flagged, because one public building
    (a station) can be several footprints. A place with no named footprint falls back to the single best match.
    """
    footprints = [shapely.from_wkb(wkb) for wkb in geoms_wkb]
    tree = shapely.STRtree(footprints)
    flagged, missed = set(), []
    for place in places:
        x, y = TO_BNG.transform(float(place["lon"]), float(place["lat"]))
        point = shapely.Point(x, y)
        candidates = tree.query(point.buffer(NAME_M)).tolist()
        names = [(osm_names or {}).get(ids[i]) for i in candidates]
        named = [
            i
            for i, name in zip(candidates, names, strict=True)
            if names_match(place["name"], name) and footprints[i].distance(point) <= NAME_M
        ]
        if not named:
            index = match_venue(point, [footprints[i] for i in candidates])
            named = [] if index is None else [candidates[index]]
        if named:
            flagged.update(ids[i] for i in named)
        else:
            missed.append(place["name"])
    return flagged, missed
