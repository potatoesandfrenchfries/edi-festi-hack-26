import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEAD_HEIGHT_M, KERB_OFFSET_M, LAMP_Z, LIT_LAMP, MAX_SCALE, MIN_ZOOM, capColour, faceBearing, lampColour, poleOffset, signalGeometry, signalScale } from './signal3d';
import { SIGNAL_AMBER, SIGNAL_COLOURS, SIGNAL_GREEN, SIGNAL_RED } from './signals';
import { approachBearings } from './cars-runner';
import { gridRoads } from './grid-roads.testutil';
import { CarSim } from './engine/car-sim.mjs';

const LAT = 55.95;
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

describe('signalScale', () => {
  it('is real size once zoomed in far enough, and enlarges signals as the map zooms out, up to a cap', () => {
    expect(signalScale(20, LAT)).toBe(1);
    let previous = 1;
    for (const zoom of [18, 17, 16, 15, 14]) {
      const scale = signalScale(zoom, LAT);
      expect(scale).toBeGreaterThanOrEqual(previous);
      previous = scale;
    }
    expect(signalScale(MIN_ZOOM, LAT)).toBe(MAX_SCALE);
    expect(signalScale(8, LAT)).toBeLessThanOrEqual(MAX_SCALE);
  });
  it('makes the head a few pixels tall at the zoom the dots start at, so it can be seen', () => {
    const px = (zoom: number) => (HEAD_HEIGHT_M * signalScale(zoom, LAT)) / ((40075016 * Math.cos((LAT * Math.PI) / 180)) / (512 * 2 ** zoom));
    expect(px(17)).toBeGreaterThan(7);
    expect(px(14)).toBeGreaterThan(2);
  });
});

describe('where a signal stands and which way it faces', () => {
  it('puts the pole on the left of the traffic (it drives on the left): west of a northbound road, north of an eastbound one', () => {
    const north = poleOffset(0);
    expect(north.east).toBeCloseTo(-KERB_OFFSET_M);
    expect(north.north).toBeCloseTo(0);
    const east = poleOffset(90);
    expect(east.east).toBeCloseTo(0);
    expect(east.north).toBeCloseTo(KERB_OFFSET_M);
    const south = poleOffset(180);
    expect(south.east).toBeCloseTo(KERB_OFFSET_M); // left of a southbound vehicle is east
  });
  it('faces the head back along the road, to the oncoming traffic', () => {
    expect(faceBearing(0)).toBe(180);
    expect(faceBearing(90)).toBe(270);
    expect(faceBearing(270)).toBe(90);
    expect(faceBearing(350)).toBe(170);
  });
  it('reads the direction of travel from the end of each approach road', () => {
    const roads = gridRoads(7);
    const sim = new CarSim(roads, { population: 2, seed: 1 });
    const bearings = approachBearings(sim);
    expect(bearings).toHaveLength(sim.approaches.length);
    expect([...bearings].map((b) => Math.round(b)).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]); // a junction in the grid is entered from all four sides
    for (const b of bearings) expect(b).toBeGreaterThanOrEqual(0);
  });
});

describe('the lamps', () => {
  it('lights the red lamp (top) for red, amber (middle) for amber and green (bottom) for green, and the other two dim', () => {
    for (const dark of [false, true]) {
      const set = SIGNAL_COLOURS[dark ? 'dark' : 'light'];
      const lit = (state: number) => [0, 1, 2].map((lamp) => lampColour(state, lamp, dark));
      expect(lit(SIGNAL_RED)[0]).toBe(set.red);
      expect(lit(SIGNAL_AMBER)[1]).toBe(set.amber);
      expect(lit(SIGNAL_GREEN)[2]).toBe(set.green);
      for (const state of [SIGNAL_RED, SIGNAL_AMBER, SIGNAL_GREEN]) {
        const colours = lit(state);
        const on = LIT_LAMP[state as 0 | 1 | 2];
        colours.forEach((c, lamp) => {
          if (lamp !== on) expect(luminance(c)).toBeLessThan(luminance(colours[on] as string) * 0.6); // a lit lamp is clearly brighter than a dim one
        });
      }
    }
  });
  it('gives the cap the colour of the state, so it reads from straight above', () => {
    expect(capColour(SIGNAL_RED, false)).toBe(SIGNAL_COLOURS.light.red);
    expect(capColour(SIGNAL_AMBER, true)).toBe(SIGNAL_COLOURS.dark.amber);
    expect(capColour(SIGNAL_GREEN, false)).toBe(SIGNAL_COLOURS.light.green);
  });
  it('orders the lamps red over amber over green, as on a real signal', () => {
    expect(LAMP_Z[0]).toBeGreaterThan(LAMP_Z[1]);
    expect(LAMP_Z[1]).toBeGreaterThan(LAMP_Z[2]);
  });
});

describe('signalGeometry', () => {
  const size = (geo: THREE.BufferGeometry) => {
    geo.computeBoundingBox();
    return geo.boundingBox!.getSize(new THREE.Vector3());
  };
  it('is a pole about 4 m tall with a head taller than a lamp stack, a thin cap above it, and a lamp that faces the road', () => {
    const { structure, cap, lamp } = signalGeometry();
    expect(size(structure).z).toBeGreaterThan(4);
    expect(size(structure).z).toBeLessThan(5);
    expect(structure.boundingBox!.min.z).toBeCloseTo(0, 1); // stands on the ground
    expect(size(cap).z).toBeLessThan(0.2);
    expect(cap.boundingBox!.min.z).toBeGreaterThan(structure.boundingBox!.max.z - 0.4); // sits on top of the head
    expect(size(lamp).y).toBeLessThan(size(lamp).x); // a flat disc whose face looks along y, the head's face
    expect(HEAD_HEIGHT_M).toBeGreaterThan(Math.abs(LAMP_Z[0] - LAMP_Z[2]) + 0.26); // three lamps fit in the head
  });
});
