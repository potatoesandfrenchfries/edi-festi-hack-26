import shapely
from shapely.geometry import Point, box

from pipeline.validate_heights import match_footprint, passes


def test_passes_uses_the_larger_of_absolute_and_relative_tolerance():
    assert passes(2.9, 10, 3.0, 0.15)  # inside 3 m
    assert not passes(3.1, 10, 3.0, 0.15)
    assert passes(7.0, 50, 3.0, 0.15)  # 15% of 50 = 7.5
    assert not passes(8.0, 50, 3.0, 0.15)
    assert passes(-7.0, 50, 3.0, 0.15)  # errors can be negative


def test_match_picks_the_largest_footprint_within_the_radius():
    geoms = [box(0, 0, 2, 2), box(2.5, 0, 12.5, 10), box(100, 100, 110, 110)]
    tree = shapely.STRtree(geoms)
    assert match_footprint(Point(1, 1), geoms, tree, radius=5) == 1  # the porch is inside, the church is 1.5 m away and larger
    assert match_footprint(Point(105, 105), geoms, tree, radius=5) == 2


def test_match_returns_none_when_nothing_is_close():
    geoms = [box(0, 0, 2, 2)]
    assert match_footprint(Point(50, 50), geoms, shapely.STRtree(geoms), radius=5) is None
