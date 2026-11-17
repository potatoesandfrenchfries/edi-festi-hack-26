// Traffic signals on the map: a dot at each signalised approach's stop line, coloured by its state in the car engine. The engine runs a fixed
// 90-second cycle with two alternating phases at every OpenStreetMap signal, so the colours are a MODELLED cycle, not real timings. Drawn
// under the cars, from a zoom where a junction is big enough to read. The positions are fixed for the run (the worker sends them once);
// the states arrive with every car frame and are pushed to the map only when they change.
import * as maplibregl from 'maplibre-gl';

export const SIGNALS_SOURCE = 'signals';
export const SIGNALS_LAYER = 'signals-layer';
export const SIGNAL_GREEN = 0;
export const SIGNAL_AMBER = 1;
export const SIGNAL_RED = 2;
/** Dots are drawn from this zoom; below it a junction is a few pixels and the dots would be noise. */
export const SIGNALS_MIN_ZOOM = 14;
/** Most often the map data is replaced, in milliseconds. At 60x the lights change every second or so; the cars' own frames are no faster. */
export const MIN_PUSH_MS = 200;
/** Red is larger and darker than green so the stop state also shows without colour: a colour-blind viewer can still tell the two apart by size. */
export const SIGNAL_COLOURS = {
  light: { green: '#06a77d', amber: '#f2a900', red: '#c1121f', ring: '#ffffff' },
  dark: { green: '#3ddc97', amber: '#ffd23f', red: '#ff5964', ring: '#0b0e14' },
} as const;

type GeoData = Parameters<maplibregl.GeoJSONSource['setData']>[0];
const EMPTY: GeoData = { type: 'FeatureCollection', features: [] };

/** One point per approach, with its state (`s`: 0 green, 1 amber, 2 red). `positions` is [longitude, latitude, ...]. */
export function signalFeatures(positions: Float64Array, states: Uint8Array): GeoData {
  const n = Math.min(states.length, Math.floor(positions.length / 2));
  const features: { type: 'Feature'; properties: { s: number }; geometry: { type: 'Point'; coordinates: [number, number] } }[] = [];
  for (let k = 0; k < n; k++) {
    features.push({ type: 'Feature', properties: { s: states[k] as number }, geometry: { type: 'Point', coordinates: [positions[2 * k] as number, positions[2 * k + 1] as number] } });
  }
  return { type: 'FeatureCollection', features };
}

const sameStates = (a: Uint8Array | null, b: Uint8Array): boolean => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

export class SignalLayer {
  private map: maplibregl.Map | null = null;
  private positions: Float64Array | null = null;
  private states: Uint8Array | null = null;
  /** The states the map was last given, so an unchanged frame costs nothing. */
  private shown: Uint8Array | null = null;
  private visible = true;
  private lastPush = -Infinity;

  /** Adds the source and layer to the map's current style, with the latest signals drawn at once. Call on every 'style.load', before the cars. */
  install(map: maplibregl.Map, dark: boolean): void {
    this.map = map;
    this.shown = null;
    const c = SIGNAL_COLOURS[dark ? 'dark' : 'light'];
    const size = (red: number, amber: number, green: number) => ['match', ['get', 's'], SIGNAL_RED, red, SIGNAL_AMBER, amber, green] as unknown as maplibregl.ExpressionSpecification;
    map.addSource(SIGNALS_SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: SIGNALS_LAYER,
      type: 'circle',
      source: SIGNALS_SOURCE,
      minzoom: SIGNALS_MIN_ZOOM,
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: {
        'circle-color': ['match', ['get', 's'], SIGNAL_RED, c.red, SIGNAL_AMBER, c.amber, c.green] as unknown as maplibregl.ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], SIGNALS_MIN_ZOOM, size(2.8, 2.4, 2), 16, size(4.6, 4, 3.4), 18, size(7.5, 6.5, 5.5)],
        'circle-stroke-color': c.ring,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], SIGNALS_MIN_ZOOM, 0.6, 17, 1.2],
        'circle-pitch-alignment': 'map',
      },
    });
    this.push(true);
  }

  /** Where the stop lines are (from the worker's 'ready' message). */
  setPositions(positions: Float64Array | undefined): void {
    if (!positions) return;
    this.positions = positions;
    this.shown = null;
    this.push(true);
  }

  /** The states of the approaches, in the order of the positions. Cheap to call for every frame. */
  setStates(states: Uint8Array | undefined): void {
    if (!states) return;
    this.states = states;
    this.push(false);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.map?.getLayer(SIGNALS_LAYER)) this.map.setLayoutProperty(SIGNALS_LAYER, 'visibility', visible ? 'visible' : 'none');
  }

  private push(force: boolean): void {
    const source = this.map?.getSource<maplibregl.GeoJSONSource>(SIGNALS_SOURCE);
    if (!source || !this.positions || !this.states) return;
    if (!force && (sameStates(this.shown, this.states) || performance.now() - this.lastPush < MIN_PUSH_MS)) return;
    this.lastPush = performance.now();
    this.shown = Uint8Array.from(this.states);
    source.setData(signalFeatures(this.positions, this.states));
  }
}
