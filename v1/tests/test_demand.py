from datetime import date, datetime

import pytest

from pipeline.demand import (
    assign_hubs,
    build_series,
    load_config,
    origin_class,
    pack,
    parse_eif_start,
    parse_tattoo_start,
    postcode_area,
    sector_of,
    shares,
    spread,
    staying_people,
)  # fmt: skip

CFG = load_config()
TIMING = {"arrive_before_min": 30, "leave_after_min": 30}


def test_postcode_area_takes_the_leading_letters_and_ignores_junk():
    assert postcode_area("EH1 3EP") == "EH" and postcode_area("g12 8QQ") == "G" and postcode_area(" kY11") == "KY"
    assert postcode_area("1") is None and postcode_area(None) is None and postcode_area("") is None


def test_origin_class_local_daytrip_stay_and_abroad_always_stays():
    assert origin_class("EH", None, CFG) == "local"
    assert origin_class("FK", "United Kingdom", CFG) == "daytrip"
    assert origin_class("SW", "United Kingdom", CFG) == "stay"
    assert origin_class("EH", "Germany", CFG) == "stay"  # an EH-looking postcode does not make a German booker local
    assert origin_class(None, None, CFG) is None and origin_class(None, "", CFG) is None


def test_sector_of_known_areas_and_none_for_edinburgh():
    assert sector_of("KY", CFG) == "north" and sector_of("G", CFG) == "west" and sector_of("TD", CFG) == "south"
    assert sector_of("EH", CFG) is None


def test_assign_hubs_follows_the_weights_and_is_deterministic():
    hubs = [{"key": "a", "weight": 0.75}, {"key": "b", "weight": 0.25}]
    tickets = {str(i): 10 for i in range(20)}
    placed = assign_hubs(tickets, hubs)
    assert sum(1 for h in placed.values() if h == "a") == 15
    assert placed == assign_hubs(dict(reversed(list(tickets.items()))), hubs)


def test_spread_conserves_the_count_and_splits_by_overlap():
    series = [0.0] * 8
    spread(series, 10, 50, 40, 15)  # slots 0..3 of 15 minutes: 5, 15, 15, 5 minutes of the 40
    assert sum(series) == pytest.approx(40) and series[0] == pytest.approx(5) and series[1] == pytest.approx(15)


def test_build_series_people_arrive_then_leave_and_the_room_empties():
    show = (date(2026, 8, 7), "v", 60)
    start = datetime(2026, 8, 7, 19, 0)
    out = build_series([("v", start, show[2], 100)], TIMING, date(2026, 8, 7), 2, 15)["v"]
    assert sum(out["arrivals"]) == pytest.approx(100) and sum(out["departures"]) == pytest.approx(100)
    assert max(out["present"]) == pytest.approx(100, rel=0.15)
    assert out["present"][-1] == pytest.approx(0, abs=1e-6)
    at_start = 19 * 60 // 15
    assert out["present"][at_start] > 90  # everyone is in at curtain up


def test_show_after_midnight_runs_into_the_next_day():
    out = build_series([("v", datetime(2026, 8, 7, 23, 30), 60, 50)], TIMING, date(2026, 8, 7), 2, 15)["v"]
    assert sum(out["departures"][:96]) == pytest.approx(0) and sum(out["departures"][96:]) == pytest.approx(50)


def test_pack_drops_small_cells_and_empty_days():
    series = {"arrivals": [0, 4, 30, 0] + [0] * 92, "departures": [0] * 96, "present": [0, 0, 30, 12] + [0] * 92}
    packed = pack(series, date(2026, 8, 7), 15, 10)
    assert packed["2026-08-07"]["a"][:4] == [0, 0, 30, 0] and packed["2026-08-07"]["p"][3] == 12
    assert pack({"arrivals": [0] * 96, "departures": [0] * 96, "present": [0] * 96}, date(2026, 8, 7), 15, 10) == {}


def test_shares_and_staying_people():
    assert shares({"local": 2, "daytrip": 1, "stay": 1, None: 50}) == {"local": 0.5, "daytrip": 0.25, "stay": 0.25}
    assert shares({}) == {"local": 0.0, "daytrip": 0.0, "stay": 0.0}
    assert staying_people({"2026-08-07": 400}, 0.5, CFG) == {
        "2026-08-07": round(400 * 0.5 / CFG["origin"]["shows_per_person_per_day"])
    }


def test_date_formats_of_the_extracts():
    assert parse_eif_start("07/08/2026 14:00") == datetime(2026, 8, 7, 14, 0)
    assert parse_tattoo_start("8/7/26 21:30") == datetime(2026, 8, 7, 21, 30)


def test_hub_weights_sum_to_one_and_hubs_have_places():
    assert sum(h["weight"] for h in CFG["fringe_hubs"]) == pytest.approx(1.0)
    assert all(-3.21 < h["lon"] < -3.17 and 55.94 < h["lat"] < 55.96 for h in CFG["fringe_hubs"])  # inside the modelled road area
