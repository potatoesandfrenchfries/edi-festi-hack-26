// From ticket counts to cars: how many festival cars should start each simulated second at each venue.
// People arriving (or leaving) a venue are split by where they come from (local, day-trip, staying, from the ticket postcodes), and each
// kind takes a car, a bus or neither (config/transport.yaml, placeholders). Park-and-ride moves out-of-town drivers onto shuttle buses.
// A full bus turns riders away, and some of them drive instead. All of this is an assumption layered on real counts: a modelled estimate.
import { slotValue, type Demand, type OriginSplit } from './demand';
import type { OriginMix, TripRates, TripVenue } from './trips';

export const TRANSPORT_PATH = 'data/transport.json';

export type Kind = keyof OriginSplit;
const KINDS: readonly Kind[] = ['local', 'daytrip', 'stay'];

export interface Transport {
  status: string;
  modes: { car_share: Record<Kind, number>; bus_share: Record<Kind, number>; car_occupancy: number; spill_to_car: number };
  bus: { seats_per_bus: number; load_factor: number; festival_routes_share: number; fallback_departures_per_hour: number; shuttle_km: number; turned_away_hours: number };
  simulation: { sim_scale: number; trip_window_start_hour: number; trip_window_end_hour: number; warmup_minutes: number };
  walking: { speed_m_s: number };
  levers: { park_and_ride: { min: number; max: number; step: number; default: number; extra_minutes: number } };
}

/** The choices a council could make. Bus frequency multiplies today's departures; park-and-ride is the share of out-of-town drivers diverted. */
export interface Levers {
  busFrequency: number;
  parkAndRide: number;
  closures: boolean;
}

export async function loadTransport(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<Transport | null> {
  try {
    const response = await fetchFn(new URL(TRANSPORT_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as Transport;
    return data.modes?.car_share && data.bus && data.simulation && data.levers ? data : null;
  } catch {
    return null;
  }
}

/** The venues cars can be sent to, in a fixed order that the rates follow. */
export function tripVenues(demand: Demand): TripVenue[] {
  return Object.keys(demand.venues)
    .sort()
    .map((key) => ({ key, lon: demand.venues[key]!.lon, lat: demand.venues[key]!.lat }));
}

const SOURCES: Record<string, 'fringe' | 'eif' | 'tattoo'> = { Fringe: 'fringe', International: 'eif', Tattoo: 'tattoo' };

export interface SlotPlan {
  rates: TripRates;
  /** People wanting a bus in this slot (both directions), and what the buses serving the area can carry. */
  busRiders: number;
  busCapacity: number;
  /** Riders turned away by full buses. */
  turnedAway: number;
  /** People park-and-ride sent to a shuttle bus instead of driving in (both directions). */
  diverted: number;
  /** Real car trips this slot, both directions, before scaling down to the simulated sample. */
  carTrips: number;
  /** Of those, the cars arriving at a venue (the ones that need to park). */
  carArrivals: number;
  /** People arriving plus leaving. */
  people: number;
}

interface Flow {
  car: Record<Kind, number>;
  bus: number;
  diverted: number;
}
const noFlow = (): Flow => ({ car: { local: 0, daytrip: 0, stay: 0 }, bus: 0, diverted: 0 });

/** One direction at one venue: people split into drivers by kind, and bus riders (including those park-and-ride sends to a shuttle). */
function flowOf(people: number, split: OriginSplit, transport: Transport, parkAndRide: number): Flow {
  const flow = noFlow();
  for (const kind of KINDS) {
    const group = people * split[kind];
    const car = group * transport.modes.car_share[kind];
    const diverted = kind === 'local' ? 0 : car * parkAndRide;
    flow.car[kind] = car - diverted;
    flow.bus += group * transport.modes.bus_share[kind] + diverted;
    flow.diverted += diverted;
  }
  return flow;
}

/**
 * The cars to start in one slot of a date. `departuresPerHour` is the bus departures per hour serving the area at today's timetable
 * (the frequency lever multiplies it). Pure: the same inputs always give the same plan.
 */
export function planSlot(demand: Demand, transport: Transport, date: string, slot: number, levers: Levers, departuresPerHour: number): SlotPlan {
  const keys = Object.keys(demand.venues).sort();
  const slotSeconds = demand.slot_minutes * 60;
  const capacity = departuresPerHour * levers.busFrequency * transport.bus.festival_routes_share * transport.bus.seats_per_bus * transport.bus.load_factor * (slotSeconds / 3600);
  const flows = keys.map((key) => {
    const venue = demand.venues[key]!;
    const source = SOURCES[venue.festival];
    const split = source ? demand.origins[source] : undefined;
    const arriving = split ? slotValue(venue, date, slot, 'a') : 0;
    const leaving = split ? slotValue(venue, date, slot, 'd') : 0;
    return {
      inbound: split ? flowOf(arriving, split, transport, levers.parkAndRide) : noFlow(),
      outbound: split ? flowOf(leaving, split, transport, levers.parkAndRide) : noFlow(),
      people: arriving + leaving,
    };
  });
  // Buses carry people both ways at once, so each direction has the capacity to itself.
  const ridersIn = flows.reduce((sum, f) => sum + f.inbound.bus, 0);
  const ridersOut = flows.reduce((sum, f) => sum + f.outbound.bus, 0);
  const turned = (riders: number) => (riders > capacity && riders > 0 ? (riders - capacity) / riders : 0);
  const turnedIn = turned(ridersIn);
  const turnedOut = turned(ridersOut);

  const inbound: number[] = [];
  const outbound: number[] = [];
  const byKind: Record<Kind, number> = { local: 0, daytrip: 0, stay: 0 };
  let carPeople = 0;
  const toCars = (flow: Flow, turnedShare: number) => {
    const spilled = flow.bus * turnedShare * transport.modes.spill_to_car;
    for (const kind of KINDS) byKind[kind] += flow.car[kind] + (kind === 'local' ? spilled : 0);
    const people = KINDS.reduce((sum, kind) => sum + flow.car[kind], 0) + spilled;
    carPeople += people;
    return people / transport.modes.car_occupancy; // real cars
  };
  const perSecond = (realCars: number) => realCars / transport.simulation.sim_scale / slotSeconds;
  let carTrips = 0;
  let carArrivals = 0;
  flows.forEach((f) => {
    const cin = toCars(f.inbound, turnedIn);
    const cout = toCars(f.outbound, turnedOut);
    inbound.push(perSecond(cin));
    outbound.push(perSecond(cout));
    carTrips += cin + cout;
    carArrivals += cin;
  });
  return {
    rates: { inbound, outbound, mix: originMix(demand, byKind, carPeople) },
    busRiders: ridersIn + ridersOut,
    busCapacity: capacity * 2,
    turnedAway: ridersIn * turnedIn + ridersOut * turnedOut,
    diverted: flows.reduce((sum, f) => sum + f.inbound.diverted + f.outbound.diverted, 0),
    carTrips,
    carArrivals,
    people: flows.reduce((sum, f) => sum + f.people, 0),
  };
}

/** Where the slot's cars start: the locals anywhere, everyone else at the gateway of their compass sector (shares from the ticket postcodes). */
export function originMix(demand: Demand, byKind: Record<Kind, number>, total: number): OriginMix {
  if (total <= 0) return { local: 1, north: 0, west: 0, south: 0 };
  const sectors = demand.origins.sectors;
  const sum = (sectors.north ?? 0) + (sectors.west ?? 0) + (sectors.south ?? 0);
  const share = (name: 'north' | 'west' | 'south') => (sum > 0 ? (sectors[name] ?? 0) / sum : 1 / 3);
  const outOfTown = (byKind.daytrip + byKind.stay) / total;
  return { local: byKind.local / total, north: outOfTown * share('north'), west: outOfTown * share('west'), south: outOfTown * share('south') };
}
