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


# --- closures.web: the Fringe typical-day export for the map ---------------------------------------------------------
from closures import web  # noqa: E402


def day_row(day, rid="R1", loc="high_street", frm="10:30", to="24:00", bans="True", status="in_force"):
    return {"date": day, "restriction_id": rid, "location_id": loc, "festival": "Fringe/summer festivals",
            "restriction_type": "closed_to_vehicles", "bans_vehicles": bans, "status": status, "time_from": frm, "time_to": to}


def test_seconds_reads_clock_times_and_midnight():
    assert web.seconds("10:30") == 37800
    assert web.seconds("24:00") == 86400
    assert web.seconds("00:00") == 0


def test_windows_keep_only_real_bans_on_that_day():
    rows = [day_row("2026-08-15"), day_row("2026-08-16", rid="R2"),
            day_row("2026-08-15", rid="R3", bans="False"), day_row("2026-08-15", rid="R4", status="withdrawn")]
    got = web.windows_on(rows, date(2026, 8, 15))
    assert [w["restriction_id"] for w in got] == ["R1"]
    assert (got[0]["from"], got[0]["to"]) == (37800, 86400)


def test_overnight_window_splits_across_two_dates():
    rows = [day_row("2026-08-14", rid="C", loc="cowgate_candlemaker_blackfriars", frm="15:00", to="05:00")]
    evening = web.windows_on(rows, date(2026, 8, 14))
    morning = web.windows_on(rows, date(2026, 8, 15))
    assert [(w["from"], w["to"]) for w in evening] == [(15 * 3600, 86400)]
    assert [(w["from"], w["to"]) for w in morning] == [(0, 5 * 3600)]
    assert web.windows_on(rows, date(2026, 8, 13)) == []


def test_build_uses_one_fringe_date_per_day_type_and_drops_what_has_no_street():
    rows = [day_row("2026-08-11", loc="high_street"), day_row("2026-08-11", rid="J", loc="east_adam_street_pleasance")]
    places = {"high_street": {"name": "High Street", "ways": [1, 2], "confidence": "medium"},
              "east_adam_street_pleasance": {"name": "Junction", "point": (55.9, -3.1)}}
    out = web.build(rows, places, {"weekday": date(2026, 8, 11)})
    day = out["days"]["weekday"]
    assert day["date"] == "2026-08-11"
    assert [c["location"] for c in day["closures"]] == ["high_street"]
    assert day["closures"][0]["ways"] == [1, 2]
    assert [u["location"] for u in day["unmapped"]] == ["east_adam_street_pleasance"]


def test_fringe_days_are_the_right_weekdays_inside_the_fringe():
    assert web.FRINGE_DAYS["weekday"].weekday() < 5
    assert web.FRINGE_DAYS["saturday"].weekday() == 5
    assert web.FRINGE_DAYS["sunday"].weekday() == 6
    assert all(date(2026, 8, 7) <= d <= date(2026, 8, 30) for d in web.FRINGE_DAYS.values())


def test_real_schedule_closes_the_old_town_on_a_fringe_saturday():
    out = web.build(web.read_days())
    names = {c["location"] for c in out["days"]["saturday"]["closures"]}
    assert {"high_street", "parliament_square", "johnston_terrace", "lawnmarket"} <= names
    assert "george_street_hanover_frederick" not in names  # withdrawn after the Princes Street fire
    high = [c for c in out["days"]["saturday"]["closures"] if c["location"] == "high_street"]
    assert [(c["from"], c["to"]) for c in high] == [(10 * 3600 + 1800, 21 * 3600)]  # weekend: 10:30 to 21:00
