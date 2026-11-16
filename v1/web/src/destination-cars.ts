// Background cars that head for a venue and then go back to wandering, run inside the car worker.
// Unlike the festival trips (trips.ts), which are extra cars that follow the ticket counts and park, these are ordinary cars that start
// wherever the engine put them. A share of them (chosen once, by car id) is given a venue to drive to, picked with the venue's audience as
// the weight, and an A* route to the nearest road it can reach. On arrival the car carries on with the engine's weighted random turns,
// and after a short dwell it picks its next venue. The share does not respond to the council's levers, so it is off in the scenario sweep.
// Modelled traffic, an illustration of where drivers might be heading, never a count.
import type { CarSim } from './engine/car-sim.mjs';
import { nearestNodes, type TripVenue } from './trips';

/** Seconds a car wanders after reaching a venue before it picks the next one. assumption: nothing measured; keeps the share heading out. */
export const DWELL_S = 300;
/** A car that has not arrived after this long gives up and wanders (usually a closure cut it off). */
export const ABANDON_AFTER_S = 2400;
/** Most routes planned per check, so a hundred cars choosing at once do not stall the worker. */
export const PLANS_PER_CHECK = 12;
/** Road nodes tried per venue as the place to drive to, nearest first. */
const CANDIDATES_TRIED = 3;
/** The car has arrived once it is this far along the last road of its route (the same test as the festival trips). */
const ARRIVED_AT = 0.5;

export interface DestinationStats {
  /** Cars driving to a venue now. */
  heading: number;
  /** Venues chosen since the run began, arrivals, routes planned again after a closure or a relocation, and cars that gave up or could not be routed. */
  chosen: number;
  arrived: number;
  replanned: number;
  abandoned: number;
  unreachable: number;
  /** Arrivals per venue since the start (the order of the venues given). */
  arrivedAt: number[];
}

/** A number in [0, 1) that depends only on the seed and the car, so the same cars are chosen in every run. */
export function unit(seed: number, car: number): number {
  let h = Math.imul((seed | 0) ^ Math.imul(car + 1, 0x9e3779b1), 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Index of the entry of `weights` that `u` in [0, 1) falls in, or -1 if every weight is zero. */
export function pickIndex(weights: readonly number[], u: number): number {
  let total = 0;
  for (const w of weights) total += Math.max(w, 0);
  if (total <= 0) return -1;
  let r = u * total;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(weights[i] as number, 0);
    if (w <= 0) continue;
    last = i;
    r -= w;
    if (r < 0) return i;
  }
  return last;
}

export class DestinationCars {
  private share = 0;
  private weights: number[];
  private readonly nodes: [number, number][][];
  private readonly dest: Int32Array;
  private readonly destEdge: Int32Array;
  private readonly since: Float64Array;
  private readonly resumeAt: Float64Array;
  private cursor = 0;
  private readonly counts: Omit<DestinationStats, 'heading' | 'arrivedAt'> = { chosen: 0, arrived: 0, replanned: 0, abandoned: 0, unreachable: 0 };
  private readonly arrivedAt: number[];

  /** Only cars 0 to `slots - 1` (the background traffic) can be given a venue. */
  constructor(
    private readonly sim: CarSim,
    private readonly venues: readonly TripVenue[],
    private readonly slots: number,
    private readonly seed: number,
    private readonly random: () => number,
  ) {
    this.nodes = venues.map((v) => nearestNodes(sim, v.lon, v.lat));
    this.weights = venues.map(() => 0);
    this.arrivedAt = venues.map(() => 0);
    const n = Math.min(slots, sim.n);
    this.dest = new Int32Array(n).fill(-1);
    this.destEdge = new Int32Array(n).fill(-1);
    this.since = new Float64Array(n).fill(-1);
    this.resumeAt = new Float64Array(n);
  }

  /** `share` of the background cars head for venues, each venue chosen with its weight (the order of the venues given). Zero turns it off. */
  setTarget(share: number, weights: readonly number[]): void {
    this.share = Math.min(Math.max(Number.isFinite(share) ? share : 0, 0), 1);
    // A venue with no road in reach cannot be driven to, so it never gets a car.
    this.weights = this.venues.map((_, v) => ((this.nodes[v]?.length ?? 0) > 0 ? Math.max(weights[v] ?? 0, 0) : 0));
  }

  /** Whether car `car` is one of the cars that head for venues at the current share. */
  isChosen(car: number): boolean {
    return unit(this.seed, car) < this.share;
  }

  /** Whether car `car` is driving to a venue now. */
  isHeading(car: number): boolean {
    return this.dest[car] !== undefined && (this.dest[car] as number) >= 0;
  }

  /** Where car `car` is heading (an index into the venues), or -1. */
  venueOf(car: number): number {
    return this.dest[car] ?? -1;
  }

  stats(): DestinationStats {
    let heading = 0;
    for (let car = 0; car < this.dest.length; car++) if ((this.dest[car] as number) >= 0 && this.sim.active[car]) heading++;
    return { ...this.counts, heading, arrivedAt: [...this.arrivedAt] };
  }

  /**
   * Looks at every background car: arrivals go back to wandering, cars whose route was dropped (a closure, or being relocated by the gridlock
   * relief) get a new one, and cars that are due a venue pick one. Call every few steps.
   */
  check(): void {
    const sim = this.sim;
    const n = this.dest.length;
    let plans = 0;
    for (let k = 0; k < n; k++) {
      const car = (this.cursor + k) % n;
      if (!sim.active[car] || sim.leaving[car] || !this.isChosen(car)) {
        if ((this.dest[car] as number) >= 0) this.release(car);
        continue;
      }
      if (sim.back[car]) continue; // turned round at a closure: the engine is driving it back to where it was going
      const venue = this.dest[car] as number;
      if (venue >= 0) {
        if (sim.edge[car] === this.destEdge[car] && (sim.pos[car] as number) >= (sim.length[this.destEdge[car] as number] as number) * ARRIVED_AT) {
          this.finish(car, venue, true);
        } else if (sim.time - (this.since[car] as number) > ABANDON_AFTER_S) {
          this.finish(car, venue, false);
        } else if (sim.route[car] == null && sim.edge[car] !== this.destEdge[car] && sim.next[car] !== this.destEdge[car]) {
          // The route ran out before the last road (a closure dropped it, or the gridlock relief moved the car). On the last road the route is
          // always used up, and the car just needs to reach the halfway mark, so that is not a dropped route.
          if (plans >= PLANS_PER_CHECK) {
            this.cursor = car;
            return;
          }
          plans++;
          if (this.plan(car, venue)) this.counts.replanned++;
          else this.finish(car, venue, false, true);
        }
      } else if (sim.time >= (this.resumeAt[car] as number) && this.weights.some((w) => w > 0)) {
        if (plans >= PLANS_PER_CHECK) {
          this.cursor = car;
          return;
        }
        plans++;
        const chosen = pickIndex(this.weights, this.random());
        if (chosen >= 0 && this.plan(car, chosen)) this.counts.chosen++;
        else this.resumeAt[car] = sim.time + DWELL_S; // nowhere reachable from here: try again later
      }
    }
    this.cursor = 0;
  }

  /** Gives car `car` the quickest route from the end of its road to a road by `venue`. False if none of the nearest nodes can be reached. */
  private plan(car: number, venue: number): boolean {
    const sim = this.sim;
    const edge = sim.edge[car] as number;
    const from = sim.to[edge] as number;
    const candidates = (this.nodes[venue] as [number, number][]).slice(0, CANDIDATES_TRIED);
    for (const [node] of candidates) {
      if (node === from) continue;
      const route = sim.findDetour(from, node);
      if (!route || route.length === 0) continue;
      sim.route[car] = route;
      sim.routeStep[car] = 0;
      sim.pickNext(car, edge); // takes the first road of the route
      this.dest[car] = venue;
      this.destEdge[car] = route[route.length - 1] as number;
      if ((this.since[car] as number) < 0) this.since[car] = sim.time; // a replanned car keeps its original start time
      return true;
    }
    return false;
  }

  /** The car is done with its venue: it wanders, and picks another after the dwell. */
  private finish(car: number, venue: number, arrived: boolean, unreachable = false): void {
    if (arrived) {
      this.counts.arrived++;
      this.arrivedAt[venue] = (this.arrivedAt[venue] as number) + 1;
    } else if (unreachable) {
      this.counts.unreachable++;
    } else {
      this.counts.abandoned++;
    }
    this.release(car);
    this.resumeAt[car] = this.sim.time + DWELL_S * (0.5 + this.random());
  }

  /** Forgets the car's venue and any route to it, so it goes back to weighted random turns. */
  private release(car: number): void {
    this.dest[car] = -1;
    this.destEdge[car] = -1;
    this.since[car] = -1;
    this.sim.route[car] = null;
  }
}
