import { describe, expect, it } from 'vitest';
import { BusRoadEffects, MOVING_BUS_FACTOR, STOPPED_BUS_FACTOR } from './car-bus-effects';
import { CarRunner } from './cars-runner';
import { BUS_FLOATS, BUS_MOVING, BUS_OFF_ROAD, BUS_STOPPED, type FromWorker } from './cars-protocol';
import { gridRoads } from './grid-roads.testutil';
import { CarSim } from './engine/car-sim.mjs';

function setup(population = 40) {
  const sim = new CarSim(gridRoads(), { population, seed: 5 });
  sim.reseed({ population });
  return { sim, effects: new BusRoadEffects(sim) };
}
/** Longitude, latitude and compass bearing of the middle of road `e` (the grid's roads are straight, two points each). */
function middle(sim: CarSim, e: number): [number, number, number] {
  const p = sim.ptStart[e] as number;
  const [lon0, lat0, lon1, lat1] = [sim.lon[p] as number, sim.lat[p] as number, sim.lon[p + 1] as number, sim.lat[p + 1] as number];
  const bearing = ((Math.atan2((lon1 - lon0) * sim.mPerLon, (lat1 - lat0) * sim.mPerLat) * 180) / Math.PI + 360) % 360;
  return [(lon0 + lon1) / 2, (lat0 + lat1) / 2, bearing];
}
const buses = (...bs: [number, number, number, number][]) => Float32Array.from(bs.flat());

describe('BusRoadEffects', () => {
  it('slows the road a stopped bus is on to its stopped factor, and leaves other roads alone', () => {
    const { sim, effects } = setup();
    const free = Float32Array.from(sim.speed);
    const [lon, lat, bearing] = middle(sim, 0);
    expect(effects.apply(buses([lon, lat, bearing, BUS_STOPPED]))).toBe(1);
    expect(sim.speed[0]).toBeCloseTo((free[0] as number) * STOPPED_BUS_FACTOR, 5);
    for (let e = 1; e < sim.E; e++) expect(sim.speed[e]).toBe(free[e]);
  });

  it('slows a moving bus\'s road less, and uses the strongest effect when several buses share a road', () => {
    const { sim, effects } = setup();
    const free = sim.speed[0] as number;
    const [lon, lat, bearing] = middle(sim, 0);
    effects.apply(buses([lon, lat, bearing, BUS_MOVING]));
    expect(sim.speed[0]).toBeCloseTo(free * MOVING_BUS_FACTOR, 5);
    effects.apply(buses([lon, lat, bearing, BUS_MOVING], [lon, lat, bearing, BUS_STOPPED]));
    expect(sim.speed[0]).toBeCloseTo(free * STOPPED_BUS_FACTOR, 5);
  });

  it('only affects the carriageway the bus is travelling on, by bearing', () => {
    const { sim, effects } = setup();
    // Road 0 and road 1 are the two directions of the same street.
    const [lon, lat, bearing] = middle(sim, 0);
    const free = Float32Array.from(sim.speed);
    effects.apply(buses([lon, lat, bearing, BUS_STOPPED]));
    expect(sim.speed[0]).toBeLessThan(free[0] as number);
    expect(sim.speed[1]).toBe(free[1]); // the opposite direction is not held up
    effects.apply(buses([lon, lat, (bearing + 180) % 360, BUS_STOPPED]));
    expect(sim.speed[0]).toBe(free[0]);
    expect(sim.speed[1]).toBeLessThan(free[1] as number);
  });

  it('ignores buses laying over, and buses nowhere near a road', () => {
    const { sim, effects } = setup();
    const [lon, lat, bearing] = middle(sim, 0);
    expect(effects.apply(buses([lon, lat, bearing, BUS_OFF_ROAD]))).toBe(0);
    expect(effects.apply(buses([lon + 0.0005, lat + 0.0005, bearing, BUS_STOPPED]))).toBe(0); // a block away from any street
  });

  it('puts a road back as soon as the bus leaves it, and clears everything on null', () => {
    const { sim, effects } = setup();
    const free = Float32Array.from(sim.speed);
    const [lon, lat, bearing] = middle(sim, 0);
    effects.apply(buses([lon, lat, bearing, BUS_STOPPED]));
    const [lon2, lat2, bearing2] = middle(sim, 6);
    effects.apply(buses([lon2, lat2, bearing2, BUS_MOVING]));
    expect(sim.speed[0]).toBe(free[0]);
    expect(sim.speed[6]).toBeLessThan(free[6] as number);
    expect(effects.apply(null)).toBe(0);
    expect(Array.from(sim.speed)).toEqual(Array.from(free));
    expect(effects.freeSpeed(6)).toBe(free[6]);
  });

  it('really slows the cars: with a stopped bus on every road they average far less than without', () => {
    const mean = (blocked: boolean) => {
      const { sim, effects } = setup(60);
      if (blocked) {
        const all: [number, number, number, number][] = [];
        for (let e = 0; e < sim.E; e++) all.push([...middle(sim, e), BUS_STOPPED]);
        effects.apply(buses(...all));
      }
      for (let i = 0; i < 600; i++) sim.step(0.2);
      return sim.stats().averageSpeedMps;
    };
    expect(mean(true)).toBeLessThan(mean(false) * 0.7);
  });
});

describe('the car worker', () => {
  const run = (busMessage: Float32Array | null | undefined) => {
    const messages: FromWorker[] = [];
    const runner = new CarRunner((m) => void messages.push(m));
    runner.handle({ type: 'init', roads: gridRoads(), population: 60, seed: 5 });
    runner.handle({ type: 'run', speed: 20, running: true, frameMs: 100 });
    if (busMessage !== undefined) runner.handle({ type: 'buses', data: busMessage });
    for (let t = 0; t <= 3500; t += 40) runner.tick(t);
    return messages.filter((m) => m.type === 'stats');
  };
  const everyRoad = () => {
    const sim = new CarSim(gridRoads(), { population: 1, seed: 1 });
    const all: [number, number, number, number][] = [];
    for (let e = 0; e < sim.E; e++) all.push([...middle(sim, e), BUS_STOPPED]);
    return buses(...all);
  };

  it('reports how many roads buses are slowing, and none when nothing is coupled', () => {
    const coupled = run(everyRoad()).at(-1);
    const alone = run(undefined).at(-1);
    if (coupled?.type !== 'stats' || alone?.type !== 'stats') throw new Error('no stats');
    expect(coupled.slowedByBuses).toBeGreaterThan(20);
    expect(alone.slowedByBuses).toBe(0);
    expect(BUS_FLOATS).toBe(4);
  });

  it('counts the delay buses cause as delay, against the road\'s own speed rather than the lowered one', () => {
    const delayRate = (data: Float32Array | undefined) => {
      const stats = run(data).filter((m) => m.type === 'stats');
      const total = stats.reduce((a, m) => a + (m.type === 'stats' ? m.delayCarSeconds : 0), 0);
      const seconds = stats.reduce((a, m) => a + (m.type === 'stats' ? m.simSeconds : 0), 0);
      return total / seconds;
    };
    expect(delayRate(everyRoad())).toBeGreaterThan(delayRate(undefined) * 1.5);
  });

  it('drops back to free-flowing roads when told the buses are gone', () => {
    const cleared = run(null).at(-1);
    if (cleared?.type !== 'stats') throw new Error('no stats');
    expect(cleared.slowedByBuses).toBe(0);
  });
});
