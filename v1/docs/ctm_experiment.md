# Experiment: a Cell Transmission Model beside the car engine

Branch `ctm-experiment`. Status: **an experiment, not wired into the app.** Everything below is a modelled estimate with placeholder
capacities; nothing is calibrated against traffic counts.

## What was built

`web/src/engine/ctm.mjs` is a Cell Transmission Model (Daganzo 1994) on the same `roads.json` graph the car engine reads. Each road is cut
into cells; each step a cell passes what it holds, up to the road's capacity, into the next cell if there is room. Three numbers per road
decide everything: free-flow speed (the posted limit), capacity per lane (by road class, placeholder values from the plan's section 3.3,
marked "verify" there) and jam density (one vehicle per 7.5 m of lane, the car engine's own slot size). Queues, spillback and the speed
of a shockwave come out of those.

It shares with the car engine: the graph, closures, the fixed-time signals (same 90 s cycle, same phase rule, same seeded offsets; a test
checks every road at every 3 s against `CarSim.signalState`) and the turn weights. It adds sources (vehicles entering a road, waiting
outside if there is no room) and sinks (junctions where vehicles leave).

`web/src/ctm.test.ts` (14 tests): conservation and no overfilling, determinism, flow below capacity passes at free-flow speed,
discharge at capacity when demand exceeds it (within 5%), a lane drop as a bottleneck with spillback (within 7%), class capacities, a
signalised approach discharging 1,800 veh/h x green share (within 10%), nothing crossing on red, closures draining, the speed curve.

`web/scripts/ctm-compare.ts` runs both engines on the pilot graph with the same population (`npx vite-node scripts/ctm-compare.ts`).

## What it showed (pilot graph, 1,141 vehicles, 20 simulated minutes, closed system)

| scenario | model | mean speed km/h | stuck cars (over 120 s) | vehicles in congested cells | wall ms per simulated second |
|---|---|---:|---:|---:|---:|
| open network | car engine | 8.5 | 639 | n/a | 0.82 |
| open network | cell model | 5.9 | n/a | 85% | 0.04 |
| High Street + Canongate closed (24 roads) | car engine | 8.4 | 552 | n/a | 0.85 |
| High Street + Canongate closed (24 roads) | cell model | 6.6 | n/a | 83% | 0.03 |

- **Speed of the computation:** the cell model is about 20 times cheaper per simulated second (6,986 cells at 2 s steps against 1,141
  cars at 0.2 s steps). Its cost follows road length, not the number of vehicles, so it does not slow as traffic grows.
- **Both jam, and that is the setup, not the models.** Vehicles circulate with no destination and turn by road weight, so they pile onto
  the heavily weighted roads (after an hour 41% of the cell model's vehicles are on primary roads, 8% of the road length) and the
  network drifts into gridlock at every population tried (100 to 1,141). The car engine does the same, which is why the app has gridlock
  relief. The plan's remark that the baseline "jams at 12% of capacity" is this effect. So the absolute speeds above say nothing about
  Edinburgh, and the two models agree only on the broad picture: the closure moves little in a network that is already jammed.
- **Where they agree on the detail: they barely do.** Per-road crowding correlates at Pearson 0.33 and Spearman 0.43 across the 1,973
  roads. Two models of a jammed random walk will differ, so this is no evidence that either is wrong.

## What a CTM is good and bad at, for this project

Good:
- **Capacity is a parameter.** The plan's phase 3 needs per-class capacity checked against observed flow. Here it is one number per
  class, set to match counts; in the car engine it emerges from car-following and has to be tuned by trial.
- **It is cheap and scales with the network, not the fleet.** A council-wide graph (the plan's 15,000 to 25,000 edges) would cost about
  1 ms per step. That fits a phone far more easily than 6,000 individually simulated cars.
- **Congestion is the output, not a by-product:** density, speed and queue length per road, already in the form a heat map wants.

Bad:
- **No vehicles.** Nothing to draw as a car, follow, give a venue to, or click on. Your priority was a visual app, and cars are what make
  it visual. A density-coloured road layer is visual, but it is a different picture.
- **No destinations as built.** Traffic splits at junctions by fixed ratios. A festival trip to a given venue needs origin-destination
  routing on top: the standard fix keeps one density per destination (a "multi-commodity" CTM) and splits by the shortest path to
  each. That is the missing piece for the festival story and is not built.
- **Junction rules are crude.** Priority is shared in proportion to demand, with no give-way. The car engine also has none ("no turn
  bans or conflicts"), but SUMO does.

## Recommendation

1. Keep the car engine for what the app is for: visible cars in the centre.
2. If the city-wide plan goes ahead, use a CTM for the **background traffic outside the centre** (it is cheap, and capacity can be
   calibrated to the DfT counts in `docs/traffic_counts.md`), and let it feed vehicles in at the edge of the car engine's area. That
   avoids simulating thousands of invisible cars.
3. Before relying on either for a festival result, add the destination layer and an open (source and sink) demand, so the model stops
   jamming for the wrong reason.

## SUMO

Not worth adding as a dependency: it is a native program, so it cannot run in the browser or on a phone, which is the point of this
project. It would be worth one offline run as a **reference**: SUMO imports OpenStreetMap, has validated car-following, junction priority
and routing, and its per-road flows and speeds on the same area would show how far each of our two engines is from an accepted one. That
is what was suggested ("a reference for junction rules"), and it costs about a day, mostly set-up. Comparing both engines against the
DfT counts first is cheaper and says more about Edinburgh.
