"""Turn the Scotland GTFS feed into one compact JSON file of Lothian bus services for the web simulator.

    uv run python -m lothian.build            # downloads the feed on first run (cached in lothian/data/raw/)
    uv run python -m lothian.build --force    # re-download
    uv run python -m lothian.build --date 2027-08-14   # a chosen day (a Fringe Saturday) instead of the typical Tuesday

Output: lothian/web/data/lothian.json (git-ignored; reproducible).

The simulator does not follow the timetable clock. For every route it keeps one representative trip per
direction (the most common pattern on a typical weekday: the shape, the ordered stops with each stop's
distance along the shape in metres, and arrival/departure seconds relative to the start) and a regular
headway (the median gap between departures on that day). The browser then loops buses around that
route forever, spaced evenly.
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from lothian.fetch import fetch

# Lothian Buses, Lothian Country Buses, East Coast Buses (trams, route_type 0, are excluded below).
AGENCIES = {"OP596": "LOTH", "OP597": "NELB", "OP598": "ECBU"}
OUT = Path(__file__).parent / "web" / "data" / "lothian.json"

# The client uses the same constants, so distances along a shape agree on both sides.
LAT_REF = 55.95
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * float(np.cos(np.radians(LAT_REF)))
SNAP_RADIUS_M = 60.0     # a stop may only snap to shape segments this close ...
BACKWARD_TOLERANCE_M = 30.0  # ... and may sit this far behind the previous stop (rounding, loops)
DETOUR_FACTOR, DETOUR_SLACK_M, DETOUR_PENALTY = 2.0, 200.0, 0.05  # cost per metre beyond that allowance
COORD_SCALE = 100_000   # shapes are stored as integers of 1e-5 degrees (about 1 m)


def parse_time(text: str) -> int:
    """GTFS HH:MM:SS to seconds; hours may exceed 23 for trips running past midnight."""
    h, m, s = text.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def to_xy(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    return np.column_stack((lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT))


def polyline_cum(xy: np.ndarray) -> np.ndarray:
    seg = np.hypot(*np.diff(xy, axis=0).T) if len(xy) > 1 else np.zeros(0)
    return np.concatenate(([0.0], np.cumsum(seg)))


def _candidates(point: np.ndarray, xy: np.ndarray, cum: np.ndarray) -> list[tuple[float, float]]:
    """(distance along shape, offset from shape) at every local minimum within SNAP_RADIUS_M."""
    a, b = xy[:-1], xy[1:]
    ab = b - a
    len2 = np.maximum((ab ** 2).sum(axis=1), 1e-9)
    t = np.clip(((point - a) * ab).sum(axis=1) / len2, 0.0, 1.0)
    foot = a + ab * t[:, None]
    off = np.hypot(*(foot - point).T)
    along = cum[:-1] + t * np.sqrt(len2)
    near = off <= SNAP_RADIUS_M
    out = []
    for i in np.flatnonzero(near):
        left = off[i - 1] if i > 0 else np.inf
        right = off[i + 1] if i + 1 < len(off) else np.inf
        if off[i] <= left and off[i] <= right:
            out.append((float(along[i]), float(off[i])))
    if not out:
        i = int(np.argmin(off))
        out.append((float(along[i]), float(off[i])))
    return out


def project_stops(xy: np.ndarray, cum: np.ndarray, stops: np.ndarray) -> list[int]:
    """Distance in metres along the polyline for each stop, non-decreasing.

    A stop can be near several parts of a looping route, so candidates are chosen jointly: a dynamic
    programme minimises total offset subject to the stops being visited in order.
    """
    if len(xy) < 2:
        return [0] * len(stops)
    cands = [_candidates(p, xy, cum) for p in stops]
    cost = [[c[1] for c in cands[0]]]
    back: list[list[int]] = [[-1] * len(cands[0])]
    for j in range(1, len(cands)):
        row, brow = [], []
        straight = float(np.hypot(*(stops[j] - stops[j - 1])))
        for dist, off in cands[j]:
            best, arg = np.inf, -1
            for k, (pd, _) in enumerate(cands[j - 1]):
                if dist + BACKWARD_TOLERANCE_M < pd:
                    continue
                # A road leg is rarely much longer than the straight line; penalise skipping ahead
                # to a later pass of the shape (loops, out-and-back routes).
                excess = max(0.0, (dist - pd) - DETOUR_FACTOR * straight - DETOUR_SLACK_M)
                total = cost[j - 1][k] + DETOUR_PENALTY * excess
                if total < best:
                    best, arg = total, k
            if arg < 0:  # nothing earlier fits: fall back to the cheapest predecessor
                arg = int(np.argmin(cost[j - 1]))
                best = cost[j - 1][arg]
            row.append(best + off)
            brow.append(arg)
        cost.append(row)
        back.append(brow)
    k = int(np.argmin(cost[-1]))
    picked = []
    for j in range(len(cands) - 1, -1, -1):
        picked.append(cands[j][k][0])
        k = back[j][k]
    picked.reverse()
    return [int(round(d)) for d in np.maximum.accumulate(picked)]


def spread_equal_times(arr: list[int], dep: list[int], dist: list[int]) -> tuple[list[float], list[float]]:
    """Timetable times are whole minutes, so neighbouring stops often share one time and a bus would
    jump between them. For each run of stops with the same arrival time, keep the first as an anchor
    and place the rest by distance between that anchor's departure and the next anchor's arrival.
    The last run is left as is (nothing to spread towards)."""
    n = len(arr)
    arr_out, dep_out = [float(a) for a in arr], [float(d) for d in dep]
    i = 0
    while i < n:
        j = i + 1
        while j < n and arr[j] == arr[i]:
            j += 1
        span = dist[j] - dist[i] if j < n else 0
        if j - i > 1 and j < n and span > 0:
            for k in range(i + 1, j):
                t = dep[i] + (arr[j] - dep[i]) * (dist[k] - dist[i]) / span
                arr_out[k] = dep_out[k] = t
        i = j
    return arr_out, dep_out


def read_lothian(gtfs: Path):
    with open(gtfs / "routes.txt", newline="", encoding="utf-8") as fh:
        routes = {r["route_id"]: r for r in csv.DictReader(fh)
                  if r["agency_id"] in AGENCIES and r["route_type"] == "3"}
    with open(gtfs / "trips.txt", newline="", encoding="utf-8") as fh:
        trips = {t["trip_id"]: t for t in csv.DictReader(fh) if t["route_id"] in routes}
    return routes, trips


def read_stop_times(path: Path, trip_ids: set[str]) -> dict[str, list[tuple[int, int, int, str]]]:
    """Stream the (~700 MB) stop_times file; the first five columns never contain quoted commas."""
    out: dict[str, list] = defaultdict(list)
    with open(path, encoding="utf-8") as fh:
        next(fh)
        for line in fh:
            trip, arr, dep, stop, seq = line.split(",", 5)[:5]
            if trip in trip_ids:
                out[trip].append((int(seq), parse_time(arr or dep), parse_time(dep or arr), stop))
    for rows in out.values():
        rows.sort()
    return out


def read_shapes(path: Path, shape_ids: set[str]) -> dict[str, list[tuple[int, float, float]]]:
    out: dict[str, list] = defaultdict(list)
    with open(path, encoding="utf-8") as fh:
        next(fh)
        for line in fh:
            sid, lat, lon, seq = line.split(",", 4)[:4]
            if sid in shape_ids:
                out[sid].append((int(seq), float(lon), float(lat)))
    for pts in out.values():
        pts.sort()
    return out


def encode_shape(pts: list[tuple[int, float, float]]) -> tuple[list[int], np.ndarray]:
    """Quantise to 1e-5 degrees, drop repeated points, delta-encode. Returns (encoded, lon/lat array)."""
    q = []
    for _, lon, lat in pts:
        p = (round(lon * COORD_SCALE), round(lat * COORD_SCALE))
        if not q or p != q[-1]:
            q.append(p)
    flat = [q[0][0], q[0][1]]
    for (x0, y0), (x1, y1) in zip(q, q[1:]):
        flat += [x1 - x0, y1 - y0]
    return flat, np.array(q, dtype=float) / COORD_SCALE


TYPICAL_WEEKDAY = 1                      # Tuesday
DAYTIME = (7 * 3600, 19 * 3600)          # departures in this window set the headway
LAYOVER_S = 120                          # pause at each terminus before turning round
HEADWAY_MIN_S, HEADWAY_MAX_S, HEADWAY_DEFAULT_S = 180, 3600, 1800


def typical_day(feed_start: str) -> date:
    """A Tuesday a week into the feed: ordinary term-time service, clear of the feed's first-day quirks."""
    d = datetime.strptime(feed_start, "%Y%m%d").date() + timedelta(days=7)
    return d + timedelta(days=(TYPICAL_WEEKDAY - d.weekday()) % 7)


def no_service_message(day: date, feed: dict) -> str:
    """Why a chosen day cannot be built. The feed is a rolling window, so a past Fringe is gone and a future one may not be filed yet."""
    return (f"the feed has no Lothian bus service on {day} ({day:%A}). It is dated {feed['feed_start_date']} to {feed['feed_end_date']}, "
            "but operators file timetables only a few months ahead, so its services can stop earlier. Pick a day inside the feed, "
            "or rebuild with a feed archived for that date (see lothian/README.md, 'A Fringe day').")


def service_runs(cal: dict | None, adds: list[int], removes: list[int], d: date) -> bool:
    di = int(d.strftime("%Y%m%d"))
    if di in removes:
        return False
    if di in adds:
        return True
    names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    return bool(cal) and int(cal["start_date"]) <= di <= int(cal["end_date"]) and cal[names[d.weekday()]] == "1"


def median_gap(starts: list[int]) -> int | None:
    """Median positive gap in seconds between consecutive departures, or None with fewer than two."""
    s = sorted(set(starts))
    gaps = sorted(b - a for a, b in zip(s, s[1:]))
    return gaps[len(gaps) // 2] if gaps else None


def headway(starts: list[int]) -> int | None:
    """Daytime headway if there are enough daytime departures, otherwise from the whole day (night routes)."""
    day = [s for s in starts if DAYTIME[0] <= s < DAYTIME[1]]
    return median_gap(day) if len(day) >= 3 else median_gap(starts)


def build(force: bool = False, chosen_day: date | None = None) -> dict:
    gtfs = fetch(force)
    routes, trips = read_lothian(gtfs)
    print(f"{len(routes)} routes, {len(trips)} trips", file=sys.stderr)

    with open(gtfs / "feed_info.txt", newline="", encoding="utf-8") as fh:
        feed = next(csv.DictReader(fh))
    day = chosen_day or typical_day(feed["feed_start_date"])
    services = {t["service_id"] for t in trips.values()}
    with open(gtfs / "calendar.txt", newline="", encoding="utf-8") as fh:
        cal = {c["service_id"]: c for c in csv.DictReader(fh) if c["service_id"] in services}
    adds: dict[str, list[int]] = defaultdict(list)
    removes: dict[str, list[int]] = defaultdict(list)
    with open(gtfs / "calendar_dates.txt", newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["service_id"] in services:
                (adds if r["exception_type"] == "1" else removes)[r["service_id"]].append(int(r["date"]))
    runs = {s: service_runs(cal.get(s), adds[s], removes[s], day) for s in services}
    if chosen_day and not any(runs.values()):
        raise SystemExit(no_service_message(day, feed))

    # Only trips of the typical day matter; a route that does not run that day falls back to all its trips.
    by_route: dict[str, list[str]] = defaultdict(list)
    for tid, t in trips.items():
        by_route[t["route_id"]].append(tid)
    chosen: dict[str, list[str]] = {}
    for rid, tids in by_route.items():
        on_day = [t for t in tids if runs[trips[t]["service_id"]]]
        if on_day or not chosen_day:  # for a chosen day, a route that does not run that day is left out
            chosen[rid] = on_day or tids
    wanted = {t for tids in chosen.values() for t in tids}
    print(f"typical day {day} ({day:%A}): {len(wanted)} of {len(trips)} trips considered", file=sys.stderr)

    stop_times = read_stop_times(gtfs / "stop_times.txt", wanted)
    shapes_raw = read_shapes(gtfs / "shapes.txt", {trips[t]["shape_id"] for t in wanted if trips[t]["shape_id"]})
    used_stops = {r[3] for t in wanted for r in stop_times.get(t, [])}
    with open(gtfs / "stops.txt", newline="", encoding="utf-8") as fh:
        stop_rows = {s["stop_id"]: s for s in csv.DictReader(fh) if s["stop_id"] in used_stops}

    shape_enc: dict[str, list[int]] = {}
    shape_xy: dict[str, np.ndarray] = {}
    shape_cum: dict[str, np.ndarray] = {}
    for sid, pts in shapes_raw.items():
        flat, lonlat = encode_shape(pts)
        shape_enc[sid] = flat
        shape_xy[sid] = to_xy(lonlat[:, 0], lonlat[:, 1])
        shape_cum[sid] = polyline_cum(shape_xy[sid])
    stop_xy = {s: to_xy(np.array([float(r["stop_lon"])]), np.array([float(r["stop_lat"])]))[0]
               for s, r in stop_rows.items()}

    out_routes = []
    legs_by_route: dict[str, list] = {}
    for rid in sorted((r for r in routes if r in chosen), key=lambda r: (routes[r]["route_short_name"].rjust(4), r)):
        by_dir: dict[str, list[str]] = defaultdict(list)
        for tid in chosen[rid]:
            rows = stop_times.get(tid, [])
            sid = trips[tid]["shape_id"]
            if len(rows) >= 2 and sid in shape_enc:
                by_dir[trips[tid]["direction_id"]].append(tid)
        legs, gaps = [], []
        for direction in sorted(by_dir):
            tids = by_dir[direction]
            candidates: Counter = Counter()
            first_of: dict[tuple, str] = {}
            for tid in tids:
                rows = stop_times[tid]
                # Same shape + same stops + same running times = the same service pattern.
                key = (trips[tid]["shape_id"], tuple(r[3] for r in rows), tuple(r[1] - rows[0][2] for r in rows))
                candidates[key] += 1
                first_of.setdefault(key, tid)
            tid = first_of[candidates.most_common(1)[0][0]]
            rows, sid = stop_times[tid], trips[tid]["shape_id"]
            dists = project_stops(shape_xy[sid], shape_cum[sid], np.array([stop_xy[r[3]] for r in rows]))
            arr, dep = spread_equal_times([r[1] for r in rows], [r[2] for r in rows], dists)
            t0 = rows[0][2]
            legs.append({
                "shape": sid, "stops": [r[3] for r in rows], "dists": dists,
                "times": [round(v - t0) for a, d in zip(arr, dep) for v in (a, d)],
                "headsign": trips[tid]["trip_headsign"],
            })
            g = headway([stop_times[t][0][2] for t in tids])
            if g:
                gaps.append(g)
        if not legs:
            continue
        gap = sum(gaps) / len(gaps) if gaps else HEADWAY_DEFAULT_S
        legs_by_route[rid] = legs
        out_routes.append({"id": rid, "name": routes[rid]["route_short_name"], "agency": AGENCIES[routes[rid]["agency_id"]],
                           "headway": int(min(max(gap, HEADWAY_MIN_S), HEADWAY_MAX_S)), "legs": legs})

    # Renumber shapes and stops so the file only carries what the legs use.
    shape_ids = sorted({leg["shape"] for r in out_routes for leg in r["legs"]})
    stop_ids = sorted({s for r in out_routes for leg in r["legs"] for s in leg["stops"]})
    shape_n = {s: i for i, s in enumerate(shape_ids)}
    stop_n = {s: i for i, s in enumerate(stop_ids)}
    for r in out_routes:
        del r["id"]
        for leg in r["legs"]:
            leg["shape"] = shape_n[leg["shape"]]
            leg["stops"] = [stop_n[s] for s in leg["stops"]]

    print(f"{len(out_routes)} routes, {sum(len(r['legs']) for r in out_routes)} legs, "
          f"{len(shape_ids)} shapes, {len(stop_ids)} stops", file=sys.stderr)
    return {
        "meta": {
            "feedVersion": feed["feed_version"], "typicalDay": day.isoformat(),
            "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "coordScale": COORD_SCALE, "layover": LAYOVER_S,
            "source": "DfT Bus Open Data Service GTFS (Scotland), Open Government Licence v3.0",
        },
        "routes": out_routes,
        "stops": [[round(float(stop_rows[s]["stop_lon"]), 5), round(float(stop_rows[s]["stop_lat"]), 5), stop_rows[s]["stop_name"]]
                  for s in stop_ids],
        "shapes": [shape_enc[s] for s in shape_ids],
    }


def main() -> None:
    args = sys.argv[1:]
    # --out may be repeated: the standalone viewer and the v1 map each read their own copy.
    outs = [Path(args[i + 1]) for i, a in enumerate(args) if a == "--out" and i + 1 < len(args)] or [OUT]
    day = date.fromisoformat(args[args.index("--date") + 1]) if "--date" in args else None
    data = build(force="--force" in args, chosen_day=day)
    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    for out in outs:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
