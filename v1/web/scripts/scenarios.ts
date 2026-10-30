// Sweeps the council's levers for one festival date and writes public/data/scenarios.json.
//   npx vite-node scripts/scenarios.ts [date] [--quick]
// Slow (minutes): every combination is a full evening in the car engine. Needs the data from `make cars demand transport economics buses` (and `make revenue` for the revenue column).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BusData } from '../src/buses';
import type { CarData } from '../src/cars';
import { ClosureSchedule, type ClosureData } from '../src/closures';
import type { Demand } from '../src/demand';
import type { Economics } from '../src/impact';
import type { RevenueConfig } from '../src/revenue';
import { leverGrid, runScenario, sweep, TODAY, type Inputs } from '../src/scenario';
import type { Transport } from '../src/trip-demand';

const data = (name: string) => fileURLToPath(new URL(`../public/data/${name}`, import.meta.url));
const read = <T>(name: string): T => JSON.parse(readFileSync(data(name), 'utf8')) as T;
const optional = <T>(name: string): T | null => (existsSync(data(name)) ? read<T>(name) : null);

export function load(): Inputs {
  const roads = read<CarData>('roads.json');
  const closureData = optional<ClosureData>('closures.json');
  return {
    roads,
    demand: read<Demand>('demand.json'),
    transport: read<Transport>('transport.json'),
    econ: read<Economics>('economics.json'),
    busData: optional<BusData>('lothian.json'),
    revenue: optional<RevenueConfig>('revenue.json'),
    closures: closureData ? new ClosureSchedule(closureData, roads) : null,
  };
}

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-08-15';
const inputs = load();

if (args.includes('--time')) {
  const t = Date.now();
  const outcome = runScenario(inputs, { date, levers: TODAY, festival: true });
  console.log(`one evening in ${((Date.now() - t) / 1000).toFixed(1)} s`, JSON.stringify({ ...outcome, scenario: undefined }, null, 1));
} else {
  const frequencies = quick ? [1, 2] : [0.5, 1, 1.5, 2, 3];
  const parkAndRide = quick ? [0, 0.3] : [0, 0.3, 0.6];
  const result = sweep(inputs, date, leverGrid(frequencies, parkAndRide, [false, true]), (done, total) => console.log(`${done}/${total}`));
  const out = data('scenarios.json');
  writeFileSync(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), status: inputs.transport.status, ...result }) + '\n');
  const best = result.outcomes[result.best]!;
  console.log(`cheapest: ${JSON.stringify(best.scenario.levers)} £${Math.round(best.costs.total)} vs today £${Math.round(result.outcomes[result.today]!.costs.total)} -> ${out}`);
}
