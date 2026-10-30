import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { metresPerPixel } from './bus3d';
import { TENT_PX, TENT_POSITION, tentGeometry, tentScale } from './tent';

describe('tentScale', () => {
  it('keeps real size when zoomed in', () => {
    expect(tentScale(18, 55.94)).toBe(1);
  });
  it('is at least TENT_PX wide on screen when zoomed out, within the cap', () => {
    const width = (zoom: number) => (2 * 9.8 * tentScale(zoom, 55.94)) / metresPerPixel(zoom, 55.94);
    expect(width(15)).toBeCloseTo(TENT_PX);
    expect(tentScale(5, 55.94)).toBe(5);
  });
});

describe('tentGeometry', () => {
  it('is a round big top about 20 m across and 9 m high, standing on the ground', () => {
    const { wall, roof, finial } = tentGeometry();
    for (const geometry of [wall, roof, finial]) geometry.computeBoundingBox();
    expect(roof.boundingBox!.max.x - roof.boundingBox!.min.x).toBeCloseTo(19.6, 0);
    expect(wall.boundingBox!.min.z).toBeCloseTo(0);
    expect(finial.boundingBox!.max.z).toBeGreaterThan(8.5);
    expect(finial.boundingBox!.max.z).toBeLessThan(10);
  });
});

describe('TENT_POSITION', () => {
  it('matches the tent row of config/venues.csv, so the render and the pipeline agree', () => {
    const rows = readFileSync(new URL('../../config/venues.csv', import.meta.url), 'utf8').trim().split('\n').slice(1);
    const tents = rows.map((line) => line.split(',')).filter((cells) => cells[3] === 'tent');
    expect(tents).toHaveLength(1);
    expect([Number(tents[0]![1]), Number(tents[0]![2])]).toEqual(TENT_POSITION);
  });
  it('is inside George Square Gardens (OSM way 4075023: 55.9430 to 55.9443 N, 3.1903 to 3.1873 W)', () => {
    expect(TENT_POSITION[0]).toBeGreaterThan(-3.1903);
    expect(TENT_POSITION[0]).toBeLessThan(-3.1873);
    expect(TENT_POSITION[1]).toBeGreaterThan(55.943);
    expect(TENT_POSITION[1]).toBeLessThan(55.9443);
  });
});
