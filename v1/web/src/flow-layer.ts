// The cell model (engine/ctm.mjs) on the map, as an alternative to the simulated cars: every road tinted by how fast its traffic is
// moving and how full it is, with dots carried along at that speed (flow-dots.ts). Switched on with `?flow` in the page address; the
// simulated cars are hidden while it is on. Runs on the main thread: the model costs well under a millisecond per frame.
// A modelled ESTIMATE of flow: capacities and background traffic are placeholders, and the dots draw it, they are not vehicles.
import * as maplibregl from 'maplibre-gl';
import { carColours, type CarData } from './cars';
import { Car3dLayer } from './car3d';
import { FLOATS_PER_CAR } from './cars-protocol';
import { CellModel } from './engine/ctm.mjs';
import { FlowDemand } from './flow-demand';
import { FLOW_COLOURS, FlowDots, flowDotColours, roadLevels } from './flow-dots';
import type { TripRates, TripVenue } from './trips';

export const FLOW_SOURCE = 'flow-roads';
export const FLOW_ROADS_LAYER = 'flow-roads-layer';
export const FLOW_CARS_LAYER = 'flow-dots-3d';
const STEP_SECONDS = 2; // model step, which also sets the cell length
const MAX_STEPS_PER_FRAME = 30; // the model is cheap, but never let a slow frame spiral
const ROAD_UPDATE_MS = 500;
const DOT_VEHICLES = 2; // real vehicles one dot stands for: finer than a simulated car, so a thin flow still reads as traffic
const CHANGE = 0.03; // a road's colour is only rewritten when its level or load has moved this much

export interface FlowStats {
  /** Real vehicles on the roads, their mean speed, the share in congested stretches, and those waiting outside a gateway for room. */
  vehicles: number;
  speedKmh: number;
  congestedShare: number;
  waiting: number;
  dots: number;
}

export class FlowSimulation {
  onStats: ((stats: FlowStats | null) => void) | null = null;
  private model: CellModel | null = null;
  private demand: FlowDemand | null = null;
  private dots: FlowDots | null = null;
  private map: maplibregl.Map | null = null;
  private layer: Car3dLayer | null = null;
  private visible = true;
  private speed = 20;
  private fraction = 1;
  private closed: number[] = [];
  private venues: TripVenue[] = [];
  private rates: TripRates | null = null;
  private raf = 0;
  private last = 0;
  private carry = 0;
  private lastRoads = 0;
  private shown: { level: Float32Array; load: Float32Array } | null = null;
  private readonly hud: HTMLElement | null;
  private readonly dotScale: number;

  constructor(private readonly data: CarData, private readonly options: { scale: number; dotScale?: number }) {
    this.dotScale = options.dotScale ?? DOT_VEHICLES;
    this.hud = typeof document === 'undefined' ? null : document.createElement('div');
    if (this.hud) {
      this.hud.id = 'flow-hud';
      this.hud.setAttribute('role', 'status');
      this.hud.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:5;max-width:min(30rem,calc(100vw - 24px));padding:6px 10px;border-radius:6px;font:12px/1.4 system-ui,sans-serif;background:rgba(20,24,32,.82);color:#f2f4f8;pointer-events:none';
      this.hud.hidden = true;
      document.body.append(this.hud);
    }
  }

  /** Adds the road tint and the dots to the map's current style. Call on every 'style.load', after the car layers. */
  install(map: maplibregl.Map, dark: boolean): void {
    this.map = map;
    this.shown = null; // a new style has no feature state: write every road again
    const features = this.data.edges.map((e, id) => ({ type: 'Feature' as const, properties: { id }, geometry: { type: 'LineString' as const, coordinates: pairs(e[8] as number[]) } }));
    map.addSource(FLOW_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features }, promoteId: 'id' });
    const level: maplibregl.ExpressionSpecification = ['coalesce', ['feature-state', 'level'], 0];
    const load: maplibregl.ExpressionSpecification = ['coalesce', ['feature-state', 'load'], 0];
    map.addLayer({
      id: FLOW_ROADS_LAYER,
      type: 'line',
      source: FLOW_SOURCE,
      layout: { visibility: this.visible ? 'visible' : 'none', 'line-cap': 'round' },
      paint: {
        'line-color': ['interpolate', ['linear'], level, 0, FLOW_COLOURS[0]!, 0.35, FLOW_COLOURS[1]!, 0.7, FLOW_COLOURS[2]!],
        'line-opacity': ['interpolate', ['linear'], load, 0, dark ? 0.22 : 0.3, 0.08, 0.75, 0.3, 0.95],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 1.8, 17, 5, 19, 9],
        'line-offset': ['interpolate', ['linear'], ['zoom'], 11, -0.3, 14, -1, 17, -2.6, 19, -4.5], // drive on the left, so the two directions show apart
      },
    });
    this.layer = new Car3dLayer(() => undefined, FLOW_CARS_LAYER);
    this.layer.setColours(flowDotColours(carColours(dark).neutral!));
    this.layer.setVisible(this.visible);
    map.addLayer(this.layer);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layer?.setVisible(visible);
    if (this.map?.getLayer(FLOW_ROADS_LAYER)) this.map.setLayoutProperty(FLOW_ROADS_LAYER, 'visibility', visible ? 'visible' : 'none');
    if (this.hud) this.hud.hidden = !visible;
    if (visible && this.model) this.run();
    if (!visible) this.onStats?.(null);
  }

  /** Simulated seconds per real second. */
  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** Cars on the road as a multiple of today's (the hour's share of the day times the demand slider): scales the background traffic. */
  setDemand(fraction: number): void {
    this.fraction = fraction;
    this.demand?.setDemand(fraction);
  }

  setClosedEdges(edges: readonly number[]): void {
    const model = this.model;
    if (model && this.closed.length) model.setClosed(this.closed, false);
    this.closed = [...edges];
    if (model && this.closed.length) model.setClosed(this.closed, true);
  }

  /** The venues cars can be sent to. Set before `start`: the destinations are fixed when the model is built. */
  setTripVenues(venues: readonly TripVenue[]): void {
    this.venues = [...venues];
  }

  setTripRates(rates: TripRates | null): void {
    this.rates = rates;
    this.demand?.setRates(rates);
  }

  start(): void {
    if (!this.model) this.build();
    this.run();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private build(): void {
    const model = new CellModel(this.data, { dt: STEP_SECONDS, seed: this.data.sim?.seed ?? 1 });
    this.model = model;
    this.demand = new FlowDemand(model, this.venues, this.data.classes, { scale: this.options.scale });
    model.setAdaptive(true); // drivers steer round queues
    this.dots = new FlowDots(model, this.data, this.dotScale);
    if (this.closed.length) model.setClosed(this.closed, true);
    this.demand.setDemand(this.fraction);
    this.demand.setRates(this.rates);
  }

  private run(): void {
    if (this.raf || !this.visible || !this.model) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const { model, dots } = this;
    if (!this.visible || !model || !dots) return;
    const elapsed = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!document.hidden) {
      this.carry += elapsed * this.speed;
      const steps = Math.min(Math.floor(this.carry / STEP_SECONDS), MAX_STEPS_PER_FRAME);
      this.carry = steps === MAX_STEPS_PER_FRAME ? 0 : this.carry - steps * STEP_SECONDS;
      for (let k = 0; k < steps; k++) model.step();
      if (steps) dots.advance(steps * STEP_SECONDS);
      this.layer?.setFrame(dots.frame());
      if (now - this.lastRoads >= ROAD_UPDATE_MS) {
        this.lastRoads = now;
        this.tintRoads(model);
        this.report(model, dots);
      }
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private tintRoads(model: CellModel): void {
    const map = this.map;
    if (!map?.getSource(FLOW_SOURCE)) return;
    const now = roadLevels(model), before = this.shown;
    for (let e = 0; e < model.E; e++) {
      if (before && Math.abs((before.level[e] as number) - (now.level[e] as number)) < CHANGE && Math.abs((before.load[e] as number) - (now.load[e] as number)) < CHANGE) continue;
      map.setFeatureState({ source: FLOW_SOURCE, id: e }, { level: now.level[e], load: now.load[e] });
      if (before) {
        before.level[e] = now.level[e] as number;
        before.load[e] = now.load[e] as number;
      }
    }
    this.shown ??= now;
  }

  private report(model: CellModel, dots: FlowDots): void {
    const s = model.stats();
    const stats: FlowStats = { vehicles: s.vehicles, speedKmh: s.averageSpeedMps * 3.6, congestedShare: s.congestedShare, waiting: s.waiting, dots: dots.frame().length / FLOATS_PER_CAR };
    this.onStats?.(stats);
    if (this.hud) {
      this.hud.textContent = `Flow model (experimental, modelled) · ${Math.round(stats.vehicles)} vehicles · mean ${stats.speedKmh.toFixed(0)} km/h · ${Math.round(stats.congestedShare * 100)}% in queues${stats.waiting >= 1 ? ` · ${Math.round(stats.waiting)} waiting to enter` : ''}. Dots draw the flow; one dot is about ${this.dotScale} vehicles.`;
    }
  }
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < flat.length; k += 2) out.push([flat[k] as number, flat[k + 1] as number]);
  return out;
}
