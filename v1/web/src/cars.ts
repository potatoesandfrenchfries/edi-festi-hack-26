// Simulated cars: the car engine (engine) running in a worker on the Edinburgh road graph from `make cars`.
// NOT real traffic: cars are placed by road class and lane-kilometres (no traffic counts), then drive, queue at signals and
// merge on their own. Switching the layer off stops the worker's simulation.
import * as maplibregl from 'maplibre-gl';
import { Car3dLayer } from './car3d';
import { FLOATS_PER_CAR, type CarStatsMessage, type FromWorker, type ToWorker } from './cars-protocol';
import type { TripRates, TripVenue } from './trips';
import type { Roads } from './engine/car-sim.mjs';
import { COLOURS, PERSONALITIES } from './engine/personality.mjs';

export const CARS_PATH = 'data/roads.json';
export const CARS_SOURCE = 'cars';
export const CARS_LAYER = 'cars-layer';
/** Cars cost more per simulated second than buses (a step is about 0.3 ms), so they run at most this fast however fast the buses are set. */
export const MAX_CAR_SPEED = 60;
export const DEFAULT_POPULATION = 1500;
/** Car slots kept for festival trips, on top of the background traffic. */
export const TRIP_SLOTS = 1200;
/** Most cars that can be asked for, as a multiple of the population: the car demand slider's top value, with room to spare. */
export const MAX_DEMAND = 1.6;
const SEED = 2026;

export interface CarData extends Roads {
  /** Written by pipeline/stage08_roads.py: how many cars fit and how many to run. */
  sim?: { area: string; capacity: number; population: number; seed: number };
}

export async function loadCarData(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<CarData | null> {
  try {
    const response = await fetchFn(new URL(CARS_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as CarData;
    return Array.isArray(data.edges) && data.edges.length > 0 && typeof data.nodes === 'number' ? data : null;
  } catch {
    return null;
  }
}

/** Personality colours, with the near-black neutral car lightened on a dark map so it can be seen. */
export function carColours(dark: boolean): Record<string, string> {
  return { ...COLOURS, neutral: dark ? '#cfd4dc' : (COLOURS.neutral ?? '#1f1f1f') };
}

const MAX_JUMP_DEG = 0.003; // a car that moved further than this between frames was reseeded or wrapped: show it, do not slide it

/** Positions part-way (0..1) between two frames of the same cars. Bearing turns the short way round. */
export function lerpFrame(from: Float32Array, to: Float32Array, t: number): Float32Array {
  if (from.length !== to.length) return to;
  const out = new Float32Array(to.length);
  for (let i = 0; i < to.length; i += FLOATS_PER_CAR) {
    const [lon0, lat0, bearing0] = [from[i] as number, from[i + 1] as number, from[i + 2] as number];
    const [lon1, lat1, bearing1] = [to[i] as number, to[i + 1] as number, to[i + 2] as number];
    const jumped = Math.abs(lon1 - lon0) > MAX_JUMP_DEG || Math.abs(lat1 - lat0) > MAX_JUMP_DEG;
    const k = jumped ? 1 : t;
    const turn = ((bearing1 - bearing0 + 540) % 360) - 180;
    out[i] = lon0 + (lon1 - lon0) * k;
    out[i + 1] = lat0 + (lat1 - lat0) * k;
    out[i + 2] = (bearing0 + turn * k + 360) % 360;
    out[i + 3] = to[i + 3] as number;
    out[i + 4] = to[i + 4] as number;
  }
  return out;
}

type GeoData = Parameters<maplibregl.GeoJSONSource['setData']>[0];

export function carFeatures(frame: Float32Array): GeoData {
  const features: { type: 'Feature'; properties: { kind: number; speed: number }; geometry: { type: 'Point'; coordinates: [number, number] } }[] = [];
  for (let i = 0; i < frame.length; i += FLOATS_PER_CAR) {
    features.push({
      type: 'Feature',
      properties: { kind: frame[i + 4] as number, speed: Math.round((frame[i + 3] as number) * 3.6) },
      geometry: { type: 'Point', coordinates: [frame[i] as number, frame[i + 1] as number] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export interface CarWorker {
  postMessage(message: ToWorker): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  terminate(): void;
}
const defaultWorker = (): CarWorker => new Worker(new URL('./cars.worker.ts', import.meta.url), { type: 'module' });

export class CarSimulation {
  /** Called about once a second with the worker's figures, and with null if the cars are stopped or failed. */
  onStats: ((stats: (CarStatsMessage & { requestedSpeed: number }) | null) => void) | null = null;
  private worker: CarWorker | null = null;
  private map: maplibregl.Map | null = null;
  private visible = true;
  private armed = false;
  private speed = 20;
  private demand = 1;
  private raf = 0;
  private previous: Float32Array | null = null;
  private current: Float32Array | null = null;
  private previousAt = 0;
  private currentAt = 0;
  private lastDraw = 0;
  private failed = false;
  private busStates: Float32Array | null = null;
  private closedEdges: number[] = [];
  private tripVenues: TripVenue[] = [];
  private tripRates: TripRates | null = null;
  private layer3d: Car3dLayer | null = null;
  /** True if the 3D models could not be set up: the dots are then drawn instead. */
  private dotsOnly = false;

  constructor(
    private readonly data: CarData,
    /** Minimum milliseconds between frames and redraws: ~100 normally, slow for reduced motion. */
    private frameMs = 100,
    private readonly createWorker: () => CarWorker = defaultWorker,
  ) {}

  /** Adds the cars source and layer to the map's current style. Call on every 'style.load', before the bus layers so cars sit under them. */
  install(map: maplibregl.Map, dark: boolean): void {
    this.map = map;
    const colours = carColours(dark);
    map.addSource(CARS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: CARS_LAYER,
      type: 'circle',
      source: CARS_SOURCE,
      minzoom: 11.5,
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: {
        'circle-color': ['match', ['get', 'kind'], ...PERSONALITIES.flatMap((name, i) => [i, colours[name] ?? '#1f1f1f']), '#1f1f1f'] as unknown as maplibregl.ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 0.8, 14, 1.7, 16, 3, 18, 6],
        // The 3D cars draw the traffic; these dots are invisible and stand in only if the models cannot start.
        'circle-opacity': this.dotsOnly ? 0.9 : 0,
        'circle-stroke-color': dark ? '#0b0e14' : '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 15, 0.6],
      },
    });
    this.layer3d = new Car3dLayer(() => this.useDotsOnly());
    this.layer3d.setColours(PERSONALITIES.map((name) => colours[name] ?? '#1f1f1f'));
    this.layer3d.setVisible(this.visible);
    map.addLayer(this.layer3d);
    this.redraw();
  }

  private useDotsOnly(): void {
    this.dotsOnly = true;
    if (this.map?.getLayer(CARS_LAYER)) this.map.setPaintProperty(CARS_LAYER, 'circle-opacity', 0.9);
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** The newest frame from the worker: FLOATS_PER_CAR numbers per car. */
  latestFrame(): Float32Array | null {
    return this.current;
  }

  /** Tells the car worker where the buses are (see coupling.ts), or null to clear their effect on the roads. */
  setBusStates(data: Float32Array | null): void {
    this.busStates = data;
    this.worker?.postMessage({ type: 'buses', data });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layer3d?.setVisible(visible);
    if (this.map?.getLayer(CARS_LAYER)) this.map.setLayoutProperty(CARS_LAYER, 'visibility', visible ? 'visible' : 'none');
    if (visible && this.armed) this.start();
    else this.sendRun();
    if (!visible) this.onStats?.(null);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.sendRun();
  }

  /** The roads closed to vehicles now (edge indexes in the road graph; an empty list reopens everything). */
  setClosedEdges(edges: readonly number[]): void {
    this.closedEdges = [...edges];
    this.worker?.postMessage({ type: 'closed', edges: this.closedEdges });
  }

  /** The venues cars can be sent to. Set before `start`: the worker keeps car slots for the trips when it is created. */
  setTripVenues(venues: readonly TripVenue[]): void {
    this.tripVenues = [...venues];
  }

  /** How many festival cars to start per simulated second at each venue (the order of `setTripVenues`). Null stops the trips. */
  setTripRates(rates: TripRates | null): void {
    this.tripRates = rates;
    if (rates) this.worker?.postMessage({ type: 'trips', rates });
  }

  /** Cars on the road as a multiple of the population `make cars` chose (the hour's share of the day times the demand slider). */
  setDemand(fraction: number): void {
    this.demand = Math.min(Math.max(fraction, 0), MAX_DEMAND);
    this.worker?.postMessage({ type: 'demand', fraction: this.demand });
  }

  setFrameInterval(ms: number): void {
    this.frameMs = ms;
    this.sendRun();
  }

  /** Starts the simulation (idempotent). Kept apart from `install` for the same reason as the buses: wait for the page to go idle first. */
  start(): void {
    this.armed = true;
    if (!this.visible || this.failed) return;
    if (!this.worker) this.spawn();
    this.sendRun();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private spawn(): void {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.receive(event.data);
    worker.postMessage({ type: 'init', roads: this.data, population: this.data.sim?.population ?? DEFAULT_POPULATION, seed: this.data.sim?.seed ?? SEED, maxDemand: MAX_DEMAND, venues: this.tripVenues, tripSlots: TRIP_SLOTS });
    if (this.demand !== 1) worker.postMessage({ type: 'demand', fraction: this.demand });
    if (this.busStates) worker.postMessage({ type: 'buses', data: this.busStates });
    if (this.closedEdges.length) worker.postMessage({ type: 'closed', edges: this.closedEdges });
    if (this.tripRates) worker.postMessage({ type: 'trips', rates: this.tripRates });
  }

  private receive(message: FromWorker): void {
    if (message.type === 'frame') {
      this.previous = this.current;
      this.previousAt = this.currentAt;
      this.current = message.data;
      this.currentAt = performance.now();
    } else if (message.type === 'stats') {
      this.onStats?.({ ...message, requestedSpeed: Math.min(this.speed, MAX_CAR_SPEED) });
    } else if (message.type === 'error') {
      this.failed = true;
      this.stop();
      this.onStats?.(null);
    }
  }

  private sendRun(): void {
    this.worker?.postMessage({ type: 'run', speed: Math.min(this.speed, MAX_CAR_SPEED), running: this.visible, frameMs: this.frameMs });
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (!this.visible || !this.worker) return;
    if (now - this.lastDraw >= this.frameMs / 2 && !document.hidden) {
      this.lastDraw = now;
      this.redraw(now);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Draws the cars part-way between the last two frames, so they glide rather than step. Shows one frame interval behind the worker. */
  private redraw(now = performance.now()): void {
    const source = this.map?.getSource<maplibregl.GeoJSONSource>(CARS_SOURCE);
    if (!source || !this.current) return;
    const interval = Math.max(this.currentAt - this.previousAt, 1);
    const t = this.previous ? Math.min(1, Math.max(0, (now - this.currentAt) / interval)) : 1;
    const frame = this.previous ? lerpFrame(this.previous, this.current, t) : this.current;
    this.layer3d?.setFrame(frame);
    source.setData(carFeatures(frame));
  }
}
