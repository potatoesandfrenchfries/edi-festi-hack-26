import { describe, expect, it } from 'vitest';
import { CarRunner } from './cars-runner';
import { gridRoads } from './grid-roads.testutil';
import { emptyRates, gateways, nearestNodes, pickWeighted, SNAP_MAX_M, type TripRates, type TripVenue } from './trips';
import { CarSim } from './engine/car-sim.mjs';

const SIDE = 7;
const roads = gridRoads(SIDE);
const centre: TripVenue = { key: 'hall', lon: -3.19 + 3 * 0.002, lat: 55.95 + 3 * 0.002 }; // node 24, the middle of the grid
const far: TripVenue = { key: 'faraway', lon: -3.0, lat: 56.1 };
const rates = (inbound: number[], outbound: number[], mix: Partial<TripRates['mix']> = {}): TripRates => ({
  inbound, outbound, mix: { local: 0, north: 0, west: 0, south: 0, ...mix },
});

function runner(venues: TripVenue[], population = 30) {
  const r = new CarRunner(() => undefined);
  r.handle({ type: 'init', roads, population, seed: 5, venues, tripSlots: 200 });
  r.handle({ type: 'demand', fraction: 0 }); // no background cars, so every car on the road is a festival trip
  return r;
}

describe('road lookups', () => {
  const sim = new CarSim(roads, { population: 5, seed: 1 });
  it('nearestNodes lists nearby nodes nearest first and nothing beyond the snap distance', () => {
    const near = nearestNodes(sim, centre.lon, centre.lat);
    expect(near[0]![0]).toBe(3 * SIDE + 3);
    expect(near[0]![1]).toBeLessThan(5);
    expect(near.map((n) => n[1])).toEqual([...near.map((n) => n[1])].sort((a, b) => a - b));
    expect(near.every((n) => n[1] <= SNAP_MAX_M)).toBe(true);
    expect(nearestNodes(sim, far.lon, far.lat)).toEqual([]);
  });
  it('finds entry roads heading in and exit roads heading out in every sector', () => {
    const g = gateways(sim, roads.classes);
    for (const sector of ['north', 'west', 'south'] as const) {
      expect(g.entry[sector].length).toBeGreaterThan(0);
      expect(g.exit[sector].length).toBeGreaterThan(0);
    }
    const north = g.entry.north[0]!;
    expect(sim.nodeLat[sim.to[north]!]!).toBeLessThan(sim.nodeLat[sim.from[north]!]!); // heading south, into the area
  });
  it('pickWeighted follows the weights and ignores negatives', () => {
    expect(pickWeighted({ a: 1, b: 3 }, 0.1)).toBe('a');
    expect(pickWeighted({ a: 1, b: 3 }, 0.5)).toBe('b');
    expect(pickWeighted({ a: -4, b: 1 }, 0)).toBe('b');
  });
});

describe('inbound trips', () => {
  it('cars from a gateway drive to the venue and park there', () => {
    const r = runner([centre]);
    r.handle({ type: 'trips', rates: rates([0.1], [0], { north: 1 }) });
    r.simulate(300);
    r.handle({ type: 'trips', rates: rates([0], [0]) });
    r.simulate(900);
    const stats = r.tripFigures()!;
    expect(stats.started).toBeGreaterThanOrEqual(25);
    expect(stats.arrived).toBeGreaterThanOrEqual(stats.started * 0.9);
    expect(stats.arrivedAt[0]).toBe(stats.arrived);
    expect(stats.active).toBe(stats.started - stats.arrived - stats.abandoned);
    expect(stats.walkMetres / stats.arrived).toBeLessThan(10); // parked at the venue's own node
    expect(stats.tripSeconds / stats.arrived).toBeGreaterThan(30); // it was a drive, not a teleport
  });

  it('every car makes for the venue: none wander once the flow stops', () => {
    const r = runner([centre]);
    r.handle({ type: 'trips', rates: rates([0.2], [0], { west: 1 }) });
    r.simulate(200);
    r.handle({ type: 'trips', rates: rates([0], [0]) });
    r.simulate(1200);
    expect(r.tripFigures()!.active).toBe(0);
    expect(r.figures().cars).toBe(0);
  });

  it('a closure round the venue makes drivers park short and walk, and the trip still ends', () => {
    const r = runner([centre]);
    const node = 3 * SIDE + 3;
    const sim = new CarSim(roads, { population: 2, seed: 1 });
    const around: number[] = [];
    for (let e = 0; e < sim.E; e++) if (sim.from[e] === node || sim.to[e] === node) around.push(e);
    r.handle({ type: 'closed', edges: around });
    r.handle({ type: 'trips', rates: rates([0.1], [0], { south: 1 }) });
    r.simulate(300);
    r.handle({ type: 'trips', rates: rates([0], [0]) });
    r.simulate(900);
    const stats = r.tripFigures()!;
    expect(stats.arrived).toBeGreaterThanOrEqual(stats.started * 0.8);
    expect(stats.walkMetres / stats.arrived).toBeGreaterThan(50); // a block away
    expect(stats.unreachable).toBe(0);
  });

  it('the demand slider does not remove festival cars', () => {
    const r = runner([centre]);
    r.handle({ type: 'trips', rates: rates([0.1], [0], { local: 1 }) });
    r.simulate(120);
    const before = r.tripFigures()!.active;
    r.handle({ type: 'demand', fraction: 0.25 });
    r.simulate(5);
    expect(before).toBeGreaterThan(3);
    expect(r.tripFigures()!.active).toBeGreaterThanOrEqual(before - r.tripFigures()!.arrived);
  });
});

describe('outbound trips and edge cases', () => {
  it('after a show, cars leave the venue for a gateway', () => {
    const r = runner([centre]);
    r.handle({ type: 'trips', rates: rates([0], [0.1], { south: 1 }) });
    r.simulate(300);
    r.handle({ type: 'trips', rates: rates([0], [0]) });
    r.simulate(900);
    const stats = r.tripFigures()!;
    expect(stats.started).toBeGreaterThanOrEqual(25);
    expect(stats.left).toBeGreaterThanOrEqual(stats.started * 0.9);
    expect(stats.arrived).toBe(0);
  });

  it('a venue with no road in reach gets no cars, and the flow reports it', () => {
    const r = new CarRunner(() => undefined);
    const messages: unknown[] = [];
    const posting = new CarRunner((m) => void messages.push(m));
    posting.handle({ type: 'init', roads, population: 10, seed: 5, venues: [far, centre], tripSlots: 50 });
    const ready = messages.find((m) => (m as { type: string }).type === 'ready') as { venuesPlaced: boolean[] };
    expect(ready.venuesPlaced).toEqual([false, true]);
    posting.handle({ type: 'trips', rates: rates([5, 0], [5, 0], { local: 1 }) });
    posting.simulate(60);
    expect(posting.tripFigures()!.started).toBe(0);
    expect(r.tripFigures()).toBeNull(); // a runner that was never started has no flow
  });

  it('without venues there are no trips and the extra slots are not made', () => {
    const r = new CarRunner(() => undefined);
    r.handle({ type: 'init', roads, population: 20, seed: 5, tripSlots: 100 });
    expect(r.tripFigures()).toBeNull();
  });

  it('emptyRates is all zero', () => {
    expect(emptyRates(3).inbound).toEqual([0, 0, 0]);
  });
});
