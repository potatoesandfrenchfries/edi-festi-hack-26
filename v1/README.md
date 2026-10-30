# Edinburgh presence map

An interactive 3D map of Edinburgh in which each building is shaded by the **modelled** number of people active in it, by hour of day and day type.

**These are modelled estimates, not live counts.** No open source of per-building occupancy exists. The design is to allocate Scotland's Census 2022 resident and workplace populations to buildings by floor area and use class, but that step (M2) is paused: what the map shows today are **template values**, placeholder populations proportional to floor area, with a use class read from OpenStreetMap and Overture tags (`pipeline/template_values.py`). They are not census figures. The hourly profiles are placeholders until calibrated. Visitors and tourists are not modelled, and neither are pupils and students.

Status: milestones M0 (scaffold), M1 (footprints, LiDAR heights, static 3D pilot map) and M3 (hourly animation: day type, hour slider with play, metric toggle, legend, popup, manual festival multiplier) are built. M2 (census allocation), M4 (calibration) and M5 (full city) are paused, so the map is a visualisation template whose data is still to be chosen. M1's height acceptance check is not met (see `docs/height_validation.md`). See `PLAN.md` for the scope of each milestone and `DESIGN.md` for the model. M3 frame-rate results are in `docs/frame_rate.md`.

## Setup

Requires [uv](https://docs.astral.sh/uv/), Node 22 or newer, and `make`.

```sh
make install            # Python 3.12 environment and web dependencies
make test               # Python tests, web typecheck and unit tests
make install-browsers   # once, for the browser smoke test
make test-e2e
make web-dev            # start the web app; Vite prints the URL
```

Fetch the pilot-area data (about 150 MB, cached in `data/raw/`, gitignored):

```sh
make fetch
```

Build the pilot map (needs `brew install tippecanoe`), then view it with `make web-dev`:

```sh
make m1                 # footprints, heights, tiles and the height validation report
```

### The whole city

The pilot covers the Old Town and New Town (5 km²). The whole City of Edinburgh council area (263 km², 66 work tiles of 2.5 km) is built with the same stages, one tile at a time so whole-city rasters never have to fit in memory:

```sh
make city AREA=full     # fetch (several GB, cached and resumable per tile), footprints, heights, infill, tiles
```

`AREA=full` writes to `data/interim/full/` and `data/out/full/`, so the pilot outputs are never overwritten. Both builds can copy their tiles to `web/public/data/buildings.pmtiles` (and `profiles.json`, which must match them), and `web/public/data/served_area.txt` says which one is there. A full build always replaces the copy; a pilot build leaves a full-city copy alone and says so, so the map no longer shrinks back to the pilot when someone rebuilds it. Run `SERVE_PILOT=1 make tiles` to show the pilot again. Buildings are drawn from zoom 13. LiDAR comes from Phase 5 for every tile. The tile list is `config/full_tiles.json` (regenerate with `uv run python -m pipeline.area_tiles`). A tile also reads a 100 m LiDAR buffer, and an empty-ground patch for the infill belongs to the tile that holds its centre, so nothing is cut or drawn twice at tile edges. The 2.5 km tile list covers slightly more than the council boundary, so some buildings just outside it are included.

`make tiles` also writes `web/public/data/profiles.json` (hourly curves, festival range and colour break points for the web app) and `data/out/oracle.json` (20 sampled buildings with the values the pipeline expects, which the web unit tests check the client against).

`make help` lists everything else, including one target per pipeline stage. Stages 03 to 05 and 07 are stubs that exit with "not implemented yet"; the tile stage supplies the template values instead.

## Using the map

Pick a day type and an hour (or press Play) to change the headline totals. Buildings are cream, and a building flagged `is_venue` in the tiles is drawn in purple so festival venues stand out (the pipeline that sets the flag is not built yet, so for now every building is cream). Click a building for its estimate, use class and height source. The **festival scenario** slider multiplies the workers' share by 1.00 to 1.50. It is a manual scenario, not a measurement. With reduced motion set in the operating system, Play steps more slowly. The **Display** tab switches inferred buildings, landmark towers and building heights on and off, and offers three performance presets (Detailed, Balanced, Light: lower resolution, a later zoom, no inferred buildings). **Test speed** scrubs the hour for three seconds and recommends a preset from the frame rate. A status line at the bottom of the panel shows how many buildings loaded, or says when the basemap fell back to a flat background. Settings are remembered in the browser when storage is available.

The hourly curves are parametric shapes in `config/profiles.yaml`; colour break points, the festival range and the template densities are in `config/model.yaml`. All are placeholders.

### Festival surge and the cost of getting there

The **Explore** tab takes a festival date (3 to 31 August) instead of a day type, and shades buildings by the **festival surge**: audiences at venues (from the 2026 Fringe, EIF and Tattoo ticket counts) and extra guests in hotels, halls and licensed short-term lets. In the **Scenario** tab, cars drive to the venues the tickets name, and a table of configurations (bus frequency, park-and-ride, Fringe closures) shows which loses the least time, fuel and carbon. All of it is modelled: counts are real, how people travel and where Fringe venues are is assumed. See [docs/festival_transport.md](docs/festival_transport.md).

```sh
make demand accommodation transport tiles   # ticket counts, short-term-let beds, travel assumptions, then the beds on the buildings
cd web && npm run scenarios                 # sweep the configurations for 15 August (slow); writes public/data/scenarios.json
```

### Simulated buses

The **Display** tab has a **Simulated buses** switch and a speed setting. Lothian buses run on every route, each looping end to end and back at the running times of the published timetable, spaced at a regular headway. **This is a simulation, not live positions**, and the headways come from one typical weekday. Build the data once (a public ~290 MB timetable download, no key, cached in `../lothian/`):

```sh
make buses              # writes web/public/data/lothian.json
```

Without that file the map works as before and the switch is greyed out.

**Simulated cars** (same tab) put the car engine on the Edinburgh street network, in a Web Worker: cars follow each other with a charged-particle rule, change lanes, queue at the 88 signalised junctions from OpenStreetMap and choose turns at random. They are drawn as small 3D cars (enlarged when zoomed out, not drawn below zoom 12), coloured by driver personality (aggressive, neutral, calm, error-prone). **Not real traffic**: no traffic counts or live feed are used, so how many cars there are and where is a modelling choice. Build the road graph once (an Overpass query, cached; public servers sometimes answer 502 and the fetch retries):

```sh
make cars               # writes web/public/data/roads.json; the pilot area only
```

Two honest limits. The pilot area is the only part with cars (`AREA=full make cars` is supported but untested). And the engine **gridlocks**: on this dense street grid, queues spill back round a block until a ring of full roads waits on itself and never clears, even at 6% of capacity. So a car stopped for over 90 s is moved to a free road (SUMO-style teleporting; the panel shows how many). Without that, 90% of cars are stuck within half an hour, which `web/src/cars.test.ts` keeps as a regression test. Cars run at most 60x however fast the buses are set. The engine is in `web/src/engine/`.

**Buses and cars affect each other** (on by default when both layers are showing). Once a second each side reads the other. A bus stopped at a stop lowers the speed of the road it is on to 30% of its limit (a moving bus to 80%), which the car engine reads every step, so cars queue behind it; the buses are snapped to the road within 20 m and travelling the same way. In the other direction, cars crowd a bus's 150 m cell (a car counts for 0.35 of a bus) and a queue of crawling cars holds it up by up to half. The congestion glow counts buses and cars together. These factors are placeholders, and this is a heuristic on road speeds, not a model of lanes: a bus does not physically block a lane, nothing overtakes it, and the two run on their own clocks (buses up to 200x, cars up to 60x), so they are coupled in real time rather than simulated time. Delay a bus causes is counted in the cars' delay figures (they are measured against the road's own speed, not the lowered one).

**Traffic effects** (on by default, same tab) make the buses interact instead of replaying the timetable: buses on a route follow each other with a charged-particle rule, queue at stops, and bunch up as random delays and longer boarding for late buses accumulate; and buses slow down where many routes share a street, with a red glow where several are crawling together. Turn it off for the plain timetable replay. All the constants are placeholders, not calibrated against real bus data (`web/src/traffic.ts`). The pipeline and the standalone viewer are described in [../lothian/README.md](../lothian/README.md).

**Cost of traffic** (the Impact tab) puts a modelled price on slow traffic as a simulated day runs from 06:00: working time lost (people held up times a value of time), fuel burnt (standing still and driving) and carbon emitted (litres times a factor, then valued per tonne), for cars and buses, with generated sentences about the day so far. The cars' sums come from the worker (time below the speed a car would choose on a clear road, time at a standstill, distance), the buses' from the fleet's current rates, so the totals do not depend on how fast the simulation is set. The Scenario tab has two sliders, **bus frequency** (a multiple of the Lothian timetable) and **car traffic** (a multiple of an hourly profile that peaks at 08:00 and 17:00); they are independent, so more buses do not remove cars. **Every constant is a placeholder** in `config/economics.yaml` (each names the published source to check it against), the simulated cars are a sample scaled by `fleet_scale`, and the figures are illustrative, not measurements. Build the constants once (this is the one exception to the no-cost rule, see `CLAUDE.md` rule 6):

```sh
make economics          # writes web/public/data/economics.json
```

**Fringe street closures** (Scenario tab, on by default) close the Old Town streets the council bans vehicles from in August, at its hours (for example High Street 10:30 to 24:00 on weekdays and 10:30 to 21:00 at weekends), using one typical Fringe weekday, Saturday or Sunday chosen by the Explore tab's day type. The cars drive round them; closed streets are drawn as red dashed lines and named in the Impact commentary. Build the data once (it reads `../closures/out`):

```sh
make closures           # writes web/public/data/closures.json
```

Only cars are affected: buses still drive the timetable's shapes through closed streets (Lothian's real diversions are not modelled), and a closure only shows where its street is in the car road graph (the map says how many are not). Hours are the council's, hand-transcribed; short-term event closures are not included.

## Configuration

The basemap defaults to a flat background with no key. To use another keyless style, copy `.env.example` to `.env` and set `VITE_BASEMAP_STYLE_URL`. That value is compiled into the page and is public, so never put a secret in it.

Twelve iconic buildings (spires, towers, monuments) are listed in `config/landmarks.csv` and drawn with stepped towers so the skyline reads correctly; everything else uses the automatic LiDAR height.

Where OpenStreetMap and the footprint data leave ground empty, `make infill` adds **inferred** buildings (real structures seen in the LiDAR, and standard frontage buildings beside mapped ones). They are drawn in a lighter tone and never mixed into the mapped buildings. Parks, gardens, rail, water, trees and slopes stay empty. See `docs/infill.md`.

Model parameters live in `config/`. Each value is tagged with its origin (placeholder, literature, calibrated or assumption).

## Data and attribution

See `DATA_SOURCES.md` for every dataset, its licence, access date and checksum. Contains OpenStreetMap data (ODbL), Overture Maps data, LiDAR for Scotland and Scotland's Census 2022 data (Open Government Licence v3.0).
