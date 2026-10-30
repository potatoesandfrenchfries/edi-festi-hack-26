"""Road graph builder for the simulated cars: synthetic Overpass-style elements only, no network."""

import pytest

from pipeline.roads import build_graph, exclusion, haversine, lanes_per_direction, snap_signals, speed_limit, strongly_connected

CLASSES = {"primary", "residential", "motorway"}
DEFAULTS = {"primary": 30, "residential": 20, "motorway": 70}
BBOX = (-3.21, 55.94, -3.17, 55.97)


def way(way_id, refs, coords, **tags):
    tags.setdefault("highway", "residential")
    return {
        "type": "way",
        "id": way_id,
        "nodes": refs,
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in coords],
        "tags": tags,
    }


def test_exclusion_keeps_ordinary_roads_and_says_why_others_are_left_out():
    assert exclusion({"highway": "residential"}, CLASSES) is None
    assert exclusion({"highway": "footway"}, CLASSES) == "class footway not included"
    assert exclusion({"highway": "residential", "area": "yes"}, CLASSES) == "area"
    assert exclusion({"highway": "residential", "access": "private"}, CLASSES) == "access=private"
    # The most specific access key decides: private access but motor vehicles designated is usable.
    assert exclusion({"highway": "residential", "access": "private", "motor_vehicle": "yes"}, CLASSES) is None


def test_speed_limit_reads_mph_and_kmh_or_falls_back_to_the_class_default():
    assert speed_limit({"highway": "primary", "maxspeed": "20 mph"}, DEFAULTS) == (8.94, False)
    assert speed_limit({"highway": "primary", "maxspeed": "50"}, DEFAULTS) == (13.89, False)
    assert speed_limit({"highway": "primary", "maxspeed": "national"}, DEFAULTS) == (13.41, True)
    assert speed_limit({"highway": "motorway"}, DEFAULTS) == (31.29, True)


def test_lanes_per_direction():
    assert lanes_per_direction({}, oneway=True) == (1, 0)
    assert lanes_per_direction({"lanes": "3"}, oneway=True) == (3, 0)
    assert lanes_per_direction({}, oneway=False) == (1, 1)
    assert lanes_per_direction({"lanes": "4"}, oneway=False) == (2, 2)
    assert lanes_per_direction({"lanes:forward": "3", "lanes:backward": "1"}, oneway=False) == (3, 1)
    assert lanes_per_direction({"lanes": "9"}, oneway=True) == (4, 0)  # capped


def test_strongly_connected_returns_the_largest_cycle():
    graph = {1: [2], 2: [3], 3: [1, 4], 4: [5], 5: [4], 6: []}
    assert strongly_connected(graph) == {1, 2, 3}


def test_haversine_is_about_right():
    assert haversine(-3.19, 55.95, -3.19, 55.96) == pytest.approx(1112, abs=5)


def square():
    """A 1 km square of two-way streets (ways 1 and 2 meet at nodes 10 and 12), a one-way street, and a dead-end spur."""
    x0, y0, dx, dy = -3.19, 55.95, 0.0158, 0.009
    a, b, c = (x0, y0), (x0 + dx, y0), (x0 + dx, y0 + dy)
    return [
        way(1, [10, 11, 12], [a, (x0 + dx / 2, y0), b], maxspeed="20 mph"),
        way(2, [12, 13, 10], [b, c, a], highway="primary"),
        way(
            3, [11, 20], [(x0 + dx / 2, y0), (x0 + dx / 2, y0 - 0.004)], oneway="yes"
        ),  # leads away and never comes back: dropped
        way(4, [13, 30], [c, (x0 + dx, y0 + dy + 0.003)]),  # two-way dead end: kept, it is reachable and can turn round
        # Beside node 13, the corner where the dead-end spur joins: three neighbours, so a junction.
        {"type": "node", "id": 99, "lon": c[0] + 0.0001, "lat": c[1] + 0.0001, "tags": {"highway": "traffic_signals"}},
    ]


def test_build_graph_splits_at_junctions_and_drops_what_cars_could_never_leave():
    roads, stats = build_graph(square(), BBOX, CLASSES, DEFAULTS)
    assert stats["droppedDisconnected"] >= 1  # the one-way spur from node 11 to 20
    assert roads["nodes"] == len({e[0] for e in roads["edges"]} | {e[1] for e in roads["edges"]})
    # Every edge has the documented layout and both ends exist.
    for e in roads["edges"]:
        assert len(e) == 11 and e[7] > 0 and len(e[8]) >= 4 and 0 <= e[0] < roads["nodes"] and 0 <= e[1] < roads["nodes"]
    assert roads["classes"] == ["primary", "residential"]
    # Two-way streets give an edge in each direction sharing the OSM way id.
    by_way = {}
    for e in roads["edges"]:
        by_way.setdefault(e[9], []).append(e)
    assert all(len(v) % 2 == 0 for k, v in by_way.items() if k != 3)
    assert 3 not in by_way
    # The 20 mph way is slower than the primary's inferred 30 mph.
    speeds = {e[9]: e[4] for e in roads["edges"]}
    assert speeds[1] < speeds[2]


def test_a_traffic_signal_snaps_to_a_nearby_junction_only():
    roads, stats = build_graph(square(), BBOX, CLASSES, DEFAULTS)
    assert stats["signals"] == {"osmNodes": 1, "junctions": 1}
    assert len(roads["signals"]) == 1
    far = square()
    far[-1] = {"type": "node", "id": 99, "lon": -3.2, "lat": 55.96, "tags": {"highway": "traffic_signals"}}
    assert build_graph(far, BBOX, CLASSES, DEFAULTS)[1]["signals"]["junctions"] == 0


def test_oneway_and_reversed_oneway_give_a_single_direction_each():
    elements = [
        way(1, [1, 2, 3], [(-3.19, 55.95), (-3.18, 55.95), (-3.18, 55.96)]),
        way(2, [3, 4, 1], [(-3.18, 55.96), (-3.19, 55.96), (-3.19, 55.95)], oneway="yes"),
        way(5, [1, 2], [(-3.19, 55.95), (-3.18, 55.95)], oneway="-1", highway="primary"),
    ]
    roads, _ = build_graph(elements, BBOX, CLASSES, DEFAULTS)
    one_way = [e for e in roads["edges"] if e[9] == 2]
    assert len(one_way) == 1 and one_way[0][6] == 0 and one_way[0][3] == 1


def test_roads_outside_the_area_and_unwanted_classes_are_ignored():
    elements = [
        way(1, [1, 2], [(-3.19, 55.95), (-3.18, 55.95)], highway="footway"),
        way(2, [3, 4], [(-3.0, 55.5), (-3.01, 55.5)]),
    ]
    roads, stats = build_graph(elements, BBOX, CLASSES, DEFAULTS)
    assert roads["edges"] == [] and stats["excludedWays"] == {"class footway not included": 1}


def test_snap_signals_uses_the_closest_junction():
    # The builder's internal edge layout: [from, to, class, lanes, speed, inferred, two_way, coords, ...]
    edges = [
        [1, 2, "r", 1, 10, 0, 1, [-3.19, 55.95, -3.189, 55.95]],
        [1, 3, "r", 1, 10, 0, 1, [-3.19, 55.95, -3.19, 55.951]],
        [1, 4, "r", 1, 10, 0, 1, [-3.19, 55.95, -3.191, 55.95]],
    ]
    assert snap_signals([(-3.19001, 55.95001)], edges, {1: 0, 2: 1, 3: 2, 4: 3}) == [0]
