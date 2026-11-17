// A festival evening in the cell model: the ticket-driven trip rates (trip-demand.ts) as sources and destinations, run with and without
// the festival street closures, on the real road graph. Prints a small table; writes nothing.
//   npx vite-node scripts/ctm-festival.ts [date]
// Modelled estimates from placeholder travel assumptions and a placeholder background flow; the point is the comparison, not the numbers.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CarData } from '../src/cars';
import { ClosureSchedule, type ClosureData } from '../src/closures';
import { dayTypeOf, slotAt, type Demand } from '../src/demand';
import { CellModel } from '../src/engine/ctm.mjs';
import { FlowDemand } from '../src/flow-demand';
import { planSlot, tripVenues, type Transport } from '../src/trip-demand';

const read = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8')) as T;
const roads = read<CarData>('roads.json'), demand = read<Demand>('demand.json'), transport = read<Transport>('transport.json');
const closureFile = existsSync(fileURLToPath(new URL('../public/data/closures.json', import.meta.url))) ? read<ClosureData>('closures.json') : null;
const closures = closureFile ? new ClosureSchedule(closureFile, roads) : null;
const date = process.argv[2] ?? '2026-08-15';
const day = dayTypeOf(date);
const venues = tripVenues(demand);
const [from, to] = [transport.simulation.trip_window_start_hour, transport.simulation.trip_window_end_hour];
const warm = transport.simulation.warmup_minutes * 60;
const DEPARTURES = transport.bus.fallback_departures_per_hour;

function run(closedOn: boolean) {
  const model = new CellModel(roads, { dt: 2, seed: roads.sim?.seed ?? 2026 });
  const flow = new FlowDemand(model, venues, roads.classes, { scale: transport.simulation.sim_scale });
  model.setAdaptive(true);
  let queueVehicleSeconds = 0, vehicleSeconds = 0, lastSlot = -1, closedKey = '';
  const arrived = new Float64Array(venues.length);
  for (let clock = from * 3600 - warm; clock < to * 3600; clock += 10) {
    const slot = slotAt(demand, clock);
    if (slot !== lastSlot) {
      lastSlot = slot;
      flow.setRates(planSlot(demand, transport, date, slot, { busFrequency: 1, parkAndRide: 0, closures: closedOn }, DEPARTURES).rates);
    }
    if (closedOn && closures) {
      const edges = closures.at(day, clock).edges, key = edges.join(',');
      if (key !== closedKey) { closedKey = key; model.setClosed(model.closed.reduce<number[]>((a, c, e) => (c ? [...a, e] : a), []), false); model.setClosed(edges, true); }
    }
    model.advance(10);
    if (clock >= from * 3600) {
      const s = model.stats();
      vehicleSeconds += s.vehicles * 10;
      queueVehicleSeconds += s.vehicles * s.congestedShare * 10;
    }
  }
  venues.forEach((_, v) => { const d = flow.venueDestination[v]!; if (d >= 0) arrived[v] = model.exitedBy[d]!; });
  const s = model.stats();
  return { arrivals: arrived.reduce((a, b) => a + b, 0), speed: s.averageSpeedMps * 3.6, queueHours: queueVehicleSeconds / 3600, waiting: s.waiting, vehicleHours: vehicleSeconds / 3600 };
}
console.log(`${date} (${day}), window ${from}:00 to ${to}:00 after ${transport.simulation.warmup_minutes} min warm-up; ${venues.length} venues. Real vehicles, modelled.`);
console.log('| closures | vehicles arriving at venues | vehicle-hours | vehicle-hours in queues | waiting outside at the end | mean speed at the end km/h |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const on of [false, true]) {
  const r = run(on);
  console.log(`| ${on ? 'on' : 'off'} | ${Math.round(r.arrivals)} | ${Math.round(r.vehicleHours)} | ${Math.round(r.queueHours)} | ${Math.round(r.waiting)} | ${r.speed.toFixed(0)} |`);
}
