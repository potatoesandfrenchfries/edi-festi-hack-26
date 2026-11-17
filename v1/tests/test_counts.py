"""Traffic-count selection and matching to road edges: synthetic count rows and a synthetic road graph, no network."""

import pytest

from pipeline.counts import (
    class_medians,
    distance_to_polyline,
    heading,
    match_counts,
    parse_popularity,
    select_counts,
    spearman,
)

CONFIG = {"first_year": 2015, "excluded_years": [2020, 2021], "counted_only": True}
CATEGORIES = {"PA": ["primary"], "MCU": ["residential"]}
LAT = 55.95
LON = -3.19
DLON = 0.001  # about 63 m of longitude here
M_PER_DEG_LAT = 111195.0


def row(point, year, method="Counted", flow=10000, category="PA", **extra):
    base = {
        "count_point_id": point, "year": year, "estimation_method": method, "all_motor_vehicles": flow, "road_category": category,
        "road_name": "A1", "latitude": str(LAT), "longitude": str(LON), "link_length_km": "1.5",
    }  # fmt: skip
    return {**base, **extra}


def test_the_latest_counted_year_wins_and_estimated_and_pandemic_years_never_do():
    rows = [
        row(1, 2017, flow=100),
        row(1, 2019, flow=200),
        row(1, 2022, method="Estimated", flow=999),  # a model's guess
        row(1, 2021, flow=888),  # pandemic
        row(2, 2014, flow=300),  # too old
        row(3, 2020, flow=400),  # pandemic only
        row(4, 2023, flow=500),
    ]
    chosen = {c["id"]: c for c in select_counts(rows, CONFIG)}
    assert set(chosen) == {1, 4}
    assert chosen[1]["aadf"] == 200 and chosen[1]["year"] == 2019
    assert chosen[4]["lat"] == LAT and chosen[4]["linkKm"] == 1.5


def test_a_count_with_no_link_length_is_still_selected():
    assert select_counts([row(1, 2023, link_length_km=None)], CONFIG)[0]["linkKm"] is None


def test_estimated_rows_are_used_only_if_the_config_allows_it():
    rows = [row(1, 2022, method="Estimated")]
    assert select_counts(rows, CONFIG) == []
    assert len(select_counts(rows, {**CONFIG, "counted_only": False})) == 1


def test_distance_to_polyline_is_the_perpendicular_distance_inside_a_segment_and_the_end_distance_beyond_it():
    coords = [LON, LAT, LON + DLON, LAT]
    north_10m = 10 / M_PER_DEG_LAT
    assert distance_to_polyline(LON + DLON / 2, LAT + north_10m, coords) == pytest.approx(10, abs=0.1)
    assert distance_to_polyline(LON - DLON, LAT, coords) == pytest.approx(63, abs=1.5)  # beyond the start: distance to the start
    assert distance_to_polyline(LON, LAT, [LON, LAT, LON, LAT]) == 0  # a zero-length segment does not divide by zero


def edge(a, b, coords, klass=0, two_way=1, way=1):
    return [a, b, klass, 1, 13.4, 0, two_way, 63.0, coords, way, 0]


def graph(*edges):
    return {"classes": ["primary", "residential"], "edges": list(edges)}


def point(**extra):
    return {
        "id": 7,
        "year": 2023,
        "road": "A1",
        "category": "PA",
        "lon": LON + DLON / 2,
        "lat": LAT,
        "aadf": 12000,
        "linkKm": 1.0,
        **extra,
    }


EAST = [LON, LAT, LON + DLON, LAT]
WEST = [LON + DLON, LAT, LON, LAT]


def test_a_two_way_road_shares_the_count_between_its_two_directions():
    roads = graph(edge(0, 1, EAST), edge(1, 0, WEST))
    matches, unmatched = match_counts([point()], roads, CATEGORIES, 25)
    assert unmatched == []
    assert sorted(m[0] for m in matches) == [0, 1]
    assert all(m[1] == 6000 and m[2] == 2 and m[4] == 7 and m[5] == 2023 for m in matches)


def test_a_one_way_road_takes_the_whole_count():
    roads = graph(edge(0, 1, EAST, two_way=0))
    matches, _ = match_counts([point()], roads, CATEGORIES, 25)
    assert matches == [[0, 12000, 1, 0.0, 7, 2023]]


def test_the_other_carriageway_of_a_dual_carriageway_shares_the_count():
    north_15m = 15 / M_PER_DEG_LAT
    other = [LON + DLON, LAT + 2 * north_15m, LON, LAT + 2 * north_15m]
    roads = graph(edge(0, 1, EAST, two_way=0, way=1), edge(2, 3, other, two_way=0, way=2))
    matches, _ = match_counts([point(lat=LAT + north_15m)], roads, CATEGORIES, 25)
    assert sorted(m[0] for m in matches) == [0, 1] and all(m[1] == 6000 and m[2] == 2 for m in matches)


def test_a_parallel_road_going_the_same_way_is_not_the_other_carriageway():
    north_15m = 15 / M_PER_DEG_LAT
    same = [LON, LAT + 2 * north_15m, LON + DLON, LAT + 2 * north_15m]
    roads = graph(edge(0, 1, EAST, two_way=0, way=1), edge(2, 3, same, two_way=0, way=2))
    matches, _ = match_counts(
        [point(lat=LAT + north_15m / 3)], roads, CATEGORIES, 25
    )  # 5 m from the first road, 25 m from the second
    assert [m[0] for m in matches] == [0] and matches[0][1] == 12000


def test_only_the_nearest_piece_of_a_long_road_is_matched():
    east_of = [LON + DLON, LAT, LON + 2 * DLON, LAT]
    roads = graph(edge(0, 1, EAST, two_way=0), edge(1, 2, east_of, two_way=0))
    matches, _ = match_counts([point(lon=LON + DLON / 4)], roads, CATEGORIES, 25)
    assert [m[0] for m in matches] == [0]


def test_a_count_with_no_compatible_road_in_range_is_reported_with_the_reason():
    far = 100 / M_PER_DEG_LAT
    roads = graph(edge(0, 1, EAST, klass=1), edge(2, 3, [LON, LAT + far, LON + DLON, LAT + far]))
    # A residential street is under the point, but a principal A road may only match a primary one, which is 100 m away.
    matches, unmatched = match_counts([point()], roads, CATEGORIES, 25)
    assert matches == [] and unmatched == [[7, "A1", "no road of a compatible class within range"]]
    matches, unmatched = match_counts([point(lat=LAT + 10)], roads, CATEGORIES, 25)
    assert unmatched == [[7, "A1", "no road within range"]]


def test_class_medians_are_taken_over_matched_edges_and_count_each_count_point_once():
    roads = graph(edge(0, 1, EAST), edge(1, 0, WEST), edge(2, 3, EAST, klass=1, two_way=0))
    matches = [[0, 6000, 2, 1.0, 7, 2023], [1, 6000, 2, 1.0, 7, 2023], [2, 400, 1, 3.0, 8, 2022]]
    assert class_medians(matches, roads) == {"primary": (1, 6000), "residential": (1, 400)}


def test_heading_and_loops():
    assert heading(EAST)[0] == pytest.approx(1) and heading(WEST)[0] == pytest.approx(-1)
    assert heading([LON, LAT, LON + DLON, LAT, LON, LAT]) is None


def test_popularity_weights_are_read_from_the_engine_source():
    weights = parse_popularity("x\nconst POPULARITY = { motorway: 4, primary: 3, living_street: .5 };\ny")
    assert weights == {"motorway": 4, "primary": 3, "living_street": 0.5}
    from pipeline.common import ROOT

    real = parse_popularity((ROOT / "web" / "src" / "engine" / "car-sim.mjs").read_text())
    assert real["motorway"] > real["residential"] > 0


def test_spearman_orders_agreement_and_disagreement():
    assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1)
    assert spearman([1, 2, 3, 4], [40, 30, 20, 10]) == pytest.approx(-1)
    assert spearman([1, 2, 3], [5, 5, 5]) is None  # no spread, no correlation
    assert spearman([1, 2], [1, 2]) is None  # too few to say anything
