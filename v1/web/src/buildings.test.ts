import { describe, expect, it } from 'vitest';
import { firstLabelLayer, hideBasemapExtrusions, tilesAvailable } from './buildings';

const respond = (body: string, ok = true) => (async () => ({ ok, arrayBuffer: async () => new TextEncoder().encode(body).buffer })) as unknown as typeof fetch;

describe('tilesAvailable', () => {
  it('accepts a response that starts with the PMTiles magic bytes', async () => {
    expect(await tilesAvailable('x', respond('PMTiles\u0003'))).toBe(true);
  });
  it('rejects the HTML a dev server returns for unknown paths', async () => {
    expect(await tilesAvailable('x', respond('<!doctype html>'))).toBe(false);
  });
  it('rejects error responses and network failures', async () => {
    expect(await tilesAvailable('x', respond('PMTiles', false))).toBe(false);
    expect(await tilesAvailable('x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('firstLabelLayer', () => {
  const mapWith = (layers: { id: string; type: string; 'source-layer'?: string }[]) => ({ getStyle: () => ({ layers }) }) as unknown as Parameters<typeof firstLabelLayer>[0];
  it('finds the first symbol layer so buildings sit under labels', () => {
    expect(firstLabelLayer(mapWith([{ id: 'bg', type: 'background' }, { id: 'roads', type: 'line' }, { id: 'names', type: 'symbol' }, { id: 'places', type: 'symbol' }]))).toBe('names');
  });
  it('skips labels that sit under the flat layers, as in the dark public style (water labels come before buildings and roads)', () => {
    const style = [
      { id: 'bg', type: 'background' }, { id: 'water', type: 'fill' }, { id: 'water_name', type: 'symbol' }, { id: 'building', type: 'fill' },
      { id: 'roads', type: 'line' }, { id: 'road_names', type: 'symbol' }, { id: 'borders', type: 'line', 'source-layer': 'boundary' }, { id: 'places', type: 'symbol' },
    ];
    expect(firstLabelLayer(mapWith(style))).toBe('road_names');
  });
  it('is undefined for a style with no labels', () => {
    expect(firstLabelLayer(mapWith([{ id: 'bg', type: 'background' }]))).toBeUndefined();
  });
});

describe('hideBasemapExtrusions', () => {
  it('hides only the 3D building layers a basemap brings', () => {
    const hidden: string[] = [];
    const map = {
      getStyle: () => ({ layers: [{ id: 'bg', type: 'background' }, { id: 'building-3d', type: 'fill-extrusion' }, { id: 'names', type: 'symbol' }] }),
      setLayoutProperty: (id: string, name: string, value: string) => value === 'none' && name === 'visibility' && hidden.push(id),
    } as unknown as Parameters<typeof hideBasemapExtrusions>[0];
    expect(hideBasemapExtrusions(map)).toEqual(['building-3d']);
    expect(hidden).toEqual(['building-3d']);
  });
});
