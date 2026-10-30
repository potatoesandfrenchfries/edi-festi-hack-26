import { describe, expect, it } from 'vitest';
import {
  allBuses, BusSimulation, busFeatures, busState, createModel, decodeShape, describeBus, legProgress, loadBusData, pointAt, timetableRates, totalBuses,
  type BusData, type BusLeg,
} from './buses';

// One straight east-west shape of 12 steps of 0.01 degrees (about 7.5 km); both legs reuse it.
const SCALE = 100000;
const shape = [-319000, 5595000, ...Array.from({ length: 12 }, () => [1000, 0]).flat()];
const leg: BusLeg = { shape: 0, stops: [0, 1], dists: [0, 7500], times: [0, 30, 270, 270], headsign: 'Somewhere' };
const data = (headway = 100): BusData => ({
  meta: { feedVersion: 'x', typicalDay: '2026-11-03', coordScale: SCALE, layover: 60, source: 'test' },
  stops: [[-3.19, 55.95, 'A'], [-3.07, 55.95, 'B']],
  shapes: [shape],
  routes: [{ name: '1', agency: 'LOTH', headway, legs: [leg, leg] }],
});

describe('legProgress', () => {
  it('is monotonic, symmetric and pinned at the ends', () => {
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const v = legProgress(i / 100, 120);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = v;
    }
    expect(legProgress(0, 120)).toBe(0);
    expect(legProgress(1, 120)).toBe(1);
    expect(legProgress(0.5, 120)).toBeCloseTo(0.5, 9);
    expect(legProgress(0.2, 120) + legProgress(0.8, 120)).toBeCloseTo(1, 9);
    expect(legProgress(0.02, 120)).toBeLessThan(0.02); // eases out of the stop
  });
});

describe('pointAt', () => {
  it('interpolates along the shape and heads east', () => {
    const s = decodeShape(shape, SCALE);
    const mid = pointAt(s, (s.cum[s.cum.length - 1] as number) / 2);
    expect(mid.bearing).toBeCloseTo(90, 0);
    expect(mid.lon).toBeCloseTo(-3.13, 6);
    expect(pointAt(s, -50).lon).toBe(s.lon[0]);
  });
});

describe('model', () => {
  it('derives cycle, bus count and spacing from the headway', () => {
    const model = createModel(data());
    const route = model.routes[0]!;
    expect(route.cycle).toBe(2 * (270 + 60));
    expect(route.count).toBe(7);
    expect(route.spacing).toBeCloseTo(660 / 7, 9);
    expect(totalBuses(model)).toBe(7);
    expect(totalBuses(createModel(data(), 2))).toBe(Math.round(660 / 50));
  });

  it('shows the running headway, not the timetable one, when the frequency is changed', () => {
    expect(createModel(data(120), 2).routes[0]!.headway).toBe(60);
    expect(createModel(data(120)).routes[0]!.headway).toBe(120);
  });

  it('dwells, drives east, waits at the terminus, then drives the next leg', () => {
    const model = createModel(data());
    const route = { ...model.routes[0]!, offset: 0, spacing: 0 };
    const at = (t: number) => busState(model, route, 0, t);
    expect(at(10)).toMatchObject({ atStop: true, layover: false, nextStop: 0 });
    expect(at(60)).toMatchObject({ atStop: false, nextStop: 1 });
    expect(at(60).lon).toBeLessThan(at(200).lon);
    expect(at(280)).toMatchObject({ layover: true, atStop: true, leg: 0 });
    expect(at(340).leg).toBe(1);
    expect(at(440).layover).toBe(false);
  });

  it('repeats forever, staggers buses evenly, and copes with negative time', () => {
    const model = createModel(data());
    const route = model.routes[0]!;
    expect(busState(model, route, 3, 123.4).lon).toBeCloseTo(busState(model, route, 3, 123.4 + 5 * route.cycle).lon, 9);
    const buses = allBuses(model, 123.4);
    expect(buses).toHaveLength(7);
    expect(new Set(buses.map((b) => b.lon.toFixed(6))).size).toBeGreaterThan(1);
    expect(allBuses(model, 0, 'nope')).toHaveLength(0);
    for (const b of allBuses(model, -1234)) expect(Number.isFinite(b.lon) && Number.isFinite(b.lat)).toBe(true);
  });
});

describe('map data', () => {
  it('writes one point per bus with operator colour, bearing and layover flag', () => {
    const buses = allBuses(createModel(data()), 50);
    const collection = busFeatures(buses) as { features: { properties: Record<string, unknown>; geometry: { coordinates: number[] } }[] };
    expect(collection.features).toHaveLength(buses.length);
    expect(collection.features[0]!.properties).toMatchObject({ id: '0:0', colour: '#D55E00', layover: expect.any(Boolean) });
    expect(collection.features[0]!.geometry.coordinates).toHaveLength(2);
  });

  it('describes a bus without claiming it is live', () => {
    const d = data(600);
    const content = describeBus(allBuses(createModel(d), 0)[0]!, d);
    expect(content.title).toBe('Route 1');
    expect(Object.fromEntries(content.rows)).toMatchObject({ Operator: 'Lothian Buses', Towards: 'Somewhere', Frequency: 'about every 10 min, simulated' });
    expect(content.flags[0]).toMatch(/not a live bus/);
  });
});

describe('loadBusData', () => {
  const respond = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body }) as Response) as typeof fetch;
  it('accepts built data', async () => {
    expect(await loadBusData(respond(data()), 'http://localhost/')).toMatchObject({ routes: expect.any(Array) });
  });
  it('returns null when the file is missing, malformed or the fetch fails', async () => {
    expect(await loadBusData(respond(null, false), 'http://localhost/')).toBeNull();
    expect(await loadBusData(respond({ routes: [] }), 'http://localhost/')).toBeNull();
    expect(await loadBusData((async () => { throw new Error('offline'); }) as typeof fetch, 'http://localhost/')).toBeNull();
  });
});

describe('timetableRates', () => {
  it('adds up the metres driven per second by the whole fleet, and delays nothing', () => {
    const model = createModel(data());
    const rates = timetableRates(model);
    const route = model.routes[0]!;
    // Two legs of 7.5 km per cycle, shared by the buses on the route.
    expect(rates.metresPerSecond).toBeCloseTo((route.count * 2 * 7500) / route.cycle, 9);
    expect(rates).toMatchObject({ buses: 7, delayBuses: 0, idleBuses: 0 });
  });
  it('doubles with twice the buses', () => {
    const base = timetableRates(createModel(data()));
    const twice = timetableRates(createModel(data(), 2));
    expect(twice.metresPerSecond).toBeGreaterThan(base.metresPerSecond * 1.8);
    expect(twice.metresPerSecond).toBeLessThan(base.metresPerSecond * 2.3);
  });
});

describe('BusSimulation frequency', () => {
  it('rebuilds the fleet at the new frequency and reports its driving rates', () => {
    const sim = new BusSimulation(data());
    const before = sim.rates();
    sim.setFrequency(2);
    expect(sim.model.routes[0]!.count).toBeGreaterThan(7);
    expect(sim.rates().buses).toBeGreaterThan(before.buses);
    sim.setFrequency(1);
    expect(sim.rates().buses).toBe(before.buses);
  });
  it('ignores a frequency that is not a positive number', () => {
    const sim = new BusSimulation(data());
    sim.setFrequency(0);
    sim.setFrequency(Number.NaN);
    expect(sim.model.routes[0]!.count).toBe(7);
  });
  it('keeps the traffic model in step with the new fleet', () => {
    const sim = new BusSimulation(data());
    sim.setTraffic(true);
    sim.setFrequency(2);
    expect(sim.trafficStats()?.buses).toBe(sim.model.routes[0]!.count);
  });
});
