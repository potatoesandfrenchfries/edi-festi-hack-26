import { describe, expect, it } from 'vitest';
import type { Closure } from './closures';
import type { Economics } from './impact';
import { DAY_START_S, ImpactTracker, type ImpactScenario, type ImpactSources } from './impact-tracker';
import type { DayType } from './presence';
import type { BusRates } from './traffic';

const econ: Economics = {
  status: 'placeholder',
  time: { value_of_time_gbp_per_hour: 10, car_occupancy: 1, bus_passengers_per_bus: 10 },
  fuel: { car_price_gbp_per_litre: 1, bus_price_gbp_per_litre: 1, car_idle_litres_per_hour: 1, car_litres_per_km: 0.1, bus_idle_litres_per_hour: 2, bus_litres_per_km: 0.4 },
  emissions: { car_kg_co2e_per_litre: 2, bus_kg_co2e_per_litre: 2, carbon_value_gbp_per_tonne: 100 },
  scale: { fleet_scale: 1 },
  demand: {
    car_hourly_profile: Array.from({ length: 24 }, () => 0.5),
    car_demand: { min: 0.25, max: 1.5, step: 0.05, default: 1 },
    bus_frequency: { min: 0.25, max: 3, step: 0.25, default: 1 },
  },
};
const rates: BusRates = { buses: 10, metresPerSecond: 20, delayBuses: 1, idleBuses: 0 };

function setup(over: Partial<ImpactScenario> = {}, busRates: BusRates | null = rates) {
  const clock = { now: 1000, hidden: false, speed: 60 };
  const demands: number[] = [];
  const src: ImpactSources = { busRates: () => busRates, setCarDemand: (f) => void demands.push(f), speed: () => clock.speed, hidden: () => clock.hidden, now: () => clock.now };
  const tracker = new ImpactTracker(econ, src);
  tracker.setScenario({ carsOn: true, busesOn: true, busFrequency: 1, carDemand: 1, ...over });
  return { tracker, clock, demands };
}
const sums = (simSeconds: number) => ({ simSeconds, delayCarSeconds: simSeconds / 2, idleCarSeconds: simSeconds / 4, distanceM: 1000 });

describe('ImpactTracker', () => {
  it('starts the day at 06:00 with nothing used up', () => {
    const { tracker } = setup();
    expect(tracker.ledger.clock).toBe(DAY_START_S);
    expect(tracker.view().total).toBe('£0.00');
    expect(tracker.view().clock).toBe('06:00');
  });

  it('moves the day by the simulated seconds the car worker reports, and adds the cars and the buses for that time', () => {
    const { tracker } = setup();
    tracker.onCarStats(sums(600));
    expect(tracker.ledger.clock).toBe(DAY_START_S + 600);
    expect(tracker.ledger.cars.delayPersonHours).toBeCloseTo(300 / 3600, 9);
    expect(tracker.ledger.buses.delayPersonHours).toBeCloseTo((1 * 600) / 3600 * 10, 9);
    expect(tracker.view().clock).toBe('06:10');
    expect(Number(tracker.view().total.replace('£', ''))).toBeGreaterThan(0);
  });

  it('does not let real time move the day while the cars are reporting', () => {
    const { tracker, clock } = setup();
    tracker.onCarStats(sums(60));
    clock.now += 1000;
    tracker.tick();
    expect(tracker.ledger.clock).toBe(DAY_START_S + 60);
  });

  it('falls back to real time at the simulation speed, buses only, once the cars go quiet', () => {
    const { tracker, clock } = setup();
    tracker.onCarStats(sums(60));
    clock.now += 5000; // longer than the worker may stay silent
    tracker.tick();
    expect(tracker.ledger.clock).toBeCloseTo(DAY_START_S + 60 + 2 * 60, 6); // capped at 2 s of real time, at 60x
    expect(tracker.ledger.cars.delayPersonHours).toBeCloseTo(30 / 3600, 9); // unchanged by the fallback
  });

  it('advances with the buses alone when the cars are off', () => {
    const { tracker, clock } = setup({ carsOn: false });
    clock.now += 1000;
    tracker.tick();
    expect(tracker.ledger.clock).toBe(DAY_START_S + 60);
    expect(tracker.ledger.cars.delayPersonHours).toBe(0);
    expect(tracker.ledger.buses.drivingLitres).toBeGreaterThan(0);
  });

  it('holds the day while neither simulation is running, or the tab is hidden', () => {
    const none = setup({ carsOn: false, busesOn: false });
    none.clock.now += 1000;
    none.tracker.tick();
    expect(none.tracker.ledger.clock).toBe(DAY_START_S);
    const hidden = setup({ carsOn: false });
    hidden.clock.hidden = true;
    hidden.clock.now += 1000;
    hidden.tracker.tick();
    expect(hidden.tracker.ledger.clock).toBe(DAY_START_S);
  });

  it('uses no bus costs while the buses are off', () => {
    const { tracker } = setup({ busesOn: false });
    tracker.onCarStats(sums(600));
    expect(tracker.ledger.buses.drivingLitres).toBe(0);
    expect(tracker.ledger.cars.drivingLitres).toBeGreaterThan(0);
  });

  it('gives the same totals whether the worker reports in one piece or many', () => {
    const one = setup();
    one.tracker.onCarStats({ simSeconds: 600, delayCarSeconds: 300, idleCarSeconds: 150, distanceM: 6000 });
    const many = setup();
    for (let i = 0; i < 10; i++) many.tracker.onCarStats({ simSeconds: 60, delayCarSeconds: 30, idleCarSeconds: 15, distanceM: 600 });
    expect(many.tracker.ledger.cars.delayPersonHours).toBeCloseTo(one.tracker.ledger.cars.delayPersonHours, 9);
    expect(many.tracker.ledger.buses.co2Kg).toBeCloseTo(one.tracker.ledger.buses.co2Kg, 9);
  });

  it('asks for the cars the hour and the slider call for, and only when that changes', () => {
    const { tracker, demands } = setup({ carDemand: 1.5 });
    expect(demands).toEqual([0.75]); // 0.5 of the day's profile x 1.5
    tracker.onCarStats(sums(60));
    expect(demands).toEqual([0.75]); // unchanged, not sent again
    tracker.setScenario({ carsOn: true, busesOn: true, busFrequency: 1, carDemand: 0.5 });
    expect(demands).toEqual([0.75, 0.25]);
  });

  it('does not touch the cars when they are off', () => {
    const { demands } = setup({ carsOn: false });
    expect(demands).toEqual([]);
  });

  it('restarts the day from 06:00 with nothing used up, and asks for the cars again', () => {
    const { tracker, demands } = setup();
    tracker.onCarStats(sums(3600));
    tracker.restart();
    expect(tracker.ledger.clock).toBe(DAY_START_S);
    expect(tracker.view().total).toBe('£0.00');
    expect(demands.length).toBeGreaterThanOrEqual(1);
  });

  it('forgets the cars when told they are off', () => {
    const { tracker, clock } = setup();
    tracker.onCarStats(sums(60));
    tracker.onCarStats(null);
    clock.now += 1000;
    tracker.tick();
    expect(tracker.ledger.clock).toBe(DAY_START_S + 60 + 60);
  });

  it('describes the day in sentences once something has built up', () => {
    const { tracker } = setup({ busFrequency: 2 });
    tracker.onCarStats(sums(1800));
    const lines = tracker.view().lines;
    expect(lines[0]).toContain('By 06:30');
    expect(lines.join(' ')).toContain('×2.00');
  });
});

describe('ImpactTracker closures', () => {
  const high: Closure = { id: 'R1', location: 'high_street', name: 'High Street', festival: 'Fringe', type: 'closed_to_vehicles', from: 10.5 * 3600, to: 21 * 3600, ways: [1], confidence: 'medium' };
  const schedule = (days: Partial<Record<DayType, number[]>> = { weekday: [4, 5] }) => ({
    at: (day: DayType, t: number) => {
      const active = (days[day] ?? []).length && t >= high.from && t < high.to ? [high] : [];
      return { edges: active.length ? [...(days[day] ?? [])] : [], active };
    },
  });
  function withClosures(over: Partial<ImpactScenario> = {}, days?: Partial<Record<DayType, number[]>>) {
    const clock = { now: 1000 };
    const sent: number[][] = [];
    const src: ImpactSources = {
      busRates: () => rates, setCarDemand: () => undefined, setClosedEdges: (e) => void sent.push(e), speed: () => 60, hidden: () => false, now: () => clock.now,
    };
    const tracker = new ImpactTracker(econ, src, schedule(days));
    tracker.setScenario({ carsOn: true, busesOn: true, busFrequency: 1, carDemand: 1, day: 'weekday', closuresOn: true, ...over });
    return { tracker, sent };
  }
  const sums = (simSeconds: number) => ({ simSeconds, delayCarSeconds: 0, idleCarSeconds: 0, distanceM: 1000 });

  it('closes nothing before the closure hours, then closes the streets when the day reaches them, and reopens at the end', () => {
    const { tracker, sent } = withClosures();
    expect(sent).toEqual([]); // 06:00: nothing closed, nothing to say
    tracker.onCarStats(sums(5 * 3600)); // to 11:00
    expect(sent).toEqual([[4, 5]]);
    tracker.onCarStats(sums(60));
    expect(sent).toEqual([[4, 5]]); // unchanged, not sent again
    tracker.onCarStats(sums(10 * 3600)); // to 21:01
    expect(sent).toEqual([[4, 5], []]);
  });
  it('names the closed streets in the commentary while they are closed', () => {
    const { tracker } = withClosures();
    tracker.onCarStats(sums(5 * 3600));
    expect(tracker.view().lines.join(' ')).toContain('One street is closed to vehicles right now: High Street.');
  });
  it('uses the closures of the chosen day type', () => {
    const { tracker, sent } = withClosures({ day: 'saturday' }, { weekday: [4, 5] });
    tracker.onCarStats(sums(5 * 3600));
    expect(sent).toEqual([]);
  });
  it('reopens the streets when the closures are switched off, and when the cars are', () => {
    const { tracker, sent } = withClosures();
    tracker.onCarStats(sums(5 * 3600));
    tracker.setScenario({ carsOn: true, busesOn: true, busFrequency: 1, carDemand: 1, day: 'weekday', closuresOn: false });
    expect(sent.at(-1)).toEqual([]);
    expect(tracker.view().lines.join(' ')).not.toContain('closed to vehicles');
  });
  it('sends them again after a restart of the day, to the 06:00 state', () => {
    const { tracker, sent } = withClosures();
    tracker.onCarStats(sums(5 * 3600));
    tracker.restart();
    expect(sent.at(-1)).toEqual([]);
  });
  it('does nothing when there is no schedule', () => {
    const { tracker } = setup();
    tracker.onCarStats(sums(5 * 3600));
    expect(tracker.view().lines.join(' ')).not.toContain('closed to vehicles');
  });
});
