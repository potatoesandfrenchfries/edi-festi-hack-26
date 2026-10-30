import shapely

from pipeline.stage06_tiles import to_feature
from pipeline.venues import NEAREST_M, PUBLIC_BUILDINGS, TO_BNG, load_venues, match_venue, names_match, public_ids, venue_ids
from tests.test_tiles import record


def test_containing_footprint_wins_and_the_largest_when_they_overlap():
    small, large = shapely.box(0, 0, 10, 10), shapely.box(-5, -5, 20, 20)
    assert match_venue(shapely.Point(5, 5), [small, large]) == 1


def test_point_beside_a_building_snaps_to_the_nearest_within_range():
    near, far = shapely.box(10, 0, 20, 10), shapely.box(100, 0, 110, 10)
    assert match_venue(shapely.Point(5, 5), [far, near]) == 1
    assert match_venue(shapely.Point(5 - NEAREST_M, 5), [far, near]) is None


def test_names_match_ignores_case_the_and_apostrophes_but_not_short_fragments():
    assert names_match("The Queen's Hall", "The Queen's Hall") and names_match("St Bride's Centre", "St Brides Centre")
    assert names_match("Central Hall", "Methodist Central Halls") and names_match("Studio Theatre", "The Studio")
    assert (
        not names_match("Usher Hall", "Hall")
        and not names_match("Usher Hall", None)
        and not names_match("Jazz Bar", "Old College")
    )


def test_a_named_footprint_beats_the_one_under_the_point():
    under, named = shapely.box(0, 0, 10, 10), shapely.box(30, 0, 60, 10)
    assert match_venue(shapely.Point(5, 5), [under, named], [None, "Usher Hall"], "Usher Hall") == 1
    assert match_venue(shapely.Point(5, 5), [under, named], [None, "Usher Hall"], "Queen's Hall") == 0
    far = shapely.box(500, 0, 530, 10)  # named like the venue but too far from the point
    assert match_venue(shapely.Point(5, 5), [under, far], [None, "Usher Hall"], "Usher Hall") == 0


def test_venue_ids_flags_the_building_under_the_point_and_reports_misses():
    x, y = TO_BNG.transform(-3.1886, 55.9446)
    here, elsewhere = shapely.box(x - 5, y - 5, x + 5, y + 5), shapely.box(x + 500, y, x + 510, y + 10)
    venues = [
        {"name": "Here", "lon": "-3.1886", "lat": "55.9446"},
        {"name": "Nowhere", "lon": "-3.3", "lat": "55.9"},
    ]
    flagged, missed = venue_ids(venues, ["a", "b"], [shapely.to_wkb(here), shapely.to_wkb(elsewhere)])
    assert flagged == {"a": "Here"} and missed == ["Nowhere"]


def test_venues_csv_is_in_edinburgh_and_names_its_source():
    venues = load_venues()
    assert venues and all(-3.4 < float(v["lon"]) < -3.0 and 55.8 < float(v["lat"]) < 56.1 and v["source"] for v in venues)


def test_is_venue_is_written_only_for_venues():
    assert to_feature(record(is_venue=True))["properties"]["is_venue"] is True
    assert "is_venue" not in to_feature(record(is_venue=False))["properties"]
    assert "is_venue" not in to_feature(record())["properties"]


def test_a_tent_flags_no_building_even_with_one_under_it():
    x, y = TO_BNG.transform(-3.1886, 55.9446)
    under = shapely.box(x - 5, y - 5, x + 5, y + 5)
    venues = [{"name": "Tent", "lon": "-3.1886", "lat": "55.9446", "kind": "tent"}]
    assert venue_ids(venues, ["a"], [shapely.to_wkb(under)]) == ({}, [])


def test_venues_csv_has_one_kind_per_row_and_the_spiegeltent_is_a_tent():
    kinds = {v["name"]: v["kind"] for v in load_venues()}
    assert set(kinds.values()) <= {"building", "tent", "ground"}
    assert kinds["George Square Spiegeltent"] == "tent"


def test_public_ids_flags_every_footprint_named_like_the_place():
    x, y = TO_BNG.transform(-3.1895, 55.9520)
    a, b = shapely.box(x - 20, y - 5, x - 2, y + 5), shapely.box(x + 2, y - 5, x + 20, y + 5)
    other = shapely.box(x + 500, y, x + 510, y + 10)
    places = [
        {"name": "Edinburgh Waverley", "lon": "-3.1895", "lat": "55.9520"},
        {"name": "Nowhere", "lon": "-3.3", "lat": "55.9"},
    ]
    names = {"a": "Edinburgh Waverley", "b": "Edinburgh Waverley", "c": None}
    flagged, missed = public_ids(places, ["a", "b", "c"], [shapely.to_wkb(g) for g in (a, b, other)], names)
    assert flagged == {"a", "b"} and missed == ["Nowhere"]


def test_public_buildings_csv_is_in_edinburgh_and_names_its_source():
    places = load_venues(PUBLIC_BUILDINGS)
    assert places and all(-3.4 < float(p["lon"]) < -3.0 and 55.8 < float(p["lat"]) < 56.1 and p["source"] for p in places)


def test_is_public_is_written_only_for_public_buildings():
    assert to_feature(record(is_public=True))["properties"]["is_public"] is True
    assert "is_public" not in to_feature(record(is_public=False))["properties"]
