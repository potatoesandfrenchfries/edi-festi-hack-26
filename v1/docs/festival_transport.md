# Festival surge and the cost of getting there

The story: for four weeks in August Edinburgh's population jumps, and the surge lands on a street network and a bus system sized for an ordinary month. This part of the project shows **where the extra people are**, sends **their cars to the venues the tickets name**, and tries **different council choices** (more buses, park-and-ride, street closures) to see which loses the least time, fuel and carbon.

Everything here is a modelled estimate. Counts come from the 2026 ticket extracts; everything that decides what a count means (how people travel, where Fringe venues are, how full the beds are) is an assumption in `config/`, tagged `placeholder` or `assumption`.

## What is real and what is assumed

| Piece | Comes from | Real or assumed |
|---|---|---|
| Audience at each venue, by date and 15-minute slot | Fringe, EIF and Tattoo 2026 ticket counts (`pipeline/stage10_demand.py`) | Counts are real. Arrival (30 min before) and leaving (20 min after) times are assumptions. Show length is a placeholder for the Fringe (the extract has a start only) and for EIF. |
| Where EIF and Tattoo venues are | The festivals feed (`edinburgh_festivals` MCP); three EIF venues are approximate | Real positions, except The Lyceum, Edinburgh Playhouse and Playfair Library (marked in `config/venues.csv`). |
| Where **Fringe** venues are | Nowhere: the Fringe extract has numeric venue ids only and the feed refuses a Fringe key | **Assumed.** Each venue id is put on one of eight hub centres in `config/demand.yaml`, largest first, to match placeholder shares. The largest Fringe venue id (630,000 tickets, a third of the Fringe) lands wholly on one hub, which makes that hub too big. |
| Where bookers live | Postcode area (EIF, Tattoo) and country (Tattoo) | Real. The Fringe extract has neither, so it borrows the equal-weight mean of the other two (a large assumption: EIF is 26% staying visitors, the Tattoo 87%). |
| Beds | Council short-term-let register (4,151 issued licences, 16,360 beds, maximum occupancy per licence); hotels, guest houses, hostels and halls from OSM and Overture tags | Licences are real; they are placed by postcode, not address. Hotel and hall beds are estimated from floor area. The city-wide hotel bed total is a placeholder (the tag-based estimate for the whole council area is 32,000 hotel beds against the placeholder 30,000, a reassuring cross-check, not a validation). |
| How people travel | `config/transport.yaml` | **Placeholders**: car and bus shares by kind of booker, car occupancy, bus capacity, how many riders a full bus turns away who then drive. No travel survey is used. |
| Traffic | The car engine, on the OSM road graph of the Old and New Town, with the Lothian timetable's buses | Engine is real code; the traffic it carries is a sample scaled up by a placeholder (`sim_scale`). |
| Prices | `config/economics.yaml` | Placeholders (value of time, fuel, carbon). |

## The headline layer (Explore tab)

Pick a date (3 to 31 August) and an hour. Buildings are shaded by the **festival surge**: the extra people the festivals put in each one. Two sources:

- **Audiences at venues**, from ticket counts. Venues that have a building footprint (16 across the whole council area) are shaded; Fringe hubs and the Castle Esplanade have no footprint and are drawn as translucent discs sized by the crowd.
- **Extra guests in beds**: beds in hotels, halls and licensed lets, times the occupancy the festival adds above a base level (`occupancy.base`, 65%), times the share of guests in the building at that hour (`night_profile`). Occupancy that night is the base plus the night's staying visitors over every bed in the city, capped at 98%.

Clicking a building says how many of each it holds that hour.

## The cars (Scenario tab, and the map)

The engine's own traffic still wanders. On top of it, **festival cars** are made from the ticket counts, in the car worker (`web/src/trips.ts`, `trip-demand.ts`):

1. For each 15-minute slot, the people arriving at (or leaving) each venue are split by where they live (local, day-trip, staying) and by mode (`config/transport.yaml`). Riders a full bus turns away drive with some probability. Park-and-ride moves out-of-town drivers onto shuttle buses.
2. Locals start anywhere in the area; everyone else starts at the gateway road of their compass sector (shares from the ticket postcodes).
3. Each car is given an A* route to the nearest reachable road to its venue, drives it with the engine's car-following and signals, and parks. After the show the audience's cars go from the venue to a gateway.
4. Where a street closure cuts a venue off, the car parks at the nearest road it can reach and its driver **walks the rest**; that walk is a cost.

Cars gave up after 40 minutes are counted (`abandoned`). The simulated day starts at 17:00 when festival data is loaded, so audiences arrive within minutes of watching.

## Testing configurations (`web/src/scenario.ts`)

One run puts the evening (18:00 to midnight, including the Tattoo's 23:00 exit) through the engine with the buses and closures coupled in, and prices it:

- **time**: delay in traffic, walking from where a closure made drivers park, hours lost by riders turned away from full buses, and the extra minutes park-and-ride adds, at the value of time;
- **fuel and carbon**: cars (idle and driving) and the *change* in bus running relative to today (only the share that serves the festival area), plus shuttle bus-kilometres.

The levers are **bus frequency** (×0.5 to ×3), **park-and-ride** (0 to 60% of out-of-town drivers) and **Fringe street closures** (on or off). `npm run scenarios` runs every combination for 15 August (the busiest day) and writes `web/public/data/scenarios.json`; the Scenario tab shows the cheapest configurations, what the festival adds beyond a no-festival run of the same evening, and a button that applies a row to the live map.

A run is deterministic. A full sweep takes a long time (about a minute per configuration); `--quick` runs a small grid, `--time` runs one evening.

## What the sweep says (with the placeholder inputs)

For Saturday 15 August, 18:00 to midnight, 30 configurations plus a no-festival reference (`web/public/data/scenarios.json`, built 2026-10-30):

| | Today's choices | Cheapest: buses ×2 | Lowest carbon: buses ×0.5 |
|---|---|---|---|
| Total cost of the evening | £210k | £184k (−12%) | £292k (+39%) |
| What the festival adds on top of the no-festival evening (£149k) | £61k | £35k (−42%) | £143k |
| CO₂e | 54 t | 76 t (+23 t) | 43 t (−10 t) |
| Riders turned away by full buses | 5,100 | 0 | 15,700 |

- **Today's buses are too few for the evening.** A full bus turns riders away, and the time they lose (and the drivers some of them become) costs more than running more buses.
- **Cost and carbon pull apart.** The configuration that loses least money (more buses) emits more carbon, because the extra bus kilometres burn more fuel than the cars they replace. ×1.5 is the middle: £187k and 65 t. Which to pick depends on what a tonne of carbon is worth; the table in the app ranks by either.
- **Park-and-ride never paid** in these runs: the extra 20 minutes it adds for each traveller outweighed the road time it saved. It is the most placeholder-driven lever (shuttle time and shuttle capacity are guesses).
- **Closures only cost** here (+£2k to +£8k depending on the other levers), because the pedestrian benefit that justifies them is not valued, and drivers who park short walk the rest.

These rankings hold only as far as the placeholders in `config/transport.yaml` and `config/economics.yaml` do. Doubling the bus fleet's running for six hours is charged at 40% of the city's buses (`festival_routes_share`); change that, or the 0.5 hours a turned-away rider loses, and the order of the first few rows can change.

## What it brings in (`web/src/revenue.ts`)

Each run also reports the revenue the festival adds, from `config/revenue.yaml` (`make revenue`). Only the festival's own increment is counted, so the same evening without it earns nothing.

- **Bus fares**: riders who got on (riders wanting a bus less those a full bus turned away) times an average fare per boarding. Riders park-and-ride sends to shuttles pay the shuttle fare instead. More buses carry more riders, so they earn more.
- **Bus running**: the extra bus-kilometres against today's timetable (and the shuttles) at an operating rate, plus their fuel. Thinning the timetable shows as a saving. Fares less running is what a frequency choice does to the operator.
- **Visitor levy**: people who need a bed that night (`staying_people`) become room-nights, charged a share of an assumed August room rate. It is for the whole night, not the evening window, and it does not change with the levers: it is on the table so the losses can be read against it, not to rank configurations.
- **Parking**: cars arriving for the festival times the share that park in a council-charged space in the evening times a charge. Park-and-ride parking is taken to be free, so diverting drivers trades parking income for shuttle fares.

The revenue goes to the council and bus operators; the losses fall on drivers and riders. The two are shown side by side (the Revenue column and a sentence in the Scenario tab), never subtracted. The bus fuel in "running" is also inside the cost's fuel line, so do not add the two figures together.

Left out on purpose: VAT and income tax (they go to the Treasury, not the council), ticket income (it goes to the festivals), non-domestic rates and licence fees (paid whatever the festival does, so not an increment), and visitor spending in shops and restaurants (a wider-economy figure that needs displacement and leakage adjustments before it means anything).

## What to be careful about

- **Read the ranking more than the pounds.** The simulated cars are a sample (every one stands for `sim_scale` real vehicles) and the engine's delay against free-flow speed is large even without the festival, so absolute costs are large too. The festival's own cost is shown as the run less the same evening without it.
- **The objective leaves out benefits.** Closures are made for pedestrian safety and crowding, which are not valued here, so they can only look costly. More buses help only through fewer riders turned away.
- **Only the Old Town and New Town have cars.** Venues just outside the road area (the Queen's Hall, King's Theatre, Church Hill) are reached at the nearest road within 600 m; farther ones get no cars. The building layer covers the whole council area, but the cars and scenarios do not.
- **The festival is shown as a surge, not as everyone.** The old template population (floor area, not census) is still what the headline totals use; the shading shows only the festival's extra people.
- **The levy dominates the revenue and is the least certain part.** On 15 August the placeholders give about £130k of levy against about £64k of fares and £4k of parking. The levy rests on an assumed room rate, a paid share and a cap share; check the rate, start date and scope of Edinburgh's levy, and compare the result with the council's own projection of annual yield, before quoting it. The festival's marginal loss is also small beside it, because the engine's delay is large even without the festival (see the first point).
- **The short-term-let register's reuse terms are not stated** on the council page (see `DATA_SOURCES.md`). Verify before publishing derived data.

## Reproducing it

```sh
make demand            # ticket extracts in ../dataset -> web/public/data/demand.json (aggregates only)
make accommodation     # council short-term-let register -> data/interim/stl_beds.json
make transport         # config/transport.yaml -> web/public/data/transport.json
make revenue           # config/revenue.yaml -> web/public/data/revenue.json (run before the sweep for the Revenue column)
make tiles             # places the beds on buildings (rerun after accommodation)
make cars economics buses closures    # the road graph, prices, bus timetable and closures
cd web && npm run scenarios           # the sweep; slow
```
