import pytest
import shapely

from pipeline.accommodation import (
    beds_of,
    load_config,
    normalise_postcode,
    occupancy,
    parse_register,
    place_beds,
    stay_kind,
    tag_beds,
)
from pipeline.stage06_tiles import to_feature
from tests.test_tiles import record

CFG = load_config()


def test_postcodes_are_normalised_and_junk_is_rejected():
    assert (
        normalise_postcode("eh1  3ep") == "EH1 3EP"
        and normalise_postcode("EH66PN") == "EH6 6PN"
        and normalise_postcode("W1A 1AA") == "W1A 1AA"
    )
    assert normalise_postcode("EH1") is None and normalise_postcode(None) is None and normalise_postcode("nonsense") is None


def test_beds_use_occupancy_then_bedrooms_then_a_default():
    assert beds_of("6.0", "3", CFG) == 6
    assert beds_of("", "3", CFG) == 3 * CFG["short_term_lets"]["beds_per_bedroom"]
    assert beds_of("0", "", CFG) == CFG["short_term_lets"]["beds_per_bedroom"]


def test_register_counts_only_issued_licences_once_and_drops_what_has_no_postcode():
    row = lambda status, number, postcode, occ: {
        "Status": status, "Short Term Let Licence Number": number, "Postcode": postcode, "Maximum Occupancy": occ, "Number of Bedrooms": ""
    }  # fmt: skip
    rows = [
        row("Licence issued", "EH-1-F", "EH1 3EP", "4"),
        row("Licence issued", "EH-1-F", "EH1 3EP", "4"),  # the same licence on a second sheet
        row("Licence issued", "EH-2-F", "EH1 3EP", "2"),
        row("Application withdrawn", "EH-3-F", "EH1 3EP", "9"),
        row("Licence issued", "EH-4-F", "", "5"),
    ]
    assert parse_register(rows, CFG) == {"EH1 3EP": {"beds": 6, "lets": 2}}


def test_stay_kind_from_tags_and_beds_from_floor_area():
    assert (
        stay_kind("hotel", None, CFG) == "hotel"
        and stay_kind(None, "hostel", CFG) == "hotel"
        and stay_kind(None, "dormitory", CFG) == "halls"
    )
    assert stay_kind("museum", "apartments", CFG) is None
    assert tag_beds("hotel", 2800, CFG) == pytest.approx(2800 / CFG["hotels"]["m2_per_bed"])
    assert tag_beds("halls", 2000, CFG) == pytest.approx(
        2000 / CFG["student_halls"]["m2_per_bed"] * CFG["student_halls"]["festival_let_share"]
    )
    assert tag_beds(None, 5000, CFG) == 0


def test_place_beds_spreads_by_floor_area_skips_excluded_and_reports_the_lost():
    near_big, near_small = shapely.box(0, 0, 10, 10), shapely.box(12, 0, 22, 10)
    hotel, far = shapely.box(-8, 0, -2, 10), shapely.box(500, 0, 510, 10)
    footprints, areas, excluded = [near_big, near_small, hotel, far], [300.0, 100.0, 9999.0, 50.0], [False, False, True, False]
    beds, lost = place_beds([(5, 5, 8), (900, 900, 3)], footprints, areas, excluded, CFG)
    assert beds[0] == pytest.approx(6) and beds[1] == pytest.approx(2) and beds[2] == 0 and beds[3] == 0
    assert lost == 3


def test_occupancy_rises_with_visitors_and_is_capped():
    base, top = CFG["occupancy"]["base"], CFG["occupancy"]["max"]
    assert (
        occupancy(0, 1000, CFG) == base
        and occupancy(100, 1000, CFG) == pytest.approx(base + 0.1)
        and occupancy(10_000, 1000, CFG) == top
    )


def test_tiles_carry_beds_and_the_venue_key_only_when_there_are_some():
    plain = to_feature({**record(), "is_venue": False})["properties"]
    assert "beds" not in plain and "venue" not in plain
    full = to_feature({**record(), "is_venue": True, "venue_key": "usher_hall", "beds": 41.6, "stay_kind": "hotel"})["properties"]
    assert full["beds"] == 42 and full["stay"] == "hotel" and full["venue"] == "usher_hall"


def test_night_profile_has_24_hours_between_0_and_1():
    assert len(CFG["night_profile"]) == 24 and all(0 <= v <= 1 for v in CFG["night_profile"])
