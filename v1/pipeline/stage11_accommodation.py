"""Stage 11: bed-spaces in licensed short-term lets, by postcode, with a position for each postcode.

    uv run python -m pipeline.stage11_accommodation

Downloads the City of Edinburgh Council's short-term-let register (a public register, cached in data/raw/stl/), keeps issued licences with
their postcode and maximum occupancy only, and looks each postcode up on postcodes.io (open, no key; only postcodes are sent). Writes
data/interim/stl_beds.json for stage 06, which puts the beds on buildings. The register's applicant and address columns are never read.
"""

import json
from collections import defaultdict

import requests
import xlrd

from pipeline.accommodation import load_config, parse_register
from pipeline.common import RAW, ROOT, download, record

URL = "https://www.edinburgh.gov.uk/downloads/file/32198/short-term-lets"
SOURCE = RAW / "stl" / "short_term_lets.xls"
POSTCODE_CACHE = RAW / "stl" / "postcodes.json"
OUT = ROOT / "data" / "interim" / "stl_beds.json"
LOOKUP = "https://api.postcodes.io/postcodes"
HEADERS = {
    "User-Agent": "edinburgh-presence-hackathon/0.1 (festival transport research; uses the public short-term-let register)"
}
WANTED = ("Status", "Short Term Let Licence Number", "Postcode", "Maximum Occupancy", "Number of Bedrooms")


def read_register(path=SOURCE):
    """Rows of every sheet, as dicts of only the WANTED columns. The header is the first row that has a 'Status' cell."""
    book = xlrd.open_workbook(path)
    for sheet in book.sheets():
        rows = [[str(c).strip() if c != "" else "" for c in sheet.row_values(i)] for i in range(sheet.nrows)]
        header = next((i for i, row in enumerate(rows) if "Status" in row), None)
        if header is None:
            continue
        wanted = {name: rows[header].index(name) for name in WANTED if name in rows[header]}
        for row in rows[header + 1 :]:
            yield {name: row[i] for name, i in wanted.items()}


def geocode(postcodes):
    """{postcode: (lon, lat)} from postcodes.io, 100 at a time; cached so a rerun asks for nothing new. Unknown postcodes are left out."""
    cache = json.loads(POSTCODE_CACHE.read_text()) if POSTCODE_CACHE.exists() else {}
    todo = sorted(p for p in postcodes if p not in cache)
    for start in range(0, len(todo), 100):
        batch = todo[start : start + 100]
        response = requests.post(LOOKUP, json={"postcodes": batch}, timeout=60)
        response.raise_for_status()
        for item in response.json()["result"]:
            found = item["result"]
            cache[item["query"]] = [found["longitude"], found["latitude"]] if found and found.get("longitude") else None
    POSTCODE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    POSTCODE_CACHE.write_text(json.dumps(cache, sort_keys=True))
    return {p: tuple(cache[p]) for p in postcodes if cache.get(p)}


def main():
    cfg = load_config()
    download(URL, SOURCE, headers=HEADERS)
    record(
        "edinburgh_short_term_let_register", SOURCE, url=URL, licence="Council public register; reuse terms not stated on the page (verify)",
        notes="Short Term Let licences and applications; only status, postcode and occupancy are used",
    )  # fmt: skip
    by_postcode = parse_register(read_register(), cfg)
    places = geocode(by_postcode)
    totals = defaultdict(int)
    out = []
    for postcode, entry in sorted(by_postcode.items()):
        totals["beds"] += entry["beds"]
        totals["lets"] += entry["lets"]
        if postcode in places:
            lon, lat = places[postcode]
            out.append({"postcode": postcode, "lon": round(lon, 6), "lat": round(lat, 6), **entry})
            totals["placed_beds"] += entry["beds"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"licences": totals["lets"], "beds": totals["beds"], "postcodes": out}, separators=(",", ":")) + "\n"
    )
    print(
        f"{totals['lets']} issued licences, {totals['beds']} beds in {len(by_postcode)} postcodes; "
        f"{totals['placed_beds']} beds ({len(out)} postcodes) located -> {OUT}"
    )


if __name__ == "__main__":
    main()
