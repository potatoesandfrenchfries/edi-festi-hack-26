import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

export const BUILDINGS_SOURCE = 'buildings';
export const BUILDINGS_LAYER = 'buildings-3d';
export const PARTS_LAYER = 'landmark-parts-3d';
export const INFERRED_LAYER = 'inferred-3d';
export const TILES_PATH = 'data/buildings.pmtiles';
export const BUILDINGS_MIN_ZOOM = 13;

/** Colour of a mapped building whose estimate is under the first break point (the neutral class of the scale). */
export const BUILDING_COLOUR = { light: '#b8a99a', dark: '#7d8aa0' } as const;
/** Inferred buildings (not mapped in OSM) are a lighter tone of the same colour so they are never mistaken for mapped ones. */
export const INFERRED_COLOUR = { light: '#d3c8bc', dark: '#a3aec2' } as const;

let registered = false;

export function registerPmtiles(): void {
  if (registered) return;
  maplibregl.addProtocol('pmtiles', new Protocol().tile);
  registered = true;
}

/** True when `url` serves a PMTiles archive. A dev server answers unknown paths with HTML, so check the magic bytes. */
export async function tilesAvailable(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(url, { headers: { Range: 'bytes=0-6' } });
    if (!response.ok) return false;
    const head = new TextDecoder().decode((await response.arrayBuffer()).slice(0, 7));
    return head === 'PMTiles';
  } catch {
    return false;
  }
}

export const MODELLED_LAYERS = [BUILDINGS_LAYER, PARTS_LAYER] as const;

/** Sets the occupancy colour on the mapped buildings and the landmark parts that stand on them. Inferred buildings are not modelled. */
export function setOccupancyColour(map: maplibregl.Map, colour: ExpressionSpecification): void {
  for (const layer of MODELLED_LAYERS) map.setPaintProperty(layer, 'fill-extrusion-color', colour);
}

export function setInferredColour(map: maplibregl.Map, dark: boolean): void {
  map.setPaintProperty(INFERRED_LAYER, 'fill-extrusion-color', dark ? INFERRED_COLOUR.dark : INFERRED_COLOUR.light);
}

const ALL_LAYERS = [BUILDINGS_LAYER, PARTS_LAYER, INFERRED_LAYER] as const;

/** Buildings appear from this zoom up. A later zoom means fewer buildings on screen at once. */
export function setBuildingsMinZoom(map: maplibregl.Map, minZoom: number): void {
  for (const layer of ALL_LAYERS) map.setLayerZoomRange(layer, minZoom, 24);
}

/** Real building heights, or flat footprints. Flat is lighter to draw and easier to read from above. */
export function setHeights(map: maplibregl.Map, on: boolean): void {
  for (const layer of ALL_LAYERS) map.setPaintProperty(layer, 'fill-extrusion-height', on ? ['get', 'height_m'] : 0);
}

export function setTowersVisible(map: maplibregl.Map, visible: boolean): void {
  map.setLayoutProperty(PARTS_LAYER, 'visibility', visible ? 'visible' : 'none');
}

export function setInferredVisible(map: maplibregl.Map, visible: boolean): void {
  map.setLayoutProperty(INFERRED_LAYER, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Where to insert the modelled buildings: before the first label layer that comes after every flat map layer (land, roads,
 * the basemap's own building footprints), so the buildings cover those and stay under street names and place labels. Boundary
 * lines are ignored because styles interleave them with labels. Undefined for a flat background with no labels.
 */
export function firstLabelLayer(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers as { id: string; type: string; 'source-layer'?: string }[];
  const flat = new Set(['background', 'fill', 'line', 'raster', 'hillshade', 'color-relief']);
  let lastFlat = -1;
  layers.forEach((layer, i) => {
    if (flat.has(layer.type) && layer['source-layer'] !== 'boundary') lastFlat = i;
  });
  return layers.find((layer, i) => i > lastFlat && layer.type === 'symbol')?.id;
}

/** Hides 3D buildings a basemap style brings, so only the modelled buildings are extruded and the basemap cannot cover them. */
export function hideBasemapExtrusions(map: maplibregl.Map): string[] {
  const hidden = map
    .getStyle()
    .layers.filter((layer) => layer.type === 'fill-extrusion')
    .map((layer) => layer.id);
  for (const id of hidden) map.setLayoutProperty(id, 'visibility', 'none');
  return hidden;
}

export function addBuildings(map: maplibregl.Map, tilesUrl: string, dark: boolean): void {
  hideBasemapExtrusions(map);
  const before = firstLabelLayer(map);
  map.addSource(BUILDINGS_SOURCE, { type: 'vector', url: `pmtiles://${tilesUrl}`, minzoom: BUILDINGS_MIN_ZOOM, maxzoom: 16 });
  const paint = {
    'fill-extrusion-color': dark ? BUILDING_COLOUR.dark : BUILDING_COLOUR.light,
    'fill-extrusion-height': ['get', 'height_m'],
    'fill-extrusion-base': 0,
    'fill-extrusion-opacity': 1,
  } satisfies maplibregl.FillExtrusionLayerSpecification['paint'];
  map.addLayer({ id: BUILDINGS_LAYER, type: 'fill-extrusion', source: BUILDINGS_SOURCE, 'source-layer': 'buildings', minzoom: BUILDINGS_MIN_ZOOM, paint }, before);
  // Stepped towers and spires of the curated landmarks, drawn over their building's body.
  map.addLayer({ id: PARTS_LAYER, type: 'fill-extrusion', source: BUILDINGS_SOURCE, 'source-layer': 'landmark_parts', minzoom: BUILDINGS_MIN_ZOOM, paint }, before);
  // Buildings inferred for empty ground (docs/infill.md): real structures seen in the LiDAR, and standard frontage plots.
  map.addLayer(
    {
      id: INFERRED_LAYER,
      type: 'fill-extrusion',
      source: BUILDINGS_SOURCE,
      'source-layer': 'inferred_buildings',
      minzoom: BUILDINGS_MIN_ZOOM,
      paint: { ...paint, 'fill-extrusion-color': dark ? INFERRED_COLOUR.dark : INFERRED_COLOUR.light },
    },
    before,
  );
}
