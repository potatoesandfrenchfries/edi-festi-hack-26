import { describe, expect, it } from 'vitest';
import type { Demand } from './demand';
import { originMix, planSlot, tripVenues, type Levers, type Transport } from './trip-demand';

const empty = () => Array(96).fill(0);
const slotsWith = (slot: number, value: number) => Object.assign(empty(), { [slot]: value });
const demand: Demand = {
  status: 'placeholder',
  note: '',
  slot_minutes: 15,
  first_day: '2026-08-15',
  venues: {
    b_hub: { name: 'Hub', lon: -3.19, lat: 55.95, festival: 'Fringe', kind: 'hub', tickets: 1, days: { '2026-08-15': { a: slotsWith(70, 1000), d: slotsWith(80, 500), p: empty() } } },
    a_hall: { name: 'Hall', lon: -3.2, lat: 55.95, festival: 'International', kind: 'building', tickets: 1, days: { '2026-08-15': { a: slotsWith(70, 400), d: empty(), p: empty() } } },
    c_bar: { name: 'Bar', lon: -3.18, lat: 55.95, festival: 'Jazz and Blues', kind: 'building', tickets: 0, days: {} },
  },
  origins: {
    eif: { local: 0.5, daytrip: 0.2, stay: 0.3 },
    tattoo: { local: 0.1, daytrip: 0.1, stay: 0.8 },
    fringe: { local: 0.4, daytrip: 0.1, stay: 0.5 },
    sectors: { north: 0.2, west: 0.3, south: 0.5 },
  },
  staying_people: {},
};
const transport: Transport = {
  status: 'placeholder',
  modes: { car_share: { local: 0.1, daytrip: 0.5, stay: 0.1 }, bus_share: { local: 0.3, daytrip: 0.2, stay: 0.3 }, car_occupancy: 2, spill_to_car: 0.5 },
  bus: { seats_per_bus: 70, load_factor: 1, festival_routes_share: 1, fallback_departures_per_hour: 600, shuttle_km: 6, turned_away_hours: 0.5 },
  simulation: { sim_scale: 5, trip_window_start_hour: 17, trip_window_end_hour: 21, warmup_minutes: 20 },
  walking: { speed_m_s: 1.3 },
  levers: { park_and_ride: { min: 0, max: 0.6, step: 0.15, default: 0, extra_minutes: 20 } },
};
const today: Levers = { busFrequency: 1, parkAndRide: 0, closures: false };
const plan = (levers: Partial<Levers> = {}, departures = 1000, slot = 70) => planSlot(demand, transport, '2026-08-15', slot, { ...today, ...levers }, departures);
const order = Object.keys(demand.venues).sort(); // a_hall, b_hub, c_bar

describe('venues and rates', () => {
  it('lists venues in a fixed order and gives rates in that order', () => {
    expect(tripVenues(demand).map((v) => v.key)).toEqual(order);
    expect(plan().rates.inbound).toHaveLength(3);
  });
  it('inbound cars follow the arrivals and the mode shares', () => {
    const p = plan();
    // Fringe hub: 1000 people, 40% local @10%, 10% day-trip @50%, 50% staying @10% = 40+50+50 = 140 drivers, 2 per car, 1 in 5 simulated
    const cars = 140 / 2 / 5 / 900;
    expect(p.rates.inbound[1]).toBeCloseTo(cars, 9);
    expect(p.rates.outbound[1]).toBe(0); // nobody leaves in slot 70
    expect(p.rates.inbound[0]).toBeGreaterThan(0); // the EIF hall also has arrivals
  });
  it('outbound cars follow the departures, and a venue with no ticket source gets none', () => {
    const p = plan({}, 1000, 80);
    expect(p.rates.outbound[1]).toBeCloseTo((500 * (0.4 * 0.1 + 0.1 * 0.5 + 0.5 * 0.1)) / 2 / 5 / 900, 9);
    expect(p.rates.inbound[2]).toBe(0);
    expect(p.rates.outbound[2]).toBe(0);
  });
  it('an empty slot starts nothing', () => {
    const p = plan({}, 1000, 10);
    expect(p.rates.inbound.every((r) => r === 0) && p.rates.outbound.every((r) => r === 0)).toBe(true);
    expect(p.people).toBe(0);
  });
  it('is deterministic', () => {
    expect(plan()).toEqual(plan());
  });
});

describe('levers', () => {
  it('park-and-ride removes out-of-town drivers from the roads and puts them on buses', () => {
    const base = plan();
    const par = plan({ parkAndRide: 0.5 });
    expect(par.carTrips).toBeLessThan(base.carTrips);
    expect(par.busRiders).toBeGreaterThan(base.busRiders);
    // the day-trip and staying drivers are halved; the locals are not
    const kept = (1000 * 0.4 * 0.1 + (1000 * 0.1 * 0.5 + 1000 * 0.5 * 0.1) * 0.5 + 400 * 0.5 * 0.1 + (400 * 0.2 * 0.5 + 400 * 0.3 * 0.1) * 0.5) / 2;
    expect(par.carTrips).toBeCloseTo(kept, 6);
    expect(par.diverted).toBeCloseTo((1000 * 0.1 * 0.5 + 1000 * 0.5 * 0.1 + 400 * 0.2 * 0.5 + 400 * 0.3 * 0.1) * 0.5, 6);
    expect(base.diverted).toBe(0);
    expect(par.busRiders - base.busRiders).toBeCloseTo((1000 * 0.1 * 0.5 + 1000 * 0.5 * 0.1 + 400 * 0.2 * 0.5 + 400 * 0.3 * 0.1) * 0.5, 6);
  });
  it('too few buses turn riders away and some of them drive; enough buses turn none away', () => {
    const plenty = plan({}, 100000);
    const few = plan({}, 8);
    expect(plenty.turnedAway).toBe(0);
    expect(few.turnedAway).toBeGreaterThan(0);
    expect(few.carTrips).toBeGreaterThan(plenty.carTrips);
    expect(plan({ busFrequency: 3 }, 8).turnedAway).toBeLessThan(few.turnedAway); // more buses, fewer turned away
  });
  it('the cars added by full buses equal the share of turned-away riders that drive', () => {
    const plenty = plan({}, 100000);
    const few = plan({}, 8);
    expect(few.carTrips - plenty.carTrips).toBeCloseTo((few.turnedAway * transport.modes.spill_to_car) / transport.modes.car_occupancy, 6);
  });
});

describe('origin mix', () => {
  it('sums to one and splits out-of-town cars by sector', () => {
    const mix = originMix(demand, { local: 30, daytrip: 40, stay: 30 }, 100);
    expect(mix.local).toBeCloseTo(0.3);
    expect(mix.north + mix.west + mix.south).toBeCloseTo(0.7);
    expect(mix.south / mix.west).toBeCloseTo(0.5 / 0.3);
    expect(mix.local + mix.north + mix.west + mix.south).toBeCloseTo(1);
  });
  it('with no cars, everyone is local; with no sector data, thirds', () => {
    expect(originMix(demand, { local: 0, daytrip: 0, stay: 0 }, 0)).toEqual({ local: 1, north: 0, west: 0, south: 0 });
    const flat = originMix({ ...demand, origins: { ...demand.origins, sectors: {} } }, { local: 0, daytrip: 1, stay: 0 }, 1);
    expect(flat.north).toBeCloseTo(1 / 3);
  });
});
