"""Festival street closures for the v1 web map: what is closed to vehicles, where and when, on a typical Fringe day.

    uv run python -m closures.web                       # writes v1/web/public/data/closures.json
    uv run python -m closures.web --out some/other.json

Reads closures/out/restriction_days.csv (built by closures.build from the council's Summertime Streets page) and picks one
representative date for each of the map's three day types, so the map can show the closures that go with "Weekday", "Saturday"
and "Sunday". Each closure is listed with the OSM way ids it covers; the web app joins those to the car road graph (roads.json
keeps the way id of every edge), so only streets that are in that graph can be closed there.
"""
import csv
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from closures import geometry

OUT = Path(__file__).parent / "out"
DEFAULT_TARGET = Path(__file__).parent.parent / "v1" / "web" / "public" / "data" / "closures.json"

# A Tuesday, a Saturday and a Sunday in the middle of the Fringe (7 to 31 August 2026), when every Summertime Streets restriction
# is in force and the Tattoo is running. Chosen to match the day types in the map's Explore tab.
FRINGE_DAYS = {"weekday": date(2026, 8, 11), "saturday": date(2026, 8, 15), "sunday": date(2026, 8, 16)}
DAY = 24 * 3600


def seconds(clock: str) -> int:
    """'10:30' to seconds since midnight; '24:00' is the end of the day."""
    hours, minutes = clock.split(":")
    return int(hours) * 3600 + int(minutes) * 60


def read_days(path: Path = OUT / "restriction_days.csv") -> list[dict]:
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def bans(row: dict) -> bool:
    """A real ban on vehicles that is in force (not a loading bay, a pedestrian provision or a dropped plan)."""
    return row["bans_vehicles"] == "True" and row["status"] == "in_force"


def windows_on(rows: list[dict], day: date) -> list[dict]:
    """The vehicle bans that apply on `day`, as [from, to) seconds of that day.

    A restriction that runs overnight (Cowgate, 15:00 to 05:00) is two windows: the evening of its own date, and the small hours
    of the next date. So the early hours of `day` come from the restriction rows of the day before."""
    out = []
    for row in rows:
        if not bans(row):
            continue
        start, end = seconds(row["time_from"]), seconds(row["time_to"])
        overnight = end <= start
        if row["date"] == day.isoformat():
            out.append({**row, "from": start, "to": DAY if overnight else end})
        elif overnight and row["date"] == (day - timedelta(days=1)).isoformat():
            out.append({**row, "from": 0, "to": end})
    return sorted(out, key=lambda w: (w["location_id"], w["from"]))


def closure(row: dict, locations: dict) -> dict | None:
    """One window as the web app reads it, or None if the location cannot be put on the road graph (a junction point)."""
    place = locations[row["location_id"]]
    ways = place.get("ways")
    if not ways:
        return None
    return {
        "id": row["restriction_id"], "location": row["location_id"], "name": place["name"], "festival": row["festival"],
        "type": row["restriction_type"], "from": row["from"], "to": row["to"], "ways": ways,
        "confidence": place.get("confidence", "low"),
    }


def build(rows: list[dict] | None = None, locations: dict | None = None, days: dict[str, date] = FRINGE_DAYS) -> dict:
    rows = read_days() if rows is None else rows
    locations = geometry.LOCATIONS if locations is None else locations
    result: dict = {
        "source": "City of Edinburgh Council, Summertime Streets 2026 (hand-transcribed in closures/schedule.py)",
        "built": datetime.now().astimezone().isoformat(timespec="seconds"), "days": {},
    }
    for name, day in days.items():
        windows, unmapped = [], []
        for w in windows_on(rows, day):
            c = closure(w, locations)
            (windows if c else unmapped).append(c or {"id": w["restriction_id"], "location": w["location_id"], "reason": "junction, not a street"})
        result["days"][name] = {"date": day.isoformat(), "closures": windows, "unmapped": unmapped}
    return result


def main() -> None:
    args = sys.argv[1:]
    target = Path(args[args.index("--out") + 1]) if "--out" in args else DEFAULT_TARGET
    data = build()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, separators=(",", ":")))
    for name, d in data["days"].items():
        print(f"{name}: {d['date']}, {len(d['closures'])} closures, {len(d['unmapped'])} not mapped")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
