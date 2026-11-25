
# Plan: city-wide traffic at low density, and road capacity

Status (updated 25 November 2026): **phase 1 is built, phase 2 is partly built, phases 3 to 5 are not.**

- **Phase 1, done.** The DfT counts are fetched and matched to the road graphs (`pipeline/fetch_dft_counts.py`, `pipeline/stage14_counts.py`,
  results in `traffic_counts.md`; 110 count points, only 4 of them inside the pilot box), and the council-area graph is built in three zones
  (`config/roads.yaml` `zones`, `roads_full.json`). The pilot graph is unchanged.
- **Phase 2, partly done.** Cars are placed by **zone density** (`cars.zone_density_per_km`: 8, 3 and 1.2 cars per directed km in the core, ring
  and outer city, about 3,200 cars), not yet by observed flow; the worker keeps each zone near its share; festival cars still enter at the edge
  of the core and ring; the app loads `roads_full.json` when it exists (`?area=pilot` for the centre only). **Not done:** placement weighted by
  the matched counts (`flows.json`), the performance budget at 3,000, 6,000 and 10,000 cars, and per-car weights in the cost accounting
  (section 3.2), so the cost figures still treat every car as `sim_scale` vehicles.
- **Phases 3 to 5, not started:** per-class capacity, the give-way rule, validation against counts, the re-run sweep.

Figures marked *(measure)* are estimates to be replaced by a measurement; values marked *(verify)* come from general traffic-engineering
practice and must be checked against a source before they go in a config file.

## 1. Why

Two weaknesses of the car simulation, both visible in the app:

1. **The cars exist only in the centre.** The road graph covers the Old Town and New Town (a 2.4 x 2.1 km box): 1,973 directed roads, 137 km,
   954 junctions, 88 of them signalised, with 1,141 cars (6% of a capacity of 19,025). Nothing outside that box can carry a car, so
   there is no background traffic in the rest of the city and festival cars all start at the box's edge or on a random road inside it.
2. **All roads behave alike.** A road differs from another only by its speed limit, its number of lanes, whether its end is signalised and a
   guessed class weight used to place cars (`POPULARITY` in `web/src/engine/car-sim.mjs`). Cars follow each other with the same rules
   everywhere, so a single-lane residential street and a three-lane primary road with the same limit move traffic alike.
   Nothing in the model is calibrated against traffic counts (`config/roads.yaml` says so).

**Goal.** Cars across the whole City of Edinburgh area, densest in the centre and sparse elsewhere; and each road with a capacity that depends
on what kind of road it is, checked against observed flows.

**Not goals.** Live traffic, route choice by congestion, parking, pedestrians, or a city-wide festival surge model (the surge stays in the
centre; the outer cars are background and a source of arriving festival traffic).

## 2. What exists now (so the plan builds on it)

| Piece | Where | Relevant detail |
|---|---|---|
| Road fetch, per area | `pipeline/fetch_osm_roads.py`, `pipeline/common.py` (`overpass_boxes`) | `PRESENCE_AREA=full make cars` already fetches the council area (bbox 23 x 21 km) in several Overpass boxes; one class list (`config/roads.yaml`). |
| Graph build | `pipeline/stage08_roads.py` | Splits ways at junctions, snaps signals within 25 m, sets population = 6% of capacity, capped at 6,000. |
| Cars | `web/src/engine/car-sim.mjs`, `cars-runner.ts`, `cars.worker.ts` | Cars placed by lane-km x class weight; weighted random turns; A* only for detours; ~0.3 ms per 0.2 s step at 1,100 cars. |
| Festival trips | `web/src/trips.ts` | Gateways are roads crossing the outer 12% ring of the *graph's* bounding box, grouped north / west / south. |
| Costs | `scenario.ts`, `impact.ts` | One `sim_scale` (5 real vehicles per simulated car) for every car. |

## 3. Design

### 3.1 One graph, two levels of detail

Keep a single directed graph so the engine is unchanged in kind, but fetch and keep different road classes by zone:

- **Core**: the existing pilot box plus a buffer (about 500 m): every class in `config/roads.yaml`, as now.
- **Ring** (a wider box round the core, for example 3 km from the Old Town): motorway, trunk, primary, secondary and tertiary plus their links.
- **Outer city** (the rest of the council area): motorway, trunk, primary, secondary and their links only.

Roads that cross a zone boundary keep the more detailed treatment up to the boundary. The zone of each edge is stored in `roads.json` (a small
integer per edge) because later steps use it. Edge budget: aim for 15,000 to 25,000 directed edges *(measure in phase 1; the pilot is 1,973)*.
If the file is too large, ship it as a compact binary or gzip and decode in the worker (today `roads.json` is parsed on the main thread and
copied to the worker).

*Why not a second, coarse model for the outer city?* It would need a hand-off between two engines at the boundary. One graph needs none.

### 3.2 Density: a car budget spread by observed flow

Cars are placed in proportion to **flow x length** of each road, not lane-km x class. With a total budget of N cars:

1. A **core share** keeps today's density in the centre (about 8 cars per km). Start at today's 1,141 cars, so the centre does not look worse.
2. The rest goes to the ring and outer city, weighted by each road's flow (section 3.4). At 6,000 cars in total and about 10,000 directed km
   in the outer area *(measure)* that is thin, which is the intent: a few cars on every arterial, continuous enough to see.
3. N is set by a **performance budget** measured in phase 2 (steps per real second at 20x and 60x with 3,000, 6,000 and 10,000 cars), not by the old placeholder cap of 6,000.

Cars switch on and off with the car-demand slider and the hourly profile as now (`applyDemand`), per zone factor 1.

**Cost accounting has to change.** Today every simulated car stands for `sim_scale` = 5 real vehicles (`config/transport.yaml`). With zones,
a car in the outer city stands for many more real vehicles than one in the core. Each car therefore carries a **weight** (real vehicles per
simulated car, by zone, from the same flow data), and `account()` in `cars-runner.ts` sums delay and idle time weighted by it. Without this the
outer cars would be counted as if they were as rare as core cars and the cost figures would be wrong. Open question: whether the cost
objective should count the outer city at all; the festival's effect is in the centre, so an option is to cost only the core and the ring and
show the outer city for context. Decide in phase 3.

### 3.3 Capacity of roads

What "capacity" means here: the most vehicles per hour a road can pass in one direction, set by its type, lanes, speed and the junction at
its end. It must come out of the engine's own rules (so queues form where real ones do), not be a number pasted over the result.

**Model.** Give each edge parameters, derived from its class, lanes and speed and stored in `roads.json`:

- `headway` (the desired time gap, seconds) and a `reaction`/`min gap`, which together set the free-flow capacity per lane. The engine already has
  per-car `headway`, `minGap`, `pAccel`, `decel` (personalities, `personality.mjs`); the change is to scale them by an edge factor so a lane
  of a primary road passes more vehicles per hour than a lane of a residential street.
- **At signals**, capacity is set by the green share and the **saturation flow** (vehicles per hour of green per lane). The cycle is fixed at 90 s
  (40 s green per phase); the saturation flow comes from the headway, and the start-up lost time from `pAccel`.
- **At junctions without signals**, today cars merge freely ("no turn bans or conflicts", `car-sim.mjs`). Add a give-way rule where a minor
  road meets a major one (minor-road cars wait for a gap), using the class difference to decide which is minor. This is the largest engine change and
  can be a second step.
- **Lane changes and bus effects** stay as they are.

**Target values** (all in a new `config/capacity.yaml`, each with an origin tag per CLAUDE.md rule 8):

| Road type | Target capacity per lane | Origin |
|---|---|---|
| Signalised urban approach | about 1,800 veh/h of green *(verify)* | literature |
| Urban single carriageway, free-flowing | about 900 to 1,200 veh/h per direction *(verify)* | literature |
| Residential / living street | about 400 to 700 veh/h per direction *(verify)* | assumption |
| Motorway lane | about 2,000 veh/h *(verify)* | literature |

**Measuring what the engine does.** Add a harness (`web/src/capacity.test.ts` plus a script) that runs a one-lane ring road and a signalised
approach at saturating demand and reports the discharge rate in veh/h per lane for each class. The acceptance check is that each class lands
within about 15% of its target. Tune the edge factors until it does, then keep the harness as a regression test, so a later change that
silently halves capacity is caught.

### 3.4 Data

| Source | Use | Notes |
|---|---|---|
| [DfT road traffic counts, City of Edinburgh](https://roadtraffic.dft.gov.uk/local-authorities/29) | Annual average daily flow per count point, by vehicle type; relative flow by road; check on simulated flows | Open (OGL), bulk CSV/JSON and an API. Mostly major roads; daily, not hourly. Each figure is marked Counted or Estimated: use Counted. Confirm the direction columns first. |
| [City of Edinburgh Spatial Hub traffic count data](https://data.spatialhub.scot/dataset/traffic_count_data-ce) | Hourly or 15-minute profiles; junction turn counts for real turn splits in the centre; ANPR | OGL; survey packages from 2016 to 2025. Formats and centre coverage **not yet checked**. |
| [Transport Scotland automatic counter summaries](https://www.transport.gov.scot/media/41875/63-atc-key-summary-table-february-2018-draft.pdf) | Trunk roads only (A720 and so on) | PDF tables, so hand transcription; use only to check a few roads. |
| OpenStreetMap tags (`lanes`, `maxspeed`, `turn:lanes`, bus-lane tags, `junction`) | Lanes and speed per edge, bus lanes | Already fetched with the ways; the class list stays in `config/roads.yaml`. |

Capacity itself is not observed in any of these: counts show flow, not what the road could carry. It comes from the engineering values in 3.3.

**Matching counts to roads.** For each count point, take the nearest graph edge within 25 m with a compatible class, and the direction whose
bearing is closest to the count's direction (or both, split evenly, where the file gives a combined count). Record the match distance and
drop any match over 25 m or without a class match. Report how many count points matched and which roads are covered.

## 4. Phases

Each phase ends with its acceptance checks passing and a short report of what passed and what did not (CLAUDE.md rule 1). Commit each phase
on its own.

### Phase 1: counts and the larger graph, no engine change

1. **Fetch the DfT counts** for the City of Edinburgh (record in `DATA_SOURCES.md`: URL, licence, access date, checksum; report what was fetched, rule 3).
   Inspect the columns; keep Counted rows only; write `data/raw/counts/` (gitignored).
2. **`pipeline/stage14_counts.py`**: match count points to the *current* pilot graph and to a **full-area** graph, write
   `web/public/data/flows.json` (edge index, AADF, direction, match distance).
3. **Zoned graph build**: `config/roads.yaml` gets `zones` (core bbox + buffer, ring distance, classes per zone, each with an origin tag);
   `fetch_osm_roads.py` fetches the council area once (cached); `stage08_roads.py` filters by zone and writes the zone per edge. Print edges, km,
   lane-km and file size per zone. `PRESENCE_AREA=pilot` keeps working exactly as today.
4. **Tests**: matching (a synthetic road and count point), zone filter (a road in each zone keeps or loses its class as configured), the pilot graph is byte-identical to today's.

*Acceptance:* the share of count points matched, the edges and file size of the zoned graph, and a plot or table of counts against current class
weights (to see whether the guessed weights are even in the right order). Decide the edge budget from this.

### Phase 2: density and weights

1. **Placement by flow**: the engine takes per-edge placement weights (`reseed({ weights })` already accepts them) from `flows.json`: observed flow
   where matched, a per-class median from the matched roads elsewhere. Core share fixed as in 3.2.
2. **Performance budget**: measure steps per second and frame time at 3,000, 6,000 and 10,000 cars on the zoned graph at 20x and 60x; set the
   population and `max_population` from it; make A* (`DETOUR_LIMIT`) and any per-call scan over every road (`nearestSegment`,
   `nearestNodes`) work at the larger size (index them or limit the search).
3. **Gateways and local starts** (`trips.ts`): with a council-wide graph, an arrival from outside enters at the outer city's boundary, and a local
   starts anywhere in the ring or core, not at a random road in the centre.
4. **Tests**: placement follows weights (a statistical test as in `cars.test.ts`), population never exceeds capacity, determinism for a seed.

*Acceptance:* the app shows cars across the city, densest in the centre, at a frame rate you can still use; the core's cars per km is within 20% of today's.

### Phase 3: capacity

1. **`config/capacity.yaml`** with the target values (origin-tagged) and `stage08_roads.py` writing per-edge `headway` and friends.
2. **Engine**: apply the per-edge factors in car following and at signal stop lines (3.3). Keep the old behaviour behind a switch until the harness passes.
3. **Capacity harness** (3.3): discharge rate per lane for each class; tune until each is within about 15% of target.
4. **Weights in the cost accounting** (3.2) and the decision on costing the outer city.
5. **Give-way rule** at unsignalised junctions as a separate step, with its own tests and a before/after of average speed and stuck cars.

*Acceptance:* the harness passes; on the pilot area average speed, stuck cars and relieved cars stay in the same range as today (the engine's
average speed is about 13 km/h on an ordinary evening and about 750 cars are teleported per 30 simulated minutes, which is already a sign
the baseline is too jammed; do not make it worse, and note where it improves).

### Phase 4: validation against counts

1. Run the baseline day and compare **simulated flow per hour with the AADF-scaled hourly flow** on every matched edge (daily counts turned into
   hourly ones with the profile in `economics.json`, or with Spatial Hub profiles if they are usable).
2. Report the **GEH statistic** per edge (the usual UK check: GEH under 5 on at least 85% of links) and the share of matched roads whose
   simulated flow is within a factor of two of the count.
3. Tune zone shares and per-class weights, not individual roads. Record the residuals and say where the model is wrong; do not fit
   each count point.

*Acceptance:* a table in `docs/` of matched roads, count, simulated flow and GEH, with the share that pass. If few pass, say so; the model is
not a forecast of any one road.

### Phase 5: scenarios and docs

Re-run `npm run scenarios` (it will be slower with more cars; check the time per scenario first and reduce the car count for the sweep if needed),
update `festival_transport.md`, and compare the ranking of configurations before and after. The ranking is the finding; the pound figures are not.

## 5. Risks and open questions

- **The outer cars are a thin sample.** One simulated car there stands for many vehicles, so its random behaviour (a stuck car, a signal)
  moves the totals more than a core car's does. Cost the core and ring only, or smooth the outer city's contribution, if the sweep ranking turns
  out to depend on it.
- **Count coverage.** Counts cover major roads far better than residential streets; the core's side streets will rely on class medians.
  The Spatial Hub packages may fill the centre in; their coverage is unchecked.
- **Daily counts, hourly model.** AADF is a daily figure; turning it into hourly flows borrows a profile. That assumption must be labelled.
- **Engine cost.** More cars and per-edge parameters slow every step; the performance budget in phase 2 decides N, and the browser worker is the limit.
- **File size and load time** of a council-wide `roads.json` in the browser (phase 1 measures it; compress if needed).
- **The jammed baseline.** The relief that teleports stuck cars hides a model that jams at 12% of capacity. Capacity work may change this a lot;
  expect the sweep results to move.
- **OSM quality.** Lane counts and speed limits are missing on many ways; defaults are guesses (`config/roads.yaml`). Phase 1 should report how many edges rely on a default.

## 6. Conventions this plan follows

Every tunable lives in `config/` with an origin tag (`placeholder`, `literature`, `calibrated`, `assumption`); modelled values stay labelled as
estimates; every dataset is recorded in `DATA_SOURCES.md`; code and tests are written together in small functions; each phase is committed
separately; `PRESENCE_AREA=pilot` keeps working unchanged throughout.
