"""Road graph builder for the simulated cars: synthetic Overpass-style elements only, no network."""

import pytest

from pipeline.common import area
from pipeline.roads import (
    bng_box_to_wgs84,
    build_graph,
    edge_midpoint,
    exclusion,
    haversine,
    lanes_per_direction,
    snap_signals,
    speed_limit,
    strongly_connected,
    zone_boxes,
    zone_function,
    zone_queries,
)

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


# --- zones (the council-area build) ---------------------------------------------------------------------------------------------


def test_zone_boxes_grow_the_pilot_box_by_each_buffer():
    core, ring = zone_boxes((100, 200, 300, 400), 10, 50)
    assert core == (90, 190, 310, 410) and ring == (50, 150, 350, 450)


def test_a_point_belongs_to_the_innermost_zone_that_holds_it():
    pilot = area("pilot")["bbox_bng"]
    zone = zone_function(zone_boxes(pilot, 500, 3000))
    west, south, east, north = area("pilot")["bbox_wgs84"]
    assert zone((west + east) / 2, (south + north) / 2) == 0  # the middle of the Old Town and New Town
    assert zone(west - 0.004, (south + north) / 2) == 0  # about 250 m west: inside the 500 m core buffer
    assert zone(west - 0.02, (south + north) / 2) == 1  # about 1.3 km west: ring
    assert zone(west - 0.15, south) == 2  # far west: outer


def test_overpass_wgs84_box_holds_the_whole_bng_box():
    south, west, north, east = bng_box_to_wgs84(zone_boxes(area("pilot")["bbox_bng"], 0, 0)[0])
    p_west, p_south, p_east, p_north = area("pilot")["bbox_wgs84"]
    # The grid is slightly rotated against lon/lat, so the enclosing box is a little larger, never smaller.
    assert south <= p_south and west <= p_west and north >= p_north and east >= p_east
    assert (south, west, north, east) == pytest.approx((p_south, p_west, p_north, p_east), abs=1e-3)


def test_each_zone_fetches_only_what_no_wider_zone_already_returns():
    classes = ["motorway", "primary", "tertiary", "residential"]
    queries = zone_queries(classes, {"ring": ["motorway", "primary", "tertiary"], "outer": ["motorway", "primary"]})
    assert queries == [("outer", ["motorway", "primary"]), ("ring", ["tertiary"]), ("core", ["residential"])]
    # The union of what the three queries return in the box that holds them covers every class in every zone.
    assert {c for _, names in queries for c in names} == set(classes)
    # A zone with nothing extra to ask for is not queried at all.
    assert [z for z, _ in zone_queries(["primary"], {"ring": ["primary"], "outer": ["primary"]})] == ["outer"]


def test_edge_midpoint_is_the_mean_of_the_end_vertices():
    assert edge_midpoint([0.0, 0.0, 5.0, 5.0, 2.0, 4.0]) == (1.0, 2.0)


def zoned_square():
    """The square, cut at lon -3.18: west of it is the core (residential and primary kept), east of it outer (primary only)."""

    def zone_of(lon, lat):
        return 0 if lon < -3.18 else 2

    return zone_of, [{"primary", "residential"}, {"primary"}, {"primary"}]


def test_an_edge_keeps_its_class_only_if_its_zone_allows_it():
    zoning = zoned_square()
    roads, stats = build_graph(square(), BBOX, CLASSES, DEFAULTS, zoning=zoning)
    assert len(roads["zones"]) == len(roads["edges"]) and roads["zoneNames"] == ["core", "ring", "outer"]
    names = roads["classes"]
    for edge, zone in zip(roads["edges"], roads["zones"], strict=True):
        assert names[edge[2]] in zoning[1][zone]
        assert zoning[0](*edge_midpoint(edge[8])) == zone
    unzoned, _ = build_graph(square(), BBOX, CLASSES, DEFAULTS)
    outer_residential = [
        e for e in unzoned["edges"] if unzoned["classes"][e[2]] == "residential" and edge_midpoint(e[8])[0] >= -3.18
    ]
    assert outer_residential, "the fixture must have a residential edge in the outer zone for this test to mean anything"
    assert len(roads["edges"]) < len(unzoned["edges"])
    assert set(stats["byZone"]) == {"core", "outer"} or set(stats["byZone"]) == {"core", "ring", "outer"}
    assert sum(z["edges"] for z in stats["byZone"].values()) == stats["edges"]


def test_without_zoning_the_graph_has_no_zone_fields():
    roads, stats = build_graph(square(), BBOX, CLASSES, DEFAULTS)
    assert "zones" not in roads and "zoneNames" not in roads and "byZone" not in stats


def test_the_default_lane_share_counts_ways_with_no_lane_tag():
    elements = [
        way(1, [1, 2, 3], [(-3.19, 55.95), (-3.18, 55.95), (-3.18, 55.96)], lanes="2"),
        way(2, [3, 4, 1], [(-3.18, 55.96), (-3.19, 55.96), (-3.19, 55.95)]),
    ]
    _, stats = build_graph(elements, BBOX, CLASSES, DEFAULTS)
    assert 0 < stats["inferredLanesShare"] < 1


def test_a_zoned_build_places_cars_by_zone_density():
    from pipeline.stage08_roads import zone_population

    roads = {
        "zoneNames": ["core", "ring", "outer"],
        "zones": [0, 0, 1, 2],
        "edges": [[0, 1, 0, 1, 9, 0, 1, 1000.0], [1, 2, 0, 1, 9, 0, 1, 500.0], [2, 3, 0, 1, 9, 0, 1, 2000.0], [3, 0, 0, 1, 9, 0, 1, 10000.0]],
    }
    per_zone, total = zone_population(roads, {"core": 8, "ring": 3, "outer": 1.2})
    assert per_zone == [12, 6, 12]  # 1.5 km x 8, 2 km x 3, 10 km x 1.2
    assert total == 30
