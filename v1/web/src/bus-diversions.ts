// Buses and street closures. The buses follow fixed timetable paths and know nothing about the car road graph, so a street closed to
// vehicles would still carry them. The council's Summertime Streets page lists no bus exemption for the closed streets, and Lothian has
// diverted routes in earlier festivals (the 35 round Calton Hill), so while a street is closed the buses that run along it are diverted:
// the stretch is replaced by the quickest way round on open roads (the car engine's A*), the stops on it are skipped and the bus takes
// longer. Modelled, not Lothian's published diversions: no 2026 diversion notice was found. The routes are found from the geometry (a path
// that runs along a closed street, not one that crosses it), and `EXEMPT_ROUTES` is the place to name any that are let through.
import { decodeShape, pointAt, type Bus, type BusData, type BusLeg, type BusRoute, type DiversionStats, type Shape } from './buses';
import { CarSim, type Roads } from './engine/car-sim.mjs';
import { nearestNodes } from './trips';

// All `assumption`: nothing here is measured.
/** Routes (by their number on the bus) that may drive a closed street. Empty: no exemption was found for any route. Add one here if a notice shows buses allowed through. */
export const EXEMPT_ROUTES: ReadonlySet<string> = new Set<string>();
export const SAMPLE_M = 5; // spacing of the points along a bus path that are tested against the closed streets
export const NEAR_M = 15; // a point is on a closed street when it is within this distance of it...
export const PARALLEL_DEG = 30; // ...and heading within this many degrees of the street's line (a path that crosses it at a junction is not on it)
export const MIN_RUN_M = 30; // along a closed street for at least this far, or it is a crossing
export const GAP_M = 10; // a break this short inside a run (a noisy path) does not end it
export const MERGE_M = 100; // two runs closer than this are one detour, or the bus would loop back on itself
export const MARGIN_M = 20; // the bus leaves its path this far before the closed street and rejoins this far after it
export const JUNCTIONS_TRIED = 4; // nearest road junctions tried at each end of a closed stretch
export const NODE_SNAP_M = 40; // the road junction it leaves and rejoins at must be this close to those points
export const MAX_EXTRA_M = 3000; // a detour longer than this beyond the stretch it replaces is not taken (the bus runs as before)
export const DETOUR_SPEED_M_S = 5; // the extra distance of a detour is driven at this speed (18 km/h, a bus in central traffic)
const CELL_M = 30;

export interface DiversionResult {
  data: BusData;
  stats: DiversionStats;
}

/** Delta-encodes a path the way the bus data file does: x0, y0, dx1, dy1, ... in 1/`scale` degrees. The inverse of `decodeShape`. */
export function encodeShape(lon: readonly number[], lat: readonly number[], scale: number): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < lon.length; i++) {
    const nx = Math.round((lon[i] as number) * scale);
    const ny = Math.round((lat[i] as number) * scale);
    out.push(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return out;
}

/** The closed roads' segments in a coarse grid, so a point on a bus path can ask whether it is on one. */
class ClosedStreets {
  private readonly grid = new Map<number, number[]>();
  private readonly seg: { x0: number; y0: number; x1: number; y1: number; bearing: number }[] = [];

  constructor(private readonly sim: CarSim, edges: readonly number[]) {
    for (const e of edges) {
      const first = sim.ptStart[e] as number;
      const last = (sim.ptStart[e + 1] as number) - 1;
      for (let p = first; p < last; p++) this.add(p);
    }
  }
  private key(x: number, y: number): number {
    return Math.floor(x / CELL_M) * 100003 + Math.floor(y / CELL_M);
  }
  private add(p: number): void {
    const { lon, lat, mPerLon, mPerLat } = this.sim;
    const x0 = (lon[p] as number) * mPerLon;
    const y0 = (lat[p] as number) * mPerLat;
    const x1 = (lon[p + 1] as number) * mPerLon;
    const y1 = (lat[p + 1] as number) * mPerLat;
    const id = this.seg.push({ x0, y0, x1, y1, bearing: ((Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI + 360) % 360 }) - 1;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL_M / 3)));
    for (let s = 0; s <= steps; s++) {
      const k = this.key(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
      const cell = this.grid.get(k);
      if (!cell) this.grid.set(k, [id]);
      else if (!cell.includes(id)) cell.push(id);
    }
  }
  /** Whether a bus at this spot heading this way is on one of the streets: close to it and running along it. */
  on(lon: number, lat: number, bearing: number): boolean {
    const px = lon * this.sim.mPerLon;
    const py = lat * this.sim.mPerLat;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(this.key(px + dx * CELL_M, py + dy * CELL_M)) ?? []) {
          const s = this.seg[id] as (typeof this.seg)[number];
          const ax = px - s.x0;
          const ay = py - s.y0;
          const vx = s.x1 - s.x0;
          const vy = s.y1 - s.y0;
          const t = Math.max(0, Math.min(1, (ax * vx + ay * vy) / (vx * vx + vy * vy || 1)));
          if (Math.hypot(ax - t * vx, ay - t * vy) > NEAR_M) continue;
          const diff = Math.abs(((bearing - s.bearing + 540) % 360) - 180); // 0 to 180
          if (diff <= PARALLEL_DEG || diff >= 180 - PARALLEL_DEG) return true; // either way along the street
        }
      }
    }
    return false;
  }
}

/** The stretches (metres along the path) where a bus path runs along a closed street, ends merged and short crossings dropped. */
export function findRuns(shape: Shape, streets: Pick<ClosedStreets, 'on'>): { from: number; to: number }[] {
  const total = shape.cum[shape.cum.length - 1] as number;
  const runs: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | null = null;
  for (let d = 0; d <= total; d += SAMPLE_M) {
    const p = pointAt(shape, d);
    if (streets.on(p.lon, p.lat, p.bearing)) {
      if (open && d - open.to <= GAP_M) open.to = d;
      else {
        if (open) runs.push(open);
        open = { from: d, to: d };
      }
    }
  }
  if (open) runs.push(open);
  const long = runs.filter((r) => r.to - r.from >= MIN_RUN_M);
  const merged: { from: number; to: number }[] = [];
  for (const r of long) {
    const last = merged[merged.length - 1];
    if (last && r.from - last.to < MERGE_M) last.to = r.to;
    else merged.push({ ...r });
  }
  return merged;
}

interface Path {
  lon: number[];
  lat: number[];
  cum: number[];
}
const asShape = (p: Path): Shape => ({ lon: Float64Array.from(p.lon), lat: Float64Array.from(p.lat), cum: Float64Array.from(p.cum) });

export class BusDiverter {
  private readonly sim: CarSim;
  private closed: number[] = [];
  private readonly cache = new Map<string, DiversionResult>();
  private readonly shapes: Shape[];

  /** `data` is the timetable the buses run, `roads` the car road graph the detours are found on. */
  constructor(roads: Roads, private readonly data: BusData, private readonly exempt: ReadonlySet<string> = EXEMPT_ROUTES) {
    this.sim = new CarSim(roads, { population: 1, seed: 1 });
    this.shapes = data.shapes.map((s) => decodeShape(s, data.meta.coordScale));
  }

  /** The timetable with the buses that run along these closed roads (edge indexes in the road graph) sent round them. */
  apply(closedEdges: readonly number[]): DiversionResult {
    const key = closedEdges.join(',');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const result = closedEdges.length === 0 ? { data: this.data, stats: emptyStats() } : this.build(closedEdges);
    this.cache.set(key, result);
    return result;
  }

  private build(closedEdges: readonly number[]): DiversionResult {
    const { sim } = this;
    if (this.closed.length) sim.setClosed(this.closed, false);
    sim.setClosed(closedEdges, true);
    this.closed = [...closedEdges];
    const streets = new ClosedStreets(sim, closedEdges);
    const stats = emptyStats();
    const shapes = [...this.data.shapes];
    const routes = this.data.routes.map((route): BusRoute => {
      if (this.exempt.has(route.name)) return route;
      let changed = false;
      const legs = route.legs.map((leg): BusLeg => {
        const runs = findRuns(this.shapes[leg.shape] as Shape, streets);
        if (runs.length === 0) return leg;
        const out = this.divertLeg(leg, runs, stats, route.name);
        if (!out) return leg;
        shapes.push(encodeShape(out.path.lon, out.path.lat, this.data.meta.coordScale));
        changed = true;
        stats.legs++;
        stats.extraMetres += out.extra;
        stats.skippedStops += out.skipped;
        if (!stats.routes.includes(route.name)) stats.routes.push(route.name);
        return { ...out.leg, shape: shapes.length - 1, diverted: true };
      });
      return changed ? { ...route, legs } : route;
    });
    stats.routes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { data: { ...this.data, shapes, routes }, stats };
  }

  /** Whether junction `n` has a road leaving (or entering) it that is not closed. */
  private open(n: number, way: 'out' | 'in'): boolean {
    const { sim } = this;
    const [start, list] = way === 'out' ? [sim.outStart, sim.out] : [sim.inStart, sim.inEdges];
    for (let k = start[n] as number; k < (start[n + 1] as number); k++) if (!sim.dead[list[k] as number]) return true;
    return false;
  }

  /** One direction of one route, with each closed stretch replaced. Null if none of them could be (the leg then runs as before). */
  private divertLeg(leg: BusLeg, runs: { from: number; to: number }[], stats: DiversionStats, route: string): { leg: BusLeg; path: Path; extra: number; skipped: number } | null {
    const { sim } = this;
    const scale = this.data.meta.coordScale;
    const original = this.shapes[leg.shape] as Shape;
    let path: Path = { lon: Array.from(original.lon), lat: Array.from(original.lat), cum: Array.from(original.cum) };
    let stops = [...leg.stops];
    let dists = [...leg.dists];
    let times = [...leg.times];
    let extraTotal = 0;
    let skipped = 0;
    let done = 0;
    for (const run of [...runs].reverse()) { // last first, so the distances of the earlier ones do not move
      const total = path.cum[path.cum.length - 1] as number;
      const entry = Math.max(0, run.from - MARGIN_M);
      const exit = Math.min(total, run.to + MARGIN_M);
      const shape = asShape(path);
      const pin = pointAt(shape, entry);
      const pout = pointAt(shape, exit);
      // The junction the bus leaves at needs a road out that is open, and the one it rejoins at a road in that is open (the nearest junction
      // may be on the closed street itself). Try the near ones, nearest pair first, and take the first pair with a way round.
      const leave = nearestNodes(sim, pin.lon, pin.lat, JUNCTIONS_TRIED).filter(([n, m]) => m <= NODE_SNAP_M && this.open(n, 'out'));
      const rejoin = nearestNodes(sim, pout.lon, pout.lat, JUNCTIONS_TRIED).filter(([n, m]) => m <= NODE_SNAP_M && this.open(n, 'in'));
      if (leave.length === 0 || rejoin.length === 0) {
        stats.failed.push({ route, reason: 'no open junction at the ends of the closed street' });
        continue;
      }
      let nodeIn: [number, number] | undefined;
      let roads: Int32Array | null = null;
      for (const [a, b] of leave.flatMap((x) => rejoin.map((y) => [x, y] as const)).sort((p, q) => p[0][1] + p[1][1] - (q[0][1] + q[1][1]))) {
        if (a[0] === b[0]) continue;
        roads = sim.findDetour(a[0], b[0]);
        if (roads && roads.length > 0) {
          nodeIn = a;
          break;
        }
      }
      if (!nodeIn || !roads) {
        stats.failed.push({ route, reason: 'no way round on open roads' });
        continue;
      }
      // The detour's points: the junction it leaves at, then every road of the way round.
      const dLon: number[] = [sim.nodeLon[nodeIn[0]] as number];
      const dLat: number[] = [sim.nodeLat[nodeIn[0]] as number];
      for (const e of roads) {
        for (let p = (sim.ptStart[e] as number) + 1; p < (sim.ptStart[e + 1] as number); p++) {
          dLon.push(sim.lon[p] as number);
          dLat.push(sim.lat[p] as number);
        }
      }
      let before = 0;
      while (before + 1 < path.cum.length && (path.cum[before + 1] as number) <= entry) before++;
      let after = path.cum.length - 1;
      while (after > 0 && (path.cum[after - 1] as number) >= exit) after--;
      const lon = [...path.lon.slice(0, before + 1), pin.lon, ...dLon, pout.lon, ...path.lon.slice(after)];
      const lat = [...path.lat.slice(0, before + 1), pin.lat, ...dLat, pout.lat, ...path.lat.slice(after)];
      // Measured the way the bus data is (decodeShape's metres per degree, not the car engine's), so the stops' distances stay on the path.
      const measured = decodeShape(encodeShape(lon, lat, scale), scale);
      const cum = Array.from(measured.cum);
      const pinAt = before + 1;
      const poutAt = pinAt + dLon.length + 1;
      const oldSpan = exit - entry;
      const newSpan = (cum[poutAt] as number) - (cum[pinAt] as number);
      if (newSpan - oldSpan > MAX_EXTRA_M) {
        stats.failed.push({ route, reason: 'the way round is too long' });
        continue;
      }
      const keep = stops.map((_, k) => !((dists[k] as number) >= entry && (dists[k] as number) <= exit));
      if (keep.filter(Boolean).length < 2) {
        stats.failed.push({ route, reason: 'fewer than two stops left' });
        continue;
      }
      const extraSeconds = Math.max(0, newSpan - oldSpan) / DETOUR_SPEED_M_S;
      const nextStops: number[] = [];
      const nextDists: number[] = [];
      const nextTimes: number[] = [];
      stops.forEach((s, k) => {
        if (!keep[k]) return;
        const after = (dists[k] as number) > exit;
        nextStops.push(s);
        nextDists.push(after ? (dists[k] as number) - oldSpan + newSpan : (dists[k] as number));
        nextTimes.push((times[2 * k] as number) + (after ? extraSeconds : 0), (times[2 * k + 1] as number) + (after ? extraSeconds : 0));
      });
      skipped += keep.filter((k) => !k).length;
      extraTotal += Math.max(0, newSpan - oldSpan);
      stops = nextStops;
      dists = nextDists;
      times = nextTimes;
      path = { lon: Array.from(measured.lon), lat: Array.from(measured.lat), cum };
      done++;
    }
    return done === 0 ? null : { leg: { ...leg, stops, dists, times }, path, extra: extraTotal, skipped };
  }
}

const emptyStats = (): DiversionStats => ({ legs: 0, routes: [], extraMetres: 0, skippedStops: 0, failed: [] });

/** Whether this bus is driving a path that was diverted round a closed street. */
export const isDiverted = (bus: Bus): boolean => bus.route.legs[bus.leg]?.diverted === true;
