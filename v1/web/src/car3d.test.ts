import { describe, expect, it } from 'vitest';
import { busScale } from './bus3d';
import { CAR_LENGTH_M, MIN_ZOOM, carGeometry, carPixels, carScale } from './car3d';

const LAT = 55.95;

describe('carScale', () => {
  it('is real size once zoomed in, and enlarges cars as the map zooms out', () => {
    expect(carScale(18, LAT).footprint).toBe(1);
    expect(carScale(17, LAT).footprint).toBeLessThan(1.1);
    let previous = 1;
    for (const zoom of [16, 15, 14, 13, 12]) {
      const { footprint } = carScale(zoom, LAT);
      expect(footprint).toBeGreaterThanOrEqual(previous);
      previous = footprint;
    }
    expect(carScale(12, LAT).footprint).toBeGreaterThan(3);
  });

  it('caps the enlargement and keeps height growing more slowly than length', () => {
    for (const zoom of [8, 10, 12]) {
      const { footprint, height } = carScale(zoom, LAT);
      expect(footprint).toBeLessThanOrEqual(8);
      expect(height).toBeLessThanOrEqual(3);
      expect(height).toBeLessThanOrEqual(footprint);
    }
  });

  it('enlarges cars far less than buses, since there are so many of them', () => {
    for (const zoom of [12, 14, 16]) expect(carPixels(zoom)).toBeLessThan(40 * 2 ** (0.4 * (zoom - 17)));
    expect(carScale(13, LAT).footprint).toBeLessThan(busScale(13, LAT).footprint);
  });

  it('draws nothing below the minimum zoom', () => {
    expect(MIN_ZOOM).toBe(12);
  });
});

describe('carGeometry', () => {
  it('is a 4.2 m long, 1.8 m wide car, with its front at +y and centred on its middle', () => {
    const { body, glass, wheels } = carGeometry();
    body.computeBoundingBox();
    const box = body.boundingBox!;
    expect(box.max.y - box.min.y).toBeCloseTo(CAR_LENGTH_M, 5);
    expect(box.max.x - box.min.x).toBeCloseTo(1.8, 5);
    expect(box.min.y).toBeCloseTo(-box.max.y, 5);
    expect(box.max.z).toBeLessThan(1.6); // a small car, not a van
    expect(box.min.z).toBeGreaterThan(0);
    glass.computeBoundingBox();
    expect(glass.boundingBox!.max.y).toBeGreaterThan(0); // the windscreen is at the front
    wheels.computeBoundingBox();
    expect(wheels.boundingBox!.max.x).toBeGreaterThan(0.8);
    expect(wheels.boundingBox!.min.z).toBeGreaterThanOrEqual(-1e-6); // sitting on the road, to float precision
  });
});
