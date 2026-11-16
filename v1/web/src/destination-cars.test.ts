import { describe, expect, it } from 'vitest';
import { CarRunner } from './cars-runner';
import { DestinationCars, DWELL_S, pickIndex, unit } from './destination-cars';
import { CarSim, mulberry32 } from './engine/car-sim.mjs';
import { gridRoads } from './grid-roads.testutil';
import type { TripVenue } from './trips';

const SIDE = 7;
const roads = gridRoads(SIDE);
const at = (key: string, col: number, row: number): TripVenue => ({ key, lon: -3.19 + col * 0.002, lat: 55.95 + row * 0.002 });
const hall = at('hall', 3, 3);
const club = at('club', 1, 5);
const far: TripVenue = { key: 'faraway', lon: -3.0, lat: 56.1 };

function runner(venues: TripVenue[], population = 60) {
  const r = new CarRunner(() => undefined);
  r.handle({ type: 'init', roads, population, seed: 5, venues, tripSlots: 50 });
  return r;
}
const figures = (r: CarRunner) => r.destinationFigures()!;

describe('helpers', () => {
  it('unit is deterministic, in [0, 1) and spread evenly enough to pick a share', () => {
    expect(unit(5, 17)).toBe(unit(5, 17));
    const values = Array.from({ length: 4000 }, (_, car) => unit(5, car));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    const share = values.filter((v) => v < 0.25).length / values.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.28);
  });
  it('unit chooses the right share of a small fleet over many seeds (a run has only dozens of cars)', () => {
    let chosen = 0;
    for (let seed = 1; seed <= 200; seed++) for (let car = 0; car < 60; car++) if (unit(seed, car) < 0.25) chosen++;
    expect(chosen / (200 * 60)).toBeGreaterThan(0.23);
    expect(chosen / (200 * 60)).toBeLessThan(0.27);
  });
  it('pickIndex follows the weights, skips zeros and ignores negatives', () => {
    expect(pickIndex([1, 3], 0.1)).toBe(0);
    expect(pickIndex([1, 3], 0.5)).toBe(1);
    expect(pickIndex([0, 5, 0], 0.99)).toBe(1);
    expect(pickIndex([-4, 1], 0)).toBe(1);
    expect(pickIndex([0, 0], 0.5)).toBe(-1);
    expect(pickIndex([], 0.5)).toBe(-1);
  });
});

describe('destination cars', () => {
  it('does nothing until a share is asked for', () => {
    const r = runner([hall]);
    r.simulate(300);
    expect(figures(r)).toMatchObject({ heading: 0, chosen: 0, arrived: 0 });
  });
  it('has no destination cars when no venues were given', () => {
    const r = new CarRunner(() => undefined);
    r.handle({ type: 'init', roads, population: 30, seed: 5 });
    r.handle({ type: 'destinations', share: 1, weights: [] });
    expect(r.destinationFigures()).toBeNull();
  });
  it('sends the chosen share of cars to the venue, and they arrive and carry on driving', () => {
    const r = runner([hall]);
    r.handle({ type: 'destinations', share: 0.5, weights: [1] });
    r.simulate(900);
    const f = figures(r);
    expect(f.chosen).toBeGreaterThan(5);
    expect(f.arrived).toBeGreaterThan(5);
    expect(f.arrivedAt[0]).toBe(f.arrived);
    // Arriving does not park or remove anyone: the same number of cars is still on the road.
    expect(r.figures().cars).toBe(60);
    expect(f.heading).toBeLessThanOrEqual(30);
  });
  it('picks venues in proportion to their weights, and never a venue with weight zero', () => {
    const r = runner([hall, club]);
    r.handle({ type: 'destinations', share: 0.5, weights: [0, 1] });
    r.simulate(1200);
    const f = figures(r);
    expect(f.arrivedAt[1]).toBeGreaterThan(5);
    expect(f.arrivedAt[0]).toBe(0);
  });
  it('gives no car a venue that no road reaches', () => {
    const r = runner([far]);
    r.handle({ type: 'destinations', share: 1, weights: [1] });
    r.simulate(300);
    expect(figures(r)).toMatchObject({ heading: 0, chosen: 0, arrived: 0 });
  });
  it('does nothing while every weight is zero (no audience anywhere)', () => {
    const r = runner([hall]);
    r.handle({ type: 'destinations', share: 1, weights: [0] });
    r.simulate(300);
    expect(figures(r).chosen).toBe(0);
  });
  it('sends a car to another venue after the dwell, so the share keeps heading out', () => {
    const r = runner([hall]);
    r.handle({ type: 'destinations', share: 0.3, weights: [1] });
    const chosenCars = [...Array(60).keys()].filter((car) => unit(5, car) < 0.3).length; // the runner uses the init seed to choose
    expect(chosenCars).toBeGreaterThan(5);
    r.simulate(DWELL_S * 6);
    const f = figures(r);
    expect(f.arrived).toBeGreaterThan(chosenCars); // more arrivals than cars: each one went again after wandering
    expect(f.chosen).toBeGreaterThan(chosenCars);
  });
  it('turning it off sends every car back to wandering', () => {
    const r = runner([hall]);
    r.handle({ type: 'destinations', share: 0.5, weights: [1] });
    r.simulate(120);
    expect(figures(r).heading).toBeGreaterThan(0);
    r.handle({ type: 'destinations', share: 0, weights: [1] });
    r.simulate(10);
    expect(figures(r).heading).toBe(0);
    const before = figures(r).chosen;
    r.simulate(600);
    expect(figures(r).chosen).toBe(before);
  });
  it('plans a new route for a car whose road ahead is closed, and the car still reaches the venue', () => {
    const sim = new CarSim(roads, { population: 60, seed: 5 });
    const cars = new DestinationCars(sim, [hall], sim.n, 5, mulberry32(9));
    cars.setTarget(1, [1]);
    cars.check();
    // A car with a long route: close a road three roads ahead of where it is.
    const car = [...Array(sim.n).keys()].find((i) => cars.isHeading(i) && (sim.route[i] as Int32Array | null)?.length && (sim.route[i] as Int32Array).length >= 5)!;
    expect(car).toBeDefined();
    const route = sim.route[car] as Int32Array;
    const blocked = route[2] as number;
    sim.setClosed([blocked], true);
    const venue = cars.venueOf(car);
    const arrivedBefore = cars.stats().arrivedAt[venue] as number;
    let steps = 0;
    let usedClosed = false;
    while (steps < 5 * 900 && cars.isHeading(car)) {
      sim.step(0.2);
      if (sim.edge[car] === blocked) usedClosed = true;
      if (++steps % 5 === 0) cars.check();
    }
    expect(usedClosed).toBe(false); // it never drove the closed road
    expect(cars.stats().replanned).toBeGreaterThan(0);
    expect(cars.stats().arrivedAt[venue]).toBeGreaterThan(arrivedBefore);
  });
  it('is the same every time for the same seed', () => {
    const run = () => {
      const r = runner([hall, club]);
      r.handle({ type: 'destinations', share: 0.4, weights: [2, 1] });
      r.simulate(600);
      return figures(r);
    };
    expect(run()).toEqual(run());
  });
  it('leaves the festival trips alone: they are not counted as destination cars', () => {
    const r = runner([hall]);
    r.handle({ type: 'trips', rates: { inbound: [0.2], outbound: [0], mix: { local: 1, north: 0, west: 0, south: 0 } } });
    r.simulate(300);
    expect(r.tripFigures()!.started).toBeGreaterThan(0);
    expect(figures(r).chosen).toBe(0);
  });
});
