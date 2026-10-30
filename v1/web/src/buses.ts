// Simulated Lothian buses. NOT live positions: every route has one path per direction and a regular headway, and its buses
// loop end to end and back forever at the running times of the published timetable (see ../../../lothian/README.md).
// The data comes from `make buses`. Nothing here needs a key or a clock.
import * as maplibregl from 'maplibre-gl';
import { Bus3dLayer, type BusMarker } from './bus3d';
import { BusTraffic, type BusRates, type CarCell, type TrafficStats } from './traffic';
import type { PopupContent } from './popup';

export const BUSES_PATH = 'data/lothian.json';
export const BUSES_SOURCE = 'buses';
export const BUSES_LAYER = 'buses-layer';
export const BUS_ROUTE_SOURCE = 'bus-route';
export const BUS_ROUTE_LAYER = 'bus-route-line';
export const BUS_CONGESTION_SOURCE = 'bus-congestion';
export const BUS_CONGESTION_LAYER = 'bus-congestion-glow';

export const BUS_SPEEDS = [1, 5, 20, 60, 200] as const;
export type BusSpeed = (typeof BUS_SPEEDS)[number];
export const DEFAULT_BUS_SPEED: BusSpeed = 20;

/**
 * Operator colours, with a halo that follows the theme so the dots read on both basemaps. Chosen to stay apart from each other and from the
 * viridis building scale under deuteranopia, protanopia and tritanopia (simulated, Machado 2009; worst-case CIELAB distance about 17).
 */
export const BUS_COLOURS = { LOTH: '#D55E00', NELB: '#E69F00', ECBU: '#00D5FF' } as const;
export type Agency = keyof typeof BUS_COLOURS;

export interface BusLeg {
  shape: number;
  stops: number[];
  /** Metres along the shape of each stop. */
  dists: number[];
  /** Arrival and departure seconds of each stop, interleaved, relative to the start of the leg. */
  times: number[];
  headsign: string;
}
export interface BusRoute {
  name: string;
  agency: Agency;
  /** Seconds between buses. */
  headway: number;
  legs: BusLeg[];
}
export interface BusData {
  meta: { feedVersion: string; typicalDay: string; coordScale: number; layover: number; source: string };
  routes: BusRoute[];
  stops: [number, number, string][];
  /** Delta-encoded 1e-5 degree integers: x0, y0, dx1, dy1, ... */
  shapes: number[][];
}

const LAT_REF = 55.95;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((LAT_REF * Math.PI) / 180); // keep in step with lothian/build.py
const ACCEL_S = 12; // seconds a bus takes to pull away from or roll into a stop, at most

// Typed-array reads are `number | undefined` under noUncheckedIndexedAccess; the callers below stay in range.
const at = (a: ArrayLike<number>, i: number) => a[i] as number;

export interface Shape {
  lon: Float64Array;
  lat: Float64Array;
  cum: Float64Array;
}

export function decodeShape(flat: readonly number[], scale: number): Shape {
  const n = flat.length / 2;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const cum = new Float64Array(n);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += at(flat, 2 * i);
    y += at(flat, 2 * i + 1);
    lon[i] = x / scale;
    lat[i] = y / scale;
    if (i > 0) cum[i] = at(cum, i - 1) + Math.hypot((at(lon, i) - at(lon, i - 1)) * M_PER_DEG_LON, (at(lat, i) - at(lat, i - 1)) * M_PER_DEG_LAT);
  }
  return { lon, lat, cum };
}

export interface RouteLoop extends BusRoute {
  index: number;
  durations: number[];
  /** Seconds for one round trip, layovers included. */
  cycle: number;
  count: number;
  spacing: number;
  offset: number;
}
export interface BusModel {
  data: BusData;
  shapes: Shape[];
  routes: RouteLoop[];
  layover: number;
}

/** Works out each route's loop. `frequency` scales how often buses leave (2 means twice as many buses). */
export function createModel(data: BusData, frequency = 1): BusModel {
  const shapes = data.shapes.map((s) => decodeShape(s, data.meta.coordScale));
  const layover = data.meta.layover;
  const routes = data.routes.map((route, index): RouteLoop => {
    const durations = route.legs.map((l) => at(l.times, l.times.length - 1));
    const cycle = durations.reduce((sum, d) => sum + d + layover, 0);
    const count = Math.max(1, Math.round(cycle / (route.headway / frequency)));
    // A prime stride staggers routes so they do not all start at their termini together.
    // `headway` is what the buses now run at, so a popup shows the scenario rather than the timetable.
    return { ...route, headway: route.headway / frequency, index, durations, cycle, count, spacing: cycle / count, offset: (index * 7919) % cycle };
  });
  return { data, shapes, routes, layover };
}

export const totalBuses = (model: BusModel) => model.routes.reduce((sum, r) => sum + r.count, 0);

/** Fleet-wide driving rates of the plain timetable replay: buses never queue in it, so nothing is delayed or stuck. */
export function timetableRates(model: BusModel): BusRates {
  let metresPerSecond = 0;
  for (const route of model.routes) {
    const metres = route.legs.reduce((sum, leg) => sum + (leg.dists[leg.dists.length - 1] ?? 0), 0);
    metresPerSecond += (route.count * metres) / route.cycle;
  }
  return { buses: totalBuses(model), metresPerSecond, delayBuses: 0, idleBuses: 0 };
}

/**
 * Fraction (0..1) of a stop-to-stop leg covered after fraction `p` of its time. A bus accelerates, cruises, then brakes, so it
 * eases out of one stop and into the next rather than moving at constant speed.
 */
export function legProgress(p: number, legSeconds: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const r = Math.min(0.4, ACCEL_S / Math.max(legSeconds, 1));
  const k = 2 * r * (1 - r);
  if (p < r) return (p * p) / k;
  if (p > 1 - r) return 1 - ((1 - p) * (1 - p)) / k;
  return (p - r / 2) / (1 - r);
}

export interface Point {
  lon: number;
  lat: number;
  /** Degrees clockwise from north. */
  bearing: number;
}

/** Position along a decoded shape at `dist` metres. */
export function pointAt(shape: Shape, dist: number): Point {
  const { cum, lon, lat } = shape;
  const last = cum.length - 1;
  if (last < 1) return { lon: at(lon, 0), lat: at(lat, 0), bearing: 0 };
  const d = Math.max(0, Math.min(at(cum, last), dist));
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(cum, mid) <= d) lo = mid;
    else hi = mid;
  }
  const span = at(cum, hi) - at(cum, lo);
  const f = span > 0 ? (d - at(cum, lo)) / span : 0;
  const dx = (at(lon, hi) - at(lon, lo)) * M_PER_DEG_LON;
  const dy = (at(lat, hi) - at(lat, lo)) * M_PER_DEG_LAT;
  return {
    lon: at(lon, lo) + (at(lon, hi) - at(lon, lo)) * f,
    lat: at(lat, lo) + (at(lat, hi) - at(lat, lo)) * f,
    bearing: (((Math.atan2(dx, dy) * 180) / Math.PI) % 360 + 360) % 360,
  };
}

export interface BusState extends Point {
  /** Index into the route's legs: which direction it is travelling. */
  leg: number;
  atStop: boolean;
  layover: boolean;
  /** Index into `BusData.stops`. */
  nextStop: number;
}
export interface Bus extends BusState {
  id: string;
  route: RouteLoop;
}

/** A bus `rel` seconds into `leg`. */
function legState(model: BusModel, leg: BusLeg, rel: number): Point & { atStop: boolean; nextStop: number } {
  const { times, dists } = leg;
  let lo = 0;
  let hi = dists.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at(times, 2 * mid) <= rel) lo = mid;
    else hi = mid - 1;
  }
  const dep = at(times, 2 * lo + 1);
  let dist = at(dists, lo);
  let atStop = true;
  let next = lo;
  if (rel > dep && lo + 1 < dists.length) {
    const span = Math.max(at(times, 2 * (lo + 1)) - dep, 1e-6);
    dist += (at(dists, lo + 1) - dist) * legProgress((rel - dep) / span, span);
    atStop = false;
    next = lo + 1;
  }
  return { ...pointAt(model.shapes[leg.shape] as Shape, dist), atStop, nextStop: at(leg.stops, next) };
}

/** One route's bus number `k` at simulation time `t` seconds. */
export function busState(model: BusModel, route: RouteLoop, k: number, t: number): BusState {
  const { cycle } = route;
  let phase = (((t + route.offset + k * route.spacing) % cycle) + cycle) % cycle;
  for (let l = 0; l < route.legs.length; l++) {
    const leg = route.legs[l] as BusLeg;
    const run = at(route.durations, l);
    if (phase < run) return { leg: l, layover: false, ...legState(model, leg, phase) };
    phase -= run;
    if (phase < model.layover) return { leg: l, layover: true, ...legState(model, leg, run) };
    phase -= model.layover;
  }
  const last = route.legs.length - 1; // only reached if rounding leaves a sliver at the end of the loop
  return { leg: last, layover: true, ...legState(model, route.legs[last] as BusLeg, at(route.durations, last)) };
}

/** Every bus at time `t`; `only` restricts to routes with that name. */
export function allBuses(model: BusModel, t: number, only: string | null = null): Bus[] {
  const out: Bus[] = [];
  for (const route of model.routes) {
    if (only !== null && route.name !== only) continue;
    for (let k = 0; k < route.count; k++) out.push({ id: `${route.index}:${k}`, route, ...busState(model, route, k, t) });
  }
  return out;
}

const OPERATORS: Record<Agency, string> = { LOTH: 'Lothian Buses', NELB: 'Lothian Country Buses', ECBU: 'East Coast Buses' };

/** Popup text. Only things that stay true as the bus moves: the popup is not redrawn each frame. */
export function describeBus(bus: Bus, data: BusData): PopupContent {
  const headway = Math.round(bus.route.headway / 60);
  return {
    title: `Route ${bus.route.name}`,
    rows: [
      ['Operator', OPERATORS[bus.route.agency]],
      ['Towards', (bus.route.legs[bus.leg] as BusLeg).headsign || 'terminus'],
      ['Frequency', `about every ${headway} min, simulated`],
    ],
    flags: [
      'Simulated position, not a live bus',
      `Frequency taken from a typical weekday (${data.meta.typicalDay}), not the day's timetable`,
    ],
  };
}

/** What `GeoJSONSource.setData` accepts, so this file needs no separate GeoJSON types package. */
type GeoData = Parameters<maplibregl.GeoJSONSource['setData']>[0];
const EMPTY: GeoData = { type: 'FeatureCollection', features: [] };

export function busFeatures(buses: readonly Bus[]): GeoData {
  return {
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature',
      properties: { id: b.id, bearing: b.bearing, layover: b.layover, colour: BUS_COLOURS[b.route.agency] },
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
    })),
  };
}

export function busMarker(b: Bus): BusMarker {
  return { lon: b.lon, lat: b.lat, bearing: b.bearing, colour: BUS_COLOURS[b.route.agency], layover: b.layover };
}

export function legLine(model: BusModel, leg: BusLeg): GeoData {
  const s = model.shapes[leg.shape] as Shape;
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from(s.lon, (lon, i) => [lon, at(s.lat, i)] as [number, number]) } };
}

export async function loadBusData(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<BusData | null> {
  try {
    const response = await fetchFn(new URL(BUSES_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as BusData;
    return Array.isArray(data.routes) && Array.isArray(data.shapes) && data.meta?.layover !== undefined ? data : null;
  } catch {
    return null;
  }
}

/**
 * Runs the simulation and keeps a map layer in step with it. The layer is added again after every style reload with `install`;
 * the simulation clock lives here, so a theme change does not restart it.
 */
export class BusSimulation {
  model: BusModel;
  private frequency = 1;
  private t = 0;
  private speed: BusSpeed = DEFAULT_BUS_SPEED;
  private visible = true;
  private raf = 0;
  /** Set by the first `start()`; until then `setVisible` must not begin animating. */
  private armed = false;
  private last = 0;
  private lastDraw = 0;
  private map: maplibregl.Map | null = null;
  private selected: { id: string; leg: BusLeg } | null = null;
  private layer3d: Bus3dLayer | null = null;
  /** True if the 3D models could not be set up: the dots are then drawn instead. */
  private dotsOnly = false;
  /** Stateful traffic (bunching, queues, shared-street slowdown), or null for the plain timetable replay. */
  private traffic: BusTraffic | null = null;
  private trafficOn = true;
  private lastGlow = 0;

  constructor(
    private readonly data: BusData,
    /** Minimum milliseconds between map updates: ~33 normally, a slow cadence for reduced motion. */
    private drawEveryMs = 33,
  ) {
    this.model = createModel(data);
  }

  /** Adds the source and layers to the map's current style. Call on every 'style.load'. */
  install(map: maplibregl.Map, dark: boolean): void {
    this.map = map;
    map.addSource(BUSES_SOURCE, { type: 'geojson', data: EMPTY });
    map.addSource(BUS_ROUTE_SOURCE, { type: 'geojson', data: EMPTY });
    map.addSource(BUS_CONGESTION_SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: BUS_ROUTE_LAYER,
      type: 'line',
      source: BUS_ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark ? '#ffffff' : '#1f2937', 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 5] },
    });
    // Soft red glow where several buses are crawling together, under the buses.
    map.addLayer({
      id: BUS_CONGESTION_LAYER,
      type: 'circle',
      source: BUS_CONGESTION_SOURCE,
      paint: {
        'circle-color': '#ef4444',
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], ['get', 'intensity'], 0, 0.25, 1, 0.6],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 13, 22, 16, 60, 18, 130],
        'circle-pitch-alignment': 'map',
      },
    });
    // The 3D layer draws the buses. This layer is invisible and only gives clicks and hovers something to hit; if the 3D layer cannot
    // start (see `useDotsOnly`) it becomes the visible dots.
    map.addLayer({
      id: BUSES_LAYER,
      type: 'circle',
      source: BUSES_SOURCE,
      paint: {
        'circle-color': ['get', 'colour'],
        'circle-radius': this.dotRadius(),
        'circle-opacity': this.dotOpacity(),
        'circle-stroke-color': dark ? '#0b0e14' : '#ffffff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': this.dotOpacity(),
      },
    });
    this.layer3d = new Bus3dLayer(() => this.useDotsOnly());
    this.layer3d.setVisible(this.visible);
    map.addLayer(this.layer3d);
    this.applyVisible();
    this.draw();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layer3d?.setVisible(visible);
    this.applyVisible();
    if (visible && this.armed) this.start();
    else if (!visible) this.selectBus(null);
  }
  setSpeed(speed: BusSpeed): void {
    this.speed = speed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  /** Every bus right now (for the cars to react to, see coupling.ts). */
  buses(): readonly Bus[] {
    return this.currentBuses();
  }
  /** The cars summarised per cell, or null to ignore them. Only the stateful traffic reacts; the coupling resends it every second, so a rebuilt fleet picks it up again. */
  setCarPressure(cells: ReadonlyMap<number, CarCell> | null): void {
    this.traffic?.setCarPressure(cells);
  }
  /** Switches the stateful traffic on (starting every bus from where the timetable replay has it now) or off. */
  setTraffic(on: boolean): void {
    if (on === this.trafficOn && (this.traffic !== null) === on) return;
    this.trafficOn = on;
    this.traffic = on ? new BusTraffic(this.model, this.t) : null;
    this.lastGlow = 0;
    if (!on) this.map?.getSource<maplibregl.GeoJSONSource>(BUS_CONGESTION_SOURCE)?.setData(EMPTY);
  }
  /** How often buses run, as a multiple of the timetable (2 is twice as many buses). Rebuilds the fleet from where the replay has it now. */
  setFrequency(frequency: number): void {
    if (!(frequency > 0) || frequency === this.frequency) return;
    this.frequency = frequency;
    this.model = createModel(this.data, frequency);
    this.selectBus(null);
    this.traffic = this.trafficOn ? new BusTraffic(this.model, this.t) : null;
    this.lastGlow = 0;
  }
  /** What the fleet is doing right now, for the congestion costs: distance driven, buses delayed and buses stuck standing. */
  rates(): BusRates {
    return this.traffic?.rates() ?? timetableRates(this.model);
  }
  /** Live figures for the panel, or null when the traffic is off. */
  trafficStats(): TrafficStats | null {
    return this.traffic?.stats() ?? null;
  }
  setDrawInterval(ms: number): void {
    this.drawEveryMs = ms;
  }

  /** The bus with this feature id right now, for the popup. */
  find(id: string): Bus | undefined {
    return this.currentBuses().find((b) => b.id === id);
  }

  /** Highlights the path of the bus's current direction, or clears it with null. */
  selectBus(bus: Bus | null): void {
    const leg = bus ? (bus.route.legs[bus.leg] as BusLeg) : null;
    this.selected = bus && leg ? { id: bus.id, leg } : null;
    const source = this.map?.getSource<maplibregl.GeoJSONSource>(BUS_ROUTE_SOURCE);
    source?.setData(leg ? legLine(this.model, leg) : EMPTY);
  }

  /** Dot opacity: none while the 3D buses are up, dimmed during a layover if they are not. */
  private dotOpacity(): maplibregl.ExpressionSpecification | number {
    return this.dotsOnly ? ['case', ['get', 'layover'], 0.5, 1] : 0;
  }

  /** Visible dots are small; the invisible click target is about the size of a drawn bus. */
  private dotRadius(): maplibregl.ExpressionSpecification {
    return this.dotsOnly
      ? ['interpolate', ['linear'], ['zoom'], 10, 2.5, 13, 3.5, 16, 5.5, 17, 7, 19, 18]
      : ['interpolate', ['linear'], ['zoom'], 9, 9, 15, 11, 17, 9, 18, 20, 19, 33];
  }

  private useDotsOnly(): void {
    this.dotsOnly = true;
    if (!this.map?.getLayer(BUSES_LAYER)) return;
    this.map.setPaintProperty(BUSES_LAYER, 'circle-radius', this.dotRadius());
    this.map.setPaintProperty(BUSES_LAYER, 'circle-opacity', this.dotOpacity());
    this.map.setPaintProperty(BUSES_LAYER, 'circle-stroke-opacity', this.dotOpacity());
  }

  private currentBuses(): Bus[] {
    return this.traffic ? this.traffic.buses() : allBuses(this.model, this.t);
  }

  private applyVisible(): void {
    const map = this.map;
    if (!map) return;
    for (const layer of [BUSES_LAYER, BUS_ROUTE_LAYER, BUS_CONGESTION_LAYER]) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', this.visible ? 'visible' : 'none');
  }

  private draw(): void {
    const source = this.map?.getSource<maplibregl.GeoJSONSource>(BUSES_SOURCE);
    if (!source) return;
    const buses = this.currentBuses();
    source.setData(busFeatures(buses));
    // The congestion cells change slowly, so they are refreshed about once a second rather than every frame.
    if (this.traffic && performance.now() - this.lastGlow > 1000) {
      this.lastGlow = performance.now();
      this.map?.getSource<maplibregl.GeoJSONSource>(BUS_CONGESTION_SOURCE)?.setData(this.traffic.congestionCells());
    }
    this.layer3d?.setMarkers(buses.map(busMarker));
    // A bus that turns round at the terminus continues on the other direction's path.
    if (this.selected) {
      const bus = buses.find((b) => b.id === this.selected?.id);
      const leg = bus?.route.legs[bus.leg];
      if (bus && leg && leg !== this.selected.leg) this.selectBus(bus);
    }
  }

  /**
   * Starts the animation (idempotent). Kept apart from `install` on purpose: a layer that updates every frame stops the map
   * ever going idle, and the page waits for 'idle' to take down its loading overlay. Start after that.
   */
  start(): void {
    this.armed = true;
    if (this.raf || !this.visible) return;
    this.last = performance.now();
    const frame = (now: number) => {
      this.raf = 0;
      if (!this.visible || !this.map) return;
      this.t += Math.min((now - this.last) / 1000, 0.25) * this.speed;
      this.last = now;
      this.traffic?.advanceTo(this.t);
      if (now - this.lastDraw >= this.drawEveryMs && !document.hidden) {
        this.lastDraw = now;
        this.draw();
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
