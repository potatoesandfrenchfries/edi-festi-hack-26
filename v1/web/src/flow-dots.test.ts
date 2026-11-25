// The flow drawn as dots: counts that follow the vehicles, positions on the road, colours by speed.
import { describe, expect, it } from 'vitest';
import type { Roads } from './engine/car-sim.mjs';
import { CellModel } from './engine/ctm.mjs';
import { FLOATS_PER_CAR } from './cars-protocol';
import { FLOW_COLOURS, FlowDots, MAX_DOTS, flowDotColours, kindOf, roadLevels } from './flow-dots';

/** One eastbound road of 600 m (about ten 63 m steps of longitude) and a road back, so the graph is connected. */
function twoRoads(): Roads {
  const west = -3.19, east = -3.19 + 0.0096, lat = 55.95; // 0.0096 degrees of longitude is about 600 m here
  const edges = [
    [0, 1, 0, 1, 13.4, 0, 0, 600, [west, lat, east, lat], 1, 0],
    [1, 0, 0, 1, 13.4, 0, 0, 600, [east, lat + 0.001, west, lat + 0.001], 2, 0],
  ];
  return { bbox: [-3.2, 55.94, -3.17, 55.97], classes: ['primary'], nodes: 2, names: [''], signals: [], edges };
}
/** Puts `vehicles` evenly on road `e`, bypassing the model's own flow. */
function load(model: CellModel, e: number, vehicles: number) {
  const cells = model.cellStart[e + 1]! - model.cellStart[e]!;
  for (let c = model.cellStart[e]!; c < model.cellStart[e + 1]!; c++) model.n[c] = vehicles / cells;
}

describe('flow dots', () => {
  it('one dot per dotScale vehicles, and a count that holds until the vehicles move clearly away from it', () => {
    const roads = twoRoads(), model = new CellModel(roads), dots = new FlowDots(model, roads, 5);
    load(model, 0, 12); // 2.4 dots
    dots.advance(0);
    expect(dots.dotsOn(0)).toBe(2);
    load(model, 0, 13); // 2.6: not yet far enough from 2 to change
    dots.advance(0);
    expect(dots.dotsOn(0)).toBe(2);
    load(model, 0, 14.6); // 2.92
    dots.advance(0);
    expect(dots.dotsOn(0)).toBe(3);
    load(model, 0, 0);
    dots.advance(0);
    expect(dots.dotsOn(0)).toBe(0);
    expect(dots.frame().length).toBe(0);
  });

  it('puts dots on the road, on the left of the direction of travel, heading the right way', () => {
    const roads = twoRoads(), model = new CellModel(roads), dots = new FlowDots(model, roads, 5);
    load(model, 0, 20); // 4 dots on the eastbound road
    dots.advance(0);
    const frame = dots.frame();
    expect(frame.length).toBe(4 * FLOATS_PER_CAR);
    for (let i = 0; i < 4; i++) {
      const lon = frame[i * FLOATS_PER_CAR]!, lat = frame[i * FLOATS_PER_CAR + 1]!, bearing = frame[i * FLOATS_PER_CAR + 2]!;
      expect(lon).toBeGreaterThanOrEqual(-3.19 - 1e-5);
      expect(lon).toBeLessThanOrEqual(-3.19 + 0.0096 + 1e-5);
      expect(lat).toBeGreaterThan(55.95); // left of an eastward road is north
      expect((lat - 55.95) * model.mPerLat).toBeLessThan(2.8); // 2 m off the centre line, plus the frame's float32 rounding (about 0.4 m)
      expect(bearing).toBeCloseTo(90, 0);
    }
  });

  it('spaces the dots evenly and carries them at the road speed', () => {
    const roads = twoRoads(), model = new CellModel(roads), dots = new FlowDots(model, roads, 5);
    load(model, 0, 10); // 2 dots, free flow at 13.4 m/s
    dots.advance(0);
    const lons = () => Array.from({ length: 2 }, (_, i) => dots.frame()[i * FLOATS_PER_CAR]!).sort((a, b) => a - b);
    const [a0, b0] = lons();
    const length = 0.0096 * model.mPerLon; // the polyline's length in the model's metres
    expect((b0! - a0!) * model.mPerLon).toBeCloseTo(length / 2, 0); // two dots, half a road apart
    dots.advance(10); // 134 m on
    const [a1] = lons();
    expect((((a1! - a0!) * model.mPerLon) % (length / 2) + length / 2) % (length / 2)).toBeCloseTo(134, 0);
  });

  it('colours by how far below free flow the road is moving', () => {
    expect(kindOf(13.4, 13.4)).toBe(0);
    expect(kindOf(8, 13.4)).toBe(1);
    expect(kindOf(2, 13.4)).toBe(2);
    expect(FLOW_COLOURS).toHaveLength(3);
    expect(flowDotColours('#222222')).toEqual(['#222222', FLOW_COLOURS[1], FLOW_COLOURS[2]]); // free-flow dots stay visible on the green tint
    const roads = twoRoads(), model = new CellModel(roads), dots = new FlowDots(model, roads, 5);
    load(model, 0, model.room[model.cellStart[0]!]! * (model.cellStart[1]! - model.cellStart[0]!) * 0.9); // nearly jammed
    dots.advance(0);
    expect(dots.frame()[4]).toBe(2); // crawling
  });

  it('never draws more than the cap', () => {
    const roads = twoRoads(), model = new CellModel(roads), dots = new FlowDots(model, roads, 0.001);
    load(model, 0, 100);
    dots.advance(0);
    expect(dots.frame().length).toBe(MAX_DOTS * FLOATS_PER_CAR);
  });

  it('road levels: free and empty is 0 and 0; jammed is high on both', () => {
    const roads = twoRoads(), model = new CellModel(roads);
    let now = roadLevels(model);
    expect(now.level[0]).toBe(0);
    expect(now.load[0]).toBe(0);
    load(model, 0, model.room[model.cellStart[0]!]! * (model.cellStart[1]! - model.cellStart[0]!) * 0.95);
    now = roadLevels(model);
    expect(now.level[0]!).toBeGreaterThan(0.9);
    expect(now.load[0]!).toBeGreaterThan(0.9);
    expect(now.level[1]).toBe(0); // the other road is untouched
  });
});
