import { describe, expect, it } from 'vitest';
import {
  Ledger, busIncrement, carIncrement, clockLabel, commentary, demandAt, gbp, loadEconomics, ratePerHour, summarise, zero,
  type Economics, type Scenario,
} from './impact';

const econ = (over: Partial<Economics> = {}): Economics => ({
  status: 'placeholder',
  time: { value_of_time_gbp_per_hour: 10, car_occupancy: 2, bus_passengers_per_bus: 20 },
  fuel: { car_price_gbp_per_litre: 1.5, bus_price_gbp_per_litre: 1, car_idle_litres_per_hour: 1, car_litres_per_km: 0.1, bus_idle_litres_per_hour: 3, bus_litres_per_km: 0.4 },
  emissions: { car_kg_co2e_per_litre: 2, bus_kg_co2e_per_litre: 3, carbon_value_gbp_per_tonne: 100 },
  scale: { fleet_scale: 1 },
  demand: {
    car_hourly_profile: Array.from({ length: 24 }, (_, h) => h / 23),
    car_demand: { min: 0.25, max: 1.5, step: 0.05, default: 1 },
    bus_frequency: { min: 0.25, max: 3, step: 0.25, default: 1 },
  },
  ...over,
});
const scenario = (over: Partial<Scenario> = {}): Scenario => ({ clock: 9.5 * 3600, days: 0, carsOn: true, busesOn: true, busFrequency: 1, carDemand: 1, ...over });

describe('carIncrement', () => {
  it('is zero for a clear road with no driving', () => {
    expect(carIncrement(econ(), { delayCarSeconds: 0, idleCarSeconds: 0, distanceM: 0 })).toEqual(zero());
  });
  it('turns delay into person-hours by occupancy, and idling and driving into litres and CO2e', () => {
    const t = carIncrement(econ(), { delayCarSeconds: 3600, idleCarSeconds: 1800, distanceM: 10_000 });
    expect(t.delayPersonHours).toBeCloseTo(2, 9); // 1 car-hour x 2 people
    expect(t.idleLitres).toBeCloseTo(0.5, 9); // half an hour idling at 1 l/h
    expect(t.drivingLitres).toBeCloseTo(1, 9); // 10 km at 0.1 l/km
    expect(t.co2Kg).toBeCloseTo(3, 9); // 1.5 litres x 2 kg
  });
  it('scales the sample of simulated cars up to the fleet', () => {
    const sums = { delayCarSeconds: 3600, idleCarSeconds: 3600, distanceM: 1000 };
    const one = carIncrement(econ(), sums);
    const ten = carIncrement(econ({ scale: { fleet_scale: 10 } }), sums);
    expect(ten.delayPersonHours).toBeCloseTo(one.delayPersonHours * 10, 9);
    expect(ten.co2Kg).toBeCloseTo(one.co2Kg * 10, 9);
  });
});

describe('busIncrement', () => {
  const rates = { buses: 10, metresPerSecond: 50, delayBuses: 2, idleBuses: 1 };
  it('holds the rates for the interval, with passengers for people and the bus fuel figures', () => {
    const t = busIncrement(econ(), rates, 3600);
    expect(t.delayPersonHours).toBeCloseTo(40, 9); // 2 buses delayed for an hour x 20 passengers
    expect(t.idleLitres).toBeCloseTo(3, 9);
    expect(t.drivingLitres).toBeCloseTo(0.4 * 180, 9); // 50 m/s for an hour is 180 km
    expect(t.co2Kg).toBeCloseTo((3 + 72) * 3, 9);
  });
  it('is the same total however the interval is cut up (speed independence)', () => {
    const whole = busIncrement(econ(), rates, 3600);
    const parts = Array.from({ length: 60 }, () => busIncrement(econ(), rates, 60)).reduce((a, b) => ({
      delayPersonHours: a.delayPersonHours + b.delayPersonHours, idleLitres: a.idleLitres + b.idleLitres,
      drivingLitres: a.drivingLitres + b.drivingLitres, co2Kg: a.co2Kg + b.co2Kg,
    }));
    expect(parts.delayPersonHours).toBeCloseTo(whole.delayPersonHours, 9);
    expect(parts.co2Kg).toBeCloseTo(whole.co2Kg, 9);
  });
});

describe('demandAt', () => {
  const profile = econ().demand.car_hourly_profile;
  it('reads the hour and blends smoothly towards the next', () => {
    expect(demandAt(profile, 0)).toBeCloseTo(0, 9);
    expect(demandAt(profile, 3600 * 12)).toBeCloseTo(12 / 23, 9);
    expect(demandAt(profile, 3600 * 12.5)).toBeCloseTo((12 / 23 + 13 / 23) / 2, 9);
  });
  it('wraps past midnight', () => {
    expect(demandAt(profile, 3600 * 23.5)).toBeCloseTo((1 + 0) / 2, 9);
    expect(demandAt(profile, 3600 * 24)).toBeCloseTo(demandAt(profile, 0), 9);
    expect(demandAt(profile, -3600)).toBeCloseTo(demandAt(profile, 3600 * 23), 9);
  });
});

describe('Ledger', () => {
  const unit = { ...zero(), delayPersonHours: 1, drivingLitres: 1, co2Kg: 2 };
  it('adds up the intervals and moves the clock on', () => {
    const ledger = new Ledger(3600);
    ledger.add(600, unit, zero());
    ledger.add(600, unit, unit);
    expect(ledger.clock).toBe(3600 + 1200);
    expect(ledger.hour).toBe(1);
    expect(ledger.cars.delayPersonHours).toBe(2);
    expect(ledger.buses.delayPersonHours).toBe(1);
  });
  it('ignores an interval with no time in it', () => {
    const ledger = new Ledger();
    ledger.add(0, unit, unit);
    ledger.add(-5, unit, unit);
    expect(ledger.cars).toEqual(zero());
    expect(ledger.clock).toBe(0);
  });
  it('starts the next day from nothing at midnight', () => {
    const ledger = new Ledger(23.9 * 3600);
    ledger.add(60, unit, unit);
    expect(ledger.cars.delayPersonHours).toBe(1);
    ledger.add(600, unit, unit);
    expect(ledger.days).toBe(1);
    expect(ledger.cars).toEqual(zero());
    expect(ledger.clock).toBeCloseTo(23.9 * 3600 + 660 - 86400, 6);
  });
  it('resets to a chosen time', () => {
    const ledger = new Ledger();
    ledger.add(600, unit, unit);
    ledger.reset(7 * 3600);
    expect(ledger.clock).toBe(7 * 3600);
    expect(ledger.cars).toEqual(zero());
    expect(ledger.days).toBe(0);
  });
  it('reports the rate of the last interval, whatever its length', () => {
    const ledger = new Ledger();
    expect(ratePerHour(econ(), ledger)).toBe(0);
    ledger.add(60, { ...zero(), delayPersonHours: 0.1 }, zero());
    const a = ratePerHour(econ(), ledger);
    ledger.add(30, { ...zero(), delayPersonHours: 0.05 }, zero());
    expect(ratePerHour(econ(), ledger)).toBeCloseTo(a, 9); // same rate, half the time
    expect(a).toBeCloseTo(0.1 * 10 * 60, 9); // 6 person-hours an hour at £10
  });
});

describe('summarise', () => {
  it('prices time at the value of time, fuel per mode and carbon per tonne', () => {
    const cars = { delayPersonHours: 2, idleLitres: 1, drivingLitres: 3, co2Kg: 1000 };
    const buses = { delayPersonHours: 1, idleLitres: 0, drivingLitres: 10, co2Kg: 500 };
    const s = summarise(econ(), cars, buses);
    expect(s.cars.timeLostGbp).toBe(20);
    expect(s.cars.fuelGbp).toBeCloseTo(4 * 1.5, 9);
    expect(s.cars.carbonGbp).toBeCloseTo(100, 9);
    expect(s.buses.fuelGbp).toBeCloseTo(10, 9);
    expect(s.all.totalGbp).toBeCloseTo(s.cars.totalGbp + s.buses.totalGbp, 9);
    expect(s.all.fuelLitres).toBe(14);
    expect(s.all.idleLitres).toBe(1);
  });
});

describe('commentary', () => {
  const day = (over: Partial<Scenario> = {}) =>
    commentary(summarise(econ(), { delayPersonHours: 5, idleLitres: 2, drivingLitres: 8, co2Kg: 30 }, { delayPersonHours: 1, idleLitres: 0, drivingLitres: 5, co2Kg: 15 }), scenario(over), 42);
  it('says what has built up, to the minute, with the pounds, litres and carbon', () => {
    const text = day().join(' ');
    expect(text).toContain('By 09:30');
    expect(text).toContain('£85 so far today'); // £60 of time (6 person-hours at £10) + £20 of fuel + £4.50 of carbon
    expect(text).toContain('£60 of lost working time');
    expect(text).toContain('person-hours');
    expect(text).toContain('litres');
    expect(text).toContain('CO₂e');
    expect(text).toContain('£42 an hour');
  });
  it('splits the cost between cars and buses', () => {
    expect(day().join(' ')).toMatch(/Cars account for \d+% of the cost and buses for \d+%/);
  });
  it('mentions a scenario only when it differs from the normal day', () => {
    expect(day().join(' ')).not.toContain('timetable');
    expect(day({ busFrequency: 2 }).join(' ')).toContain('more often than the timetable (×2.00)');
    expect(day({ carDemand: 0.5 }).join(' ')).toContain('fewer cars');
  });
  it('always calls itself an estimate', () => {
    expect(day().at(-1)).toContain('estimates');
  });
  it('says nothing has built up at the start, and what to switch on when nothing is running', () => {
    expect(commentary(summarise(econ(), zero(), zero()), scenario({ clock: 0 }), 0)[0]).toContain('just begun');
    expect(commentary(summarise(econ(), zero(), zero()), scenario({ carsOn: false, busesOn: false }), 0)[0]).toContain('Switch on');
  });
});

describe('formatting', () => {
  it('shows pence for small sums and rounds big ones', () => {
    expect(gbp(3.456)).toBe('£3.46');
    expect(gbp(12345.6)).toBe('£12,300');
    expect(clockLabel(9.5 * 3600)).toBe('09:30');
    expect(clockLabel(86400 + 61)).toBe('00:01');
  });
});

describe('loadEconomics', () => {
  const respond = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body }) as Response) as typeof fetch;
  it('accepts the built file and rejects anything else', async () => {
    expect(await loadEconomics(respond(econ()), 'http://localhost/')).toMatchObject({ status: 'placeholder' });
    expect(await loadEconomics(respond(null, false), 'http://localhost/')).toBeNull();
    expect(await loadEconomics(respond({ time: {} }), 'http://localhost/')).toBeNull();
    expect(await loadEconomics((async () => { throw new Error('offline'); }) as typeof fetch, 'http://localhost/')).toBeNull();
  });
});
