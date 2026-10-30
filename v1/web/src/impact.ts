// What slow traffic costs over a simulated day: time lost, fuel burnt and carbon emitted, for cars and buses.
// A modelled ESTIMATE from placeholder constants (../../config/economics.yaml, written to data/economics.json by `make economics`),
// never a measurement. Pure functions and a ledger, so it is tested without a map, a worker or a clock.
import type { BusRates } from './traffic';
import { formatCount } from './popup';

export const ECONOMICS_PATH = 'data/economics.json';
export const SECONDS_PER_DAY = 86400;

export interface Range {
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface Economics {
  status: string;
  time: { value_of_time_gbp_per_hour: number; car_occupancy: number; bus_passengers_per_bus: number };
  fuel: {
    car_price_gbp_per_litre: number;
    bus_price_gbp_per_litre: number;
    car_idle_litres_per_hour: number;
    car_litres_per_km: number;
    bus_idle_litres_per_hour: number;
    bus_litres_per_km: number;
  };
  emissions: { car_kg_co2e_per_litre: number; bus_kg_co2e_per_litre: number; carbon_value_gbp_per_tonne: number };
  scale: { fleet_scale: number };
  demand: { car_hourly_profile: number[]; car_demand: Range; bus_frequency: Range };
}

export async function loadEconomics(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<Economics | null> {
  try {
    const response = await fetchFn(new URL(ECONOMICS_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as Economics;
    return data.time && data.fuel && data.emissions && data.scale && data.demand?.car_hourly_profile?.length === 24 ? data : null;
  } catch {
    return null;
  }
}

/** What one mode has used up. Person-hours are people held up (not vehicle-hours); litres split into fuel burnt standing still and fuel burnt driving. */
export interface ModeTotals {
  delayPersonHours: number;
  idleLitres: number;
  drivingLitres: number;
  co2Kg: number;
}
export const zero = (): ModeTotals => ({ delayPersonHours: 0, idleLitres: 0, drivingLitres: 0, co2Kg: 0 });
const plus = (a: ModeTotals, b: ModeTotals): ModeTotals => ({
  delayPersonHours: a.delayPersonHours + b.delayPersonHours,
  idleLitres: a.idleLitres + b.idleLitres,
  drivingLitres: a.drivingLitres + b.drivingLitres,
  co2Kg: a.co2Kg + b.co2Kg,
});

/** What the car worker reports for an interval: car-seconds lost to slow traffic, car-seconds standing still, metres driven. */
export interface CarSums {
  delayCarSeconds: number;
  idleCarSeconds: number;
  distanceM: number;
}

/** The simulated cars are a sample, so `fleet_scale` scales them up to the fleet the figures describe. */
export function carIncrement(econ: Economics, sums: CarSums): ModeTotals {
  const { fuel, emissions, time, scale } = econ;
  const idleLitres = (sums.idleCarSeconds / 3600) * fuel.car_idle_litres_per_hour * scale.fleet_scale;
  const drivingLitres = (sums.distanceM / 1000) * fuel.car_litres_per_km * scale.fleet_scale;
  return {
    delayPersonHours: (sums.delayCarSeconds / 3600) * time.car_occupancy * scale.fleet_scale,
    idleLitres,
    drivingLitres,
    co2Kg: (idleLitres + drivingLitres) * emissions.car_kg_co2e_per_litre,
  };
}

/** `rates` held for `seconds` of simulated time. The buses are the timetable's own fleet, so they are not scaled. */
export function busIncrement(econ: Economics, rates: BusRates, seconds: number): ModeTotals {
  const { fuel, emissions, time } = econ;
  const idleLitres = ((rates.idleBuses * seconds) / 3600) * fuel.bus_idle_litres_per_hour;
  const drivingLitres = ((rates.metresPerSecond * seconds) / 1000) * fuel.bus_litres_per_km;
  return {
    delayPersonHours: ((rates.delayBuses * seconds) / 3600) * time.bus_passengers_per_bus,
    idleLitres,
    drivingLitres,
    co2Kg: (idleLitres + drivingLitres) * emissions.bus_kg_co2e_per_litre,
  };
}

/** Cars on the road at this time of day as a share of the busiest hour, smoothed between the hours so it does not step. */
export function demandAt(profile: readonly number[], clockSeconds: number): number {
  const hours = (((clockSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 3600;
  const lo = Math.floor(hours) % 24;
  const k = hours - Math.floor(hours);
  return (profile[lo] ?? 0) * (1 - k) + (profile[(lo + 1) % 24] ?? 0) * k;
}

/** The running totals for one simulated day. At midnight the day is over and the next starts from nothing. */
export class Ledger {
  cars: ModeTotals = zero();
  buses: ModeTotals = zero();
  /** Seconds since midnight. */
  clock: number;
  /** Whole days finished since the last reset. */
  days = 0;
  /** The last interval added, so the panel can say what the cost is running at right now. */
  last: { seconds: number; cars: ModeTotals; buses: ModeTotals } = { seconds: 0, cars: zero(), buses: zero() };

  constructor(startClock = 0) {
    this.clock = startClock;
  }

  get hour(): number {
    return Math.floor(this.clock / 3600) % 24;
  }

  /** Moves the day on by `seconds` of simulated time and adds what was used up in it. */
  add(seconds: number, cars: ModeTotals = zero(), buses: ModeTotals = zero()): void {
    if (!(seconds > 0)) return;
    this.last = { seconds, cars, buses };
    if (this.clock + seconds >= SECONDS_PER_DAY) {
      this.days += 1;
      this.clock = (this.clock + seconds) % SECONDS_PER_DAY;
      this.cars = zero();
      this.buses = zero();
      return;
    }
    this.clock += seconds;
    this.cars = plus(this.cars, cars);
    this.buses = plus(this.buses, buses);
  }

  reset(startClock = 0): void {
    this.cars = zero();
    this.buses = zero();
    this.last = { seconds: 0, cars: zero(), buses: zero() };
    this.clock = startClock;
    this.days = 0;
  }
}

export interface ModeSummary {
  delayPersonHours: number;
  timeLostGbp: number;
  fuelLitres: number;
  idleLitres: number;
  fuelGbp: number;
  co2Kg: number;
  carbonGbp: number;
  totalGbp: number;
}
export interface Summary {
  all: ModeSummary;
  cars: ModeSummary;
  buses: ModeSummary;
}

export function modeSummary(econ: Economics, totals: ModeTotals, pricePerLitre: number): ModeSummary {
  const fuelLitres = totals.idleLitres + totals.drivingLitres;
  const timeLostGbp = totals.delayPersonHours * econ.time.value_of_time_gbp_per_hour;
  const fuelGbp = fuelLitres * pricePerLitre;
  const carbonGbp = (totals.co2Kg / 1000) * econ.emissions.carbon_value_gbp_per_tonne;
  return {
    delayPersonHours: totals.delayPersonHours, timeLostGbp, fuelLitres, idleLitres: totals.idleLitres, fuelGbp,
    co2Kg: totals.co2Kg, carbonGbp, totalGbp: timeLostGbp + fuelGbp + carbonGbp,
  };
}

const addSummary = (a: ModeSummary, b: ModeSummary): ModeSummary => ({
  delayPersonHours: a.delayPersonHours + b.delayPersonHours,
  timeLostGbp: a.timeLostGbp + b.timeLostGbp,
  fuelLitres: a.fuelLitres + b.fuelLitres,
  idleLitres: a.idleLitres + b.idleLitres,
  fuelGbp: a.fuelGbp + b.fuelGbp,
  co2Kg: a.co2Kg + b.co2Kg,
  carbonGbp: a.carbonGbp + b.carbonGbp,
  totalGbp: a.totalGbp + b.totalGbp,
});

export function summarise(econ: Economics, cars: ModeTotals, buses: ModeTotals): Summary {
  const c = modeSummary(econ, cars, econ.fuel.car_price_gbp_per_litre);
  const b = modeSummary(econ, buses, econ.fuel.bus_price_gbp_per_litre);
  return { all: addSummary(c, b), cars: c, buses: b };
}

/** What the cost is running at right now, in pounds per simulated hour, from the last interval added to the ledger. */
export function ratePerHour(econ: Economics, ledger: Ledger): number {
  const { seconds, cars, buses } = ledger.last;
  if (seconds <= 0) return 0;
  return (summarise(econ, cars, buses).all.totalGbp / seconds) * 3600;
}

export function clockLabel(clockSeconds: number): string {
  const minutes = Math.floor((((clockSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export const gbp = (value: number): string => (value < 10 ? `£${value.toFixed(2)}` : `£${formatCount(value)}`);
export const litres = (value: number): string => (value < 10 ? `${value.toFixed(1)} litres` : `${formatCount(value)} litres`);
export const carbon = (kg: number): string => (kg >= 1000 ? `${(kg / 1000).toFixed(1)} tonnes CO₂e` : kg < 10 ? `${kg.toFixed(1)} kg CO₂e` : `${formatCount(kg)} kg CO₂e`);
const hoursOf = (hours: number): string => (hours < 10 ? `${hours.toFixed(1)} person-hours` : `${formatCount(hours)} person-hours`);

export interface Scenario {
  clock: number;
  days: number;
  carsOn: boolean;
  busesOn: boolean;
  busFrequency: number;
  carDemand: number;
  /** Streets closed to vehicles right now (festival closures), by name. */
  closedStreets?: string[];
}

/** Plain-English sentences about the day so far. Every figure is an estimate and the last sentence says so. */
export function commentary(summary: Summary, scenario: Scenario, ratePerHourGbp: number): string[] {
  const { all, cars, buses } = summary;
  const lines: string[] = [];
  if (!scenario.carsOn && !scenario.busesOn) return ['Switch on the simulated cars or buses (Display tab) to see what traffic costs.'];
  if (all.totalGbp <= 0) return [`The day has just begun (${clockLabel(scenario.clock)}). Nothing has built up yet.`];
  lines.push(
    `By ${clockLabel(scenario.clock)}, traffic has cost an estimated ${gbp(all.totalGbp)} so far today: ${gbp(all.timeLostGbp)} of lost working time ` +
      `(${hoursOf(all.delayPersonHours)} held up), ${gbp(all.fuelGbp)} of fuel (${litres(all.fuelLitres)}) and ${gbp(all.carbonGbp)} of carbon (${carbon(all.co2Kg)}).`,
  );
  if (ratePerHourGbp > 0) lines.push(`Right now it is running at about ${gbp(ratePerHourGbp)} an hour.`);
  if (all.idleLitres > 0 && all.fuelLitres > 0) lines.push(`${Math.round((100 * all.idleLitres) / all.fuelLitres)}% of that fuel was burnt standing still.`);
  if (cars.totalGbp > 0 && buses.totalGbp > 0) {
    const carShare = Math.round((100 * cars.totalGbp) / all.totalGbp);
    lines.push(`Cars account for ${carShare}% of the cost and buses for ${100 - carShare}%.`);
  }
  const closed = scenario.closedStreets ?? [];
  if (closed.length) lines.push(`${closed.length === 1 ? 'One street is' : `${closed.length} streets are`} closed to vehicles right now: ${closed.join(', ')}.`);
  if (scenario.busFrequency !== 1) lines.push(`Buses are running ${scenario.busFrequency < 1 ? 'less' : 'more'} often than the timetable (×${scenario.busFrequency.toFixed(2)}).`);
  if (scenario.carDemand !== 1) lines.push(`There are ${scenario.carDemand < 1 ? 'fewer' : 'more'} cars on the road than a normal day (×${scenario.carDemand.toFixed(2)}).`);
  lines.push('Illustrative estimates from placeholder values, not measurements.');
  return lines;
}
