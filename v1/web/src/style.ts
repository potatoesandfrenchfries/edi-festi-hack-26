import type { StyleSpecification } from 'maplibre-gl';

const BACKGROUND = { light: '#e8e6e1', dark: '#161c27' } as const;

/** A style with no sources: a flat background that works offline and needs no key. */
export function blankStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    // Soft light from the south-west so extruded walls read as 3D without a basemap.
    light: { anchor: 'viewport', position: [1.5, 210, 45], intensity: 0.4 },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? BACKGROUND.dark : BACKGROUND.light } }],
  };
}
