"""Festival demand: how many people are at each venue, by date and 15-minute slot, and where they come from.

Pure functions, no file or database access (stage10_demand.py does that). Inputs are ticket counts grouped by venue and show start,
so no individual is ever handled here. All timing and origin rules are assumptions in config/demand.yaml.
"""

import re
from collections import defaultdict
from datetime import date, datetime

import yaml

from pipeline.common import ROOT

CONFIG = ROOT / "config" / "demand.yaml"
MINUTES_PER_DAY = 1440


def load_config(path=CONFIG):
    return yaml.safe_load(path.read_text())


def postcode_area(value):
    """The leading letters of a postcode ("EH1 3EP" -> "EH", "g12" -> "G"), or None if the text does not start with letters."""
    match = re.match(r"^\s*([A-Za-z]{1,2})", str(value or ""))
    return match.group(1).upper() if match else None


def origin_class(area, country, cfg):
    """ "local", "daytrip" or "stay" for one booker, or None if neither postcode nor country says. A booker abroad stays."""
    abroad = (country or "").strip().lower() not in (
        "",
        "united kingdom",
        "uk",
        "scotland",
        "england",
        "wales",
        "northern ireland",
    )
    if abroad:
        return "stay"
    if not area:
        return None
    origin = cfg["origin"]
    if area in origin["local_areas"]:
        return "local"
    return "daytrip" if area in origin["daytrip_areas"] else "stay"


def sector_of(area, cfg):
    """Compass sector ("north", "west", "south") of a postcode area outside Edinburgh, or None."""
    for sector, areas in cfg["sectors"].items():
        if area in areas:
            return sector
    return None


def assign_hubs(venue_tickets, hubs):
    """Maps each venue id to a hub key. Largest venues first, each to the hub furthest below its weighted share, so shares track weights."""
    total = sum(venue_tickets.values())
    assigned = dict.fromkeys((h["key"] for h in hubs), 0)
    out = {}
    for venue, tickets in sorted(venue_tickets.items(), key=lambda kv: (-kv[1], str(kv[0]))):
        hub = max(hubs, key=lambda h: (h["weight"] * total - assigned[h["key"]], h["key"]))
        assigned[hub["key"]] += tickets
        out[venue] = hub["key"]
    return out


def spread(series, t0, t1, count, slot):
    """Adds `count` people evenly over minutes [t0, t1) to the slot series. Minutes are from midnight of the first day."""
    if t1 <= t0 or count <= 0:
        return
    for k in range(max(int(t0 // slot), 0), min(int((t1 - 1e-9) // slot), len(series) - 1) + 1):
        lo, hi = max(t0, k * slot), min(t1, (k + 1) * slot)
        if hi > lo:
            series[k] += count * (hi - lo) / (t1 - t0)


def build_series(performances, timing, first_day, days, slot):
    """Per venue key: arrivals, departures and people present for every slot of `days` days from `first_day`.

    `performances` yields (venue key, start datetime, duration in minutes, people). Arrivals are spread over `arrive_before_min` before the
    start and departures over `leave_after_min` after the end. People present is the running balance, averaged within each slot.
    """
    n = days * MINUTES_PER_DAY // slot
    arrivals, departures = defaultdict(lambda: [0.0] * n), defaultdict(lambda: [0.0] * n)
    for venue, start, duration, people in performances:
        t = (start.date() - first_day).days * MINUTES_PER_DAY + start.hour * 60 + start.minute
        spread(arrivals[venue], t - timing["arrive_before_min"], t, people, slot)
        end = t + duration
        spread(departures[venue], end, end + timing["leave_after_min"], people, slot)
    out = {}
    for venue, arrived in arrivals.items():
        left, present, inside = departures[venue], [], 0.0
        for a, d in zip(arrived, left, strict=True):
            present.append(max(inside + (a - d) / 2, 0.0))
            inside += a - d
        out[venue] = {"arrivals": arrived, "departures": left, "present": present}
    return out


def pack(series, first_day, slot, min_cell):
    """Series -> {"YYYY-MM-DD": {"a": [...], "d": [...], "p": [...]}} with whole numbers, cells under `min_cell` dropped, empty days omitted."""
    per_day = MINUTES_PER_DAY // slot
    out = {}
    for k in range(len(series["present"]) // per_day):
        cut = slice(k * per_day, (k + 1) * per_day)
        day = {
            key: [round(v) if v >= min_cell else 0 for v in series[name][cut]]
            for key, name in (("a", "arrivals"), ("d", "departures"), ("p", "present"))
        }
        if any(day["a"]) or any(day["p"]):
            out[date.fromordinal(first_day.toordinal() + k).isoformat()] = day
    return out


def shares(counts):
    """{"local": n, "daytrip": n, "stay": n} -> shares of the known total (None, the unknown, is left out)."""
    known = {k: counts.get(k, 0) for k in ("local", "daytrip", "stay")}
    total = sum(known.values())
    return {k: round(v / total, 4) for k, v in known.items()} if total else dict.fromkeys(known, 0.0)


def staying_people(tickets_by_date, stay_share, cfg):
    """People who need a bed that night, by date: tickets that day, times the share that stay, over tickets per person per day."""
    per_person = cfg["origin"]["shows_per_person_per_day"]
    return {d: round(n * stay_share / per_person) for d, n in sorted(tickets_by_date.items())}


def parse_eif_start(text):
    """EIF writes "07/08/2026 14:00"."""
    return datetime.strptime(text.strip(), "%d/%m/%Y %H:%M")


def parse_tattoo_start(text):
    """The Tattoo extract writes "8/7/26 21:30" (month first)."""
    return datetime.strptime(text.strip(), "%m/%d/%y %H:%M")
