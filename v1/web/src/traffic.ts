// Stateful bus traffic: buses that follow, queue behind each other, dwell at stops and slow down in crowded streets.
// Switching it off gives back the timetable replay in buses.ts, where buses never interact.
//
// The following rule is the "charged particle" car-following (particleAcceleration), the same as in the car engine.
// Everything around it is new, and none of the constants are calibrated against real bus data:
//   1. Bunching. Buses on the same route and direction are particles on a line. A bus that catches the one ahead is repelled and
//      slows, and a bus cannot pass a dwelling one, so convoys form. Boarding time grows with the gap since the last bus left a
//      stop (a late bus meets more waiting passengers and falls further behind), and random short delays seed the disturbance.
//      Termini hold a bus back so headways do not collapse for good, as an operator would.
//   2. Shared-road slowdown. Many routes share a street (Princes Street, Leith Walk). Buses in a 150 m cell slow down once the
//      cell holds more than a few, which feeds back into the density. A cell whose buses are mostly crawling is flagged
//      as congested.
import { legProgress, pointAt, type Bus, type BusLeg, type BusModel, type RouteLoop, type Shape } from './buses';

export const BUS_LENGTH = 12;
export const STEP_S = 0.5;
export const MAX_SPEED = 28; // m/s, about 100 km/h: the airport and express legs genuinely run that fast

const BIG_GAP = 1e4;
const EMERGENCY_DECEL = 9;

// Bus dynamics. `placeholder`: plausible values for a double-decker, not measured.
const ACCEL = 1.0; // m/s²
const DECEL = 1.4; // m/s², comfortable braking
const TARGET_GAP = 8; // m bumper to bumper behind another bus (cars use 1-2 car lengths)
const MIN_GAP = 3; // m, the braking-distance cap keeps this much clear behind a bus
const STOP_TARGET = 1; // m before the stop point the bus aims to halt
const STOP_MIN_GAP = 0.5;
const ARRIVE_GAP = 1.5; // m, within this of the stop and nearly still counts as arrived
const ARRIVE_SPEED = 0.5; // m/s
/** Seconds lost per segment beyond the ideal accelerate-cruise-brake time. Measured at about zero for the particle rule, so none is allowed for. */
export const LOST_S = 0;

// Dwelling. `placeholder`.
const DWELL_BASE_S = 8;
const BOARD_S_PER_S = 0.03; // extra dwell seconds per second since a bus last left this stop
const BOARD_MAX_GAP_S = 900;
const DWELL_JITTER = 0.3;

// Disturbances: a delay (a light, a parked van) hits a bus on average every ~3 minutes and lasts 8-28 s. `placeholder`.
const LAPSE_PER_S = 1 / 180;
const LAPSE_FACTOR = 0.25;
const LAPSE_MIN_S = 8;
const LAPSE_SPAN_S = 20;

/**
 * A timetable already includes ordinary delays, so buses cruise a little faster than the plan to leave room for the random delays
 * above. Fitted so that, with those delays, a lone bus's loop takes about the timetabled time (median over the 99 Lothian routes).
 */
export const DISTURBANCE_PACE = 1.08;

// Terminus regulation: a bus waits until this share of the nominal headway has passed since the last one left. `assumption`.
const HOLD_SHARE = 0.7;

// Shared-road slowdown. `placeholder`: n0 buses per cell are free; each bus beyond that costs `SLOWDOWN` of the free speed.
const CELL_M = 150;
const CELL_FREE_BUSES = 3;
const SLOWDOWN = 0.35;
const MIN_FACTOR = 0.25;
const DENSITY_EVERY_S = 3;
const IDLE_SPEED = 0.1; // m/s: a bus on the road slower than this is standing
const SLOW_SPEED = 3; // m/s, 10.8 km/h as in the congestion cells
const GLOW_MIN_SLOW = 3;
const GLOW_MIN_SHARE = 0.5;

// Cars and buses share the street, so each sees the other (see coupling.ts). `placeholder`.
const CAR_LOAD = 0.35; // a simulated car counts for this much of a bus in a cell's crowding: a bus is 12 m long, a car 4.5 m
const CAR_QUEUE_DRAG = 0.5; // share of a bus's speed lost if every car in its cell is crawling

// Same metre conversion as buses.ts and lothian/build.py.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((55.95 * Math.PI) / 180);

/**
 * A bounded attraction and inverse-square short-range repulsion towards the vehicle ahead, damped by relative speed.
 * A traffic heuristic, not electrostatics: the cruise term and the braking-distance cap override the force.
 * The same rule as the car engine's. `BIG_GAP` and `EMERGENCY_DECEL` are module constants here.
 */
export function particleAcceleration(
  speed: number, desired: number, gap: number, leaderSpeed: number, target: number,
  accel: number, decel: number, minGap: number, dt: number, response = 0.9,
): number {
  const cruise = accel * Math.tanh((desired - speed) / 2);
  if (gap >= BIG_GAP) return cruise;
  const ratio = target / Math.max(0.1, gap);
  const damping = response * Math.min(1, 4 * ratio * ratio);
  const force = accel * (1 - ratio * ratio) + damping * (leaderSpeed - speed);
  const safeSpeed = Math.sqrt(Math.max(0, leaderSpeed * leaderSpeed + 2 * decel * Math.max(0, gap - minGap)));
  return Math.max(-EMERGENCY_DECEL, Math.min(cruise, force, (safeSpeed - speed) / dt));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean dwell for a stop whose previous bus left `sinceLast` seconds ago. */
export const dwellSeconds = (sinceLast: number) => DWELL_BASE_S + BOARD_S_PER_S * Math.min(Math.max(sinceLast, 0), BOARD_MAX_GAP_S);

/** Shortest time to cover `d` metres between two stops: accelerate, cruise at MAX_SPEED if there is room, brake. */
const kinematicMin = (d: number, k: number) => (d >= MAX_SPEED * MAX_SPEED * k ? d / MAX_SPEED + k * MAX_SPEED : 2 * Math.sqrt(k * d));

export interface LegPlan {
  /** Cruise speed on each segment between stops, m/s. */
  speeds: number[];
  /** Share of the normal dwell this leg can afford: 1 unless the timetable is too tight to stop for the full time. */
  dwellScale: number;
}

/**
 * Cruise speed for each segment so a bus takes the timetabled time at nominal headway. Per segment the timetabled time T from one
 * departure to the next, less the dwell and any time lost, is spent accelerating, cruising and braking: T = d/v + k·v with k = 1/(2·accel) + 1/(2·decel),
 * so v is the smaller root of k·v² − T·v + d = 0 (the larger root is a bus that cannot reach that speed in the distance).
 * Where the timetable is too tight even at MAX_SPEED (stops a few hundred metres apart on a minute-resolution timetable), the dwell
 * shrinks first, to at most a quarter, before the bus is simply late.
 */
export function planLeg(leg: BusLeg, nominalHeadway: number, pace = 1): LegPlan {
  const k = 1 / (2 * ACCEL) + 1 / (2 * DECEL);
  const dwellFull = dwellSeconds(nominalHeadway);
  const segs = leg.dists.slice(1).map((end, j) => ({
    d: Math.max(end - (leg.dists[j] as number), 1),
    // Departure to departure, so it holds the time at the far stop however the timetable splits it between arrival and departure.
    T: (leg.times[2 * (j + 1) + 1] as number) - (leg.times[2 * j + 1] as number),
  }));
  const total = segs.reduce((sum, g) => sum + g.T, 0);
  const deficit = (scale: number) => segs.reduce((sum, g) => sum + Math.max(0, kinematicMin(g.d, k) - (g.T - dwellFull * scale - LOST_S)), 0);
  const dwellScale = [1, 0.75, 0.5, 0.35, 0.25].find((scale) => deficit(scale) <= 0.03 * total) ?? 0.25;
  const speeds = segs.map(({ d, T }) => {
    const moving = Math.max(T - dwellFull * dwellScale - LOST_S, kinematicMin(d, k), 1);
    const disc = moving * moving - 4 * k * d;
    const v = disc > 0 ? (moving - Math.sqrt(disc)) / (2 * k) : Math.sqrt(d / k);
    return Math.min(MAX_SPEED, Math.max(1.5, v * pace));
  });
  return { speeds, dwellScale };
}

type Mode = 'run' | 'dwell' | 'layover';
interface Agent {
  id: string;
  route: RouteLoop;
  leg: number;
  /** Metres along the leg's shape. */
  s: number;
  v: number;
  /** Index of the stop being driven to, or dwelt at. */
  next: number;
  mode: Mode;
  timer: number;
  slowUntil: number;
  /** Shared-road speed factor, from the density of buses around it. */
  factor: number;
}

/** The fleet's rates per simulated second, for the congestion costs. "Buses" are fleet equivalents: 2.5 delayed buses means the delay adds up to 2.5 buses' time every second. */
export interface BusRates {
  buses: number;
  /** Metres driven per second, summed over the fleet. */
  metresPerSecond: number;
  /** Time lost to the shared-road slowdown, plus buses held up in a queue, as a number of buses. */
  delayBuses: number;
  /** Buses at a standstill on the road (not at a stop or a terminus), burning fuel without moving. */
  idleBuses: number;
}

export interface TrafficStats {
  buses: number;
  /** Mean speed of buses on the road and not dwelling, km/h. */
  avgKmh: number;
  /** Buses on the move but under 10.8 km/h (including ones easing away from or into a stop); dwelling buses are not counted. */
  slow: number;
  congestedCells: number;
}

/** Cars in one 150 m cell, from the car simulation: how many, how many are crawling, and the summed position of the crawling ones. */
export interface CarCell {
  cars: number;
  slow: number;
  lon: number;
  lat: number;
}

/** Which 150 m cell a position is in. Shared with the car side so both count in the same cells. */
export function cellKey(lon: number, lat: number): number {
  return Math.floor((lon * M_PER_DEG_LON) / CELL_M) * 100003 + Math.floor((lat * M_PER_DEG_LAT) / CELL_M);
}

type CellFeatures = { type: 'FeatureCollection'; features: { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { slowBuses: number; intensity: number } }[] };

export class BusTraffic {
  time: number;
  private readonly agents: Agent[] = [];
  private readonly plans: LegPlan[][];
  private readonly rng: () => number;
  private readonly groups: Agent[][];
  private readonly lastDepart = new Map<number, number>();
  private readonly lastLeave = new Map<number, number>();
  private nextDensity = 0;
  private cells: CellFeatures = { type: 'FeatureCollection', features: [] };
  private congestedCells = 0;
  /** The cars in each cell, or empty when the cars are off or not coupled. */
  private carCells: ReadonlyMap<number, CarCell> = new Map();
  /** 0 turns the shared-road slowdown off; 1 is the default strength. */
  private congestion: number;
  private readonly disturbances: boolean;

  /** `startT` seconds: the timetable-replay layout at that time is where every bus starts. */
  constructor(private readonly model: BusModel, startT = 0, options: { seed?: number; congestion?: number; pace?: number; disturbances?: boolean } = {}) {
    this.time = startT;
    this.rng = mulberry32(options.seed ?? 2026);
    this.congestion = options.congestion ?? 1;
    this.disturbances = options.disturbances ?? true;
    this.plans = model.routes.map((r) => r.legs.map((leg) => planLeg(leg, r.spacing, options.pace ?? (this.disturbances ? DISTURBANCE_PACE : 1))));
    this.groups = Array.from({ length: model.routes.length * 4 }, () => []);
    for (const route of model.routes) for (let k = 0; k < route.count; k++) this.agents.push(this.initial(route, k, startT));
    this.nextDensity = startT;
  }

  /** The latest car positions summarised per cell, or null to ignore the cars. Buses crowd with them and slow in their queues. */
  setCarPressure(cells: ReadonlyMap<number, CarCell> | null): void {
    this.carCells = cells ?? new Map();
  }

  setCongestion(strength: number): void {
    this.congestion = strength;
    if (strength === 0) for (const a of this.agents) a.factor = 1;
  }

  /** Where bus `k` of `route` is in the timetable replay at `t`, as the starting state of a moving agent. */
  private initial(route: RouteLoop, k: number, t: number): Agent {
    let phase = (((t + route.offset + k * route.spacing) % route.cycle) + route.cycle) % route.cycle;
    const base = { id: `${route.index}:${k}`, route, v: 0, slowUntil: 0, factor: 1 };
    for (let l = 0; l < route.legs.length; l++) {
      const leg = route.legs[l] as BusLeg;
      const run = route.durations[l] as number;
      if (phase < run) {
        let lo = 0;
        let hi = leg.dists.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if ((leg.times[2 * mid] as number) <= phase) lo = mid;
          else hi = mid - 1;
        }
        const dep = leg.times[2 * lo + 1] as number;
        if (phase <= dep || lo + 1 >= leg.dists.length) return { ...base, leg: l, s: leg.dists[lo] as number, next: lo, mode: 'dwell', timer: Math.max(dep - phase, 1) };
        const span = Math.max((leg.times[2 * (lo + 1)] as number) - dep, 1e-6);
        const s = (leg.dists[lo] as number) + ((leg.dists[lo + 1] as number) - (leg.dists[lo] as number)) * legProgress((phase - dep) / span, span);
        return { ...base, leg: l, s, v: this.plans[route.index]?.[l]?.speeds[lo] ?? 8, next: lo + 1, mode: 'run', timer: 0 };
      }
      phase -= run;
      if (phase < this.model.layover) return { ...base, leg: l, s: leg.dists[leg.dists.length - 1] as number, next: leg.dists.length - 1, mode: 'layover', timer: this.model.layover - phase };
      phase -= this.model.layover;
    }
    const last = route.legs.length - 1;
    const leg = route.legs[last] as BusLeg;
    return { ...base, leg: last, s: leg.dists[leg.dists.length - 1] as number, next: leg.dists.length - 1, mode: 'layover', timer: 1 };
  }

  private groupKey = (a: Agent) => a.route.index * 4 + a.leg;
  private stopKey = (a: Agent) => (a.route.index * 4 + a.leg) * 1000 + a.next;

  /** Runs the simulation up to `t`. If it has fallen far behind (a hidden tab), it skips ahead instead of catching up. */
  advanceTo(t: number, maxSteps = 600): void {
    let n = 0;
    while (this.time + STEP_S <= t && n < maxSteps) {
      this.step();
      n++;
    }
    if (this.time + STEP_S <= t) this.time = t;
  }

  step(): void {
    this.time += STEP_S;
    if (this.time >= this.nextDensity) this.updateDensity();
    for (const g of this.groups) g.length = 0;
    for (const a of this.agents) (this.groups[this.groupKey(a)] as Agent[]).push(a);
    for (const g of this.groups) g.sort((x, y) => x.s - y.s);

    // Accelerations from the state at the start of the step, then movement front to back so followers see updated leaders.
    const accel = new Map<Agent, number>();
    for (const g of this.groups) {
      for (let i = 0; i < g.length; i++) {
        const a = g[i] as Agent;
        if (a.mode !== 'run') continue;
        const leg = a.route.legs[a.leg] as BusLeg;
        const leader = g[i + 1];
        const leaderGap = leader ? leader.s - a.s - BUS_LENGTH : BIG_GAP;
        const stopGap = (leg.dists[a.next] as number) - a.s;
        let desired = (this.plans[a.route.index]?.[a.leg]?.speeds[a.next - 1] ?? 8) * a.factor;
        if (this.time < a.slowUntil) desired *= LAPSE_FACTOR;
        else if (this.disturbances && this.rng() < LAPSE_PER_S * STEP_S) a.slowUntil = this.time + LAPSE_MIN_S + this.rng() * LAPSE_SPAN_S;
        const a2 = !leader || stopGap < leaderGap // no bus ahead, or the stop is nearer: the stop is a stationary leader
          ? particleAcceleration(a.v, desired, stopGap, 0, STOP_TARGET, ACCEL, DECEL, STOP_MIN_GAP, STEP_S)
          : particleAcceleration(a.v, desired, leaderGap, leader.v, TARGET_GAP, ACCEL, DECEL, MIN_GAP, STEP_S);
        accel.set(a, a2);
      }
    }
    for (const g of this.groups) {
      for (let i = g.length - 1; i >= 0; i--) {
        const a = g[i] as Agent;
        if (a.mode === 'run') this.advance(a, g[i + 1], accel.get(a) ?? 0);
        else if (a.mode === 'dwell') this.dwell(a);
        else this.layover(a);
      }
    }
  }

  private advance(a: Agent, leader: Agent | undefined, acc: number): void {
    const leg = a.route.legs[a.leg] as BusLeg;
    const vNew = Math.min(MAX_SPEED, Math.max(0, a.v + acc * STEP_S));
    let move = ((a.v + vNew) / 2) * STEP_S;
    const wanted = move;
    if (leader) move = Math.min(move, Math.max(0, leader.s - BUS_LENGTH - 0.5 - a.s)); // hard no-overlap rule
    a.v = move < wanted ? Math.min(vNew, move / STEP_S) : vNew;
    a.s += move;
    const stopAt = leg.dists[a.next] as number;
    if (a.s >= stopAt - 0.01 || (stopAt - a.s < ARRIVE_GAP && a.v < ARRIVE_SPEED)) {
      a.s = stopAt;
      a.v = 0;
      if (a.next >= leg.dists.length - 1) {
        a.mode = 'layover';
        a.timer = this.model.layover;
      } else {
        const since = this.time - (this.lastDepart.get(this.stopKey(a)) ?? this.time - a.route.spacing);
        a.mode = 'dwell';
        a.timer = dwellSeconds(since) * (this.plans[a.route.index]?.[a.leg]?.dwellScale ?? 1) * (this.disturbances ? 1 + DWELL_JITTER * (this.rng() * 2 - 1) : 1);
      }
    }
  }

  private dwell(a: Agent): void {
    a.timer -= STEP_S;
    if (a.timer > 0) return;
    this.lastDepart.set(this.stopKey(a), this.time);
    a.mode = 'run';
    a.next++;
  }

  private layover(a: Agent): void {
    a.timer -= STEP_S;
    if (a.timer > 0) return;
    const legs = a.route.legs.length;
    const nextLeg = (a.leg + 1) % legs;
    const key = a.route.index * 4 + nextLeg;
    const leg = a.route.legs[nextLeg] as BusLeg;
    const start = leg.dists[0] as number;
    // Hold for the headway, and until the first stretch of the next leg is clear.
    if (this.time - (this.lastLeave.get(key) ?? -Infinity) < HOLD_SHARE * a.route.spacing) return;
    const first = (this.groups[key] as Agent[])[0];
    if (first && first.s < start + BUS_LENGTH + 2) return;
    this.lastLeave.set(key, this.time);
    a.leg = nextLeg;
    a.s = start;
    a.next = 1;
    a.v = 0;
    a.mode = 'run';
  }

  /** Counts buses per 150 m cell, derives each bus's shared-road factor, and flags cells that are mostly crawling. */
  private updateDensity(): void {
    this.nextDensity = this.time + DENSITY_EVERY_S;
    type Cell = { total: number; slow: number; lon: number; lat: number; cars: number; slowCars: number };
    const cells = new Map<number, Cell>();
    const keyOf = (a: Agent): [number, Cell] => {
      const leg = a.route.legs[a.leg] as BusLeg;
      const p = pointAt(this.model.shapes[leg.shape] as Shape, a.s);
      const key = cellKey(p.lon, p.lat);
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { total: 0, slow: 0, lon: 0, lat: 0, cars: 0, slowCars: 0 }));
      return [key, cell];
    };
    const onRoad = this.agents.filter((a) => a.mode !== 'layover'); // a bus laying over at a terminus is off the street
    const cellOf = new Map<Agent, Cell>();
    for (const a of onRoad) {
      const [, cell] = keyOf(a);
      cellOf.set(a, cell);
      cell.total++;
      if (a.v < SLOW_SPEED) {
        const leg = a.route.legs[a.leg] as BusLeg;
        const p = pointAt(this.model.shapes[leg.shape] as Shape, a.s);
        cell.slow++;
        cell.lon += p.lon;
        cell.lat += p.lat;
      }
    }
    for (const [key, car] of this.carCells) {
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { total: 0, slow: 0, lon: 0, lat: 0, cars: 0, slowCars: 0 }));
      cell.cars = car.cars;
      cell.slowCars = car.slow;
      cell.lon += car.lon; // the summed position of the crawling cars, so the glow sits on whatever is crawling
      cell.lat += car.lat;
    }
    for (const a of this.agents) {
      const cell = cellOf.get(a);
      const excess = cell ? Math.max(0, cell.total + CAR_LOAD * cell.cars - CELL_FREE_BUSES) : 0;
      let factor = 1 / (1 + SLOWDOWN * this.congestion * excess);
      if (cell && cell.cars >= 3) factor *= 1 - CAR_QUEUE_DRAG * this.congestion * (cell.slowCars / cell.cars); // stuck behind a queue of cars
      a.factor = this.congestion === 0 ? 1 : Math.max(MIN_FACTOR, factor);
    }
    const features: CellFeatures['features'] = [];
    for (const c of cells.values()) {
      const slow = c.slow + c.slowCars; // buses and cars alike: it is the street that is congested
      if (slow >= GLOW_MIN_SLOW && slow / (c.total + c.cars) >= GLOW_MIN_SHARE) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon / slow, c.lat / slow] }, properties: { slowBuses: c.slow, intensity: Math.min(1, slow / 8) } });
      }
    }
    this.cells = { type: 'FeatureCollection', features };
    this.congestedCells = features.length;
  }

  /** Every bus as the shape the map layers already take. */
  buses(): Bus[] {
    return this.agents.map((a) => {
      const leg = a.route.legs[a.leg] as BusLeg;
      const p = pointAt(this.model.shapes[leg.shape] as Shape, a.s);
      return { id: a.id, route: a.route, leg: a.leg, atStop: a.mode !== 'run', layover: a.mode === 'layover', nextStop: leg.stops[a.next] as number, ...p };
    });
  }

  congestionCells(): CellFeatures {
    return this.cells;
  }

  stats(): TrafficStats {
    let moving = 0;
    let speed = 0;
    let slow = 0;
    for (const a of this.agents) {
      if (a.mode !== 'run') continue;
      moving++;
      speed += a.v;
      if (a.v < SLOW_SPEED) slow++;
    }
    return { buses: this.agents.length, avgKmh: moving ? (speed / moving) * 3.6 : 0, slow, congestedCells: this.congestedCells };
  }

  /**
   * Per-second rates for the congestion costs. A bus on the road loses `1 - factor` of its time to the shared-road slowdown and all of
   * it while stopped in a queue. Dwelling at stops and layovers is timetabled, so it is neither delay nor idling here.
   */
  rates(): BusRates {
    let metresPerSecond = 0;
    let delayBuses = 0;
    let idleBuses = 0;
    for (const a of this.agents) {
      if (a.mode !== 'run') continue;
      metresPerSecond += a.v;
      if (a.v < IDLE_SPEED) {
        delayBuses += 1;
        idleBuses += 1;
      } else delayBuses += 1 - a.factor;
    }
    return { buses: this.agents.length, metresPerSecond, delayBuses, idleBuses };
  }

  /** Test hook: read-only view of the agents. */
  snapshot(): readonly Readonly<Agent>[] {
    return this.agents;
  }
}
