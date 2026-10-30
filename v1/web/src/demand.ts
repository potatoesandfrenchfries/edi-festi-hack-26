// Festival demand and visitor accommodation as the web app reads them (data/demand.json from pipeline stage 10, data/accommodation.json
// from stage 06). Modelled from 2026 ticket counts and public registers: estimates of where people are, never counts of individuals.
import type { DayType } from './presence';

export const DEMAND_PATH = 'data/demand.json';
export const ACCOMMODATION_PATH = 'data/accommodation.json';

/** One venue's day: people arriving, leaving and present in every slot (`slot_minutes` long) of the day. */
export interface VenueDay {
  a: number[];
  d: number[];
  p: number[];
}
export interface VenueDemand {
  name: string;
  lon: number;
  lat: number;
  festival: string;
  /** "building" has a footprint in the tiles, "hub" is an assumed Fringe cluster, "ground" is open ground (the Esplanade). */
  kind: 'building' | 'hub' | 'ground' | 'tent';
  tickets: number;
  days: Record<string, VenueDay>;
}
export interface OriginSplit {
  local: number;
  daytrip: number;
  stay: number;
}
export interface Demand {
  status: string;
  note: string;
  slot_minutes: number;
  first_day: string;
  venues: Record<string, VenueDemand>;
  origins: { eif: OriginSplit; tattoo: OriginSplit; fringe: OriginSplit; sectors: Record<string, number> };
  /** People who need a bed that night, by date. */
  staying_people: Record<string, number>;
}
export interface Accommodation {
  status: string;
  occupancy: { base: number; max: number };
  night_profile: number[];
  pilot_beds: Record<string, number>;
  city_beds: { str: number; hotel: number };
}

async function loadJson<T>(path: string, fetchFn: typeof fetch, base: string): Promise<T | null> {
  try {
    const response = await fetchFn(new URL(path, base));
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function loadDemand(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<Demand | null> {
  const data = await loadJson<Demand>(DEMAND_PATH, fetchFn, base);
  return data && data.venues && data.staying_people && data.slot_minutes > 0 ? data : null;
}

export async function loadAccommodation(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<Accommodation | null> {
  const data = await loadJson<Accommodation>(ACCOMMODATION_PATH, fetchFn, base);
  return data && data.night_profile?.length === 24 && data.occupancy ? data : null;
}

/** The dates the festival data covers, earliest first. */
export const festivalDates = (demand: Demand): string[] => Object.keys(demand.staying_people).sort();

/** Weekday, Saturday or Sunday for an ISO date, matching the day types the rest of the app uses. */
export function dayTypeOf(iso: string): DayType {
  const weekday = new Date(`${iso}T12:00:00`).getDay();
  return weekday === 6 ? 'saturday' : weekday === 0 ? 'sunday' : 'weekday';
}

export function dateLabel(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const slotsPerHour = (demand: Demand) => 60 / demand.slot_minutes;

/** One slot's value for a venue on a date (0 where the venue has no show that day). `slot` counts from midnight. */
export function slotValue(venue: VenueDemand, date: string, slot: number, field: keyof VenueDay): number {
  return venue.days[date]?.[field][slot] ?? 0;
}

/** People at a venue, averaged over an hour of a date. */
export function presentAt(demand: Demand, venue: VenueDemand, date: string, hour: number): number {
  const n = slotsPerHour(demand);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += slotValue(venue, date, hour * n + k, 'p');
  return sum / n;
}

/** The slot of the day that a clock time (seconds since midnight) falls in. */
export const slotAt = (demand: Demand, clockSeconds: number): number => Math.floor(((clockSeconds % 86400) / 60) / demand.slot_minutes);

/** Everyone at festival venues in the hour, summed over all of them. */
export function totalAtVenues(demand: Demand, date: string, hour: number): number {
  return Object.values(demand.venues).reduce((sum, venue) => sum + presentAt(demand, venue, date, hour), 0);
}

/** Share of beds occupied on a night: the base level plus the festival's staying visitors over every bed in the city. */
export function occupancyOn(acc: Accommodation, demand: Demand, date: string): number {
  const beds = acc.city_beds.str + acc.city_beds.hotel;
  return Math.min(acc.occupancy.max, acc.occupancy.base + (demand.staying_people[date] ?? 0) / Math.max(beds, 1));
}

/** Occupancy a festival-free night would have, for comparison: just the base level. */
export const baseOccupancy = (acc: Accommodation): number => acc.occupancy.base;

/**
 * Visitors in the pilot area's beds at an hour. Only the festival's extra guests are counted (occupancy above the base level), because the
 * base guests are there with or without a festival. Each bed holds a guest that hour with the night profile's probability.
 */
export function festivalGuestsIn(acc: Accommodation, demand: Demand, date: string, hour: number): number {
  const beds = Object.values(acc.pilot_beds).reduce((sum, n) => sum + n, 0);
  return beds * Math.max(occupancyOn(acc, demand, date) - baseOccupancy(acc), 0) * (acc.night_profile[hour] ?? 0);
}

/** The festival's extra people in the pilot area at an hour: audiences at venues plus extra guests in beds. */
export function surgeTotal(acc: Accommodation | null, demand: Demand, date: string, hour: number): { venues: number; guests: number; total: number } {
  const venues = totalAtVenues(demand, date, hour);
  const guests = acc ? festivalGuestsIn(acc, demand, date, hour) : 0;
  return { venues, guests, total: venues + guests };
}
