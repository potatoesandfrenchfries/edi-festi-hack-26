"""Build the festival vehicle-restriction dataset into closures/out/.

    uv run python -m closures.build

Writes locations.geojson (one feature per street/junction), restrictions.csv (one row per restriction window)
and restriction_days.csv (restrictions expanded to one row per calendar date, for joining to event data).
"""
import csv
import json
from pathlib import Path

from closures import geometry, schedule

OUT = Path(__file__).parent / "out"
COLS = ["restriction_id", "location_id", "festival", "restriction_type", "bans_vehicles", "status", "start_date",
        "end_date", "days", "dates", "time_from", "time_to", "exceptions", "note", "source_url"]
DAY_COLS = ["date", "restriction_id", "location_id", "festival", "restriction_type", "bans_vehicles", "status",
            "time_from", "time_to"]


def restriction_rows():
    rows = []
    for i, r in enumerate(schedule.R, 1):
        dates = schedule.expand(r)
        rows.append({
            "restriction_id": f"R{i:03d}", "location_id": r["location"], "festival": r["festival"],
            "restriction_type": r["restriction_type"], "bans_vehicles": r["bans_vehicles"], "status": r["status"],
            "start_date": dates[0].isoformat() if dates else "", "end_date": dates[-1].isoformat() if dates else "",
            "days": "listed dates" if r["dates"] else r["days"],
            "dates": ";".join(d.isoformat() for d in dates) if r["dates"] else "",
            "time_from": r["time_from"], "time_to": r["time_to"], "exceptions": r["exceptions"], "note": r["note"],
            "source_url": schedule.SOURCE_URL,
        })
    return rows


def write_csv(path, rows, cols):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def main():
    missing = {r["location"] for r in schedule.R} - set(geometry.LOCATIONS)
    assert not missing, f"restrictions without geometry: {missing}"

    OUT.mkdir(exist_ok=True)
    by_id, by_name = geometry.index(geometry.fetch())
    feats = [geometry.feature(k, v, by_id, by_name) for k, v in geometry.LOCATIONS.items()]
    (OUT / "locations.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, indent=1))

    rows = restriction_rows()
    write_csv(OUT / "restrictions.csv", rows, COLS)

    day_rows = [{"date": d.isoformat(), **{k: row[k] for k in DAY_COLS[1:]}}
                for row, r in zip(rows, schedule.R) for d in schedule.expand(r)]
    write_csv(OUT / "restriction_days.csv", day_rows, DAY_COLS)
    print(f"{len(feats)} locations, {len(rows)} restrictions, {len(day_rows)} restriction-days -> {OUT}")


if __name__ == "__main__":
    main()
