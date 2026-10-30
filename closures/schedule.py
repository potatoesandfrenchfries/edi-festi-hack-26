"""Festival vehicle restrictions, hand-transcribed from the council's Summertime Streets 2026 page.

Source: https://www.edinburgh.gov.uk/roads-travel-parking/summertime-streets-1 (fetched 2026-10-30).
The page is prose, not data, so the schedule is transcribed here. Geometry is added from OpenStreetMap in
build.py. `geometry` keys point at LOCATIONS in geometry.py.
"""
from datetime import date, timedelta

SOURCE_URL = "https://www.edinburgh.gov.uk/roads-travel-parking/summertime-streets-1"
YEAR = 2026

WEEKDAYS = "Mon-Fri"
WEEKEND = "Sat-Sun"
DAILY = "Mon-Sun"

# Tattoo closure windows, as the page words them. The "7 to 27 August" headline and the Friday 28 / Saturday 29
# extras do not line up, so each window is kept as written.
TATTOO_WINDOWS = [
    dict(dates=[date(2026, 8, 5), date(2026, 8, 6)], time_from="17:00", time_to="24:00", note="Tattoo rehearsals"),
    dict(start=date(2026, 8, 7), end=date(2026, 8, 27), days=WEEKDAYS, time_from="17:30", time_to="24:00"),
    dict(dates=[date(2026, 8, d) for d in (8, 15, 22, 29)] + [date(2026, 8, 28)], time_from="15:30", time_to="24:00",
         note="Saturdays 8, 15, 22, 29 Aug plus Friday 28 Aug"),
]

# One dict per restriction window. type: closed_to_vehicles | pedestrian_cycle_only | access_restricted |
# loading_only | junction_closed | pedestrian_provision | withdrawn
R = []


def add(location, rtype, bans_vehicles, start=None, end=None, days=DAILY, time_from="00:00", time_to="24:00",
        dates=None, festival="Fringe/summer festivals", status="in_force", exceptions="", note=""):
    R.append(dict(location=location, restriction_type=rtype, bans_vehicles=bans_vehicles, festival=festival,
                  start_date=start, end_date=end, days=days, dates=dates, time_from=time_from, time_to=time_to,
                  status=status, exceptions=exceptions, note=note))


# --- Old Town pedestrianisation, 7-30 August ---------------------------------------------------------------
for loc in ("high_street", "parliament_square", "cockburn_street", "st_giles_street"):
    for days, to in ((WEEKDAYS, "24:00"), (WEEKEND, "21:00")):
        add(loc, "closed_to_vehicles", True, date(2026, 8, 7), date(2026, 8, 30), days, "10:30", to,
            exceptions="loading/unloading per temporary signs; no waiting at any time")

add("st_giles_street_east_west", "loading_only", False, date(2026, 8, 7), date(2026, 8, 30), WEEKDAYS, "00:00", "19:00",
    note="Section accessed from Bank Street set aside for loading; dates assumed to match the St Giles' Street closure")
add("st_giles_street_east_west", "loading_only", False, date(2026, 8, 7), date(2026, 8, 30), WEEKEND, "00:00", "24:00",
    note="24 hours at weekends; dates assumed to match the St Giles' Street closure")

# --- Blair Street / Cowgate / East Adam Street --------------------------------------------------------------
add("blair_street_south_bridge_end", "closed_to_vehicles", True, date(2026, 7, 19), date(2026, 9, 7),
    exceptions="normal one-way rescinded; loading and turning area at northern end of the north-south section",
    note="Council: closed 30 m westwards from South Bridge")
add("cowgate_candlemaker_blackfriars", "closed_to_vehicles", True, date(2026, 7, 27), date(2026, 9, 2),
    time_from="15:00", time_to="05:00", exceptions="cycles; essential local access via Guthrie Street East",
    note="Runs overnight, 15:00 to 05:00 the next day")
add("east_adam_street_pleasance", "junction_closed", True, date(2026, 7, 27), date(2026, 9, 7),
    note="Junction of East Adam Street at The Pleasance")

# --- Castle / Tattoo ----------------------------------------------------------------------------------------
for w in TATTOO_WINDOWS:
    add("lawnmarket", "pedestrian_cycle_only", True, w.get("start"), w.get("end"), w.get("days", DAILY),
        w["time_from"], w["time_to"], w.get("dates"), festival="Royal Edinburgh Military Tattoo",
        exceptions="cyclists asked to dismount; servicing 06:30-10:30 via eastern end of Johnston Terrace",
        note=w.get("note", ""))
    add("johnston_terrace", "closed_to_vehicles", True, w.get("start"), w.get("end"), w.get("days", DAILY),
        w["time_from"], w["time_to"], w.get("dates"), festival="Royal Edinburgh Military Tattoo",
        note=w.get("note", ""))

add("johnston_terrace", "access_restricted", True, date(2026, 7, 27), date(2026, 9, 7),
    exceptions="from Castle Terrace: blue badge holders, taxis and cycles only; servicing 06:30-10:30; "
               "no access into or from Lawnmarket; closed to all vehicles during Tattoo hours (see Tattoo rows)",
    note="Applies outside the Tattoo operating times")
add("johnston_terrace", "closed_to_vehicles", True, dates=[date(2026, 7, d) for d in (10, 11, 12, 14, 17, 18, 19)],
    time_from="08:00", time_to="24:00", festival="Castle Concerts")

# --- Others -------------------------------------------------------------------------------------------------
add("candlemaker_row_george_iv_bridge", "pedestrian_provision", False, date(2026, 7, 24), date(2026, 9, 7),
    note="Extra pedestrian space around the Greyfriars Bobby statue; not a vehicle ban")
add("george_street_hanover_frederick", "withdrawn", False, status="withdrawn",
    note="Council: plans changed after the Princes Street fire; the street stays open for diverted buses and "
         "Assembly Festival moved Bijou and Front Room to St Andrew Square. No dates published.")


def expand(r):
    """The calendar dates on which a restriction window applies."""
    if r["dates"]:
        return sorted(r["dates"])
    if not r["start_date"]:
        return []
    names = {"Mon-Fri": range(0, 5), "Sat-Sun": range(5, 7), "Mon-Sun": range(0, 7)}[r["days"]]
    d, out = r["start_date"], []
    while d <= r["end_date"]:
        if d.weekday() in names:
            out.append(d)
        d += timedelta(days=1)
    return out
