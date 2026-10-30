import pytest

from pipeline.presence import DAY_TYPES, density_per_1000_m2, expand_profiles, hour_curve, load_profiles, presence

OFFICE = {"night": 0.0, "start": 8.0, "end": 17.0, "ramp": 1.0, "day": {"weekday": 1.0, "saturday": 0.2, "sunday": 0.1}}
LATE = {"night": 0.0, "start": 11.0, "end": 25.0, "ramp": 1.5, "day": {"weekday": 1.0, "saturday": 1.0, "sunday": 0.8}}


def test_curve_has_24_values_and_the_expected_shape():
    curve = hour_curve(OFFICE, "weekday")
    assert len(curve) == 24
    assert curve[3] == 0.0 and curve[22] == 0.0  # night
    assert curve[8] == pytest.approx(0.5) and curve[9] == 1.0  # ramp: mid-point of hour 8 is half way up
    assert curve[12] == 1.0 and curve[16] == 1.0  # plateau
    assert curve[17] == pytest.approx(0.5) and curve[18] == 0.0  # ramp down


def test_weekend_scales_the_day_level():
    assert max(hour_curve(OFFICE, "saturday")) == pytest.approx(0.2)
    assert max(hour_curve(OFFICE, "sunday")) == pytest.approx(0.1)


def test_curve_can_run_past_midnight():
    curve = hour_curve(LATE, "weekday")
    assert curve[0] == 1.0 and curve[1] == pytest.approx(2 / 3, abs=1e-4)  # still open after midnight, emptying
    assert curve[2] == 0.0 and curve[5] == 0.0 and curve[14] == 1.0


def test_a_curve_that_starts_by_ramping_from_a_high_night_level_dips():
    curve = hour_curve(
        {"night": 1.0, "start": 8.0, "end": 17.0, "ramp": 1.5, "day": {"weekday": 0.4, "saturday": 0.8, "sunday": 0.9}}, "weekday"
    )
    assert curve[2] == 1.0 and curve[12] == pytest.approx(0.4)


def test_bad_shapes_are_rejected():
    with pytest.raises(AssertionError):
        hour_curve({**OFFICE, "ramp": 0}, "weekday")


def test_configured_profiles_cover_every_class_and_day_in_range():
    profiles = load_profiles()
    assert profiles["status"] == "placeholder"
    for day in DAY_TYPES:
        assert all(0.0 <= v <= 1.0 for v in profiles["residents"][day]) and len(profiles["residents"][day]) == 24
    assert set(profiles["workers"]) == {
        "residential",
        "retail",
        "office",
        "hospitality",
        "education",
        "civic",
        "industrial",
        "mixed",
        "unknown",
    }
    for curves in profiles["workers"].values():
        assert all(0.0 <= v <= 1.0 and len(curves[d]) == 24 for d in DAY_TYPES for v in curves[d])


def test_night_is_residents_and_office_hours_are_workers():
    profiles = load_profiles()
    assert presence(100, 50, "office", 3, "weekday", profiles) == pytest.approx(100.0)  # everyone home, no workers
    midday = presence(100, 50, "office", 12, "weekday", profiles)
    assert midday == pytest.approx(100 * 0.45 + 50)


def test_festival_scales_workers_only():
    profiles = load_profiles()
    base = presence(100, 50, "office", 12, "weekday", profiles)
    festival = presence(100, 50, "office", 12, "weekday", profiles, festival=1.5)
    assert festival - base == pytest.approx(25.0)
    assert presence(100, 0, "residential", 3, "weekday", profiles, 1.5) == pytest.approx(100.0)


def test_unlisted_class_uses_the_unknown_curve():
    profiles = load_profiles()
    assert presence(0, 10, "castle", 12, "weekday", profiles) == presence(0, 10, "unknown", 12, "weekday", profiles)


def test_density_is_per_1000_m2_and_guards_zero_area():
    assert density_per_1000_m2(30, 1500) == pytest.approx(20.0)
    assert density_per_1000_m2(1, 0) == pytest.approx(1000.0)


def test_expand_profiles_requires_the_three_day_types():
    with pytest.raises(AssertionError):
        expand_profiles({"status": "placeholder", "day_types": ["weekday"]})
