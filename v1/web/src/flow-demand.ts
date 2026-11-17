// Turns the festival's trip rates (trip-demand.ts) into sources and destinations for the cell model (engine/ctm.mjs).
//
// Arrivals enter at the gateways of their compass sector (locals anywhere) bound for their venue; departures start at the venue and leave
// by the gateway of a sector; the background is through traffic between the gateways. A destination is a junction: a venue's is the
// nearest one a car can reach, a sector's are its few busiest exit roads. A modelled ESTIMATE: the rates are the placeholders of
// config/transport.yaml, and the background flow is a placeholder too.
import type { CellModel } from './engine/ctm.mjs';
import { SECTORS, gateways, nearestNodes, type OriginMix, type RoadGraph, type Sector, type TripRates, type TripVenue } from './trips';

const MAX_PER_SECTOR = 3; // entry roads and exit roads kept per sector: enough to spread the load, few enough to keep the destinations few
const LOCAL_SOURCES = 120; // roads that stand in for "anywhere in the area" when locals start their journey
const HOUR = 3600;
/** placeholder: through traffic entering at each gateway sector at a demand of 1, vehicles per hour (real vehicles, not simulated cars) */
export const BACKGROUND_PER_HOUR = 600;

export interface FlowOptions {
  /** Real vehicles each simulated car stands for: the trip rates are per simulated car, the model's capacities are for real vehicles. */
  scale: number;
  /** Through traffic at each gateway sector at a demand of 1 (vehicles per hour). */
  background?: number;
}

export class FlowDemand {
  /** Destination index of each venue, or -1 for a venue with no road within reach. */
  readonly venueDestination: number[];
  /** The destinations (junctions), in index order: the placed venues, then each sector's exit roads. */
  readonly destinations: number[] = [];
  private readonly entry: Record<Sector, number[]>;
  private readonly exitDestinations: Record<Sector, number[]>;
  private readonly venueRoads: number[][];
  private readonly locals: number[];
  private readonly background: number;
  private rates: TripRates | null = null;
  private demand = 1;

  constructor(
    private readonly model: CellModel,
    private readonly venues: readonly TripVenue[],
    classes: readonly string[],
    private readonly options: FlowOptions,
  ) {
    const graph = model as unknown as RoadGraph;
    this.background = options.background ?? BACKGROUND_PER_HOUR;
    this.venueDestination = venues.map((v) => {
      const node = nearestNodes(graph, v.lon, v.lat, 1)[0]?.[0];
      if (node === undefined) return -1;
      this.destinations.push(node);
      return this.destinations.length - 1;
    });
    this.venueRoads = this.venueDestination.map((d) => (d < 0 ? [] : roadsFrom(model, this.destinations[d] as number)));
    const { entry, exit } = gateways(graph, classes);
    const busiest = (edges: number[]) => [...edges].sort((a, b) => weight(model, b) - weight(model, a)).slice(0, MAX_PER_SECTOR);
    this.entry = { north: busiest(entry.north), west: busiest(entry.west), south: busiest(entry.south) };
    this.exitDestinations = { north: [], west: [], south: [] };
    for (const s of SECTORS) {
      for (const e of busiest(exit[s])) {
        this.destinations.push(model.to[e] as number);
        this.exitDestinations[s].push(this.destinations.length - 1);
      }
    }
    this.locals = spread(model, LOCAL_SOURCES);
    model.setDestinations(this.destinations);
  }

  /** Venues that cars can be driven to (they have a road within reach). */
  placed(): boolean[] {
    return this.venueDestination.map((d) => d >= 0);
  }

  /** Sets the festival rates (cars per simulated second at each venue, as the car engine's trips take them). Null clears them. */
  setRates(rates: TripRates | null): void {
    this.rates = rates;
    this.apply();
  }

  /** The background's multiple of its base flow (the hour's share of the day times the demand slider). */
  setDemand(fraction: number): void {
    this.demand = Math.max(0, fraction);
    this.apply();
  }

  /** Rewrites every source from the current rates. Cheap: a few hundred assignments. */
  apply(): void {
    const model = this.model, per = HOUR * this.options.scale;
    clearSources(model);
    const add = (edges: readonly number[], vehiclesPerHour: number, destination: number) => {
      if (!edges.length || vehiclesPerHour <= 0 || destination < 0) return;
      for (const e of edges) model.setSource(e, model.sourceRate[e * model.K + destination]! * HOUR + vehiclesPerHour / edges.length, destination);
    };
    if (this.rates) {
      const { inbound, outbound, mix } = this.rates;
      this.venues.forEach((_, v) => {
        const d = this.venueDestination[v] as number;
        if (d < 0) return;
        const cars = (inbound[v] ?? 0) * per;
        add(this.locals, cars * mix.local, d);
        for (const s of SECTORS) add(this.entry[s], cars * mix[s], d);
        const leaving = (outbound[v] ?? 0) * per;
        for (const [s, share] of Object.entries(leavingShares(mix)) as [Sector, number][]) {
          for (const exit of this.exitDestinations[s]) add(this.venueRoads[v] as number[], (leaving * share) / this.exitDestinations[s].length, exit);
        }
      });
    }
    // Through traffic: each gateway's flow heads for the other two sectors' exits.
    for (const s of SECTORS) {
      const targets = SECTORS.filter((o) => o !== s).flatMap((o) => this.exitDestinations[o]);
      for (const d of targets) add(this.entry[s], (this.background * this.demand) / targets.length, d);
    }
  }
}

/** Where departing cars leave the area: by sector, in proportion to the out-of-town origins (evenly if there are none). */
export function leavingShares(mix: OriginMix): Record<Sector, number> {
  const out = mix.north + mix.west + mix.south;
  return out > 0 ? { north: mix.north / out, west: mix.west / out, south: mix.south / out } : { north: 1 / 3, west: 1 / 3, south: 1 / 3 };
}

const weight = (model: CellModel, e: number): number => (model.lanes[e] as number) * (model.speed[e] as number);

/** The roads leaving a junction, where a venue's departing cars start. */
function roadsFrom(model: CellModel, node: number): number[] {
  const out: number[] = [];
  for (let i = model.outStart[node] as number; i < (model.outStart[node + 1] as number); i++) out.push(model.out[i] as number);
  return out;
}

/** `count` roads spread over the network in proportion to lane-metres: the stand-ins for "anywhere". Deterministic. */
function spread(model: CellModel, count: number): number[] {
  const cumulative = new Float64Array(model.E);
  let total = 0;
  for (let e = 0; e < model.E; e++) cumulative[e] = total += (model.length[e] as number) * (model.lanes[e] as number);
  const picked = new Set<number>();
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total;
    let lo = 0, hi = model.E - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) < target) lo = mid + 1;
      else hi = mid;
    }
    picked.add(lo);
  }
  return [...picked];
}

function clearSources(model: CellModel): void {
  model.sourceRate.fill(0);
}
