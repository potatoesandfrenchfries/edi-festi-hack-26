"""Tests for the festival closures dataset; no network (the Overpass call is not exercised)."""
from datetime import date

from closures import build, geometry, schedule


def test_expand_respects_day_pattern():
    weekday = next(r for r in schedule.R if r["location"] == "high_street" and r["days"] == schedule.WEEKDAYS)
    days = schedule.expand(weekday)
    assert days[0] == date(2026, 8, 7) and days[-1] == date(2026, 8, 28)
    assert all(d.weekday() < 5 for d in days)
    weekend = next(r for r in schedule.R if r["location"] == "high_street" and r["days"] == schedule.WEEKEND)
    assert {d.weekday() for d in schedule.expand(weekend)} == {5, 6}


def test_expand_uses_explicit_dates():
    concerts = next(r for r in schedule.R if r["festival"] == "Castle Concerts")
    assert schedule.expand(concerts)[0] == date(2026, 7, 10)
    assert len(schedule.expand(concerts)) == 7


def test_withdrawn_george_street_has_no_dates():
    r = next(r for r in schedule.R if r["location"] == "george_street_hanover_frederick")
    assert r["status"] == "withdrawn" and not r["bans_vehicles"] and schedule.expand(r) == []


def test_every_restriction_has_a_location():
    assert {r["location"] for r in schedule.R} <= set(geometry.LOCATIONS)


def test_restriction_ids_are_unique():
    ids = [r["restriction_id"] for r in build.restriction_rows()]
    assert len(ids) == len(set(ids))


def test_tail_returns_last_n_metres():
    # ~111 m per 0.001 degree of latitude; a 3-point north-south line of ~222 m
    line = [(55.000, -3.0), (55.001, -3.0), (55.002, -3.0)]
    out = geometry.tail(line, 50)
    assert out[-1] == line[-1]
    assert abs(geometry.metres(out[0], out[-1]) - 50) < 1


def test_clip_at_keeps_line_up_to_nearest_vertex():
    line = [(55.0, -3.0), (55.001, -3.0), (55.002, -3.0)]
    assert geometry.clip_at(line, (55.00101, -3.0)) == line[:2]


def test_chain_reverses_backwards_ways():
    a = [(0.0, 0.0), (0.0, 0.001)]
    b = [(0.0, 0.002), (0.0, 0.001)]  # stored end-first
    assert geometry.chain([a, b]) == [(0.0, 0.0), (0.0, 0.001), (0.0, 0.002)]
