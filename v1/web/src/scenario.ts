// Scenario runs: put a festival evening through the car engine under one set of choices (bus frequency, park-and-ride, street closures)
// and price what it cost in time, fuel and carbon. Headless: no map, worker or clock, so the same code serves tests, the command-line
// sweep (scripts/scenarios.ts) and the browser. A modelled ESTIMATE from placeholder constants, never a measurement.
import { allBuses, createModel, timetableRates, type BusData } from './buses';
import { MAX_DEMAND, TRIP_SLOTS, type CarData } from './cars';
import { CarRunner } from './cars-runner';
import type { ClosureSchedule } from './closures';
import { busStates } from './coupling';
import { dayTypeOf, slotAt, type Demand } from './demand';
import { busIncrement, carIncrement, demandAt, type Economics } from './impact';
import { revenueOf, type Revenue, type RevenueConfig } from './revenue';
import { planSlot, tripVenues, type Levers, type Transport } from './trip-demand';
import type { TripStats } from './trips';

export const TODAY: Levers = { busFrequency: 1, parkAndRide: 0, closures: false };
const CHUNK_S = 10; // simulated seconds between updates of the buses and the slot's rates

export interface Inputs {
  roads: CarData;
  demand: Demand;
  transport: Transport;
  econ: Economics;
  /** Without the bus timetable the buses neither slow the cars nor cost anything, and bus capacity falls back to the config's figure. */
  busData: BusData | null;
  /** Without the closures, that lever changes nothing. */
  closures: ClosureSchedule | null;
  /** Without the revenue assumptions, outcomes carry no revenue. */
  revenue?: RevenueConfig | null;
}

export interface Scenario {
  date: string;
  levers: Levers;
  /** False runs the same evening with the background traffic only: the reference the festival's own cost is measured against. */
  festival: boolean;
}

export interface Costs {
  /** Time lost in traffic and walking from where a closure made drivers park, valued at the value of time. */
  time: number;
  fuel: number;
  carbon: number;
  total: number;
}

export interface Outcome {
  scenario: Scenario;
  windowHours: [number, number];
  delayPersonHours: number;
  walkPersonHours: number;
  /** Hours lost by riders full buses turned away, and by those who parked and rode instead of driving in. */
  waitPersonHours: number;
  litres: number;
  co2Kg: number;
  costs: Costs;
  trips: TripStats | null;
  /** Bus riders wanting a seat, those turned away by full buses, and those park-and-ride sent to shuttles, summed over the window. */
  busRiders: number;
  turnedAway: number;
  diverted: number;
  /** Real car trips the festival called for in the window, and the share that came from people turned away by full buses. */
  festivalCarTrips: number;
  closedStreets: string[];
  /** What the festival brought in (fares, levy, parking, less the extra bus running), when the revenue assumptions are loaded. */
  revenue?: Revenue;
}

/** Bus departures per hour at today's timetable, from the data (every route's loop), or the config's fallback. */
export function departuresPerHour(busData: BusData | null, transport: Transport): number {
  if (!busData) return transport.bus.fallback_departures_per_hour;
  return createModel(busData, 1).routes.reduce((sum, route) => sum + 3600 / route.headway, 0);
}

/** Prices a run's totals. The cars are a sample, so `sim_scale` scales them up; the buses are the timetable's own fleet. */
export function price(econ: Economics, parts: { delayPersonHours: number; walkPersonHours: number; waitPersonHours: number; fuelGbp: number; co2Kg: number }): Costs {
  const time = (parts.delayPersonHours + parts.walkPersonHours + parts.waitPersonHours) * econ.time.value_of_time_gbp_per_hour;
  const carbon = (parts.co2Kg / 1000) * econ.emissions.carbon_value_gbp_per_tonne;
  return { time, fuel: parts.fuelGbp, carbon, total: time + parts.fuelGbp + carbon };
}

/** Runs one evening. Deterministic: the same inputs and scenario give the same outcome. */
export function runScenario(inputs: Inputs, scenario: Scenario): Outcome {
  const { roads, demand, transport, econ, busData, closures } = inputs;
  const { levers } = scenario;
  const scaled: Economics = { ...econ, scale: { fleet_scale: transport.simulation.sim_scale } };
  const [from, to] = [transport.simulation.trip_window_start_hour, transport.simulation.trip_window_end_hour];
  const start = from * 3600 - transport.simulation.warmup_minutes * 60;
  const day = dayTypeOf(scenario.date);
  const venues = tripVenues(demand);
  const base = departuresPerHour(busData, transport);
  const model = busData ? createModel(busData, levers.busFrequency) : null;

  const runner = new CarRunner(() => undefined);
  runner.handle({
    type: 'init', roads, population: roads.sim?.population ?? 1000, seed: roads.sim?.seed ?? 2026, maxDemand: MAX_DEMAND, venues, tripSlots: TRIP_SLOTS,
  }); // fmt: skip
  runner.handle({ type: 'demand', fraction: demandAt(econ.demand.car_hourly_profile, start) * econ.demand.car_demand.default });

  let delayCarSeconds = 0;
  let idleCarSeconds = 0;
  let distanceM = 0;
  let busRiders = 0;
  let turnedAway = 0;
  let diverted = 0;
  let festivalCarTrips = 0;
  let carArrivals = 0;
  let lastSlot = -1;
  let closedKey = '';
  const closedStreets = new Set<string>();
  const slotHours = demand.slot_minutes / 60;

  for (let clock = start; clock < to * 3600; clock += CHUNK_S) {
    const slot = slotAt(demand, clock);
    if (slot !== lastSlot) {
      lastSlot = slot;
      runner.handle({ type: 'demand', fraction: demandAt(econ.demand.car_hourly_profile, clock) * econ.demand.car_demand.default });
      if (scenario.festival) {
        const plan = planSlot(demand, transport, scenario.date, slot, levers, base);
        runner.handle({ type: 'trips', rates: plan.rates });
        if (clock >= from * 3600) {
          busRiders += plan.busRiders;
          turnedAway += plan.turnedAway;
          diverted += plan.diverted;
          festivalCarTrips += plan.carTrips;
          carArrivals += plan.carArrivals;
        }
      }
    }
    if (levers.closures && closures) {
      const now = closures.at(day, clock);
      const key = now.edges.join(',');
      if (key !== closedKey) {
        closedKey = key;
        runner.handle({ type: 'closed', edges: now.edges });
      }
      if (clock >= from * 3600) for (const c of now.active) closedStreets.add(c.name);
    }
    if (model) runner.handle({ type: 'buses', data: busStates(allBuses(model, clock)) });
    runner.simulate(CHUNK_S);
    const sums = runner.takeSums();
    if (clock >= from * 3600) {
      delayCarSeconds += sums.delayCarSeconds;
      idleCarSeconds += sums.idleCarSeconds;
      distanceM += sums.distanceM;
    }
  }

  const cars = carIncrement(scaled, { delayCarSeconds, idleCarSeconds, distanceM });
  const trips = runner.tripFigures();
  const seconds = (to - from) * 3600;
  // The buses: only the change from today's timetable is charged, and only the share of it that serves the festival area. The shuttles
  // park-and-ride needs are charged as extra bus kilometres.
  const shuttleKm = (diverted / (transport.bus.seats_per_bus * transport.bus.load_factor)) * transport.bus.shuttle_km;
  let busLitres = 0;
  let busCo2 = 0;
  let busFuelGbp = 0;
  let busKm = shuttleKm;
  if (busData) {
    const today = timetableRates(createModel(busData, 1));
    const now = timetableRates(model!);
    const delta = { buses: now.buses - today.buses, metresPerSecond: (now.metresPerSecond - today.metresPerSecond) * transport.bus.festival_routes_share, delayBuses: 0, idleBuses: 0 };
    const extra = busIncrement(scaled, delta, seconds);
    busKm += (delta.metresPerSecond * seconds) / 1000;
    busLitres += extra.idleLitres + extra.drivingLitres;
    busCo2 += extra.co2Kg;
    busFuelGbp += (extra.idleLitres + extra.drivingLitres) * econ.fuel.bus_price_gbp_per_litre;
  }
  const shuttleLitres = shuttleKm * econ.fuel.bus_litres_per_km;
  busLitres += shuttleLitres;
  busCo2 += shuttleLitres * econ.emissions.bus_kg_co2e_per_litre;
  busFuelGbp += shuttleLitres * econ.fuel.bus_price_gbp_per_litre;

  const walkPersonHours = trips ? (trips.walkMetres / transport.walking.speed_m_s / 3600) * transport.simulation.sim_scale * transport.modes.car_occupancy : 0;
  // Riders a full bus turned away lose time whether or not they then drive; park-and-ride travellers spend extra minutes on the shuttle.
  const waitPersonHours = turnedAway * transport.bus.turned_away_hours + (diverted * transport.levers.park_and_ride.extra_minutes) / 60;
  const litres = cars.idleLitres + cars.drivingLitres + busLitres;
  const co2Kg = cars.co2Kg + busCo2;
  const carFuelGbp = (cars.idleLitres + cars.drivingLitres) * econ.fuel.car_price_gbp_per_litre;
  return {
    scenario,
    windowHours: [from, to],
    delayPersonHours: cars.delayPersonHours,
    walkPersonHours,
    waitPersonHours,
    litres,
    co2Kg,
    costs: price(econ, { delayPersonHours: cars.delayPersonHours, walkPersonHours, waitPersonHours, fuelGbp: carFuelGbp + busFuelGbp, co2Kg }),
    trips,
    busRiders,
    turnedAway,
    diverted,
    festivalCarTrips,
    closedStreets: [...closedStreets].sort(),
    revenue: inputs.revenue
      ? revenueOf(inputs.revenue, { festival: scenario.festival, busRiders, turnedAway, diverted, carArrivals, stayingPeople: demand.staying_people[scenario.date] ?? 0, busKm, busFuelGbp })
      : undefined,
  };
}

/** Every combination of the lever values, today's choices first. */
export function leverGrid(frequencies: readonly number[], parkAndRide: readonly number[], closures: readonly boolean[]): Levers[] {
  const grid: Levers[] = [];
  for (const busFrequency of frequencies) for (const par of parkAndRide) for (const c of closures) grid.push({ busFrequency, parkAndRide: par, closures: c });
  return grid.sort((a, b) => Number(isToday(b)) - Number(isToday(a)));
}
const isToday = (l: Levers) => l.busFrequency === TODAY.busFrequency && l.parkAndRide === TODAY.parkAndRide && l.closures === TODAY.closures;

export interface Sweep {
  date: string;
  /** The same evening with no festival: what the roads cost anyway. */
  reference: Outcome;
  outcomes: Outcome[];
  /** Index into `outcomes` of the cheapest, and of today's choices. */
  best: number;
  today: number;
}

/** Runs every lever combination for a date and finds the cheapest by total cost. `progress` is called after each run. */
export function sweep(inputs: Inputs, date: string, grid: readonly Levers[], progress: (done: number, total: number) => void = () => undefined): Sweep {
  const reference = runScenario(inputs, { date, levers: TODAY, festival: false });
  const outcomes: Outcome[] = [];
  grid.forEach((levers, i) => {
    outcomes.push(runScenario(inputs, { date, levers, festival: true }));
    progress(i + 1, grid.length);
  });
  const best = outcomes.reduce((b, o, i) => (o.costs.total < (outcomes[b] as Outcome).costs.total ? i : b), 0);
  return { date, reference, outcomes, best, today: Math.max(0, outcomes.findIndex((o) => isToday(o.scenario.levers))) };
}
