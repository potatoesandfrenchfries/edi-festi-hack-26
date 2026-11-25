// Runs the car engine and the Cell Transmission Model (src/engine/ctm.mjs) on the same road graph and the same population, and compares
// how fast each runs and what they say. Writes nothing; prints a report.
//   npx vite-node scripts/ctm-compare.ts [--minutes 30]
// Both are closed systems: vehicles circulate and choose turns by the same weights. The car engine is run without the app's gridlock
// relief, so a jam stays a jam. An experiment, not a calibration: neither side is checked against traffic counts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CarSim, type Roads } from '../src/engine/car-sim.mjs';
import { CellModel } from '../src/engine/ctm.mjs';

const roads = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/roads.json', import.meta.url)), 'utf8')) as Roads & { sim: { population: number; seed: number } };
const minutes = Number(process.argv[process.argv.indexOf('--minutes') + 1]) || 30;
const SECONDS = minutes * 60, WARMUP = 300, SAMPLE = 10, CAR_DT = 0.2, CELL_DT = 2;
const { population, seed } = roads.sim;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += (a[i]! - ma) * (b[i]! - mb); aa += (a[i]! - ma) ** 2; bb += (b[i]! - mb) ** 2; }
  return ab / Math.sqrt(aa * bb);
}
function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const out = new Array<number>(xs.length);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]![0] === order[k]![0]) j++;
    for (let m = k; m <= j; m++) out[order[m]![1]] = (k + j) / 2;
    k = j + 1;
  }
  return out;
}
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** Roads whose name is one of these: the Royal Mile and its neighbours, the closure a festival most plausibly makes. */
const CLOSED_NAMES = ['High Street', 'Canongate'];
const closedRoads = roads.edges.map((e, i) => (CLOSED_NAMES.includes(roads.names![e[10] as number] ?? '') ? i : -1)).filter((i) => i >= 0);

interface Run { speedKmh: number; gridlocked: number; vehicles: number; perEdge: number[]; msPerSimSecond: number; congested: number }

function runCars(closed: boolean): Run {
  const sim = new CarSim(roads, { population, seed });
  sim.reseed({ population });
  if (closed) sim.setClosed(closedRoads, true);
  const perEdge = new Array<number>(sim.E).fill(0);
  let samples = 0, speed = 0, gridlocked = 0;
  const started = performance.now();
  for (let t = 0; t < SECONDS; t += CAR_DT) {
    sim.step(CAR_DT);
    if (t >= WARMUP && Math.round(t / CAR_DT) % Math.round(SAMPLE / CAR_DT) === 0) {
      for (let i = 0; i < sim.n; i++) if (sim.active[i]) perEdge[sim.edge[i]!]!++;
      const s = sim.stats();
      speed += s.averageSpeedMps; gridlocked += s.gridlocked; samples++;
    }
  }
  const wall = performance.now() - started;
  return { speedKmh: (speed / samples) * 3.6, gridlocked: gridlocked / samples, vehicles: population, perEdge: perEdge.map((v) => v / samples), msPerSimSecond: wall / SECONDS, congested: NaN };
}

function runCells(closed: boolean): Run {
  const model = new CellModel(roads, { population, seed, dt: CELL_DT });
  if (closed) model.setClosed(closedRoads, true);
  const perEdge = new Array<number>(model.E).fill(0);
  let samples = 0, speed = 0, congested = 0;
  const started = performance.now();
  for (let t = 0; t < SECONDS; t += CELL_DT) {
    model.step();
    if (t >= WARMUP && Math.round(t / CELL_DT) % (SAMPLE / CELL_DT) === 0) {
      for (let e = 0; e < model.E; e++) perEdge[e]! += model.vehicles(e);
      const s = model.stats();
      speed += s.averageSpeedMps; congested += s.congestedShare; samples++;
    }
  }
  const wall = performance.now() - started;
  return { speedKmh: (speed / samples) * 3.6, gridlocked: NaN, vehicles: model.mass(), perEdge: perEdge.map((v) => v / samples), msPerSimSecond: wall / SECONDS, congested: congested / samples };
}

const f = (x: number, d = 1) => (Number.isNaN(x) ? 'n/a' : x.toFixed(d));
console.log(`Road graph: ${roads.edges.length} directed roads, ${roads.nodes} junctions, ${roads.signals?.length ?? 0} signalised. ${population} vehicles, ${minutes} simulated minutes, ${WARMUP} s warm-up.`);
console.log(`Cell model: ${new CellModel(roads, { dt: CELL_DT }).cells} cells at ${CELL_DT} s steps. Car engine: ${CAR_DT} s steps.\n`);

const results: Record<string, { cars: Run; cells: Run }> = {};
for (const closed of [false, true]) {
  const label = closed ? `closed: ${CLOSED_NAMES.join(' + ')} (${closedRoads.length} roads)` : 'open network';
  results[label] = { cars: runCars(closed), cells: runCells(closed) };
}
const labels = Object.keys(results);

console.log('| scenario | model | mean speed km/h | stuck cars (>120 s) | vehicles in congested cells | wall ms per simulated second |');
console.log('|---|---|---:|---:|---:|---:|');
for (const label of labels) {
  const { cars, cells } = results[label]!;
  console.log(`| ${label} | car engine | ${f(cars.speedKmh)} | ${f(cars.gridlocked, 0)} | n/a | ${f(cars.msPerSimSecond, 2)} |`);
  console.log(`| ${label} | cell model | ${f(cells.speedKmh)} | n/a | ${f(cells.congested * 100, 0)}% | ${f(cells.msPerSimSecond, 2)} |`);
}

const open = results['open network']!;
const lanesLength = roads.edges.map((e) => (e[3] as number) * (e[7] as number));
const cars = open.cars.perEdge.map((v, i) => v / lanesLength[i]!), cells = open.cells.perEdge.map((v, i) => v / lanesLength[i]!);
console.log(`\nPer-road crowding, open network (time-averaged vehicles per lane-metre, ${roads.edges.length} roads): Pearson ${f(pearson(cars, cells), 2)}, Spearman ${f(spearman(cars, cells), 2)}.`);
console.log(`Vehicles on the closed roads after the closure: car engine ${f(closedRoads.reduce((s, e) => s + results[labels[1]!]!.cars.perEdge[e]!, 0), 1)}, cell model ${f(closedRoads.reduce((s, e) => s + results[labels[1]!]!.cells.perEdge[e]!, 0), 1)} (open: ${f(closedRoads.reduce((s, e) => s + open.cars.perEdge[e]!, 0), 1)} and ${f(closedRoads.reduce((s, e) => s + open.cells.perEdge[e]!, 0), 1)}).`);
