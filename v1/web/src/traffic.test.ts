import { describe, expect, it } from 'vitest';
import { createModel, type BusData, type BusLeg, type BusModel } from './buses';
import { BUS_LENGTH, BusTraffic, MAX_SPEED, STEP_S, dwellSeconds, mulberry32, particleAcceleration, planLeg } from './traffic';

// A straight east-west road of 12 steps of 0.01 degrees (about 7.5 km). Six stops 1.5 km apart, 150 s between them (incl. dwell).
const SCALE = 100000;
const shape = [-319000, 5595000, ...Array.from({ length: 12 }, () => [1000, 0]).flat()];
const stops = [0, 1, 2, 3, 4, 5];
const leg: BusLeg = {
  shape: 0, stops,
  dists: stops.map((i) => i * 1500),
  times: stops.flatMap((i) => [i * 150, i * 150 + (i === 0 || i === 5 ? 0 : 15)]),
  headsign: 'Somewhere',
};
const world = (routes: number, headway: number): BusData => ({
  meta: { feedVersion: 'x', typicalDay: '2026-11-03', coordScale: SCALE, layover: 60, source: 'test' },
  stops: stops.map((i) => [-3.19 + i * 0.024, 55.95, `S${i}`] as [number, number, string]),
  shapes: [shape],
  routes: Array.from({ length: routes }, (_, i) => ({ name: String(i + 1), agency: 'LOTH' as const, headway, legs: [leg, leg] })),
});
const model = (routes = 1, headway = 120): BusModel => createModel(world(routes, headway));

/** Smallest bumper-to-bumper gap between buses that are on the same leg and out on the road. */
function tightestGap(t: BusTraffic): number {
  let tightest = Infinity;
  const on = t.snapshot().filter((a) => a.mode !== 'layover');
  for (const a of on) for (const b of on) if (a !== b && a.route === b.route && a.leg === b.leg && b.s > a.s) tightest = Math.min(tightest, b.s - a.s - BUS_LENGTH);
  return tightest;
}
const spread = (t: BusTraffic) => {
  // Coefficient of variation of the headway between consecutive buses on leg 0 of route 0, in metres.
  const s = t.snapshot().filter((a) => a.route.index === 0 && a.leg === 0 && a.mode !== 'layover').map((a) => a.s).sort((x, y) => x - y);
  const gaps = s.slice(1).map((v, i) => v - (s[i] as number));
  if (gaps.length < 2) return 0;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
};

describe('particleAcceleration (charged-particle rule)', () => {
  const p = (speed: number, gap: number, leaderSpeed = 0, desired = 12, target = 8) => particleAcceleration(speed, desired, gap, leaderSpeed, target, 1, 1.4, 3, STEP_S);
  it('speeds up towards the desired speed with nothing ahead, and eases off at it', () => {
    expect(p(5, 1e5)).toBeGreaterThan(0);
    expect(p(12, 1e5)).toBeCloseTo(0, 9);
    expect(p(15, 1e5)).toBeLessThan(0);
  });
  it('is attracted forward at a big gap and repelled when closer than the target gap', () => {
    expect(p(8, 60, 8)).toBeGreaterThan(0);
    expect(p(8, 4, 8)).toBeLessThan(0);
  });
  it('never brakes harder than the emergency limit and never exceeds the cruise term', () => {
    expect(p(20, 0.2, 0)).toBeGreaterThanOrEqual(-9);
    expect(p(5, 30, 10)).toBeLessThanOrEqual(1);
  });
  it('a bus driving at a stationary one stops short of it', () => {
    let gap = 120, v = 12;
    for (let i = 0; i < 600; i++) {
      v = Math.max(0, v + p(v, gap, 0) * STEP_S);
      gap -= v * STEP_S;
      expect(gap).toBeGreaterThan(0);
    }
    expect(v).toBeLessThan(0.3);
    expect(gap).toBeGreaterThan(2.5); // keeps its minimum gap
  });
});

describe('planLeg', () => {
  it('chooses cruise speeds below the maximum for an ordinary leg', () => {
    const plan = planLeg(leg, 120);
    expect(plan.dwellScale).toBe(1);
    expect(plan.speeds).toHaveLength(5);
    for (const v of plan.speeds) expect(v).toBeGreaterThan(5), expect(v).toBeLessThanOrEqual(MAX_SPEED);
  });
  it('shrinks the dwell, then caps speed, when the timetable is too tight for the stops', () => {
    const tight: BusLeg = { ...leg, times: stops.flatMap((i) => [i * 55, i * 55 + (i === 0 || i === 5 ? 0 : 15)]) };
    const plan = planLeg(tight, 120);
    expect(plan.dwellScale).toBeLessThan(1);
    for (const v of plan.speeds) expect(v).toBeLessThanOrEqual(MAX_SPEED);
  });
  it('dwell grows with the time since the last bus', () => {
    expect(dwellSeconds(600)).toBeGreaterThan(dwellSeconds(60));
    expect(dwellSeconds(-5)).toBe(dwellSeconds(0));
    expect(dwellSeconds(1e6)).toBe(dwellSeconds(900));
  });
});

describe('BusTraffic', () => {
  it('starts from the timetable layout with one agent per scheduled bus', () => {
    const m = model();
    const t = new BusTraffic(m);
    expect(t.snapshot()).toHaveLength(m.routes[0]!.count);
    expect(t.buses().every((b) => Number.isFinite(b.lon) && Number.isFinite(b.lat))).toBe(true);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const run = (seed: number) => { const t = new BusTraffic(model(), 0, { seed }); t.advanceTo(3000); return t.snapshot().map((a) => a.s.toFixed(3)).join(); };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  it('a lone bus takes about the timetabled time round the loop', () => {
    const m = model(1, 100000); // a headway so long there is a single bus
    expect(m.routes[0]!.count).toBe(1);
    const t = new BusTraffic(m, 0, { disturbances: false, congestion: 0 });
    const starts: number[] = [];
    let previous = t.snapshot()[0]!.mode;
    for (let i = 0; i < 20000 && starts.length < 5; i++) {
      t.step();
      const mode = t.snapshot()[0]!.mode;
      if (previous === 'layover' && mode === 'run') starts.push(t.time);
      previous = mode;
    }
    expect(starts.length).toBeGreaterThanOrEqual(5);
    const cycle = (starts[4]! - starts[2]!) / 1; // two legs, so two starts per cycle
    expect(cycle / m.routes[0]!.cycle).toBeGreaterThan(0.85);
    expect(cycle / m.routes[0]!.cycle).toBeLessThan(1.15);
  });

  it('never lets buses overlap, however long it runs', () => {
    const t = new BusTraffic(model(1, 70));
    let tightest = Infinity;
    for (let i = 0; i < 20000; i++) { t.step(); tightest = Math.min(tightest, tightestGap(t)); }
    expect(tightest).toBeGreaterThanOrEqual(-0.01); // the hard no-overlap rule leaves at least the bus's own length
  });

  it('spacing drifts into bunches when disturbed, but stays even when nothing disturbs it', () => {
    const calm = new BusTraffic(model(1, 90), 0, { disturbances: false, congestion: 0 });
    const rough = new BusTraffic(model(1, 90), 0, { congestion: 0 });
    const before = spread(rough);
    calm.advanceTo(3 * 3600, 100000);
    rough.advanceTo(3 * 3600, 100000);
    expect(spread(rough)).toBeGreaterThan(before + 0.1);
    expect(spread(rough)).toBeGreaterThan(spread(calm));
  });

  it('shared streets slow buses down, and the slowdown can be switched off', () => {
    const avg = (congestion: number) => {
      const t = new BusTraffic(createModel(world(8, 120)), 0, { congestion, disturbances: false });
      let sum = 0, n = 0;
      for (let i = 0; i < 4000; i++) { t.step(); if (i > 1000 && i % 20 === 0) { sum += t.stats().avgKmh; n++; } }
      return sum / n;
    };
    expect(avg(1)).toBeLessThan(avg(0) * 0.95);
  });

  it('flags a cell where several buses are crawling together', () => {
    const t = new BusTraffic(createModel(world(10, 60)), 0, { seed: 3 });
    let flagged = 0;
    for (let i = 0; i < 6000; i++) { t.step(); flagged = Math.max(flagged, t.congestionCells().features.length); }
    expect(flagged).toBeGreaterThan(0);
    const cell = t.congestionCells().features[0];
    if (cell) expect(cell.properties.intensity).toBeGreaterThan(0);
  });

  it('skips ahead instead of grinding when it has fallen far behind', () => {
    const t = new BusTraffic(model());
    const started = performance.now();
    t.advanceTo(1e7);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(t.time).toBe(1e7);
  });

  it('reports bus states in the shape the map layers use', () => {
    const t = new BusTraffic(model(), 0);
    t.advanceTo(400);
    const b = t.buses()[0]!;
    expect(b).toMatchObject({ id: '0:0', leg: expect.any(Number), atStop: expect.any(Boolean), layover: expect.any(Boolean), nextStop: expect.any(Number) });
    const stats = t.stats();
    expect(stats.buses).toBe(t.snapshot().length);
    expect(stats.avgKmh).toBeGreaterThanOrEqual(0);
  });
});

describe('mulberry32', () => {
  it('is a reproducible generator on [0, 1)', () => {
    const a = mulberry32(5), b = mulberry32(5);
    for (let i = 0; i < 50; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
});

describe('BusTraffic.rates', () => {
  it('reports distance driven and no delay for a free-flowing fleet', () => {
    const t = new BusTraffic(model(1, 300), 0, { disturbances: false, congestion: 0 });
    t.advanceTo(600);
    const r = t.rates();
    expect(r.buses).toBe(t.stats().buses);
    expect(r.metresPerSecond).toBeGreaterThan(0);
    expect(r.delayBuses).toBeLessThanOrEqual(r.idleBuses + 1e-9); // only buses standing in a queue are delayed
  });
  it('counts more delay when buses crowd one road', () => {
    const crowd = new BusTraffic(model(8, 120), 0, { disturbances: false });
    const calm = new BusTraffic(model(8, 120), 0, { disturbances: false, congestion: 0 });
    crowd.advanceTo(1800);
    calm.advanceTo(1800);
    expect(crowd.rates().delayBuses).toBeGreaterThanOrEqual(calm.rates().delayBuses);
    expect(crowd.rates().delayBuses).toBeLessThanOrEqual(crowd.rates().buses);
  });
  it('never has more standing buses than delayed ones', () => {
    const t = new BusTraffic(model(4, 120), 0);
    t.advanceTo(1200);
    const r = t.rates();
    expect(r.idleBuses).toBeLessThanOrEqual(r.delayBuses + 1e-9);
  });
});
