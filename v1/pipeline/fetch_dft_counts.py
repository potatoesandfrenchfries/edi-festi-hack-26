"""Downloads the Department for Transport's annual average daily flow (AADF) count points for the City of Edinburgh.

    uv run python -m pipeline.fetch_dft_counts

One row per count point per year, from the DfT road traffic statistics API (https://roadtraffic.dft.gov.uk/). Every row is kept in
data/raw/counts/dft_aadf_edinburgh.json; choosing which to use (Counted, not a pandemic year, the latest per point) is
pipeline/counts.py. Cached: REFETCH=1 downloads it again.
"""

import json
import os

import requests
import yaml

from pipeline.common import RAW, ROOT, record

API = "https://roadtraffic.dft.gov.uk/api/average-annual-daily-flow"
TARGET = RAW / "counts" / "dft_aadf_edinburgh.json"
LICENCE = "Open Government Licence v3.0, (c) Department for Transport"


def fetch_year(authority, year):
    """All AADF rows for one authority and year (the API pages at 1,000 rows; Edinburgh has about 100 count points)."""
    rows, page = [], 1
    while True:
        response = requests.get(
            API,
            params={"filter[local_authority_id]": authority, "filter[year]": year, "page[size]": 1000, "page[number]": page},
            timeout=60,
            headers={"User-Agent": "edinburgh-presence-pipeline/0.1"},
        )
        response.raise_for_status()
        body = response.json()
        rows += body["data"]
        if page >= body.get("last_page", 1):
            return rows
        page += 1


def main():
    if TARGET.exists() and not os.environ.get("REFETCH"):
        print(f"{TARGET} is cached; REFETCH=1 downloads it again")
        return
    config = yaml.safe_load((ROOT / "config" / "flows.yaml").read_text())["dft"]
    # The latest published year is not known in advance: ask upwards from the first year until a year comes back empty.
    rows, year = [], config["first_year"]
    while True:
        found = fetch_year(config["local_authority_id"], year)
        print(f"  {year}: {len(found)} rows", flush=True)
        if not found and year > config["first_year"]:
            break
        rows += found
        year += 1
        if year > config["first_year"] + 20:
            break
    rows.sort(key=lambda r: (r["year"], r["count_point_id"]))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(rows, separators=(",", ":")))
    years = sorted({r["year"] for r in rows})
    counted = sum(r["estimation_method"] == "Counted" for r in rows)
    entry = record(
        "dft_aadf_edinburgh", TARGET, url=f"{API}?filter[local_authority_id]={config['local_authority_id']}", licence=LICENCE,
        notes=f"{len(rows)} rows, years {years[0]}-{years[-1]}, {counted} Counted and {len(rows) - counted} Estimated; "
        f"{len({r['count_point_id'] for r in rows})} count points",
    )  # fmt: skip
    print(f"{len(rows)} rows ({counted} Counted), {entry['bytes'] / 1e3:.0f} kB -> {TARGET}")


if __name__ == "__main__":
    main()
