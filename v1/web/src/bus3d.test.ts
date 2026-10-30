import * as maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { busGeometry, busPixels, busScale, localMetres, metresPerPixel } from './bus3d';
import { busMarker, type Bus } from './buses';

describe('busScale', () => {
  const onScreen = (zoom: number) => (11 * busScale(zoom, 55.95).footprint) / metresPerPixel(zoom, 55.95);
  it('keeps real size when zoomed in', () => {
    expect(busScale(18.5, 55.95)).toEqual({ footprint: 1, height: 1 });
  });
  it('makes buses smaller as the map zooms out and larger as it zooms in, but never below real size', () => {
    const sizes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(onScreen);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);
    expect(onScreen(13)).toBeCloseTo(busPixels(13));
  });
  it('shrinks more slowly than the map itself', () => {
    expect(onScreen(14) / onScreen(13)).toBeLessThan(2);
    expect(onScreen(14) / onScreen(13)).toBeGreaterThan(1);
  });
  it('grows height more slowly than length, and is capped so a far-out bus does not become a skyscraper', () => {
    const far = busScale(9, 55.95);
    expect(far.height).toBeLessThanOrEqual(far.footprint);
    expect(far.footprint).toBeLessThanOrEqual(40);
    expect(far.height).toBeLessThanOrEqual(5);
  });
});

describe('metresPerPixel', () => {
  it('halves with every zoom level and is about 0.9 m per pixel at zoom 15.5 in Edinburgh', () => {
    expect(metresPerPixel(16, 55.95) * 2).toBeCloseTo(metresPerPixel(15, 55.95));
    expect(metresPerPixel(15.5, 55.95)).toBeGreaterThan(0.85);
    expect(metresPerPixel(15.5, 55.95)).toBeLessThan(1.0);
  });
});

describe('localMetres', () => {
  const origin = maplibregl.MercatorCoordinate.fromLngLat([-3.19, 55.95]);
  it('is zero at the origin and positive to the east and north', () => {
    const here = localMetres(origin, -3.19, 55.95);
    expect(here.east).toBeCloseTo(0);
    expect(here.north).toBeCloseTo(0);
    const p = localMetres(origin, -3.18, 55.96);
    expect(p.east).toBeGreaterThan(0);
    expect(p.north).toBeGreaterThan(0);
  });
  it('measures about one real kilometre per 0.009 degrees of latitude, and per 0.016 of longitude here', () => {
    expect(localMetres(origin, -3.19, 55.959).north).toBeGreaterThan(990);
    expect(localMetres(origin, -3.19, 55.959).north).toBeLessThan(1010);
    expect(localMetres(origin, -3.174, 55.95).east).toBeGreaterThan(990);
    expect(localMetres(origin, -3.174, 55.95).east).toBeLessThan(1010);
  });
});

describe('busGeometry', () => {
  it('is a double-decker about 11 m long, 2.6 m wide and 4.4 m tall, standing on z = 0', () => {
    const { body, wheels, glass } = busGeometry();
    for (const geometry of [body, wheels, glass]) geometry.computeBoundingBox();
    const box = body.boundingBox!;
    expect(box.max.y - box.min.y).toBeCloseTo(11);
    expect(box.max.x - box.min.x).toBeCloseTo(2.55);
    expect(box.max.z).toBeCloseTo(4.4);
    expect(wheels.boundingBox!.min.z).toBeCloseTo(0);
    expect(glass.boundingBox!.max.z).toBeLessThanOrEqual(box.max.z);
  });
});

describe('busMarker', () => {
  it('carries position, heading, operator colour and layover state', () => {
    const bus = { lon: -3.2, lat: 55.95, bearing: 90, layover: true, route: { agency: 'LOTH' } } as unknown as Bus;
    expect(busMarker(bus)).toEqual({ lon: -3.2, lat: 55.95, bearing: 90, colour: '#D55E00', layover: true });
  });
});
