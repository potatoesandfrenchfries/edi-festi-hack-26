// Bus simulation: pure functions over the data built by lothian/build.py. No clock or calendar.
//
// Every route has one *leg* per direction (shape, stops, each stop's distance along the shape, and
// arrival/departure seconds relative to the start) and a regular headway. A route's buses run a
// round trip (leg 0, layover, leg 1, layover) on a loop; with N = ceil(cycle / headway) buses spaced
// evenly around that loop, a bus leaves each terminus every `headway` seconds, forever.
// No DOM or map code, so it runs in the browser and under `node --test`.

const LAT_REF = 55.95;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos(LAT_REF * Math.PI / 180); // keep in step with lothian/build.py
const ACCEL_S = 12; // seconds a bus takes to pull away from / roll into a stop, at most

/** Decode delta-encoded integer shapes into lon/lat plus cumulative metres. */
export function decodeShape(flat, scale) {
  const n = flat.length / 2;
  const lon = new Float64Array(n), lat = new Float64Array(n), cum = new Float64Array(n);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += flat[2 * i]; y += flat[2 * i + 1];
    lon[i] = x / scale; lat[i] = y / scale;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot((lon[i] - lon[i - 1]) * M_PER_DEG_LON, (lat[i] - lat[i - 1]) * M_PER_DEG_LAT);
  }
  return { lon, lat, cum };
}

/**
 * Work out each route's loop. `frequency` scales how often buses leave (2 = twice as many buses).
 */
export function createModel(data, { frequency = 1 } = {}) {
  const shapes = data.shapes.map(s => decodeShape(s, data.meta.coordScale));
  const layover = data.meta.layover;
  const routes = data.routes.map((route, index) => {
    const durations = route.legs.map(l => l.times[l.times.length - 1]);
    const cycle = durations.reduce((a, d) => a + d + layover, 0);
    const headway = route.headway / frequency;
    const count = Math.max(1, Math.round(cycle / headway));
    return { ...route, index, durations, cycle, count, spacing: cycle / count, offset: (index * 7919) % cycle };
  });
  return { data, shapes, routes, layover };
}

export const totalBuses = model => model.routes.reduce((a, r) => a + r.count, 0);

/**
 * Fraction (0..1) of a stop-to-stop leg covered after fraction p of its time. The bus accelerates,
 * cruises, then brakes, so it eases out of one stop and into the next instead of moving at a
 * constant speed (with a bounded ramp).
 */
export function legProgress(p, legSeconds) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const r = Math.min(0.4, ACCEL_S / Math.max(legSeconds, 1));
  const k = 2 * r * (1 - r);
  if (p < r) return p * p / k;
  if (p > 1 - r) return 1 - (1 - p) * (1 - p) / k;
  return (p - r / 2) / (1 - r);
}

/** Position along a decoded shape at `dist` metres: { lon, lat, bearing }. */
export function pointAt(shape, dist) {
  const { cum, lon, lat } = shape;
  const last = cum.length - 1;
  if (last < 1) return { lon: lon[0], lat: lat[0], bearing: 0 };
  const d = Math.max(0, Math.min(cum[last], dist));
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo];
  const f = span > 0 ? (d - cum[lo]) / span : 0;
  const dx = (lon[hi] - lon[lo]) * M_PER_DEG_LON, dy = (lat[hi] - lat[lo]) * M_PER_DEG_LAT;
  return {
    lon: lon[lo] + (lon[hi] - lon[lo]) * f,
    lat: lat[lo] + (lat[hi] - lat[lo]) * f,
    bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
  };
}

/** A bus `rel` seconds into `leg`: its position, whether it is dwelling, and the stop it is heading for. */
export function legState(model, leg, rel) {
  const times = leg.times, dists = leg.dists;
  let lo = 0, hi = dists.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[2 * mid] <= rel) lo = mid; else hi = mid - 1; }
  const i = lo, dep = times[2 * i + 1];
  let dist = dists[i], atStop = true, next = i;
  if (rel > dep && i + 1 < dists.length) {
    const span = Math.max(times[2 * (i + 1)] - dep, 1e-6);
    dist = dists[i] + (dists[i + 1] - dists[i]) * legProgress((rel - dep) / span, span);
    atStop = false;
    next = i + 1;
  }
  return { ...pointAt(model.shapes[leg.shape], dist), atStop, nextStop: leg.stops[next] };
}

/** One route's bus number `k` at simulation time `t` seconds. */
export function busState(model, route, k, t) {
  const cycle = route.cycle;
  let phase = (((t + route.offset + k * route.spacing) % cycle) + cycle) % cycle;
  for (let l = 0; l < route.legs.length; l++) {
    const leg = route.legs[l], run = route.durations[l];
    if (phase < run) return { leg: l, layover: false, ...legState(model, leg, phase) };
    phase -= run;
    if (phase < model.layover) return { leg: l, layover: true, ...legState(model, leg, run) };
    phase -= model.layover;
  }
  const last = route.legs.length - 1; // unreachable unless rounding leaves a sliver at the end
  return { leg: last, layover: true, ...legState(model, route.legs[last], route.durations[last]) };
}

/** Every bus at time `t`. `only` is an optional route index to restrict to. */
export function allBuses(model, t, only = null) {
  const out = [];
  for (const route of model.routes) {
    if (only !== null && route.index !== only) continue;
    for (let k = 0; k < route.count; k++) out.push({ id: `${route.index}:${k}`, route, ...busState(model, route, k, t) });
  }
  return out;
}
