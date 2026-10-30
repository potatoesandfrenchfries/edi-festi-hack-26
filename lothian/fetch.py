"""Download the BODS Scotland GTFS timetable feed (public, no API key) into lothian/data/raw/."""
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/scotland/"
RAW = Path(__file__).parent / "data" / "raw"
NEEDED = ["agency", "routes", "trips", "stop_times", "stops", "shapes", "calendar", "calendar_dates", "feed_info"]


def fetch(force: bool = False) -> Path:
    """Return the directory holding the extracted GTFS .txt files, downloading if needed."""
    out = RAW / "gtfs"
    if out.exists() and not force and all((out / f"{n}.txt").exists() for n in NEEDED):
        return out
    RAW.mkdir(parents=True, exist_ok=True)
    archive = RAW / "scotland.zip"
    print(f"downloading {URL} (~290 MB)", file=sys.stderr)
    req = urllib.request.Request(URL, headers={"User-Agent": "edi-festi-hack-26 lothian sim"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(archive, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    shutil.rmtree(out, ignore_errors=True)
    with zipfile.ZipFile(archive) as zf:
        for name in NEEDED:
            zf.extract(f"{name}.txt", out)
    return out


if __name__ == "__main__":
    print(fetch(force="--force" in sys.argv))
