# Festival vehicle restrictions (2026)

Where and when vehicles are banned or restricted in Edinburgh during the summer festivals. No open dataset
exists for this: the City of Edinburgh Council publishes it as prose on
[Summertime Streets 2026](https://www.edinburgh.gov.uk/roads-travel-parking/summertime-streets-1), so this
folder turns that page into structured data.

```sh
uv run python -m closures.build     # fetches OSM street geometry (cached in closures/data/raw), writes closures/out/
uv run pytest tests/test_closures.py
```

## Outputs (`closures/out/`)

| File | One row per | Key columns |
|---|---|---|
| `locations.geojson` | street or junction | `location_id`, `name`, `geometry_confidence`, `geometry_note` |
| `restrictions.csv` | restriction window | `restriction_id`, `location_id`, `restriction_type`, `bans_vehicles`, `status`, `start_date`, `end_date`, `days`, `dates`, `time_from`, `time_to`, `exceptions`, `note` |
| `restriction_days.csv` | restriction x calendar date | `date`, `restriction_id`, `location_id`, `time_from`, `time_to` |

Join `restrictions.csv` to `locations.geojson` on `location_id`. Use `restriction_days.csv` to ask "what was
restricted on this date" or to join to event data by date. A `time_to` earlier than `time_from` (Cowgate,
15:00 to 05:00) runs overnight into the next day; `24:00` means midnight at the end of that date.

`restriction_type`: `closed_to_vehicles`, `pedestrian_cycle_only`, `access_restricted`, `loading_only`,
`junction_closed`, `pedestrian_provision` (no ban), `withdrawn` (planned, then dropped). Filter on `bans_vehicles`
and `status == "in_force"` for actual bans.

## For the map

```sh
uv run python -m closures.web     # writes v1/web/public/data/closures.json (or `make closures` in v1/)
```

`closures.web` picks one date in the middle of the Fringe for each of the map's day types (Tuesday 11, Saturday 15 and Sunday
16 August 2026) and lists the vehicle bans in force on it, as seconds since midnight, with the OSM way ids each covers. Overnight
bans (Cowgate) are split across the two dates. The map joins the way ids to its car road graph, so a closure shows up there only
if its street is in that graph. Junction closures (East Adam Street) have no street and are listed as `unmapped`.

## Caveats

- **Schedule is hand-transcribed** from one page, in `schedule.py`; re-check it against the page if the council
  updates it. Several details are the council's own: the Tattoo is "7 to 27 August" but also lists Friday 28 and
  Saturday 29 August, and each is kept as written.
- **Geometry is indicative.** The council names streets, not extents. Each location carries
  `geometry_confidence`: `high` (whole OSM street matches the wording), `medium` (extent not stated), `low`
  (sub-section or junction approximated, e.g. Blair Street's 30 m is the last 30 m of its OSM way, George Street
  is every OSM way in the Hanover to Frederick block).
- **George Street is not closed.** The council dropped its plan after the Princes Street fire so buses can divert
  along it; it is kept as a `withdrawn` row so the absence is explicit.
- **Short-term event restrictions** (Pride, marches, etc.) are not on this page. They are issued as temporary
  traffic regulation orders (PDFs at https://www.edinburgh.gov.uk/roads-pavements/view-comment-traffic-orders-new/2)
  and are not included yet.
- Street geometry is © OpenStreetMap contributors (ODbL).
