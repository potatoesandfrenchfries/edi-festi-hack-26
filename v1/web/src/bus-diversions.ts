// Buses and street closures. The buses follow fixed timetable paths and know nothing about the car road graph, so a street closed to
// vehicles would still carry them. The council's Summertime Streets page lists no bus exemption for the closed streets, and Lothian has
// diverted routes in earlier festivals (the 35 round Calton Hill), so while a street is closed the buses that run along it are diverted:
// the stretch is replaced by the quickest way round on open roads (the car engine's A*), the stops on it are skipped and the bus takes
// longer. Modelled, not Lothian's published diversions: no 2026 diversion notice was found. The routes are found from the geometry (a path
// that runs along a closed street, not one that crosses it), and `EXEMPT_ROUTES` is the place to name any that are let through.
import { decodeShape, pointAt, type Bus, type BusData, type BusLeg, type BusRoute, type BusRuleRef, type DiversionStats, type Shape } from './buses';
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
export const NODE_SNAP_M = 40;
export const NAMED_SNAP_M = 60; // a named diversion's junction may be this far from the bus's own path (the street meets it at a kerb, not on its centre line) // the road junction it leaves and rejoins at must be this close to those points
export const MAX_EXTRA_M = 3000; // a detour longer than this beyond the stretch it replaces is not taken (the bus runs as before)
export const DETOUR_SPEED_M_S = 5; // the extra distance of a detour is driven at this speed (18 km/h, a bus in central traffic)
const CELL_M = 30;


/** The way round a closed stretch that a bus notice spells out, as the streets it takes in order (the bus keeps to its own path elsewhere). */
export interface DiversionVia {
  /** First date (YYYY-MM-DD) it applies; before it, and for routes not listed, the bus takes the quickest way round. */
  from?: string;
  routes: readonly string[];
  /** Which way the bus is running along the closed stretch: the section is east-west, so east is towards Leith Walk and west is towards the West End. */
  direction: 'east' | 'west';
  streets: readonly string[];
}
/** A stretch of road closed to buses between two dates (inclusive), with the diversions published for it. */
export interface DiversionRule {
  id: string;
  /** Where the dates and streets come from, and when they were read. */
  source: string;
  from: string;
  to: string;
  /**
   * The road closed to buses, as a line of [longitude, latitude] points along it. By coordinates, not graph edges: a bus-only street such as
   * Princes Street is not in the car road graph, so there are no edges to name.
   */
  section: { name: string; line: readonly (readonly [number, number])[] };
  via: readonly DiversionVia[];
}
/** A rule in force on the day, with the diversions that have started. */
export interface ActiveRule extends BusRuleRef {
  rule: DiversionRule;
  via: readonly DiversionVia[];
}

/**
 * Hardcoded: closures of one street to buses that the timetable does not know about, taken from Lothian's notices. `assumption`: the
 * streets are as printed, but where a bus leaves and rejoins its own path is worked out here, and a notice may have changed since it was read.
 * Not modelled: the westbound 15, 33 and 34 (09:00 to 20:00 from 5 August), whose notice gives the streets they take but not where they
 * rejoin their route; they take the quickest way round, as they do outside those hours.
 */
export const DIVERSION_RULES: readonly DiversionRule[] = [
  {
    id: 'princes-street-fire-2026',
    source:
      'Lothian Buses, "Partial closure of Princes Street" (lothianbuses.com/news/2026/07/partial-closure-of-princes-street/) and "Bus services set to return to Princes Street" (/news/2026/08/): ' +
      'closed after a fire on 9 July 2026, buses back on Saturday 29 August. Routes 43, 106 and X6 from the 5 August notice (Edinburgh Reporter, theedinburghreporter.co.uk/2026/08/changes-to-bus-diversions-on-princes-street/). Read 2026-11-17.',
    from: '2026-07-09',
    to: '2026-08-28',
    // Princes Street from South Charlotte Street to Frederick Street (412 m): the line the Lothian paths follow, which ends at the south ends of those two streets in the car graph.
    section: { name: 'Princes Street', line: [[-3.20582, 55.95048], [-3.19952, 55.95158]] },
    via: [
      { from: '2026-08-05', routes: ['43'], direction: 'east', streets: ['Charlotte Square', 'North Charlotte Street', 'Queen Street', 'Frederick Street'] },
      { from: '2026-08-05', routes: ['106', 'X6'], direction: 'east', streets: ['Charlotte Square', 'North Charlotte Street', 'Queen Street', 'North St David Street', 'South St David Street'] },
      { from: '2026-08-05', routes: ['43'], direction: 'west', streets: ['Frederick Street', 'Queen Street', 'North Charlotte Street', 'South Charlotte Street'] },
      { from: '2026-08-05', routes: ['106', 'X6'], direction: 'west', streets: ['South St David Street', 'North St David Street', 'Queen Street', 'North Charlotte Street', 'South Charlotte Street'] },
    ],
  },
];

/** The rules in force on this date (YYYY-MM-DD) with the diversions that have started. An empty or unknown date has none. */
export function rulesAt(date: string, rules: readonly DiversionRule[] = DIVERSION_RULES): ActiveRule[] {
  return rules
    .filter((r) => date >= r.from && date <= r.to)
    .map((rule) => {
      const via = rule.via.filter((v) => !v.from || date >= v.from);
      return { id: `${rule.id}+${via.length}`, rule, via }; // the id changes when more of the diversions start, so a change is noticed
    });
}

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

  /** The streets of these road edges and, as well, these lines of [longitude, latitude] points (a street the car graph does not have). */
  constructor(private readonly sim: CarSim, edges: readonly number[], lines: readonly (readonly (readonly [number, number])[])[] = []) {
    for (const e of edges) {
      const first = sim.ptStart[e] as number;
      const last = (sim.ptStart[e + 1] as number) - 1;
      for (let p = first; p < last; p++) this.add(sim.lon[p] as number, sim.lat[p] as number, sim.lon[p + 1] as number, sim.lat[p + 1] as number);
    }
    for (const line of lines) for (let k = 0; k + 1 < line.length; k++) this.add(line[k]![0], line[k]![1], line[k + 1]![0], line[k + 1]![1]);
  }
  private key(x: number, y: number): number {
    return Math.floor(x / CELL_M) * 100003 + Math.floor(y / CELL_M);
  }
  private add(lon0: number, lat0: number, lon1: number, lat1: number): void {
    const { mPerLon, mPerLat } = this.sim;
    const x0 = lon0 * mPerLon;
    const y0 = lat0 * mPerLat;
    const x1 = lon1 * mPerLon;
    const y1 = lat1 * mPerLat;
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
  /** Road edges by street name, for the diversions that name their streets. */
  private readonly byName = new Map<string, number[]>();

  /** `data` is the timetable the buses run, `roads` the car road graph the detours are found on. */
  constructor(roads: Roads, private readonly data: BusData, private readonly exempt: ReadonlySet<string> = EXEMPT_ROUTES, private readonly rules: readonly DiversionRule[] = DIVERSION_RULES) {
    this.sim = new CarSim(roads, { population: 1, seed: 1 });
    this.shapes = data.shapes.map((s) => decodeShape(s, data.meta.coordScale));
    roads.edges.forEach((edge, e) => {
      const name = roads.names?.[edge[10] as number];
      if (!name) return;
      const list = this.byName.get(name);
      if (list) list.push(e);
      else this.byName.set(name, [e]);
    });
  }

  /** The rules in force on this date. See `rulesAt`. */
  rulesAt(date: string): readonly ActiveRule[] {
    return rulesAt(date, this.rules);
  }

  /**
   * The timetable with the buses that run along these closed roads (edge indexes in the road graph, closed to everything) and along the
   * sections of the rules in force (closed to buses only) sent round them.
   */
  apply(closedEdges: readonly number[], rules: readonly BusRuleRef[] = []): DiversionResult {
    const active = rules as readonly ActiveRule[];
    const key = `${closedEdges.join(',')}|${active.map((r) => `${r.id}:${r.via.map((v) => `${v.routes.join('+')}${v.direction}`).join(';')}`).join('|')}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const result = closedEdges.length === 0 && active.length === 0 ? { data: this.data, stats: emptyStats() } : this.build(closedEdges, active);
    this.cache.set(key, result);
    return result;
  }

  /** The junction (node) where streets `a` and `b` meet, the one nearest node `near` if they meet more than once. -1 if they do not meet (or are not in the graph). */
  private junction(a: string, b: string, near: number): number {
    const { sim } = this;
    const nodesOf = (name: string) => {
      const set = new Set<number>();
      for (const e of this.byName.get(name) ?? []) {
        set.add(sim.from[e] as number);
        set.add(sim.to[e] as number);
      }
      return set;
    };
    const first = nodesOf(a);
    let best = -1;
    let bestD = Infinity;
    for (const n of nodesOf(b)) {
      if (!first.has(n)) continue;
      const d = near < 0 ? 0 : Math.hypot(((sim.nodeLon[n] as number) - (sim.nodeLon[near] as number)) * sim.mPerLon, ((sim.nodeLat[n] as number) - (sim.nodeLat[near] as number)) * sim.mPerLat);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** The node of street `name` nearest node `near`, or -1 if the street is not in the graph. */
  private nearestOf(name: string, near: number): number {
    const { sim } = this;
    let best = -1;
    let bestD = Infinity;
    for (const e of this.byName.get(name) ?? []) {
      for (const n of [sim.from[e] as number, sim.to[e] as number]) {
        const d = Math.hypot(((sim.nodeLon[n] as number) - (sim.nodeLon[near] as number)) * sim.mPerLon, ((sim.nodeLat[n] as number) - (sim.nodeLat[near] as number)) * sim.mPerLat);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
    return best;
  }

  /** The quickest way (road edges) through these junctions in turn, or null if any leg has none. */
  private through(nodes: readonly number[]): Int32Array | null {
    const out: number[] = [];
    for (let k = 0; k + 1 < nodes.length; k++) {
      if (nodes[k] === nodes[k + 1]) continue;
      const part = this.sim.findDetour(nodes[k] as number, nodes[k + 1] as number);
      if (!part || part.length === 0) return null;
      out.push(...part);
    }
    return out.length ? Int32Array.from(out) : null;
  }

  private build(closedEdges: readonly number[], rules: readonly ActiveRule[]): DiversionResult {
    const { sim } = this;
    if (this.closed.length) sim.setClosed(this.closed, false);
    sim.setClosed(closedEdges, true);
    this.closed = [...closedEdges];
    const sectionStreets = rules.map((rule) => ({ rule, streets: new ClosedStreets(sim, [], [rule.rule.section.line]) }));
    const streets = new ClosedStreets(sim, closedEdges, rules.map((r) => r.rule.section.line));
    const stats = emptyStats();
    const shapes = [...this.data.shapes];
    const routes = this.data.routes.map((route): BusRoute => {
      if (this.exempt.has(route.name)) return route;
      let changed = false;
      const legs = route.legs.map((leg): BusLeg => {
        const runs = findRuns(this.shapes[leg.shape] as Shape, streets);
        if (runs.length === 0) return leg;
        const out = this.divertLeg(leg, runs, stats, route.name, sectionStreets);
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

  /**
   * The way round a closed section that a notice names, when this route is listed for the direction the bus is running: the junctions of its
   * streets in turn, from where the first of them meets the bus's own path (or the start of the closed stretch, if it does not) to where the
   * last rejoins it. Also the distances along the path to cut at. Null if the route is not listed, or the streets, or a way through them,
   * are not in the graph (the bus then takes the quickest way round).
   */
  private namedWay(
    route: string,
    run: { from: number; to: number },
    path: Path,
    sections: { rule: ActiveRule; streets: ClosedStreets }[],
  ): { entry: number; exit: number; node: number; roads: Int32Array } | null {
    const shape = asShape(path);
    const onSection = sections.find((s) => findRuns(shape, s.streets).some((r) => r.from <= run.to && r.to >= run.from));
    if (!onSection) return null;
    const a = pointAt(shape, run.from);
    const b = pointAt(shape, run.to);
    const heading = Math.atan2((b.lon - a.lon) * this.sim.mPerLon, (b.lat - a.lat) * this.sim.mPerLat);
    const direction = Math.sin(heading) >= 0 ? 'east' : 'west';
    const via = onSection.rule.via.find((v) => v.direction === direction && v.routes.includes(route));
    if (!via) return null;
    const near = (p: { lon: number; lat: number }) => nearestNodes(this.sim, p.lon, p.lat, 1)[0]?.[0] ?? -1;
    const first = via.streets[0] as string;
    const last = via.streets[via.streets.length - 1] as string;
    // Where it leaves and rejoins: the node of the first (last) street that is near the bus's own path before (after) the closed stretch. A
    // street that does not reach the path (the first street of an eastbound diversion starts on Queensferry Street, off it) starts at the closed stretch.
    const touching = (street: string, lo: number, hi: number): number => {
      let best = -1;
      let bestD = NAMED_SNAP_M;
      for (const e of this.byName.get(street) ?? []) {
        for (const n of [this.sim.from[e] as number, this.sim.to[e] as number]) {
          for (let d = Math.max(0, lo); d <= Math.min(hi, path.cum[path.cum.length - 1] as number); d += SAMPLE_M * 2) {
            const p = pointAt(shape, d);
            const m = Math.hypot((p.lon - (this.sim.nodeLon[n] as number)) * this.sim.mPerLon, (p.lat - (this.sim.nodeLat[n] as number)) * this.sim.mPerLat);
            if (m < bestD) {
              bestD = m;
              best = n;
            }
          }
        }
      }
      return best;
    };
    const start = touching(first, run.from - 400, run.to);
    const end = touching(last, run.from, run.to + 400);
    const entryNode = start >= 0 ? start : near(a);
    const exitNode = end >= 0 ? end : near(b);
    if (entryNode < 0 || exitNode < 0) return null;
    const nodes = [entryNode];
    for (let k = 0; k + 1 < via.streets.length; k++) {
      const prev = nodes[nodes.length - 1] as number;
      // Streets the notice lists one after the other need not meet (North and South Charlotte Street have the square between them): then go
      // to the next street's nearest node and let the quickest way find the link.
      const j = this.junction(via.streets[k] as string, via.streets[k + 1] as string, prev);
      const next = j >= 0 ? j : this.nearestOf(via.streets[k + 1] as string, prev);
      if (next < 0) return null;
      nodes.push(next);
    }
    nodes.push(exitNode);
    const roads = this.through(nodes);
    if (!roads) return null;
    // Where on the bus's own path it leaves and rejoins: the points nearest those junctions, before and after the closed stretch.
    const nearestAt = (node: number, lo: number, hi: number): number | null => {
      let best: number | null = null;
      let bestD = NAMED_SNAP_M;
      for (let d = Math.max(0, lo); d <= Math.min(hi, path.cum[path.cum.length - 1] as number); d += SAMPLE_M) {
        const p = pointAt(shape, d);
        const m = Math.hypot((p.lon - (this.sim.nodeLon[node] as number)) * this.sim.mPerLon, (p.lat - (this.sim.nodeLat[node] as number)) * this.sim.mPerLat);
        if (m < bestD) {
          bestD = m;
          best = d;
        }
      }
      return best;
    };
    const entry = nearestAt(entryNode, run.from - 400, run.to);
    const exit = nearestAt(exitNode, run.from, run.to + 400);
    if (entry === null || exit === null || exit <= entry) return null;
    return { entry, exit, node: entryNode, roads };
  }

  /** One direction of one route, with each closed stretch replaced. Null if none of them could be (the leg then runs as before). */
  private divertLeg(
    leg: BusLeg,
    runs: { from: number; to: number }[],
    stats: DiversionStats,
    route: string,
    sections: { rule: ActiveRule; streets: ClosedStreets }[],
  ): { leg: BusLeg; path: Path; extra: number; skipped: number } | null {
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
      let entry = Math.max(0, run.from - MARGIN_M);
      let exit = Math.min(total, run.to + MARGIN_M);
      let way: { node: number; roads: Int32Array } | null = null;
      // A diversion the notice spells out, for a bus running along a rule's closed section: through the streets it names, in order.
      const named = this.namedWay(route, run, path, sections);
      if (named) {
        entry = named.entry;
        exit = named.exit;
        way = { node: named.node, roads: named.roads };
      }
      const shape = asShape(path);
      const pin = pointAt(shape, entry);
      const pout = pointAt(shape, exit);
      if (!way) {
        // The junction the bus leaves at needs a road out that is open, and the one it rejoins at a road in that is open (the nearest
        // junction may be on the closed street itself). Try the near ones, nearest pair first, and take the first pair with a way round.
        const leave = nearestNodes(sim, pin.lon, pin.lat, JUNCTIONS_TRIED).filter(([n, m]) => m <= NODE_SNAP_M && this.open(n, 'out'));
        const rejoin = nearestNodes(sim, pout.lon, pout.lat, JUNCTIONS_TRIED).filter(([n, m]) => m <= NODE_SNAP_M && this.open(n, 'in'));
        if (leave.length === 0 || rejoin.length === 0) {
          stats.failed.push({ route, reason: 'no open junction at the ends of the closed street' });
          continue;
        }
        for (const [a, b] of leave.flatMap((x) => rejoin.map((y) => [x, y] as const)).sort((p, q) => p[0][1] + p[1][1] - (q[0][1] + q[1][1]))) {
          if (a[0] === b[0]) continue;
          const found = sim.findDetour(a[0], b[0]);
          if (found && found.length > 0) {
            way = { node: a[0], roads: found };
            break;
          }
        }
        if (!way) {
          stats.failed.push({ route, reason: 'no way round on open roads' });
          continue;
        }
      }
      const roads = way.roads;
      // The detour's points: the junction it leaves at, then every road of the way round.
      const dLon: number[] = [sim.nodeLon[way.node] as number];
      const dLat: number[] = [sim.nodeLat[way.node] as number];
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
