import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, allBuses, busState, totalBuses, legProgress, pointAt, decodeShape } from './sim.js';

// Straight east-west shape, 12 steps of 0.01 degrees (~7.5 km). Leg 0 runs it with a 30 s dwell at A
// then 240 s to B; leg 1 is the same shape back to front would need its own shape, so reuse it.
const SCALE = 100000;
const shape = [-319000, 5595000, ...Array(12).fill([1000, 0]).flat()];
const leg = { shape: 0, stops: [0, 1], dists: [0, 7500], times: [0, 30, 270, 270], headsign: 'Somewhere' };
const data = (overrides = {}) => ({
  meta: { coordScale: SCALE, layover: 60 },
  stops: [[-3.19, 55.95, 'A'], [-3.07, 55.95, 'B']],
  shapes: [shape],
  routes: [{ name: '1', agency: 'LOTH', headway: 100, legs: [leg, leg], ...overrides }],
});

test('legProgress is monotonic, symmetric and pinned at the ends', () => {
  let prev = 0;
  for (let i = 0; i <= 100; i++) {
    const v = legProgress(i / 100, 120);
    assert.ok(v >= prev - 1e-12);
    prev = v;
  }
  assert.equal(legProgress(0, 120), 0);
  assert.equal(legProgress(1, 120), 1);
  assert.ok(Math.abs(legProgress(0.5, 120) - 0.5) < 1e-9);
  assert.ok(Math.abs(legProgress(0.2, 120) + legProgress(0.8, 120) - 1) < 1e-9);
  assert.ok(legProgress(0.02, 120) < 0.02, 'eases out of the stop');
});

test('pointAt interpolates along the shape and reports an easterly bearing', () => {
  const s = decodeShape(shape, SCALE);
  const mid = pointAt(s, s.cum[s.cum.length - 1] / 2);
  assert.ok(Math.abs(mid.bearing - 90) < 0.1);
  assert.ok(Math.abs(mid.lon - -3.13) < 1e-6, `midpoint of -3.19..-3.07, got ${mid.lon}`);
  assert.equal(pointAt(s, -50).lon, s.lon[0]);
});

test('cycle, bus count and spacing follow the headway', () => {
  const model = createModel(data());
  const r = model.routes[0];
  assert.equal(r.cycle, 2 * (270 + 60));
  assert.equal(r.count, Math.round(660 / 100)); // 7
  assert.ok(Math.abs(r.spacing - 660 / 7) < 1e-9);
  assert.equal(totalBuses(model), 7);
  // doubling frequency halves the headway
  assert.equal(createModel(data(), { frequency: 2 }).routes[0].count, Math.round(660 / 50));
});

test('a bus dwells, drives east, waits at the terminus, then drives the next leg', () => {
  const model = createModel(data());
  const r = { ...model.routes[0], offset: 0, spacing: 0 };
  const at = t => busState(model, r, 0, t);
  assert.ok(at(10).atStop && !at(10).layover && at(10).nextStop === 0);
  const a = at(60), b = at(200);
  assert.ok(!a.atStop && a.nextStop === 1 && a.lon < b.lon, 'moves east');
  assert.ok(at(280).layover && at(280).atStop, 'layover at the end of leg 0');
  assert.equal(at(280).leg, 0);
  assert.equal(at(340).leg, 1);
  assert.ok(!at(340 + 100).layover);
});

test('the loop repeats forever and buses are evenly staggered', () => {
  const model = createModel(data());
  const r = model.routes[0];
  const t = 123.4;
  const first = busState(model, r, 3, t), later = busState(model, r, 3, t + 5 * r.cycle);
  assert.ok(Math.abs(first.lon - later.lon) < 1e-9);
  const lons = allBuses(model, t).map(b => b.lon);
  assert.equal(new Set(lons.map(l => l.toFixed(6))).size > 1, true);
  assert.equal(allBuses(model, t).length, 7);
  assert.equal(allBuses(model, t, 1).length, 0, 'filter by route index');
});

test('negative times still give valid positions', () => {
  const model = createModel(data());
  for (const b of allBuses(model, -1234)) assert.ok(Number.isFinite(b.lon) && Number.isFinite(b.lat));
});
