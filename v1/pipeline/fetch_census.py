"""Fetches Scotland's Census 2022 tables and geography files used by the occupancy model.

    uv run python -m pipeline.fetch_census

All files are small and only published Scotland-wide; they are clipped to Edinburgh in later stages.
The multivariate and topic table bundles (70 to 100 MB each) are deliberately not fetched.
"""

from pipeline.common import RAW, download, record

LICENCE = "Open Government Licence v3.0 (National Records of Scotland / Scotland's Census 2022); verify wording on each page"
CENSUS = "https://www.scotlandscensus.gov.uk"
NRS = "https://www.nrscotland.gov.uk"
FILES = {
    "census_workplace_daytime_tables": (
        f"{CENSUS}/media/3emcxnis/scotlands-census-2022-workplace-population-tables-17-june-2025.xlsx",
        "workplace_population_tables_2025-06-17.xlsx",
        "Workplace population tables, council area and output area. Check the sheets for the daytime definition (spike S1).",
    ),
    "census_oa_boundaries_clipped": (
        f"{NRS}/media/uwdpx4hn/output-area-2022-mhw.zip",
        "output_area_2022_boundaries_clipped_to_coast.zip",
        "2022 output area boundaries, clipped to the coastline (shapefile).",
    ),
    "census_oa_usual_residents": (
        f"{NRS}/media/owpknvgk/outputarea2022_usualresidentpopulation.csv",
        "output_area_2022_usual_resident_population.csv",
        "Usual resident population per 2022 output area.",
    ),
    "census_oa_to_dz_iz": (
        f"{NRS}/media/iz3evrqt/oa22_dz22_iz22.zip",
        "oa22_dz22_iz22.zip",
        "Lookup from 2022 output area to 2022 data zone and intermediate zone.",
    ),
    "census_index": (
        f"{NRS}/media/utrbt5ze/census_2022_index.zip",
        "census_2022_index.zip",
        "Output area to higher areas (including council area), and higher-area lookups.",
    ),
}


def fetch():
    for key, (url, name, notes) in FILES.items():
        target = download(url, RAW / "census" / name)
        entry = record(key, target, url=url, licence=LICENCE, notes=notes)
        print(f"{key}: {entry['bytes'] / 1e6:.2f} MB -> {target}")


if __name__ == "__main__":
    fetch()
