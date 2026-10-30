// Venue-directed car trips, run inside the car worker next to the engine's background traffic.
// Instead of wandering, a festival car is created at an entry road (a gateway on the edge of the area, or anywhere for a local), is given
// an A* route to the nearest reachable road to its venue, drives it with the engine's own car-following and signals, and parks on arrival.
// After a show the audience's cars go the other way, from the venue to a gateway. How many cars start each second comes from the ticket
// counts (trip-demand.ts). Where a closure cuts off the venue, the car parks at the nearest road it can reach and its driver walks the rest.
import type { CarSim } from './engine/car-sim.mjs';

export const SECTORS = ['north', 'west', 'south'] as const;
export type Sector = (typeof SECTORS)[number];

export interface TripVenue {
  key: string;
  lon: number;
  lat: number;
}
/** Where a car's journey starts (or, leaving, ends): a local starts anywhere in the area, the others at the gateway of their compass sector. */
export interface OriginMix {
  local: number;
  north: number;
  west: number;
  south: number;
}
/** Cars to start per simulated second at each venue (same order as the venues), arriving at it and leaving from it. */
export interface TripRates {
  inbound: number[];
  outbound: number[];
  mix: OriginMix;
}
export interface TripStats {
  /** Festival cars on the road now. */
  active: number;
  started: number;
  arrived: number;
  left: number;
  /** Gave up (took over 40 minutes, usually after a closure cut their route). */
  abandoned: number;
  /** A trip that could not start because the venue could not be reached by road at all. */
  unreachable: number;
  /** Starts held back because the entry road had no room. */
  blocked: number;
  /** Metres drivers walk from where they parked to the venue, summed over arrivals (zero unless a closure makes them park short). */
  walkMetres: number;
  /** Seconds the arrived inbound trips took, summed. */
  tripSeconds: number;
  /** Arrivals per venue since the start. */
  arrivedAt: number[];
}

export const SNAP_MAX_M = 600; // a venue further than this from any road is outside the modelled area
export const CANDIDATES = 12; // road nodes kept per venue as places to park, nearest first
export const GATEWAY_ZONE = 0.12; // the outer share of the area, per side, that counts as a gateway
export const ABANDON_AFTER_S = 2400;
const MAX_OWED = 5; // most starts a venue may owe: a long blocked entry road must not release a burst of hundreds later
const ROOM_AT_START_M = 8;
const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary']);

interface Trip {
  venue: number;
  inbound: boolean;
  destEdge: number;
  born: number;
  walkM: number;
}

export const emptyRates = (venues: number): TripRates => ({ inbound: Array(venues).fill(0), outbound: Array(venues).fill(0), mix: { local: 1, north: 0, west: 0, south: 0 } });

/** Road nodes within SNAP_MAX_M of a point, nearest first, as [node, metres]. Only nodes with a road in and a road out can be driven to. */
export function nearestNodes(sim: CarSim, lon: number, lat: number, count = CANDIDATES): [number, number][] {
  const hasOut = (n: number) => (sim.outStart[n + 1] as number) > (sim.outStart[n] as number);
  const hasIn = (n: number) => (sim.inStart[n + 1] as number) > (sim.inStart[n] as number);
  const found: [number, number][] = [];
  for (let n = 0; n < sim.nodes; n++) {
    if (!hasOut(n) || !hasIn(n)) continue;
    const d = Math.hypot(((sim.nodeLon[n] as number) - lon) * sim.mPerLon, ((sim.nodeLat[n] as number) - lat) * sim.mPerLat);
    if (d <= SNAP_MAX_M) found.push([n, d]);
  }
  return found.sort((a, b) => a[1] - b[1]).slice(0, count);
}

/** Entry roads (heading in) and exit roads (heading out) for each compass sector, found in the outer ring of the area. */
export function gateways(sim: CarSim, classes: readonly string[]): { entry: Record<Sector, number[]>; exit: Record<Sector, number[]> } {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (let n = 0; n < sim.nodes; n++) {
    minLon = Math.min(minLon, sim.nodeLon[n] as number);
    maxLon = Math.max(maxLon, sim.nodeLon[n] as number);
    minLat = Math.min(minLat, sim.nodeLat[n] as number);
    maxLat = Math.max(maxLat, sim.nodeLat[n] as number);
  }
  const zone = (n: number): Sector | null => {
    const lon = ((sim.nodeLon[n] as number) - minLon) / Math.max(maxLon - minLon, 1e-9);
    const lat = ((sim.nodeLat[n] as number) - minLat) / Math.max(maxLat - minLat, 1e-9);
    if (lat >= 1 - GATEWAY_ZONE) return 'north';
    if (lon <= GATEWAY_ZONE) return 'west';
    if (lat <= GATEWAY_ZONE) return 'south';
    return null;
  };
  const entry = { north: [], west: [], south: [] } as Record<Sector, number[]>;
  const exit = { north: [], west: [], south: [] } as Record<Sector, number[]>;
  for (let e = 0; e < sim.E; e++) {
    const from = zone(sim.from[e] as number);
    const to = zone(sim.to[e] as number);
    if (from && !to) entry[from].push(e);
    if (to && !from) exit[to].push(e);
  }
  const major = (edges: number[]) => {
    const big = edges.filter((e) => MAJOR.has(classes[sim.cls[e] as number] ?? ''));
    return big.length >= 2 ? big : edges;
  };
  for (const s of SECTORS) {
    entry[s] = major(entry[s]);
    exit[s] = major(exit[s]);
  }
  return { entry, exit };
}

/** Picks a key of `weights` with probability proportional to its weight, from a uniform number in [0, 1). */
export function pickWeighted<K extends string>(weights: Record<K, number>, u: number): K {
  const keys = Object.keys(weights) as K[];
  const total = keys.reduce((sum, k) => sum + Math.max(weights[k], 0), 0);
  let r = u * total;
  for (const k of keys) {
    r -= Math.max(weights[k], 0);
    if (r < 0) return k;
  }
  return keys[keys.length - 1] as K;
}

export class TripFlow {
  private readonly nodes: [number, number][][] = [];
  private readonly entry: Record<Sector, number[]>;
  private readonly exit: Record<Sector, number[]>;
  private readonly cumulative: Float64Array;
  private rates: TripRates;
  private readonly owedIn: number[];
  private readonly owedOut: number[];
  private readonly trips = new Map<number, Trip>();
  private cursor: number;
  private readonly counts: Omit<TripStats, 'active' | 'arrivedAt'> = { started: 0, arrived: 0, left: 0, abandoned: 0, unreachable: 0, blocked: 0, walkMetres: 0, tripSeconds: 0 };
  private readonly arrivedAt: number[];

  /** `firstSlot` is the first car slot the flow may use; slots from there to the end of the engine's cars belong to it. */
  constructor(
    private readonly sim: CarSim,
    private readonly venues: readonly TripVenue[],
    classes: readonly string[],
    private readonly firstSlot: number,
    private readonly random: () => number,
  ) {
    this.nodes = venues.map((v) => nearestNodes(sim, v.lon, v.lat));
    ({ entry: this.entry, exit: this.exit } = gateways(sim, classes));
    this.cumulative = new Float64Array(sim.E);
    let total = 0;
    for (let e = 0; e < sim.E; e++) this.cumulative[e] = total += (sim.length[e] as number) * (sim.lanes[e] as number);
    this.rates = emptyRates(venues.length);
    this.owedIn = Array(venues.length).fill(0);
    this.owedOut = Array(venues.length).fill(0);
    this.arrivedAt = Array(venues.length).fill(0);
    this.cursor = firstSlot;
  }

  /** The venues that have a road within reach. A venue without one is outside the modelled area and gets no cars. */
  placed(): boolean[] {
    return this.nodes.map((n) => n.length > 0);
  }

  setRates(rates: TripRates): void {
    this.rates = rates;
  }

  /** Starts the cars the rates call for over `dt` simulated seconds. */
  step(dt: number): void {
    for (let v = 0; v < this.venues.length; v++) {
      if (!this.nodes[v]?.length) continue;
      this.owedIn[v] = Math.min((this.owedIn[v] as number) + (this.rates.inbound[v] ?? 0) * dt, MAX_OWED);
      this.owedOut[v] = Math.min((this.owedOut[v] as number) + (this.rates.outbound[v] ?? 0) * dt, MAX_OWED);
      while ((this.owedIn[v] as number) >= 1) {
        const result = this.start(v, true);
        if (result === 'full') break;
        this.owedIn[v] = (this.owedIn[v] as number) - 1;
      }
      while ((this.owedOut[v] as number) >= 1) {
        const result = this.start(v, false);
        if (result === 'full') break;
        this.owedOut[v] = (this.owedOut[v] as number) - 1;
      }
    }
  }

  /** Parks the cars that have reached their road and gives up on the ones that have driven too long. Call every few steps. */
  check(): void {
    const sim = this.sim;
    for (const [car, trip] of this.trips) {
      if (!sim.active[car]) {
        this.trips.delete(car);
      } else if (sim.edge[car] === trip.destEdge && (sim.pos[car] as number) >= (sim.length[trip.destEdge] as number) * 0.5) {
        sim.switchOff(car);
        this.trips.delete(car);
        if (trip.inbound) {
          this.counts.arrived++;
          this.counts.walkMetres += trip.walkM;
          this.counts.tripSeconds += sim.time - trip.born;
          this.arrivedAt[trip.venue] = (this.arrivedAt[trip.venue] as number) + 1;
        } else {
          this.counts.left++;
        }
      } else if (sim.time - trip.born > ABANDON_AFTER_S) {
        sim.switchOff(car);
        this.trips.delete(car);
        this.counts.abandoned++;
      }
    }
  }

  /** After the gridlock relief moved a festival car to another road, gives it a fresh route to where it was going. */
  reroute(car: number): void {
    const trip = this.trips.get(car);
    if (!trip) return;
    const sim = this.sim;
    const goal = sim.to[trip.destEdge] as number;
    const route = sim.findDetour(sim.to[sim.edge[car] as number] as number, goal);
    if (route) {
      sim.route[car] = route;
      sim.routeStep[car] = 0;
      sim.pickNext(car, sim.edge[car] as number);
    } else {
      sim.switchOff(car);
      this.trips.delete(car);
      this.counts.abandoned++;
    }
  }

  stats(): TripStats {
    return { ...this.counts, active: this.trips.size, arrivedAt: [...this.arrivedAt] };
  }

  isTrip(car: number): boolean {
    return this.trips.has(car);
  }

  private randomEdge(): number {
    const r = this.random() * (this.cumulative[this.cumulative.length - 1] as number);
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.cumulative[mid] as number) < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private pick<T>(list: readonly T[]): T | undefined {
    return list[Math.floor(this.random() * list.length)];
  }

  private freeSlot(): number {
    const n = this.sim.n;
    for (let k = 0; k < n - this.firstSlot; k++) {
      const car = this.firstSlot + ((this.cursor - this.firstSlot + k) % (n - this.firstSlot));
      if (!this.sim.active[car]) {
        this.cursor = car + 1;
        return car;
      }
    }
    return -1;
  }

  /** Starts one car for venue `v`. 'full' means try again later (no free slot or no room at the start); 'skipped' means it cannot be done. */
  private start(v: number, inbound: boolean): 'ok' | 'full' | 'skipped' {
    const sim = this.sim;
    const origin = pickWeighted<keyof OriginMix>(this.rates.mix, this.random());
    const sector = origin === 'local' ? null : origin;
    let first: number | undefined;
    let route: Int32Array | null = null;
    let walkM = 0;
    if (inbound) {
      first = sector ? this.pick(this.entry[sector]) : this.randomEdge();
      first ??= this.randomEdge();
      const from = sim.to[first] as number;
      for (const [node, metres] of this.nodes[v] as [number, number][]) {
        if (node === from) continue;
        route = sim.findDetour(from, node);
        if (route) {
          walkM = metres;
          break;
        }
      }
    } else {
      const node = (this.nodes[v] as [number, number][])[0]?.[0] as number;
      const outs: number[] = [];
      for (let k = sim.outStart[node] as number; k < (sim.outStart[node + 1] as number); k++) if (!sim.dead[sim.out[k] as number]) outs.push(sim.out[k] as number);
      first = this.pick(outs);
      if (first === undefined) {
        this.counts.unreachable++;
        return 'skipped';
      }
      const goalEdge = (sector ? this.pick(this.exit[sector]) : undefined) ?? this.randomEdge();
      route = sim.findDetour(sim.to[first] as number, sim.to[goalEdge] as number);
    }
    if (!route || route.length === 0 || first === undefined) {
      this.counts.unreachable++;
      return 'skipped';
    }
    const car = this.freeSlot();
    if (car < 0 || !this.put(car, first, route)) {
      this.counts.blocked++;
      return 'full';
    }
    this.trips.set(car, { venue: v, inbound, destEdge: route[route.length - 1] as number, born: sim.time, walkM });
    this.counts.started++;
    return 'ok';
  }

  /** Puts car `car` at rest at the start of road `edge` on a lane with room, with `route` for its next roads. False if no lane has room. */
  private put(car: number, edge: number, route: Int32Array): boolean {
    const sim = this.sim;
    if (sim.dead[edge] || sim.laneCapacity(edge) < 1) return false;
    for (let lane = 0; lane < (sim.lanes[edge] as number); lane++) {
      const key = edge * 4 + lane;
      const rear = sim.rear[key] as number;
      if (rear >= 0 && (sim.pos[rear] as number) < ROOM_AT_START_M) continue;
      sim.active[car] = 1;
      sim.leaving[car] = 0;
      sim.group[car] = -1;
      sim.edge[car] = edge;
      sim.lane[car] = lane;
      sim.pos[car] = 0;
      sim.v[car] = 0;
      sim.wait[car] = 0;
      sim.cooldown[car] = 0;
      sim.seg[car] = sim.ptStart[edge] as number;
      sim.back[car] = 0;
      sim.rear[key] = car;
      sim.route[car] = route; // always, even one road long: pickNext takes the first road from it
      sim.routeStep[car] = 0;
      sim.pickNext(car, edge);
      return true;
    }
    return false;
  }
}
