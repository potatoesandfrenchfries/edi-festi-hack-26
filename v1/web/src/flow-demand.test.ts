// Festival trip rates as sources and destinations for the cell model: where cars come in, where they go, and what leaves.
import { describe, expect, it } from 'vitest';
import { CellModel } from './engine/ctm.mjs';
import { FlowDemand, leavingShares } from './flow-demand';
import { gridRoads } from './grid-roads.testutil';
import { SECTORS, emptyRates, gateways, type TripRates } from './trips';

const SIDE = 7;
const centre = { key: 'centre', lon: -3.19 + 3 * 0.002, lat: 55.95 + 3 * 0.002 }; // the middle junction of the grid
const faraway = { key: 'faraway', lon: -3.0, lat: 55.9 };
const rates = (inbound: number, outbound: number, mix: TripRates['mix']): TripRates => ({ inbound: [inbound, 0], outbound: [outbound, 0], mix });
const SOUTH = { local: 0, north: 0, west: 0, south: 1 };

function setup(background = 0) {
  const roads = gridRoads(SIDE);
  const model = new CellModel(roads);
  const demand = new FlowDemand(model, [centre, faraway], roads.classes, { scale: 5, background });
  return { roads, model, demand };
}
const sourced = (model: CellModel) => {
  const edges = new Set<number>();
  for (let i = 0; i < model.sourceRate.length; i++) if (model.sourceRate[i]! > 0) edges.add(Math.floor(i / model.K));
  return edges;
};

describe('flow demand', () => {
  it('gives a venue a destination, and leaves a venue far from every road out', () => {
    const { demand } = setup();
    expect(demand.placed()).toEqual([true, false]);
    expect(demand.venueDestination[1]).toBe(-1);
    expect(demand.destinations.length).toBeGreaterThan(1);
  });

  it('brings arrivals in at their own sector gateways only, and they reach the venue', () => {
    const { roads, model, demand } = setup();
    demand.setRates(rates(0.05, 0, SOUTH)); // cars per simulated second, each standing for 5 real cars
    const south = new Set(gateways(model, roads.classes).entry.south);
    expect(sourced(model).size).toBeGreaterThan(0);
    for (const e of sourced(model)) expect(south.has(e)).toBe(true);
    model.advance(900);
    expect(model.exitedBy[demand.venueDestination[0]!]!).toBeGreaterThan(20);
    expect(model.entered - model.exited - model.mass()).toBeCloseTo(0, 6);
  });

  it('scales the rate to real vehicles: 0.05 cars a second at 5 real cars each is 900 vehicles an hour', () => {
    const { model, demand } = setup();
    demand.setRates(rates(0.05, 0, SOUTH));
    let perHour = 0;
    for (let i = 0; i < model.sourceRate.length; i++) perHour += model.sourceRate[i]! * 3600;
    expect(perHour).toBeCloseTo(0.05 * 5 * 3600, 6);
  });

  it('starts departures at the venue and takes them out by the gateway exits', () => {
    const { model, demand } = setup();
    demand.setRates(rates(0, 0.04, { local: 0, north: 0, west: 0, south: 1 }));
    const venueRoads = new Set<number>();
    const node = demand.destinations[demand.venueDestination[0]!]!;
    for (let i = model.outStart[node]!; i < model.outStart[node + 1]!; i++) venueRoads.add(model.out[i]!);
    for (const e of sourced(model)) expect(venueRoads.has(e)).toBe(true);
    model.advance(1200);
    const exits = Array.from(model.exitedBy).slice(2); // after the two... the placed venue and the exit destinations
    expect(exits.reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
    expect(model.exitedBy[demand.venueDestination[0]!]!).toBe(0);
  });

  it('through traffic flows between the sectors, scales with demand and stops at zero', () => {
    const { model, demand } = setup(600);
    demand.setDemand(1);
    model.advance(900);
    const through = model.exited;
    expect(through).toBeGreaterThan(50);
    const other = setup(600);
    other.demand.setDemand(0);
    other.model.advance(900);
    expect(other.model.exited).toBe(0);
    const double = setup(600);
    double.demand.setDemand(2);
    double.model.advance(900);
    expect(double.model.exited).toBeGreaterThan(through * 1.5);
  });

  it('clearing the rates clears the festival sources', () => {
    const { model, demand } = setup();
    demand.setRates(rates(0.05, 0.05, SOUTH));
    expect(sourced(model).size).toBeGreaterThan(0);
    demand.setRates(null);
    expect(sourced(model).size).toBe(0);
    demand.setRates(emptyRates(2));
    expect(sourced(model).size).toBe(0);
  });

  it('locals start anywhere, spread over many roads', () => {
    const { model, demand } = setup();
    demand.setRates(rates(0.05, 0, { local: 1, north: 0, west: 0, south: 0 }));
    expect(sourced(model).size).toBeGreaterThan(20);
  });

  it('departing cars leave by the out-of-town sectors in proportion, evenly if there are none', () => {
    expect(leavingShares({ local: 0.5, north: 0.1, west: 0.1, south: 0.3 })).toEqual({ north: 0.2, west: 0.2, south: 0.6 });
    const even = leavingShares({ local: 1, north: 0, west: 0, south: 0 });
    for (const s of SECTORS) expect(even[s]).toBeCloseTo(1 / 3, 9);
  });
});
