import { describe, expect, it, vi } from 'vitest';
import { gridRoads } from './grid-roads.testutil';
import type { Demand } from './demand';
import type { Economics } from './impact';
import { departuresPerHour, leverGrid, price, runScenario, sweep, TODAY, type Inputs } from './scenario';
import type { RevenueConfig } from './revenue';
import type { Transport } from './trip-demand';

vi.setConfig({ testTimeout: 60_000 }); // each of these runs a simulated hour through the car engine

const empty = () => Array(96).fill(0);
const centre = { lon: -3.19 + 3 * 0.002, lat: 55.95 + 3 * 0.002 };
const demand: Demand = {
  status: 'placeholder',
  note: '',
  slot_minutes: 15,
  first_day: '2026-08-15',
  venues: { hall: { name: 'Hall', ...centre, festival: 'International', kind: 'building', tickets: 1, days: { '2026-08-15': { a: Object.assign(empty(), { 73: 1200, 74: 1200 }), d: Object.assign(empty(), { 78: 600 }), p: empty() } } } }, // arrivals 18:15 to 18:45, departures at 19:30
  origins: { eif: { local: 0.2, daytrip: 0.4, stay: 0.4 }, tattoo: { local: 0.2, daytrip: 0.4, stay: 0.4 }, fringe: { local: 0.2, daytrip: 0.4, stay: 0.4 }, sectors: { north: 0.4, west: 0.3, south: 0.3 } },
  staying_people: { '2026-08-15': 100 },
};
const transport: Transport = {
  status: 'placeholder',
  modes: { car_share: { local: 0.2, daytrip: 0.6, stay: 0.2 }, bus_share: { local: 0.3, daytrip: 0.2, stay: 0.3 }, car_occupancy: 2, spill_to_car: 0.5 },
  bus: { seats_per_bus: 70, load_factor: 1, festival_routes_share: 1, fallback_departures_per_hour: 20, shuttle_km: 6, turned_away_hours: 0.5 },
  simulation: { sim_scale: 5, trip_window_start_hour: 18, trip_window_end_hour: 19, warmup_minutes: 5 },
  walking: { speed_m_s: 1.3 },
  levers: { park_and_ride: { min: 0, max: 0.6, step: 0.3, default: 0, extra_minutes: 20 } },
};
const econ: Economics = {
  status: 'placeholder',
  time: { value_of_time_gbp_per_hour: 16, car_occupancy: 1.3, bus_passengers_per_bus: 18 },
  fuel: { car_price_gbp_per_litre: 1.5, bus_price_gbp_per_litre: 1.2, car_idle_litres_per_hour: 0.8, car_litres_per_km: 0.075, bus_idle_litres_per_hour: 2.5, bus_litres_per_km: 0.38 },
  emissions: { car_kg_co2e_per_litre: 2.4, bus_kg_co2e_per_litre: 2.6, carbon_value_gbp_per_tonne: 280 },
  scale: { fleet_scale: 1 },
  demand: { car_hourly_profile: Array(24).fill(0.5), car_demand: { min: 0.25, max: 1.5, step: 0.05, default: 1 }, bus_frequency: { min: 0.25, max: 3, step: 0.25, default: 1 } },
};
const revenue: RevenueConfig = {
  status: 'placeholder',
  fares: { average_fare_gbp: 2, shuttle_fare_gbp: 3 },
  operations: { bus_operating_gbp_per_km: 2.5 },
  levy: { rate: 0.05, paid_share: 0.8, guests_per_room: 2, nightly_rate_gbp: 100, levied_night_share: 0.5 },
  parking: { council_paid_share: 0.25, charge_gbp: 4 },
};
const roads = { ...gridRoads(7), sim: { area: 'test', capacity: 1000, population: 60, seed: 3 } };
const inputs: Inputs = { roads, demand, transport, econ, busData: null, closures: null };
const date = '2026-08-15';

describe('pricing', () => {
  it('adds time, fuel and carbon, valuing time and carbon from the economics', () => {
    const c = price(econ, { delayPersonHours: 10, walkPersonHours: 2, waitPersonHours: 3, fuelGbp: 40, co2Kg: 500 });
    expect(c.time).toBeCloseTo(15 * 16);
    expect(c.carbon).toBeCloseTo(0.5 * 280);
    expect(c.total).toBeCloseTo(c.time + 40 + c.carbon);
  });
  it('bus departures fall back to the config when there is no timetable', () => {
    expect(departuresPerHour(null, transport)).toBe(20);
  });
  it('the lever grid lists today first', () => {
    const grid = leverGrid([0.5, 1, 2], [0, 0.3], [false, true]);
    expect(grid).toHaveLength(12);
    expect(grid[0]).toEqual(TODAY);
  });
});

describe('a festival evening', () => {
  const festival = runScenario(inputs, { date, levers: TODAY, festival: true });

  it('is deterministic', () => {
    expect(runScenario(inputs, { date, levers: TODAY, festival: true }).costs).toEqual(festival.costs);
  });
  it('sends cars to the venue and costs more than the same evening without the festival', () => {
    const reference = runScenario(inputs, { date, levers: TODAY, festival: false });
    expect(reference.trips!.started).toBe(0);
    expect(festival.trips!.started).toBeGreaterThan(20);
    expect(festival.festivalCarTrips).toBeGreaterThan(100);
    expect(festival.costs.total).toBeGreaterThan(reference.costs.total);
    expect(festival.co2Kg).toBeGreaterThan(reference.co2Kg);
  });
  it('park-and-ride keeps cars out of the area and puts the drivers on shuttles', () => {
    const par = runScenario(inputs, { date, levers: { ...TODAY, parkAndRide: 0.6 }, festival: true });
    expect(par.festivalCarTrips).toBeLessThan(festival.festivalCarTrips);
    expect(par.diverted).toBeGreaterThan(0);
    expect(par.waitPersonHours).toBeGreaterThan(festival.waitPersonHours);
  });
  it('more buses turn fewer riders away and so cost less waiting', () => {
    const few = runScenario({ ...inputs, transport: { ...transport, bus: { ...transport.bus, fallback_departures_per_hour: 2 } } }, { date, levers: TODAY, festival: true });
    expect(few.turnedAway).toBeGreaterThan(0);
    expect(few.waitPersonHours).toBeCloseTo(few.turnedAway * 0.5, 6);
    const more = runScenario({ ...inputs, transport: { ...transport, bus: { ...transport.bus, fallback_departures_per_hour: 2 } } }, { date, levers: { ...TODAY, busFrequency: 10 }, festival: true });
    expect(more.turnedAway).toBeLessThan(few.turnedAway);
  });
});

describe('revenue', () => {
  const withRevenue: Inputs = { ...inputs, revenue };
  it('is left out when the assumptions are not loaded', () => {
    expect(runScenario(inputs, { date, levers: TODAY, festival: true }).revenue).toBeUndefined();
  });
  it('the festival-free evening earns nothing, and the festival evening earns fares, levy and parking', () => {
    const reference = runScenario(withRevenue, { date, levers: TODAY, festival: false });
    expect(reference.revenue!.net).toBe(0);
    const festival = runScenario(withRevenue, { date, levers: TODAY, festival: true });
    const r = festival.revenue!;
    expect(r.fares).toBeCloseTo((festival.busRiders - festival.turnedAway) * 2, 6);
    expect(r.levy).toBeCloseTo(20 * 100 * 0.05, 6); // 100 staying people × 0.8 paid / 2 per room × 0.5 inside the cap = 20 room-nights
    expect(r.parking).toBeGreaterThan(0);
    expect(r.net).toBeCloseTo(r.fares + r.parking + r.levy - r.running, 6);
  });
  it('park-and-ride earns shuttle fares and gives up parking income, and charges the shuttle running', () => {
    const base = runScenario(withRevenue, { date, levers: TODAY, festival: true }).revenue!;
    const par = runScenario(withRevenue, { date, levers: { ...TODAY, parkAndRide: 0.6 }, festival: true }).revenue!;
    expect(par.shuttleFares).toBeGreaterThan(0);
    expect(par.parking).toBeLessThan(base.parking);
    expect(par.running).toBeGreaterThan(base.running);
  });
  it('more buses carry more riders, so they earn more fares', () => {
    const scarce = { ...withRevenue, transport: { ...transport, bus: { ...transport.bus, fallback_departures_per_hour: 2 } } };
    const few = runScenario(scarce, { date, levers: TODAY, festival: true }).revenue!;
    const more = runScenario(scarce, { date, levers: { ...TODAY, busFrequency: 10 }, festival: true }).revenue!;
    expect(more.fares).toBeGreaterThan(few.fares);
  });
});

describe('a sweep', () => {
  it('runs every combination, finds the cheapest and today', () => {
    const grid = leverGrid([1, 2], [0, 0.6], [false]);
    const seen: number[] = [];
    const result = sweep(inputs, date, grid, (done) => seen.push(done));
    expect(result.outcomes).toHaveLength(4);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(result.reference.scenario.festival).toBe(false);
    expect(result.today).toBe(0);
    const totals = result.outcomes.map((o) => o.costs.total);
    expect(totals[result.best]).toBe(Math.min(...totals));
  });
});
