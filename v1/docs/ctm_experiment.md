# Experiment: a Cell Transmission Model beside the car engine

Branch `ctm-experiment`. Status: **an experiment, off by default** (in the app only behind `?flow`). Everything below is a modelled estimate with placeholder
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

## Destinations, and seeing it (added after the first comparison)

The closed circulating setup above was the wrong test, so the model now has a **routed mode** (`setDestinations`): every vehicle belongs
to a destination (a venue's nearest junction, a gateway exit, or one of 16 "places" spread over the area) and splits at each junction by
the quickest way there. Vehicles enter at sources and leave at their destination. `web/src/flow-demand.ts` turns the festival's own trip
rates (`trip-demand.ts`) into sources: arrivals enter at their sector's gateways (locals anywhere) bound for their venue, departures start
at the venue and leave by a gateway, and a placeholder background (400 vehicles an hour per gateway sector) drives between gateways and
places. Drivers re-plan every minute by the speeds the roads are showing, so queues push traffic onto alternatives.

**Seeing it:** open the app with `?flow` in the address (for example `http://localhost:5173/?flow`). The simulated cars are replaced by
the flow: every road is tinted by how far below free-flow speed its traffic is moving (green, amber, red) and by how full it is, and dots
are carried along each road at its speed (`flow-dots.ts`, drawn by the existing 3D car layer). The festival panel's trips, the car-demand
slider, the speed control and the closures all drive it. The readout says what it is: modelled, and **one dot is about two vehicles, not a
vehicle**; nobody can follow or click one. The model runs on the main thread: it costs well under a millisecond a frame.

**What it showed on the real data** (`npx vite-node scripts/ctm-festival.ts`: Saturday 15 August, 18:00 to 24:00, real vehicles, modelled):

| closures | vehicles arriving at venues | vehicle-hours | vehicle-hours in queues | waiting outside at the end |
|---|---:|---:|---:|---:|
| off | 4,055 | 9,664 | 5,406 | 987 |
| on | 3,694 | 12,222 | 8,676 | 2,371 |

With the street closures on, fewer vehicles get to a venue, time spent in queues rises by about 60% and more traffic is left waiting at the
edge. The direction matches what a closure should do; the sizes rest on placeholders (the background flow and the travel-mode shares).

**Two faults found on the way, both worth knowing about:**
1. *First-in-first-out blocking locked the network.* At a junction I held a whole road back if any onward road was full. The route
   shares have thin tails (a way that is much slower than the best still gets a fraction of a percent), so any one full road stopped every
   stream that touched it, and the pilot gridlocked at 400 vehicles an hour. Each movement is now limited by its own onward road, as if
   every turn had a lane. The pilot then settles at a steady level instead of degrading, and a test pins this.
2. *A queue upstream of a choice cannot be steered round.* A jam that forms on the road feeding a junction holds vehicles that have
   already chosen; rerouting only helps where the queue is on the branch itself, as at a signalised approach. That is realistic, and it
   means diversion needs the choice to be made a junction earlier, which the one-minute re-planning does.

## What a CTM is good and bad at, for this project

Good:
- **Capacity is a parameter.** The plan's phase 3 needs per-class capacity checked against observed flow. Here it is one number per
  class, set to match counts; in the car engine it emerges from car-following and has to be tuned by trial.
- **It is cheap and scales with the network, not the fleet.** A council-wide graph (the plan's 15,000 to 25,000 edges) would cost about
  1 ms per step. That fits a phone far more easily than 6,000 individually simulated cars.
- **Congestion is the output, not a by-product:** density, speed and queue length per road, already in the form a heat map wants.
- **It answers the festival question directly:** with destinations it takes the same trip rates and closures as the car engine and says
  where queues form and how many arrive.

Bad:
- **No vehicles.** Nothing to follow, click or send to a venue; the dots only draw the flow. Your priority was a visual app, and the car
  engine's individual cars are what make it feel alive.
- **Junction rules are crude.** Each movement has its own limit and priority is shared in proportion to demand, with no give-way and no
  turn conflicts. The car engine also has none ("no turn bans or conflicts"), but SUMO does.
- **Routing is a placeholder.** Static shortest paths with a logit spread, re-planned every minute; no equilibrium, no learning.
- **Nothing here is calibrated.** Capacities, the background flow and its split are placeholders. The DfT counts in
  `docs/traffic_counts.md` are what to calibrate against, and the centre has too few count points to do it well.

## Recommendation

1. Keep the car engine for what the app is for: visible cars in the centre.
2. Offer the flow view (`?flow`) as the alternative that answers "where do the queues form and what does a closure do", cheaply and city-wide.
   If the city-wide plan goes ahead, a CTM is the natural model for the background traffic outside the centre, fed into the car engine's
   area at its edge.
3. Before relying on either for a result, calibrate capacity and the background to the DfT counts, and say so.

## SUMO

Not worth adding as a dependency: it is a native program, so it cannot run in the browser or on a phone, which is the point of this
project. It would be worth one offline run as a **reference**: SUMO imports OpenStreetMap, has validated car-following, junction priority
and routing, and its per-road flows and speeds on the same area would show how far each of our two engines is from an accepted one. That
is what was suggested ("a reference for junction rules"), and it costs about a day, mostly set-up. Comparing both engines against the
DfT counts first is cheaper and says more about Edinburgh.
