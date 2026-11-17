// The Cell Transmission Model experiment (engine/ctm.mjs): conservation, capacity, bottlenecks, signals and closures on small synthetic roads.
import { describe, expect, it } from 'vitest';
import { CarSim, GREEN, type Roads } from './engine/car-sim.mjs';
import { CellModel } from './engine/ctm.mjs';
import { gridRoads } from './grid-roads.testutil';

const STEP = 0.001; // degrees of longitude per node: about 63 m at this latitude

/** A one-way line of roads, one per entry of `spec` = [lanes, class index, metres], nodes 0..n. Node `signal` (if any) has a signal. */
function line(spec: [number, number, number][], signal?: number): Roads {
  const edges = spec.map(([lanes, cls, metres], i) => {
    const lon = -3.19 + i * STEP;
    return [i, i + 1, cls, lanes, 13.4, 0, 0, metres, [lon, 55.95, lon + STEP, 55.95], i + 1, 0];
  });
  return { bbox: [-3.2, 55.94, -3.17, 55.97], classes: ['primary', 'residential'], nodes: spec.length + 1, names: [''], signals: signal === undefined ? [] : [signal], edges };
}

const HOUR = 3600;
/** Runs a model with a source into the first road and a sink at the end, and returns the vehicles per hour that left in the last `window` seconds. */
function discharge(model: CellModel, sink: number, seconds: number, window: number): number {
  model.setSinks([sink]);
  model.advance(seconds - window);
  const before = model.stats().exited;
  model.advance(window);
  return ((model.stats().exited - before) / window) * HOUR;
}

describe('cell transmission model', () => {
  it('conserves vehicles in a closed network, never goes negative and never overfills a cell', () => {
    const model = new CellModel(gridRoads(6), { population: 150 });
    expect(model.mass()).toBeCloseTo(150, 6);
    for (let k = 0; k < 40; k++) {
      model.advance(30);
      expect(model.mass()).toBeCloseTo(150, 6);
    }
    for (let c = 0; c < model.cells; c++) {
      expect(model.n[c]!).toBeGreaterThanOrEqual(-1e-9);
      expect(model.n[c]!).toBeLessThanOrEqual(model.room[c]! + 1e-9);
    }
  });

  it('refuses a population that does not fit at half of jam density', () => {
    expect(() => new CellModel(gridRoads(2), { population: 5000 })).toThrow(/fit/);
  });

  it('is deterministic', () => {
    const run = () => {
      const m = new CellModel(gridRoads(5), { population: 80, seed: 3 });
      m.advance(300);
      return Array.from(m.n);
    };
    expect(run()).toEqual(run());
  });

  it('passes a flow below capacity at free-flow speed with no queue', () => {
    const roads = line([[1, 0, 300], [1, 0, 300]]);
    const model = new CellModel(roads);
    model.setSource(0, 600); // primary, one lane: capacity 1200 veh/h
    const rate = discharge(model, 2, 600, 200);
    expect(rate).toBeGreaterThan(570);
    expect(rate).toBeLessThan(630);
    expect(model.stats().waiting).toBeLessThan(1);
    expect(model.edgeSpeed(0)).toBeCloseTo(13.4, 1);
  });

  it('discharges at the road capacity when more wants in, and the rest waits outside', () => {
    const roads = line([[1, 0, 300], [1, 0, 300]]);
    const model = new CellModel(roads);
    model.setSource(0, 3000);
    const rate = discharge(model, 2, 600, 200);
    expect(rate).toBeGreaterThan(1200 * 0.95);
    expect(rate).toBeLessThan(1200 * 1.05);
    expect(model.stats().waiting).toBeGreaterThan(100);
  });

  it('a lane drop is a bottleneck: the discharge is the narrow road capacity and the queue backs up the wide one', () => {
    const roads = line([[2, 0, 400], [1, 0, 300], [1, 0, 200]]);
    const model = new CellModel(roads);
    model.setSource(0, 2200); // under the two lane capacity (2400), over the one lane capacity (1200)
    const rate = discharge(model, 3, 900, 300);
    expect(rate).toBeGreaterThan(1200 * 0.93);
    expect(rate).toBeLessThan(1200 * 1.07);
    expect(model.occupancy(0)).toBeGreaterThan(0.6); // the wide road is filling: spillback
    expect(model.occupancy(2)).toBeLessThan(0.2); // downstream of the bottleneck it flows freely
    expect(model.edgeSpeed(2)).toBeCloseTo(13.4, 1);
  });

  it('slower and narrower classes pass fewer vehicles', () => {
    const rates = [0, 1].map((cls) => {
      const model = new CellModel(line([[1, cls, 300], [1, cls, 300]]));
      model.setSource(0, 3000);
      return discharge(model, 2, 600, 200);
    });
    expect(rates[0]!).toBeGreaterThan(rates[1]! * 1.5); // primary 1200, residential 600
  });

  it('a signalised approach discharges the saturation flow during green only', () => {
    const model = new CellModel(line([[1, 1, 250]], 1)); // one residential road ending at a signal; vehicles leave the network at the stop line
    model.setSource(0, 3000);
    const rate = discharge(model, 1, 1800, 900); // ten whole 90 s cycles
    const expected = 1800 * (40 / 90); // saturation flow x green share
    expect(rate).toBeGreaterThan(expected * 0.9);
    expect(rate).toBeLessThan(expected * 1.1);
  });

  it('holds vehicles at a red light', () => {
    const model = new CellModel(line([[1, 1, 250]], 1));
    model.setSource(0, 900);
    model.setSinks([1]);
    model.advance(400); // a queue has formed and is discharging in cycles
    let moved = 0;
    for (let k = 0; k < 400; k++) {
      const before = model.stats().exited;
      const open = model.green(0);
      model.step();
      const crossed = model.stats().exited - before;
      if (!open) expect(crossed).toBe(0); // nothing crosses the stop line on red
      moved += crossed;
    }
    expect(moved).toBeGreaterThan(0); // and plenty does on green
  });

  it('shares the car engine signal timing', () => {
    const roads = gridRoads(5);
    const cars = new CarSim(roads, { population: 5, seed: 11 });
    const model = new CellModel(roads, { seed: 11 });
    for (let t = 0; t < 270; t += 3) {
      for (let e = 0; e < model.E; e++) expect(model.green(e, t)).toBe(cars.signalState(e, t) === GREEN);
    }
  });

  it('turn shares sum to one, or to nothing where every way on is closed, and a closed road gets none', () => {
    const roads = gridRoads(4);
    const model = new CellModel(roads);
    const sum = (e: number) => {
      let s = 0;
      for (let j = model.betaStart[e]!; j < model.betaStart[e + 1]!; j++) s += model.turn[j]!;
      return s;
    };
    for (let e = 0; e < model.E; e++) expect(sum(e)).toBeCloseTo(1, 9);
    const closed = [model.out[model.outStart[5]!]!];
    model.setClosed(closed, true);
    for (let e = 0; e < model.E; e++) {
      const node = model.to[e]!;
      for (let k = model.outStart[node]!, j = 0; k < model.outStart[node + 1]!; k++, j++) {
        if (model.out[k] === closed[0]) expect(model.turn[model.betaStart[e]! + j]!).toBe(0);
      }
      expect(sum(e)).toBeCloseTo(1, 9); // each junction here has another way on
    }
  });

  it('a closed road drains and takes nothing new, and no vehicle is lost', () => {
    const roads = gridRoads(5);
    const model = new CellModel(roads, { population: 120 });
    model.advance(120);
    const e = 12;
    model.setClosed([e], true);
    model.advance(300);
    expect(model.vehicles(e)).toBeLessThan(0.01);
    model.advance(300);
    expect(model.vehicles(e)).toBeLessThan(0.01);
    expect(model.mass()).toBeCloseTo(120, 6);
    model.setClosed([e], false);
    model.advance(600);
    expect(model.vehicles(e)).toBeGreaterThan(0); // reopened: traffic returns
  });

  it('speed is free flow up to the critical density and falls to zero at jam density', () => {
    const model = new CellModel(line([[1, 0, 300]]));
    const cellLength = model.cellLength[0]!;
    const perVehicle = (k: number) => k * cellLength; // vehicles in the cell at k vehicles per metre
    const critical = model.criticalDensity[0]!;
    expect(model.cellSpeed(0, perVehicle(critical * 0.5))).toBeCloseTo(13.4, 2);
    expect(model.cellSpeed(0, perVehicle(critical))).toBeCloseTo(13.4, 2);
    const jam = model.room[0]!;
    expect(model.cellSpeed(0, jam)).toBeCloseTo(0, 6);
    expect(model.cellSpeed(0, jam * 0.7)).toBeLessThan(model.cellSpeed(0, jam * 0.4));
  });

  it('an empty network reports free flow and no congestion', () => {
    const model = new CellModel(gridRoads(3));
    expect(model.stats()).toMatchObject({ vehicles: 0, congestedShare: 0, waiting: 0 });
    expect(model.edgeSpeed(0)).toBeCloseTo(13, 6);
  });
});
