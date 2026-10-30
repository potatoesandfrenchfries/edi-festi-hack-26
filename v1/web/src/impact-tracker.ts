// Runs the cost-of-traffic ledger alongside the simulations. It owns the day clock and decides how fast it moves:
//  - while the cars run, the day advances by the simulated seconds the car worker reports, and the cars' own slow-traffic sums go into the
//    ledger as they are (so the figures are right however fast or slow the worker manages to run);
//  - otherwise (cars off, or the worker not reporting) it advances by real time at the simulation speed, with buses only.
// The buses run on their own clock, so their costs are a rate (what the fleet is doing right now) held for the day's elapsed time.
// It also feeds the car worker the number of cars the time of day and the demand slider call for, and the streets that are closed to
// vehicles at this time of day on a Fringe day (closures.ts). No DOM, map or timers: tick() is called.
import type { ClosedNow } from './closures';
import type { ImpactView } from './controls';
import {
  Ledger, busIncrement, carIncrement, carbon, clockLabel, commentary, demandAt, gbp, ratePerHour, summarise, zero,
  type CarSums, type Economics,
} from './impact';
import type { DayType } from './presence';
import type { BusRates } from './traffic';

/** The simulated day starts here (06:00), so a run reaches the morning peak quickly. */
export const DAY_START_S = 6 * 3600;
const CARS_STALE_MS = 2500; // the worker reports about once a second; this much silence means it is not running
const MAX_WALL_S = 2; // a stalled timer must not add a long stretch of day at once
const DEMAND_EPSILON = 0.004;

export interface ImpactSources {
  /** The bus fleet's rates right now, or null while the buses are off. */
  busRates(): BusRates | null;
  /** Puts this many cars on the road, as a multiple of the population `make cars` chose. */
  setCarDemand(fraction: number): void;
  /** Closes exactly these roads to vehicles (edge indexes; empty reopens all) and shows them on the map. */
  setClosedEdges?(edges: number[]): void;
  /** Simulated seconds per real second that the bus side is set to. */
  speed(): number;
  hidden(): boolean;
  now(): number;
}

export interface ImpactScenario {
  carsOn: boolean;
  busesOn: boolean;
  busFrequency: number;
  carDemand: number;
  /** Which day type's closures to use (Weekday, Saturday or Sunday on the Fringe), and whether the closures are switched on. */
  day?: DayType;
  closuresOn?: boolean;
}

/** What is closed to vehicles at a time of day, on a day type. */
export interface ClosureSource {
  at(day: DayType, clockSeconds: number): ClosedNow;
}

export class ImpactTracker {
  readonly ledger = new Ledger(DAY_START_S);
  private scenario: ImpactScenario = { carsOn: false, busesOn: false, busFrequency: 1, carDemand: 1 };
  private carsAt = -Infinity;
  private lastTick: number;
  private sentDemand = Number.NaN;
  private sentClosed = '';
  private closed: ClosedNow = { edges: [], active: [] };

  constructor(private readonly econ: Economics, private readonly src: ImpactSources, private readonly closures: ClosureSource | null = null) {
    this.lastTick = src.now();
  }

  setScenario(next: ImpactScenario): void {
    this.scenario = next;
    if (!next.carsOn) this.carsAt = -Infinity;
    this.sendDemand();
    this.sendClosed();
  }

  /** The car worker's figures for the last interval, or null when the cars are off or have stopped. */
  onCarStats(stats: (CarSums & { simSeconds: number }) | null): void {
    if (!stats) {
      this.carsAt = -Infinity;
      return;
    }
    this.carsAt = this.src.now();
    if (stats.simSeconds <= 0) return;
    this.advance(stats.simSeconds, carIncrement(this.econ, stats));
  }

  /** Call about once a second. Moves the day on when the cars are not doing it. */
  tick(): void {
    const now = this.src.now();
    const wall = Math.min((now - this.lastTick) / 1000, MAX_WALL_S);
    this.lastTick = now;
    if (this.src.hidden() || !this.scenario.busesOn || now - this.carsAt < CARS_STALE_MS) return;
    this.advance(wall * this.src.speed(), zero());
  }

  /** Starts the simulated day again, at 06:00 or at `startClock` (seconds since midnight). */
  restart(startClock: number = DAY_START_S): void {
    this.ledger.reset(startClock);
    this.sentDemand = Number.NaN; // say it again: the worker's cars are wherever the last day left them
    this.sendDemand();
    this.sendClosed();
  }

  view(): ImpactView {
    const { all, cars, buses } = summarise(this.econ, this.ledger.cars, this.ledger.buses);
    const { carsOn, busesOn, busFrequency, carDemand } = this.scenario;
    const lines = commentary(
      { all, cars, buses },
      { clock: this.ledger.clock, days: this.ledger.days, carsOn, busesOn, busFrequency, carDemand, closedStreets: this.closedStreets() },
      ratePerHour(this.econ, this.ledger),
    );
    const hours = all.delayPersonHours < 10 ? all.delayPersonHours.toFixed(1) : Math.round(all.delayPersonHours).toLocaleString('en-GB');
    const litres = all.fuelLitres < 10 ? all.fuelLitres.toFixed(1) : Math.round(all.fuelLitres).toLocaleString('en-GB');
    return {
      total: gbp(all.totalGbp),
      time: `${gbp(all.timeLostGbp)} · ${hours} h`,
      fuel: `${gbp(all.fuelGbp)} · ${litres} L`,
      co2: carbon(all.co2Kg),
      carbon: gbp(all.carbonGbp),
      cars: gbp(cars.totalGbp),
      buses: gbp(buses.totalGbp),
      clock: this.ledger.days > 0 ? `${clockLabel(this.ledger.clock)} · day ${this.ledger.days + 1}` : clockLabel(this.ledger.clock),
      lines,
    };
  }

  private advance(seconds: number, cars: ReturnType<typeof zero>): void {
    const rates = this.scenario.busesOn ? this.src.busRates() : null;
    this.ledger.add(seconds, cars, rates ? busIncrement(this.econ, rates, seconds) : zero());
    this.sendDemand();
    this.sendClosed();
  }

  /** The names of the streets closed to vehicles right now, each once; none when the closures or the cars are off. */
  private closedStreets(): string[] {
    return this.scenario.carsOn && this.scenario.closuresOn ? [...new Set(this.closed.active.map((c) => c.name))] : [];
  }

  /** Sends the worker the roads that are closed at this time of day, when that changes. */
  private sendClosed(): void {
    const on = Boolean(this.closures && this.scenario.closuresOn && this.scenario.carsOn);
    this.closed = on && this.closures ? this.closures.at(this.scenario.day ?? 'weekday', this.ledger.clock) : { edges: [], active: [] };
    const key = this.closed.edges.join(',');
    if (key === this.sentClosed) return;
    this.sentClosed = key;
    this.src.setClosedEdges?.(this.closed.edges);
  }

  private sendDemand(): void {
    if (!this.scenario.carsOn) return;
    const fraction = demandAt(this.econ.demand.car_hourly_profile, this.ledger.clock) * this.scenario.carDemand;
    if (Number.isFinite(this.sentDemand) && Math.abs(fraction - this.sentDemand) <= DEMAND_EPSILON) return;
    this.sentDemand = fraction;
    this.src.setCarDemand(fraction);
  }
}
