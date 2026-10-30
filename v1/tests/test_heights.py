import numpy as np
import pytest
from rasterio.transform import Affine
from shapely.geometry import box

from pipeline.footprints import parse_height_m, parse_levels
from pipeline.heights import NODATA, LidarMeasure, disagree, measure, merge_height

CFG = {
    "disagreement_abs_m": 3.0,
    "disagreement_rel": 0.25,
    "on_disagreement": "keep_tag",
    "min_lidar_height_m": 2.0,
    "min_lidar_pixels": 12,
    "min_valid_fraction": 0.8,
    "steep_range_m": 3.0,
    "default_height_m": 6.0,
}
PX = 0.5


def grid(size_m=60.0):
    """A size_m square of 0.5 m pixels with origin (0, 0) top-left at y = size_m; returns transform and x, y centres."""
    n = int(size_m / PX)
    transform = Affine(PX, 0, 0, 0, -PX, size_m)
    xs = (np.arange(n) + 0.5) * PX
    ys = size_m - (np.arange(n) + 0.5) * PX
    return transform, np.meshgrid(xs, ys)


def scene(slope, height, footprint):
    """DTM = slope * x. DSM = DTM, except a flat roof `height` m above the ground at the footprint's centre."""
    transform, (x, y) = grid()
    dtm = (slope * x).astype("float32")
    dsm = dtm.copy()
    inside = (x >= footprint.bounds[0]) & (x <= footprint.bounds[2]) & (y >= footprint.bounds[1]) & (y <= footprint.bounds[3])
    dsm[inside] = slope * footprint.centroid.x + height
    return transform, dsm, dtm


def test_flat_ground_gives_the_roof_height():
    fp = box(20, 20, 30, 30)
    transform, dsm, dtm = scene(0.0, 12.0, fp)
    m = measure(dsm, dtm, transform, fp)
    assert m.height == pytest.approx(12.0, abs=0.01)
    assert m.ground_range == pytest.approx(0.0, abs=0.01)
    assert m.valid_fraction == 1.0 and m.n_pixels > 300


def test_steep_slope_is_measured_from_the_downhill_ground_and_flagged():
    """Ground rises 0.3 m per metre: a flat roof 10 m above the centre is taller on the downhill side."""
    fp = box(20, 20, 30, 30)
    transform, dsm, dtm = scene(0.3, 10.0, fp)
    low = measure(dsm, dtm, transform, fp, ground_percentile=10)
    median = measure(dsm, dtm, transform, fp, ground_percentile=50)
    assert median.height == pytest.approx(10.0, abs=0.3)
    assert low.height > median.height + 0.5
    assert low.ground_range > 3.0  # the spread that marks steep terrain


def test_nodata_pixels_are_ignored_and_reduce_the_valid_fraction():
    fp = box(20, 20, 30, 30)
    transform, dsm, dtm = scene(0.0, 8.0, fp)
    _, (_, y) = grid()
    dsm[y < 25] = NODATA  # the southern half of the footprint has no surface data
    m = measure(dsm, dtm, transform, fp)
    assert m.valid_fraction == pytest.approx(0.5, abs=0.02)
    assert m.roof_z == pytest.approx(8.0, abs=0.01)


def test_a_footprint_outside_the_raster_has_no_height():
    transform, dsm, dtm = scene(0.0, 5.0, box(20, 20, 30, 30))
    m = measure(dsm, dtm, transform, box(500, 500, 510, 510))
    assert m.height is None and m.n_pixels == 0


def lidar(height, pixels=400, valid=1.0, ground_range=0.5):
    return LidarMeasure(roof_z=height + 10.0, ground_z=10.0, ground_range=ground_range, n_pixels=pixels, valid_fraction=valid)


def merge(**kw):
    base = {"osm_height": None, "lidar": None, "overture_height": None, "floors": None, "floor_height_m": 3.2, "cfg": CFG}
    return merge_height(**{**base, **kw})


def test_priority_order_follows_design_decision_d7():
    assert merge(osm_height=20, lidar=lidar(21), overture_height=15, floors=4).src == "osm_tag"
    assert merge(lidar=lidar(21), overture_height=15, floors=4).src == "lidar"
    assert merge(overture_height=15, floors=4).src == "overture"
    assert merge(floors=4).src == "floors"
    assert merge().src == "default"


def test_floors_use_the_configured_floor_height():
    assert merge(floors=5).height_m == pytest.approx(16.0)


def test_agreeing_tag_and_lidar_is_high_confidence_and_a_lone_tag_is_medium():
    assert (merge(osm_height=20, lidar=lidar(21)).conf, merge(osm_height=20, lidar=lidar(21)).flag) == ("high", None)
    assert merge(osm_height=20).conf == "medium"


def test_disagreement_is_flagged_and_keeps_the_tag_by_default():
    r = merge(osm_height=10, lidar=lidar(25))
    assert (r.src, r.height_m, r.conf, r.flag) == ("osm_tag", 10, "low", "tag_lidar_disagree")


def test_prefer_lidar_policy_overrides_a_flagged_tag():
    r = merge(osm_height=10, lidar=lidar(25), cfg={**CFG, "on_disagreement": "prefer_lidar"})
    assert (r.src, r.height_m) == ("lidar", 25)


def test_small_differences_are_not_disagreements():
    assert not disagree(10, 12, 3.0, 0.25)  # under 3 m
    assert not disagree(40, 44, 3.0, 0.25)  # over 3 m but under 25%
    assert disagree(10, 20, 3.0, 0.25)


@pytest.mark.parametrize(
    "bad",
    [lidar(1.0), lidar(20, pixels=5), lidar(20, valid=0.5), LidarMeasure(None, None, None, 0, 0.0)],
    ids=["too low", "few pixels", "mostly nodata", "no data"],
)
def test_unreliable_lidar_falls_through_to_the_next_source(bad):
    assert merge(lidar=bad, overture_height=15).src == "overture"


def test_steep_terrain_lowers_lidar_confidence():
    r = merge(lidar=lidar(20, ground_range=5.0))
    assert (r.src, r.conf, r.flag) == ("lidar", "medium", "steep_terrain")


def test_every_result_has_a_positive_height():
    for kw in [{}, {"floors": 0}, {"overture_height": 0}, {"lidar": lidar(0.5)}]:
        assert merge(**kw).height_m > 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("12", 12),
        ("12 m", 12),
        ("12.5m", 12.5),
        ("40 ft", 12.192),
        ("40'", 12.192),
        ("0", None),
        ("-3", None),
        ("tall", None),
        ("12;15", None),
        (None, None),
        ("5000", None),
    ],
)
def test_osm_height_parsing(raw, expected):
    assert parse_height_m(raw) == pytest.approx(expected) if expected else parse_height_m(raw) is None


@pytest.mark.parametrize(("raw", "expected"), [("4", 4), ("2.5", 2.5), ("0", None), ("many", None), (None, None)])
def test_osm_levels_parsing(raw, expected):
    assert parse_levels(raw) == expected
