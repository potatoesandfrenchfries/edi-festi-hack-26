"""Visitor accommodation: bed-spaces per building from the short-term-let register, hotels and halls.

Pure functions (stage11_accommodation.py fetches and geocodes, stage06 places beds on buildings). The register is read for three columns
only (status, postcode, maximum occupancy, with bedrooms as a fallback); the applicant and the street address are never kept.
"""

import re

import shapely
import yaml

from pipeline.common import ROOT

CONFIG = ROOT / "config" / "accommodation.yaml"


def load_config(path=CONFIG):
    return yaml.safe_load(path.read_text())


def normalise_postcode(text):
    """ "eh1  3ep" -> "EH1 3EP"; None if the text is not a full UK postcode."""
    squashed = re.sub(r"\s+", "", str(text or "")).upper()
    match = re.match(r"^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$", squashed)
    return f"{match.group(1)} {match.group(2)}" if match else None


def beds_of(occupancy, bedrooms, cfg):
    """Beds for one licence: the maximum occupancy if it is a positive number, else bedrooms times beds per bedroom, else 2."""
    per_bedroom = cfg["short_term_lets"]["beds_per_bedroom"]
    for value, factor in ((occupancy, 1), (bedrooms, per_bedroom)):
        try:
            if float(value) > 0:
                return round(float(value) * factor)
        except (TypeError, ValueError):
            pass
    return per_bedroom


def parse_register(rows, cfg):
    """Rows are dicts with the register's headers. Returns {postcode: {"beds": n, "lets": n}} for issued licences, each licence counted once."""
    statuses = set(cfg["short_term_lets"]["licensed_statuses"])
    seen, out, skipped = set(), {}, 0
    for row in rows:
        if str(row.get("Status", "")).strip() not in statuses:
            continue
        number = str(row.get("Short Term Let Licence Number", "")).strip()
        if number and number != "not assigned":
            if number in seen:
                continue
            seen.add(number)
        postcode = normalise_postcode(row.get("Postcode"))
        if postcode is None:
            skipped += 1
            continue
        entry = out.setdefault(postcode, {"beds": 0, "lets": 0})
        entry["beds"] += beds_of(row.get("Maximum Occupancy"), row.get("Number of Bedrooms"), cfg)
        entry["lets"] += 1
    return out


def stay_kind(osm_tourism, overture_class, cfg):
    """ "hotel", "halls" or None: whether a building's tags say it offers beds."""
    if osm_tourism in cfg["hotels"]["osm_tourism"] or overture_class in cfg["hotels"]["overture_class"]:
        return "hotel"
    return "halls" if overture_class in cfg["student_halls"]["overture_class"] else None


def tag_beds(kind, floor_area_m2, cfg):
    """Bed-spaces for a hotel or halls building from its floor area (an estimate: the tags do not give rooms)."""
    if kind == "hotel":
        return floor_area_m2 / cfg["hotels"]["m2_per_bed"]
    if kind == "halls":
        return floor_area_m2 / cfg["student_halls"]["m2_per_bed"] * cfg["student_halls"]["festival_let_share"]
    return 0.0


def place_beds(points, footprints, floor_areas, excluded, cfg):
    """Puts each postcode's beds on the nearest few buildings, by floor area. `points` are (x, y, beds) in metres, like the footprints.

    Returns (beds per building, beds that found no building within range). Buildings flagged in `excluded` (hotels, halls) take none.
    """
    tree = shapely.STRtree(footprints)
    reach, k = cfg["short_term_lets"]["place_within_m"], cfg["short_term_lets"]["spread_over_buildings"]
    beds, lost = [0.0] * len(footprints), 0.0
    for x, y, count in points:
        point = shapely.Point(x, y)
        near = sorted((footprints[i].distance(point), i) for i in tree.query(point.buffer(reach)).tolist() if not excluded[i])
        chosen = [i for d, i in near if d <= reach][:k]
        if not chosen:
            lost += count
            continue
        weight = sum(max(floor_areas[i], 1.0) for i in chosen)
        for i in chosen:
            beds[i] += count * max(floor_areas[i], 1.0) / weight
    return beds, lost


def occupancy(staying_people, total_beds, cfg):
    """Share of beds occupied on a night: the base level plus the festival's staying visitors over all beds, never above the maximum."""
    base, top = cfg["occupancy"]["base"], cfg["occupancy"]["max"]
    return min(top, base + staying_people / max(total_beds, 1))
