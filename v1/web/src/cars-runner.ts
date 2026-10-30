// The loop that runs the car engine, with no Worker, DOM or timer in it, so it can be driven by a fake clock in tests.
// cars.worker.ts wires it to postMessage and setInterval.
import { CarSim, mulberry32 } from './engine/car-sim.mjs';
import { BusRoadEffects } from './car-bus-effects';
import { TripFlow, type TripStats } from './trips';
import { FLOATS_PER_CAR, type FromWorker, type ToWorker } from './cars-protocol';

export const STEP_SECONDS = 0.2; // the engine's own step: a car moves a few metres at most
const BUDGET_MS = 30; // most real time spent simulating in one tick, so the worker stays responsive
const STATS_EVERY_MS = 1000;
const GRIDLOCK_SECONDS = 120;

// Gridlock relief. The engine lets a car onto a road only if there is room behind that road's last car. On a dense grid of streets,
// queues then spill back round a block until a ring of full roads is waiting on itself, and it never clears: on the Edinburgh pilot
// network the number of cars stopped for over two minutes grows steadily and does not recover. Like SUMO's "teleporting", a car
// stopped for longer than this is moved to a road with room. No red light lasts this long (the engine's cycle is 90 s).
export const RELIEF_AFTER_S = 90;
const RELIEF_EVERY_STEPS = 25; // 5 simulated seconds
const RELIEF_TRIES = 30;
const ROOM_AT_START_M = 8; // free road needed behind a relocated car: car length 4.5 m, gap 2 m, plus 1 m

export class CarRunner {
  private sim: CarSim | null = null;
  private speed = 1;
  private running = false;
  private frameMs = 100;
  private target = 0;
  private lastTick = 0;
  private lastFrame = 0;
  private lastStats = 0;
  private simulatedSince = 0;
  private realSince = 0;
  private achieved = 1;
  private relocated = 0;
  private sinceRelief = 0;
  private random: () => number = Math.random;
  private cumulative: Float64Array = new Float64Array(0);
  /** Cars on the road at a demand of 1 (the init population). */
  private population = 0;
  /** Car slots for the background traffic (up to the demand slider's top value); slots after these belong to the festival trips. */
  private baselineSlots = 0;
  /** Festival cars heading for venues, or null when no venues were given. */
  private trips: TripFlow | null = null;
  private stepCount = 0;
  /** Roads closed to vehicles at the moment (edge indexes). */
  private closedNow = new Set<number>();
  /** How buses on a road slow its cars. Null until the engine exists. */
  private effects: BusRoadEffects | null = null;
  private slowedByBuses = 0;
  // Since the last stats message, for the congestion costs (see account()).
  private simAcc = 0;
  private delayAcc = 0;
  private idleAcc = 0;
  private distanceAcc = 0;

  constructor(
    private readonly post: (message: FromWorker, transfer?: Transferable[]) => void,
    /** False turns the gridlock relief off, which is only useful to show what happens without it. */
    private readonly relief = true,
  ) {}

  handle(message: ToWorker): void {
    try {
      if (message.type === 'init') {
        this.sim = new CarSim(message.roads, { population: message.population, seed: message.seed });
        const capacity = this.sim.capacity();
        // Never ask for more cars than fit at safe spacing; the engine refuses rather than overlapping them. Slots beyond the
        // population are for demand above 1 and start switched off.
        this.population = Math.min(message.population, capacity);
        const slots = Math.min(capacity, Math.max(this.population, Math.round(message.population * (message.maxDemand ?? 1))));
        const tripSlots = message.venues?.length ? Math.max(0, Math.min(message.tripSlots ?? 0, capacity - slots)) : 0;
        this.baselineSlots = slots;
        this.sim.reseed({ population: slots + tripSlots });
        this.effects = new BusRoadEffects(this.sim);
        this.slowedByBuses = 0;
        this.closedNow = new Set();
        for (let i = this.population; i < this.sim.n; i++) this.sim.switchOff(i);
        this.random = mulberry32(message.seed + 1); // its own stream, so relief never changes where the engine places or turns cars
        this.trips = message.venues?.length ? new TripFlow(this.sim, message.venues, message.roads.classes, slots, mulberry32(message.seed + 2)) : null;
        this.stepCount = 0;
        this.cumulative = this.cumulativeLaneMetres(this.sim);
        this.relocated = this.sinceRelief = 0;
        this.simAcc = this.delayAcc = this.idleAcc = this.distanceAcc = 0;
        this.target = this.sim.time;
        this.post({ type: 'ready', cars: this.population, capacity, venuesPlaced: this.trips?.placed() });
      } else if (message.type === 'demand') {
        if (this.sim) this.applyDemand(this.sim, message.fraction);
      } else if (message.type === 'trips') {
        this.trips?.setRates(message.rates);
      } else if (message.type === 'closed') {
        if (this.sim) this.applyClosed(this.sim, message.edges);
      } else if (message.type === 'buses') {
        this.slowedByBuses = this.effects?.apply(message.data) ?? 0;
      } else {
        this.speed = message.speed;
        this.running = message.running;
        this.frameMs = message.frameMs;
      }
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Advances the simulation by the real time since the last tick, within the work budget, and posts frames and stats on schedule. */
  tick(nowMs: number): void {
    const sim = this.sim;
    if (!sim) return;
    const elapsed = this.lastTick ? Math.min(nowMs - this.lastTick, 250) : 0; // a hidden tab must not cause a huge catch-up
    this.lastTick = nowMs;
    if (this.running) {
      this.target += (elapsed / 1000) * this.speed;
      const before = sim.time;
      const started = performance.now();
      while (sim.time + STEP_SECONDS <= this.target && performance.now() - started < BUDGET_MS) this.stepOnce(sim);
      if (sim.time + STEP_SECONDS <= this.target) this.target = sim.time; // cannot keep up: run slower rather than fall further behind
      this.simulatedSince += sim.time - before;
      this.realSince += elapsed;
    }
    if (nowMs - this.lastFrame >= this.frameMs) {
      this.lastFrame = nowMs;
      this.postFrame(sim);
    }
    if (nowMs - this.lastStats >= STATS_EVERY_MS) {
      this.lastStats = nowMs;
      if (this.realSince > 0) this.achieved = this.simulatedSince / (this.realSince / 1000);
      this.simulatedSince = this.realSince = 0;
      const stats = sim.stats(GRIDLOCK_SECONDS);
      this.post({
        type: 'stats', cars: stats.fleet, averageKmh: stats.averageSpeedMps * 3.6, gridlocked: stats.gridlocked,
        achievedSpeed: this.running ? this.achieved : 0, signals: sim.signalCount, relocated: this.relocated, slowedByBuses: this.slowedByBuses,
        simSeconds: this.simAcc, delayCarSeconds: this.delayAcc, idleCarSeconds: this.idleAcc, distanceM: this.distanceAcc,
        trips: this.trips?.stats(),
      });
      this.simAcc = this.delayAcc = this.idleAcc = this.distanceAcc = 0;
    }
  }

  private stepOnce(sim: CarSim): void {
    this.trips?.step(STEP_SECONDS);
    sim.step(STEP_SECONDS);
    if (this.trips && ++this.stepCount % 5 === 0) this.trips.check();
    this.account(sim, STEP_SECONDS);
    if (this.relief && ++this.sinceRelief >= RELIEF_EVERY_STEPS) {
      this.sinceRelief = 0;
      this.relieveGridlock(sim);
    }
  }

  /** Runs `seconds` of simulated time at once, with no work budget and no frames: for tests and benchmarks. */
  simulate(seconds: number): void {
    const sim = this.sim;
    if (!sim) return;
    for (let t = 0; t < seconds; t += STEP_SECONDS) this.stepOnce(sim);
    this.target = sim.time;
  }

  /** How many roads are closed to vehicles at the moment. */
  closedRoads(): number {
    return this.closedNow.size;
  }

  /** The slow-traffic sums since the last call, then starts them again from zero. For headless scenario runs, which never get a stats message. */
  takeSums(): { simSeconds: number; delayCarSeconds: number; idleCarSeconds: number; distanceM: number } {
    const sums = { simSeconds: this.simAcc, delayCarSeconds: this.delayAcc, idleCarSeconds: this.idleAcc, distanceM: this.distanceAcc };
    this.simAcc = this.delayAcc = this.idleAcc = this.distanceAcc = 0;
    return sums;
  }

  /** Festival trip figures since the run began, or null when no venues were given. */
  tripFigures(): TripStats | null {
    return this.trips?.stats() ?? null;
  }

  /** Where the traffic stands now: cars stopped over two minutes, mean speed, cars relocated so far. */
  figures(): { cars: number; stuck: number; averageKmh: number; relocated: number } {
    const stats = this.sim?.stats(GRIDLOCK_SECONDS);
    return { cars: stats?.fleet ?? 0, stuck: stats?.gridlocked ?? 0, averageKmh: (stats?.averageSpeedMps ?? 0) * 3.6, relocated: this.relocated };
  }

  private cumulativeLaneMetres(sim: CarSim): Float64Array {
    const out = new Float64Array(sim.E);
    let total = 0;
    for (let e = 0; e < sim.E; e++) out[e] = total += (sim.length[e] as number) * (sim.lanes[e] as number);
    return out;
  }

  /**
   * Adds this step's slow-traffic figures to the running sums. A car's delay is the share of the step it lost against the speed it would
   * choose on a clear road (the road's posted speed times its own pace factor, never above the limit), so a driver who is just slow is
   * not counted, but one held at a signal or in a queue is. Idle time is time at a standstill.
   */
  private account(sim: CarSim, dt: number): void {
    this.simAcc += dt;
    for (let i = 0; i < sim.n; i++) {
      if (!sim.active[i]) continue;
      const v = sim.v[i] as number;
      // The road's own speed, not the lowered one a bus on it causes: a car held up by a bus has lost time, so it counts as delay.
      const road = sim.edge[i] as number;
      const free = (this.effects?.freeSpeed(road) ?? (sim.speed[road] as number)) * Math.min(1, sim.factor[i] as number);
      if (free > 0 && v < free) this.delayAcc += dt * (1 - v / free);
      if (v < 0.1) this.idleAcc += dt;
      this.distanceAcc += v * dt;
    }
  }

  /** Closes exactly these roads and reopens any that were closed before and are not in the list. A set that has not changed does nothing. */
  private applyClosed(sim: CarSim, edges: readonly number[]): void {
    const next = new Set(edges.filter((e) => e >= 0 && e < sim.E));
    const reopen = [...this.closedNow].filter((e) => !next.has(e));
    const close = [...next].filter((e) => !this.closedNow.has(e));
    if (reopen.length === 0 && close.length === 0) return;
    if (reopen.length) sim.setClosed(reopen, false);
    if (close.length) sim.setClosed(close, true);
    this.closedNow = next;
  }

  /** Puts the cars on the road to `fraction` of the init population: extra cars leave at their next junction, missing ones join at a road start. */
  private applyDemand(sim: CarSim, fraction: number): void {
    const target = Math.min(this.baselineSlots, Math.max(0, Math.round(this.population * fraction)));
    let on = 0;
    for (let i = 0; i < this.baselineSlots; i++) if (sim.active[i] && !sim.leaving[i]) on++;
    if (on > target) {
      for (let i = this.baselineSlots - 1, excess = on - target; i >= 0 && excess > 0; i--) {
        if (!sim.active[i] || sim.leaving[i]) continue;
        sim.leaving[i] = 1;
        excess--;
      }
    } else if (on < target) {
      let missing = target - on;
      for (let i = 0; i < this.baselineSlots && missing > 0; i++) {
        if (sim.active[i] && sim.leaving[i]) { sim.leaving[i] = 0; missing--; } // changed its mind before reaching a junction
      }
      for (let i = 0; i < this.baselineSlots && missing > 0; i++) if (!sim.active[i] && this.placeCar(sim, i)) missing--;
    }
  }

  /** Moves every car that has been stopped for over RELIEF_AFTER_S to the start of a random road with room, weighted by lane length. */
  relieveGridlock(sim: CarSim): void {
    for (let car = 0; car < sim.n; car++) {
      if (!sim.active[car] || (sim.wait[car] as number) <= RELIEF_AFTER_S) continue;
      if (this.placeCar(sim, car)) {
        this.relocated++;
        this.trips?.reroute(car); // a festival car keeps its destination
      }
    }
  }

  /** Puts car `car` (switched on if it was off) at the start of a random road with room, at rest. False if no road had room in a few tries. */
  private placeCar(sim: CarSim, car: number): boolean {
    const total = this.cumulative[this.cumulative.length - 1] ?? 0;
    for (let attempt = 0; attempt < RELIEF_TRIES; attempt++) {
      const r = this.random() * total;
      let lo = 0;
      let hi = sim.E - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((this.cumulative[mid] as number) < r) lo = mid + 1;
        else hi = mid;
      }
      const lane = Math.floor(this.random() * (sim.lanes[lo] as number));
      const key = lo * 4 + lane;
      const rear = sim.rear[key] as number;
      if (sim.dead[lo] || sim.laneCapacity(lo) < 1 || (rear >= 0 && (sim.pos[rear] as number) < ROOM_AT_START_M)) continue;
      sim.active[car] = 1;
      sim.leaving[car] = 0;
      sim.group[car] = -1;
      sim.edge[car] = lo;
      sim.lane[car] = lane;
      sim.pos[car] = 0;
      sim.v[car] = 0;
      sim.wait[car] = 0;
      sim.cooldown[car] = 0;
      sim.seg[car] = sim.ptStart[lo] as number;
      sim.back[car] = 0;
      sim.route[car] = null;
      sim.rear[key] = car;
      sim.pickNext(car, lo);
      return true;
    }
    return false;
  }

  private postFrame(sim: CarSim): void {
    let count = 0;
    for (let i = 0; i < sim.n; i++) if (sim.active[i]) count++;
    const data = new Float32Array(count * FLOATS_PER_CAR);
    const where = [0, 0, 0];
    for (let i = 0, k = 0; i < sim.n; i++) {
      if (!sim.active[i]) continue;
      sim.locate(i, where);
      data.set([where[0] as number, where[1] as number, where[2] as number, sim.v[i] as number, sim.kind[i] as number], k * FLOATS_PER_CAR);
      k++;
    }
    this.post({ type: 'frame', time: sim.time, data }, [data.buffer]);
  }
}
