"""Tests for the Lothian bus pipeline helpers; synthetic data only, no download."""
from datetime import date

import numpy as np

from lothian import build as b


def line_shape(n=11, step_m=100.0):
    """A straight east-west polyline of n points, step_m apart, in local metres."""
    xy = np.column_stack((np.arange(n) * step_m, np.zeros(n)))
    return xy, b.polyline_cum(xy)


def test_parse_time_allows_hours_past_midnight():
    assert b.parse_time("08:05:30") == 8 * 3600 + 5 * 60 + 30
    assert b.parse_time("25:10:00") == 25 * 3600 + 600


def test_project_stops_is_monotonic_and_close_to_truth():
    xy, cum = line_shape()
    stops = np.array([[0, 10], [250, -15], [600, 5], [1000, 0]], dtype=float)
    assert b.project_stops(xy, cum, stops) == [0, 250, 600, 1000]


def test_project_stops_picks_the_right_pass_of_an_out_and_back_route():
    # Out along y=0 then back along y=30. Stops C and D sit at the same x as A and B but on the return
    # side, so they must snap to the second pass.
    out = np.column_stack((np.arange(0, 1001, 100.0), np.zeros(11)))
    back = np.column_stack((np.arange(1000, -1, -100.0), np.full(11, 30.0)))
    xy = np.vstack((out, back))
    cum = b.polyline_cum(xy)
    stops = np.array([[100, 0], [900, 0], [800, 30], [100, 30]], dtype=float)
    a, bb, c, d = b.project_stops(xy, cum, stops)
    assert (a, bb) == (100, 900)
    assert c > 1000 and d > c  # on the way back, not the same spots on the way out
    assert abs(c - 1230) < 40 and abs(d - 1930) < 40


def test_spread_equal_times_removes_teleporting():
    # Four stops all timetabled for the same minute, then one a minute later.
    arr = dep = [0, 0, 0, 0, 60]
    dist = [0, 100, 200, 300, 400]
    a, d = b.spread_equal_times(arr, dep, dist)
    assert a[0] == 0
    assert a == d
    assert a == sorted(a)
    assert a[1] < a[2] < a[3] < a[4]
    assert a[4] == 60
    # evenly spread by distance
    assert abs(a[2] - 30) < 1e-9


def test_spread_equal_times_leaves_distinct_times_alone():
    a, d = b.spread_equal_times([0, 60, 120], [10, 60, 120], [0, 100, 200])
    assert a == [0, 60, 120] and d == [10, 60, 120]


def test_median_gap_and_headway():
    assert b.median_gap([0, 600, 1200, 1800]) == 600
    assert b.median_gap([100]) is None
    assert b.median_gap([0, 0, 600]) == 600  # duplicate departures are not a zero gap
    day = [8 * 3600 + i * 900 for i in range(10)]
    assert b.headway(day + [3 * 3600]) == 900  # night trip outside the window is ignored
    night = [1 * 3600, 2 * 3600, 3 * 3600]  # no daytime trips: use the whole day
    assert b.headway(night) == 3600


def test_typical_day_is_a_tuesday_a_week_into_the_feed():
    d = b.typical_day("20261022")
    assert d.weekday() == 1 and date(2026, 10, 29) <= d <= date(2026, 11, 4)


def test_service_runs_handles_weekday_range_and_exceptions():
    cal = {"monday": "1", "tuesday": "1", "wednesday": "1", "thursday": "1", "friday": "1",
           "saturday": "0", "sunday": "0", "start_date": "20261001", "end_date": "20261231"}
    tue = date(2026, 11, 3)
    assert b.service_runs(cal, [], [], tue)
    assert not b.service_runs(cal, [], [20261103], tue)  # removed
    assert b.service_runs(cal, [20261107], [], date(2026, 11, 7))  # added Saturday
    assert not b.service_runs(cal, [], [], date(2027, 2, 2))  # out of range
    assert not b.service_runs(None, [], [], tue)


def test_encode_shape_round_trips_and_drops_repeats():
    pts = [(0, -3.19, 55.95), (1, -3.19, 55.95), (2, -3.18, 55.96)]
    flat, lonlat = b.encode_shape(pts)
    assert len(lonlat) == 2
    x = y = 0
    for i in range(0, len(flat), 2):
        x += flat[i]
        y += flat[i + 1]
    assert (x, y) == (-318000, 5596000)


def test_no_service_message_names_the_day_and_the_feed_window():
    feed = {"feed_start_date": "20261022", "feed_end_date": "20271207"}
    text = b.no_service_message(date(2027, 8, 14), feed)
    assert "2027-08-14" in text and "Saturday" in text
    assert "20261022" in text and "20271207" in text
