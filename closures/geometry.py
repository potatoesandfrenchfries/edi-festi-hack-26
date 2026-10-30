"""Map each restricted location to OpenStreetMap street geometry (Overpass API, ODbL).

The council page gives street names, not extents, so geometry is indicative. `confidence` says how far to trust it:
high = whole named street segment matches the council wording, medium = street extent not stated by the council,
low = council describes a sub-section (junction, 30 m, between two streets) that was approximated.
"""
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAW = Path(__file__).parent / "data" / "raw"
OVERPASS = "https://overpass-api.de/api/interpreter"
BBOX = "55.940,-3.225,55.960,-3.170"
NAMES = ["High Street", "Parliament Square", "Cockburn Street", "St Giles' Street", "Blair Street", "Lawnmarket",
         "Johnston Terrace", "Cowgate", "East Adam Street", "George Street", "Candlemaker Row", "George IV Bridge",
         "Blackfriars Street"]

# way ids chosen by hand from the Overpass result; coordinates are (lat, lon)
LOCATIONS = {
    "high_street": dict(name="High Street", ways=[2956321, 4827442, 355968075, 1325614179, 4791806],
                        confidence="medium", note="Council gives no extent; Lawnmarket/George IV Bridge end to Cockburn/Blair Street end"),
    "parliament_square": dict(name="Parliament Square", ways=[4827443, 231671129], confidence="high"),
    "cockburn_street": dict(name="Cockburn Street", ways=[4235347, 1498438113], confidence="high"),
    "st_giles_street": dict(name="St Giles' Street", ways=[1313303854], confidence="medium",
                            note="north-south link to High Street"),
    "st_giles_street_east_west": dict(name="St Giles' Street (east-west section)", ways=[4329295], confidence="medium",
                                      note="section accessed from Bank Street"),
    "blair_street_south_bridge_end": dict(name="Blair Street (South Bridge end)", ways=[2956309],
                                          tail_m=30, confidence="low",
                                          note="last 30 m of the OSM Blair Street way at the South Bridge end"),
    "cowgate_candlemaker_blackfriars": dict(name="Cowgate (Candlemaker Row to Blackfriars Street)",
                                            ways=[2954058, 880298117], clip_at=(55.9489692, -3.1855108),
                                            confidence="high"),
    "east_adam_street_pleasance": dict(name="East Adam Street / The Pleasance junction", point=(55.9474287, -3.1820855),
                                       confidence="low", note="end node of East Adam Street nearest The Pleasance"),
    "lawnmarket": dict(name="Lawnmarket (Castlehill to George IV Bridge)", ways=[2956310], confidence="high"),
    "johnston_terrace": dict(name="Johnston Terrace", ways=[23046488, 1445819969, 463491072, 656353980, 23046477],
                             confidence="high"),
    "candlemaker_row_george_iv_bridge": dict(name="Candlemaker Row / George IV Bridge junction",
                                             point=(55.9468608, -3.1911343), confidence="low",
                                             note="shared node of the two OSM ways"),
    "george_street_hanover_frederick": dict(name="George Street (Hanover Street to Frederick Street)", name_filter="George Street",
                                            lon_range=(-3.1976, -3.1954), confidence="low",
                                            note="all George Street ways between those longitudes"),
}


def fetch(force=False):
    """Download (and cache) the OSM ways for the festival streets."""
    out = RAW / "overpass.json"
    if out.exists() and not force:
        return json.loads(out.read_text())
    names = "|".join(NAMES)
    q = f'[out:json][timeout:60];way({BBOX})["highway"]["name"~"^({names})$"];out geom tags;'
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "edi-festi-hack-26 closures"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            break
        except urllib.error.HTTPError as e:
            # Overpass sheds load with 429/502/504; back off and retry
            if e.code not in (429, 502, 504) or attempt == 3:
                raise
            time.sleep(5 * 2**attempt)
    RAW.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data))
    return data


def metres(a, b):
    """Great-circle distance between (lat, lon) points."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


def chain(ways):
    """Join ways end to start into one coordinate list, reversing a way if it is stored backwards."""
    pts = list(ways[0])
    for w in ways[1:]:
        w = list(w)
        if metres(pts[-1], w[0]) > metres(pts[-1], w[-1]):
            w.reverse()
        pts += w[1:]
    return pts


def clip_at(pts, point):
    """Cut a line at the vertex nearest `point`."""
    i = min(range(len(pts)), key=lambda k: metres(pts[k], point))
    return pts[: i + 1]


def tail(pts, length):
    """The last `length` metres of a line, with the cut point interpolated."""
    out, left = [pts[-1]], length
    for a, b in zip(reversed(pts[:-1]), reversed(pts[1:])):
        d = metres(a, b)
        if d >= left:
            f = left / d
            out.append((b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f))
            return out[::-1]
        out.append(a)
        left -= d
    return out[::-1]


def feature(key, spec, ways_by_id, ways_by_name):
    """GeoJSON feature for one location."""
    if "point" in spec:
        lat, lon = spec["point"]
        geom = {"type": "Point", "coordinates": [lon, lat]}
    elif "name_filter" in spec:
        lo, hi = spec["lon_range"]
        lines = [w for w in ways_by_name[spec["name_filter"]] if all(lo <= p[1] <= hi for p in w)]
        geom = {"type": "MultiLineString", "coordinates": [[[p[1], p[0]] for p in w] for w in lines]}
    else:
        pts = chain([ways_by_id[i] for i in spec["ways"]]) if len(spec["ways"]) > 1 else list(ways_by_id[spec["ways"][0]])
        if "clip_at" in spec:
            pts = clip_at(pts, spec["clip_at"])
        if "tail_m" in spec:
            # Blair Street is stored north to south, so its tail is the South Bridge end
            pts = tail(pts, spec["tail_m"])
        geom = {"type": "LineString", "coordinates": [[p[1], p[0]] for p in pts]}
    props = dict(location_id=key, name=spec["name"], geometry_confidence=spec["confidence"], geometry_note=spec.get("note", ""))
    return {"type": "Feature", "properties": props, "geometry": geom}


def index(data):
    by_id, by_name = {}, {}
    for e in data["elements"]:
        pts = [(g["lat"], g["lon"]) for g in e["geometry"]]
        by_id[e["id"]] = pts
        by_name.setdefault(e["tags"]["name"], []).append(pts)
    return by_id, by_name
