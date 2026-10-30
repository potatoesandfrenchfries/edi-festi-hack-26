import pytest

from pipeline.osm_context import parse

WIDTHS = {"residential": 7, "footway": 2, "default": 3}
KW = {"street_half_width": WIDTHS, "rail_half_width": 4, "waterway_half_width": 3}


def way(tags, lonlat, **extra):
    return {"type": "way", "id": 1, "tags": tags, "geometry": [{"lon": x, "lat": y} for x, y in lonlat], **extra}


# A square of about 100 m near the Castle, closed.
SQUARE = [(-3.2000, 55.9500), (-3.1985, 55.9500), (-3.1985, 55.9509), (-3.2000, 55.9509), (-3.2000, 55.9500)]


def test_streets_are_buffered_by_their_class_width():
    ctx = parse([way({"highway": "residential"}, [(-3.2, 55.95), (-3.198, 55.95)])], **KW)
    narrow = parse([way({"highway": "footway"}, [(-3.2, 55.95), (-3.198, 55.95)])], **KW)
    assert ctx.street.area > 2 * narrow.street.area


def test_unknown_highway_types_use_the_default_width():
    ctx = parse([way({"highway": "bridleway"}, [(-3.2, 55.95), (-3.198, 55.95)])], **KW)
    assert ctx.street.area > 0


@pytest.mark.parametrize(
    ("tags", "attr"),
    [
        ({"leisure": "park"}, "green"),
        ({"amenity": "grave_yard"}, "green"),
        ({"natural": "wood"}, "green"),
        ({"landuse": "cemetery"}, "green"),
        ({"amenity": "parking"}, "parking"),
        ({"natural": "water"}, "water"),
        ({"landuse": "railway"}, "rail"),
        ({"place": "square"}, "plaza"),
        ({"highway": "pedestrian", "area": "yes"}, "plaza"),
    ],
)
def test_area_features_are_sorted_into_ground_classes(tags, attr):
    ctx = parse([way(tags, SQUARE)], **KW)
    assert getattr(ctx, attr).area > 5000
    assert all(getattr(ctx, other).area == 0 for other in ("green", "parking", "water", "rail", "plaza") if other != attr)


def test_built_up_landuse_does_not_take_ground_from_buildings():
    assert parse([way({"landuse": "residential"}, SQUARE)], **KW).unavailable().area == 0


def test_railway_and_waterway_lines_are_buffered():
    ctx = parse(
        [
            way({"railway": "rail"}, [(-3.2, 55.95), (-3.198, 55.95)]),
            way({"waterway": "stream"}, [(-3.2, 55.951), (-3.198, 55.951)]),
        ],
        **KW,
    )
    assert ctx.rail.area > 0 and ctx.water.area > 0


def test_multipolygon_relations_keep_their_holes():
    outer = [{"lon": x, "lat": y} for x, y in SQUARE]
    inner = [
        {"lon": x, "lat": y}
        for x, y in [(-3.1997, 55.9503), (-3.1990, 55.9503), (-3.1990, 55.9506), (-3.1997, 55.9506), (-3.1997, 55.9503)]
    ]
    rel = {"type": "relation", "id": 2, "tags": {"type": "multipolygon", "leisure": "park"},
           "members": [{"role": "outer", "geometry": outer}, {"role": "inner", "geometry": inner}]}  # fmt: skip
    ctx = parse([rel], **KW)
    whole = parse([way({"leisure": "park"}, SQUARE)], **KW).green.area
    assert 0 < ctx.green.area < whole * 0.9


def test_features_without_geometry_are_ignored():
    assert (
        parse(
            [{"type": "node", "id": 3, "tags": {"leisure": "park"}}, {"type": "way", "id": 4, "tags": {"leisure": "park"}}], **KW
        ).green.area
        == 0
    )


def test_only_roads_buildings_front_count_as_frontage():
    road = parse([way({"highway": "residential"}, [(-3.2, 55.95), (-3.198, 55.95)])], **KW)
    assert road.frontage.area == road.street.area > 0
    for kind in ("footway", "steps", "service", "path", "cycleway"):
        ctx = parse([way({"highway": kind}, [(-3.2, 55.95), (-3.198, 55.95)])], **KW)
        assert ctx.street.area > 0 and ctx.frontage.area == 0
