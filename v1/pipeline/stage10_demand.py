"""Stage 10: festival demand by venue, date and 15-minute slot, from the festivals' ticket extracts.

    uv run python -m pipeline.stage10_demand

Reads the Fringe, EIF and Tattoo 2026 extracts in ../dataset/ (personal data, git-ignored; set DATASET_DIR to move them). Only counts
grouped by venue and show start, and by postcode area, are taken from them: no customer id, email or order reference is read into
the output. Writes web/public/data/demand.json for the cars (who is going where), the building layer (who is where) and the scenarios.

Fringe tickets name a venue only by number, so their audiences are put on the hubs in config/demand.yaml (an assumption, stated in the file).
EIF and Tattoo venues are placed exactly, from config/venues.csv.
"""

import csv
import json
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import duckdb

from pipeline.common import ROOT
from pipeline.demand import (
    assign_hubs,
    build_series,
    load_config,
    origin_class,
    pack,
    parse_eif_start,
    parse_tattoo_start,
    postcode_area,
    sector_of,
    shares,
    staying_people,
)  # fmt: skip

DATASET = Path(os.environ.get("DATASET_DIR", ROOT.parent / "dataset"))
CACHE = ROOT / "data" / "interim"
OUT = ROOT / "web" / "public" / "data" / "demand.json"
VENUES = ROOT / "config" / "venues.csv"
FRINGE = DATASET / "Fringe 2026" / "Fringe2026AllTicketsSold_Clean.csv"
EIF = DATASET / "EIF 2026" / "TicketSalesAnalysisForYearOnYearComparison - 2026 full set.csv"
TATTOO_LINES = DATASET / "Tattoo 2026" / "ticket_lines.csv"
TATTOO_CUSTOMERS = DATASET / "Tattoo 2026" / "customers.csv"
CSV_OPTIONS = "header=true, all_varchar=true, null_padding=true, strict_mode=false"


def recode_eif(source=EIF, target=CACHE / "eif_2026_utf8.csv"):
    """DuckDB rejects the EIF export's Windows-1252 characters, so a UTF-8 copy is made once in the git-ignored cache."""
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with (
            open(source, encoding="cp1252", errors="replace", newline="") as f,
            open(target, "w", encoding="utf-8", newline="") as g,
        ):
            while chunk := f.read(1 << 20):
                g.write(chunk)
    return target


def fringe_rows(db):
    """(venue id, show start, tickets) per venue and start time."""
    # The default typed read, not CSV_OPTIONS: event names hold commas and the lenient parser then misaligns some rows.
    query = f"""SELECT Venue_ID::VARCHAR, Performance_Date, SUM(Tickets)::INTEGER
                FROM read_csv('{FRINGE}') WHERE Performance_Date IS NOT NULL GROUP BY 1, 2"""
    return db.sql(query).fetchall()


def eif_rows(db):
    """(venue name, show start, tickets) per venue and start time. Each EIF row is one ticket."""
    query = f"""SELECT "Venue Name", "Event Date/Time", COUNT(*) FROM read_csv('{recode_eif()}', {CSV_OPTIONS})
                WHERE "Event Date/Time" IS NOT NULL GROUP BY 1, 2"""
    return [(venue, parse_eif_start(start), n) for venue, start, n in db.sql(query).fetchall()]


def tattoo_rows(db):
    """(show start, tickets) per performance in the 2026 season."""
    query = f"""SELECT performance_date || ' ' || performance_time, SUM(tickets::INTEGER)
                FROM read_csv('{TATTOO_LINES}', {CSV_OPTIONS}) WHERE season = '2026' GROUP BY 1"""
    return [(parse_tattoo_start(start), n) for start, n in db.sql(query).fetchall()]


def origin_counts(db):
    """{source: {(date, class, sector): tickets}} for the sources that carry a postcode (EIF, Tattoo). Classes: local, daytrip, stay, None."""
    cfg = load_config()
    eif = db.sql(
        f"""SELECT "Postcode Area", substr("Event Date/Time", 1, 10), COUNT(*) FROM read_csv('{recode_eif()}', {CSV_OPTIONS})
            WHERE "Event Date/Time" IS NOT NULL GROUP BY 1, 2"""
    ).fetchall()
    tattoo = db.sql(
        f"""SELECT t.postcode_area, c.country, t.performance_date, SUM(t.tickets::INTEGER)
            FROM read_csv('{TATTOO_LINES}', {CSV_OPTIONS}) t
            LEFT JOIN (SELECT customer_ref, ANY_VALUE(country) country FROM read_csv('{TATTOO_CUSTOMERS}', {CSV_OPTIONS}) GROUP BY 1) c USING (customer_ref)
            WHERE t.season = '2026' GROUP BY 1, 2, 3"""
    ).fetchall()
    out = {"eif": defaultdict(int), "tattoo": defaultdict(int)}
    for area, day, n in eif:
        day = datetime.strptime(day, "%d/%m/%Y").date().isoformat()
        area = postcode_area(area)
        out["eif"][(day, origin_class(area, None, cfg), sector_of(area, cfg))] += n
    for area, country, day, n in tattoo:
        area = postcode_area(area)
        out["tattoo"][
            (parse_tattoo_start(day + " 00:00").date().isoformat(), origin_class(area, country, cfg), sector_of(area, cfg))
        ] += n
    return out


def venue_table():
    with open(VENUES, newline="") as f:
        return {row["key"]: row for row in csv.DictReader(f)}


def main():
    cfg = load_config()
    db = duckdb.connect()
    slot = cfg["season"]["slot_minutes"]
    timing = cfg["timing"]
    hubs = cfg["fringe_hubs"]
    venues = venue_table()

    fringe = fringe_rows(db)
    hub_of = assign_hubs(_sum_by(((v, n) for v, _, n in fringe)), hubs)
    performances = [(hub_of[v], start, timing["fringe_duration_min"], n) for v, start, n in fringe]
    unplaced = defaultdict(int)
    for name, start, n in eif_rows(db):
        key = cfg["eif_venues"].get(name)
        if key is None:
            unplaced[name] += n
        else:
            performances.append((key, start, timing["eif_duration_min"], n))
    performances += [(cfg["tattoo_venue"], start, timing["tattoo_duration_min"], n) for start, n in tattoo_rows(db)]

    first = min(p[1].date() for p in performances)
    days = (max(p[1].date() for p in performances) - first).days + 2  # one extra day for late shows that end after midnight
    series = build_series(performances, timing, first, days, slot)

    origins = origin_counts(db)
    per_source = {name: _split(counts) for name, counts in origins.items()}
    sources = cfg["origin"][
        "fringe_origin_from"
    ]  # equal weight per source: the Tattoo's tourists must not swamp the EIF's locals
    fringe_split = {k: round(sum(per_source[s][k] for s in sources) / len(sources), 4) for k in ("local", "daytrip", "stay")}
    sectors = _sector_shares(origins)
    tickets_by_date = {
        "eif": _sum_by(((k[0], n) for k, n in origins["eif"].items())),
        "tattoo": _sum_by(((k[0], n) for k, n in origins["tattoo"].items())),
        "fringe": _sum_by((p[1].date().isoformat(), p[3]) for p in performances if p[0] in hub_of.values()),
    }
    stay_share = {"eif": per_source["eif"]["stay"], "tattoo": per_source["tattoo"]["stay"], "fringe": fringe_split["stay"]}
    staying = defaultdict(int)
    for source, by_date in tickets_by_date.items():
        for day, people in staying_people(by_date, stay_share[source], cfg).items():
            staying[day] += people

    placed = {k: v for k, v in series.items()}
    known = {h["key"]: {"name": h["name"], "lon": h["lon"], "lat": h["lat"], "festival": "Fringe", "kind": "hub"} for h in hubs}
    for key in placed:
        if key in venues:
            v = venues[key]
            known[key] = {
                "name": v["name"],
                "lon": float(v["lon"]),
                "lat": float(v["lat"]),
                "festival": v["festival"],
                "kind": v["kind"],
            }
    payload = {
        "status": cfg["status"],
        "note": "Modelled from 2026 ticket counts. Fringe audiences sit on assumed hubs; arrival and departure timing are assumptions.",
        "slot_minutes": slot,
        "first_day": first.isoformat(),
        "venues": {
            key: {
                **known[key],
                "tickets": round(sum(series[key]["arrivals"])),
                "days": pack(series[key], first, slot, cfg["suppression"]["min_cell"]),
            }
            for key in sorted(placed)
            if key in known
        },
        "origins": {"eif": per_source["eif"], "tattoo": per_source["tattoo"], "fringe": fringe_split, "sectors": sectors},
        "staying_people": dict(sorted(staying.items())),
        "unplaced_eif_tickets": dict(unplaced),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    total = sum(v["tickets"] for v in payload["venues"].values())
    print(
        f"{len(payload['venues'])} venues, {total} tickets over {len(staying)} nights -> {OUT} ({OUT.stat().st_size / 1e3:.0f} kB)"
    )
    print(
        f"origin shares: {payload['origins']['eif']} EIF, {payload['origins']['tattoo']} Tattoo, {fringe_split} Fringe (mean of the two)"
    )
    if unplaced:
        print(f"EIF venues with no place in config/demand.yaml (left out): {dict(unplaced)}")


def _sum_by(pairs):
    out = defaultdict(int)
    for key, n in pairs:
        out[key] += n
    return dict(out)


def _split(counts):
    by_class = defaultdict(int)
    for (_, cls, _), n in counts.items():
        by_class[cls] += n
    return shares(by_class)


def _sector_shares(origins):
    """Share of out-of-town tickets (daytrip or stay) from each compass sector, among those whose postcode area has one."""
    by_sector = defaultdict(int)
    for counts in origins.values():
        for (_, cls, sector), n in counts.items():
            if cls in ("daytrip", "stay") and sector:
                by_sector[sector] += n
    total = sum(by_sector.values())
    return {s: round(n / total, 4) for s, n in sorted(by_sector.items())} if total else {}


if __name__ == "__main__":
    main()
