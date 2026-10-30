# Lothian bus simulator

A map of Edinburgh with simulated Lothian buses running every route. It is a **simulation, not live
tracking and not a clock-accurate timetable**: each route gets a regular headway and its buses loop
end to end and back forever, at the speeds in the published timetable.

```sh
uv run python -m lothian.build                 # downloads the feed on first run (~290 MB), writes lothian/web/data/lothian.json
uv run python -m http.server 8765 -d lothian/web
# open http://localhost:8765
```

Controls: pause/speed (1x is real speed; the default 20x makes movement visible), a **frequency**
multiplier (2x = twice as many buses), a route filter, and toggles for all route lines and stops.
Click a bus for its route, destination and next stop; its path is highlighted.

The same data also drives the **Simulated buses** layer in the main Edinburgh map (`v1/web`, `make buses`
in `v1/`). That layer is a TypeScript port of `sim.js` (`v1/web/src/buses.ts`), so the simulation currently
exists twice; the standalone viewer is the quick way to try a change to the pipeline.

## How it works

1. `lothian/fetch.py` downloads the DfT Bus Open Data Service GTFS feed for Scotland. It is public
   and needs no API key. Cached in `lothian/data/raw/` (git-ignored); `--force` re-downloads.
2. `lothian/build.py` keeps Lothian Buses, Lothian Country Buses and East Coast Buses (99 routes;
   trams excluded) and, for each route and direction:
   - picks the most common service pattern on a *typical weekday* (a Tuesday a week into the feed:
     shape, ordered stops, running times);
   - snaps each stop to its distance along the route shape (dynamic programme over candidate
     positions, so looping and out-and-back routes pick the right pass);
   - spreads stops that share the same timetabled minute by distance, because times are whole
     minutes and buses would otherwise jump between stops;
   - sets the **headway** to the median gap between departures on that day (daytime 07:00-19:00,
     or the whole day for night routes), clamped to 3-60 minutes.
3. `lothian/web/sim.js` (pure, no DOM) runs each route as a loop: leg 0, 2-minute layover, leg 1,
   layover. With `N = round(cycle / headway)` buses evenly spaced round the loop, a bus leaves each
   terminus every headway. Between stops a bus accelerates, cruises and brakes (`legProgress`).
4. `lothian/web/app.js` draws it with MapLibre.

## Traffic effects

The v1 map can also make the buses interact (`v1/web/src/traffic.ts`, switched on in the Display tab). It uses a charged-particle car-following rule (`particleAcceleration`: attraction at a
large gap, inverse-square repulsion at a small one, damped by relative speed, capped by braking distance) and applies it
to buses on the same route and direction, with the next stop acting as a stationary leader. On top of that:

- **Bunching:** boarding time grows with the gap since the last bus left a stop, random short delays hit a bus every
  few minutes, a bus cannot pass one that is dwelling, and termini hold a bus until about 70% of the headway has passed.
- **Shared streets:** buses within 150 m of more than three others cruise slower, which feeds back into the density; a
  cell where most buses are under 10.8 km/h is drawn as a red glow (congestion cells).
- **Calibration:** cruise speeds come from the timetable (departure to departure, less the dwell), so a lone bus's
  round trip is about the timetabled time (median 1.02x over the 99 routes, p10-p90 1.00-1.15x).

The car simulation itself is now in the v1 map too (Simulated cars, a Web Worker on an OSM road graph from `make cars`), and the
cars and buses slow each other (`v1/web/src/coupling.ts`: stopped buses lower a road's speed for cars, queued cars crowd and hold up
buses).

Every constant in `traffic.ts` is a placeholder; nothing is fitted to observed bus delays.

## Tests

```sh
uv run pytest tests/test_lothian.py            # pipeline helpers, synthetic data
node --test lothian/web/sim.test.mjs           # simulation core
```

## A Fringe day

The build uses a typical Tuesday a week into the feed. `--date` builds any other day instead, for example a Saturday (7 November
2026 gives 87 routes and 5,476 trips, against 99 routes and 6,125 trips on a weekday):

```sh
uv run python -m lothian.build --date 2026-11-07 --out v1/web/public/data/lothian.json
```

A route that does not run on the chosen day is left out. If the feed has no Lothian service at all on that day, the build stops and says so.

**The August 2026 Fringe timetable is not downloadable any more.** BODS publishes only the current feed, and this one is dated
22 October 2026 to 7 December 2027 (checked 30 October 2026). Its Lothian services run only to about the end of July 2027, so no
August date, 2026 or 2027, has any trips. Where a Fringe-day feed could come from:

- **The BODS feed next spring.** Operators file a few months ahead, so a feed fetched around April to June 2027 should include the
  August 2027 timetable. Then `--date 2027-08-14` works as it is (`--force` to re-download).
- **A past Fringe from an archive.** The University of Glasgow Urban Big Data Centre archive of BODS GTFS snapshots (2021 to June 2023,
  every Saturday and Tuesday from February 2023; one 19.5 GB file; OGL v3.0; <https://zenodo.org/records/14779119>,
  DOI 10.20394/dqmgka2s) should hold August 2022. Not downloaded, and not checked for Lothian coverage. A 2022 network is not the
  2026 network (Lothian announced a network overhaul in August 2026), so it shows what a festival timetable looks like, not 2026.
- **What happened in August 2026.** Lothian's news pages record the diversions (Princes Street closed after a fire on 9 July and
  reopened on 29 August, about 50 routes moved to George Street and Queen Street; 15, 33 and 34 and 43, 106 and X6 rerouted from
  5 August). That is prose, not GTFS, and is not in the simulation.

## Limits worth knowing

- Fleet size is derived (about 550 buses at 1x frequency), not the real fleet. Headways come from one
  typical weekday, so they ignore peaks, evenings and weekends.
- Buses follow the published shapes at timetabled speeds and do not react to traffic or each other.
- 7 of the 194 legs (routes 37, 100, 123, N18, N35, X18) contain a stretch implying over 90 km/h,
  from a stop-to-shape snap or a minute-resolution time (the 100 and X18 have the worst cases, where the
  published shape is roughly three times the straight-line distance). Buses run fast through those stretches.
- Live positions are not included. The keyless BODS vehicle feed contains no Lothian vehicles; live
  Lothian data would need a (free) BODS API key and the SIRI-VM feed.
- Basemap tiles are OpenStreetMap's public server, fine for a local demo. Use a keyed tile provider for
  anything public. Timetable data: DfT BODS, Open Government Licence v3.0.
- The approach (MapLibre bus layer, bearing maths, easing in and out of stops) is a standard one; positions here are computed from the timetable,
  not interpolated from received GPS fixes.
