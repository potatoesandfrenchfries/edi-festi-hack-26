import itertools

import numpy as np
import pytest
import shapely
from rasterio.transform import Affine
from shapely.geometry import box

from pipeline.landmarks import Landmark, build_landmark, ground_at, load_landmarks, match_footprint

PX = 0.5
KW = {"body_percentile": 75, "steps": 4, "margin_m": 3.0, "min_part_m2": 1.0, "simplify_m": 0.2}


def scene(ground=100.0):
    """A 60 m square of flat ground at `ground`. A 20 m square body is 10 m tall with a 4 m square tower rising to 40 m."""
    n = int(60 / PX)
    transform = Affine(PX, 0, 0, 0, -PX, 60)
    x, y = np.meshgrid((np.arange(n) + 0.5) * PX, 60 - (np.arange(n) + 0.5) * PX)
    dsm = np.full((n, n), ground, dtype="float32")
    dsm[(x >= 20) & (x <= 40) & (y >= 20) & (y <= 40)] = ground + 10
    dsm[(x >= 28) & (x <= 32) & (y >= 28) & (y <= 32)] = ground + 40
    return dsm, transform


def landmark(**over):
    base = {
        "name": "t",
        "lon": 0,
        "lat": 0,
        "tip_height_m": None,
        "body_height_m": None,
        "ground_lon": None,
        "ground_lat": None,
        "source": "",
    }
    return Landmark(**{**base, **over})


FOOT = box(20, 20, 40, 40)


def test_body_is_the_body_and_the_tower_becomes_nested_parts():
    dsm, transform = scene()
    built = build_landmark(dsm, transform, FOOT, 100.0, landmark(), **KW)
    assert built.body_height_m == pytest.approx(10.0, abs=0.5)
    assert built.tip_height_m == pytest.approx(40.0, abs=0.1)  # no published tip, so the LiDAR peak
    assert built.parts and built.parts[-1].height_m == pytest.approx(40.0, abs=0.1)
    heights = [p.height_m for p in sorted(built.parts, key=lambda p: p.level)]
    assert heights == sorted(heights)  # taller parts at higher levels


def test_parts_stay_inside_the_footprint_and_inside_each_other():
    dsm, transform = scene()
    built = build_landmark(dsm, transform, FOOT, 100.0, landmark(), **KW)
    assert all(FOOT.buffer(1e-6).contains(p.polygon) for p in built.parts)
    by_level = {p.level: p.polygon for p in built.parts}
    levels = sorted(by_level)
    for lower, upper in itertools.pairwise(levels):
        assert by_level[lower].buffer(0.6).contains(by_level[upper])


def test_a_published_tip_overrides_the_lidar_peak():
    dsm, transform = scene()
    built = build_landmark(dsm, transform, FOOT, 100.0, landmark(tip_height_m=30.0), **KW)
    assert built.tip_height_m == 30.0 and max(p.height_m for p in built.parts) == 30.0


def test_a_given_body_height_is_used():
    dsm, transform = scene()
    assert build_landmark(dsm, transform, FOOT, 100.0, landmark(body_height_m=12.0), **KW).body_height_m == 12.0


def test_ground_level_shifts_every_height():
    dsm, transform = scene()
    low = build_landmark(dsm, transform, FOOT, 100.0, landmark(), **KW)
    high = build_landmark(dsm, transform, FOOT, 90.0, landmark(), **KW)  # lower ground, so everything is taller
    assert high.body_height_m == pytest.approx(low.body_height_m + 10, abs=0.1)


def test_a_flat_building_has_no_parts():
    dsm, transform = scene()
    dsm[:] = 110.0
    assert build_landmark(dsm, transform, FOOT, 100.0, landmark(), **KW).parts == []


def test_no_surface_data_returns_none():
    dsm, transform = scene()
    assert build_landmark(dsm, transform, box(500, 500, 510, 510), 100.0, landmark(), **KW) is None


def test_ground_at_reads_the_dtm_at_a_street_point():
    dsm, transform = scene(ground=77.0)
    assert ground_at(dsm, transform, 5.0, 5.0) == pytest.approx(77.0)
    assert ground_at(dsm, transform, 500.0, 500.0) is None


def test_match_prefers_the_larger_footprint():
    geoms = [box(0, 0, 2, 2), box(2.5, 0, 12.5, 10)]
    assert match_footprint(shapely.Point(1, 1), geoms, shapely.STRtree(geoms)) == 1


def test_the_landmark_file_loads_with_blank_cells_as_none():
    lms = load_landmarks("config/landmarks.csv")
    assert len(lms) >= 10
    by_name = {lm.name: lm for lm in lms}
    assert by_name["The Hub"].tip_height_m == 74.0 and by_name["The Hub"].ground_lon is None
    assert by_name["Balmoral Hotel"].ground_lon is not None
    assert by_name["St Giles' Cathedral"].tip_height_m is None
