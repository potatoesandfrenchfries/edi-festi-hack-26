// The headline layer: buildings shaded by the festival's modelled surge, the extra people the festivals put in each building at an hour of
// a date. Two sources, both from ticket and register data (demand.ts): audiences inside venues, and extra guests in the beds of hotels,
// halls and licensed short-term lets. Hubs and the Esplanade have no footprint, so their crowds are drawn as discs. Estimates, not counts.
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import { BUILDINGS_LAYER, buildingColour } from './buildings';
import { festivalGuestsIn, occupancyOn, presentAt, type Accommodation, type Demand } from './demand';

export const CROWD_SOURCE = 'festival-crowds';
export const CROWD_LAYER = 'festival-crowds-disc';

/** Surge people per building where each colour step starts. Below the first, a building keeps its ordinary colour. */
export const SURGE_BREAKS = [1, 10, 30, 100, 300, 1000, 3000] as const;
/** Cream for no surge, then a sequential ramp from pale yellow to deep plum. Lightness falls steadily, so it also reads without colour. */
export const SURGE_COLOURS = {
  light: ['#fbe7a1', '#f6c453', '#ee8f35', '#d9532e', '#a8262f', '#74195f', '#3f0f5c'],
  dark: ['#fff1b8', '#ffd36b', '#ff9f4a', '#ff6a4a', '#ff4d6d', '#d84fd0', '#a78bff'],
} as const;

export interface Crowd {
  type: 'Feature';
  properties: { key: string; name: string; p: number };
  geometry: { type: 'Point'; coordinates: [number, number] };
}
export interface CrowdCollection {
  type: 'FeatureCollection';
  features: Crowd[];
}

export interface SurgeState {
  date: string;
  hour: number;
}

/** Extra guests per bed at an hour: occupancy above the base level, times the share of guests in the building then. */
export function guestsPerBed(acc: Accommodation | null, demand: Demand, state: SurgeState): number {
  if (!acc) return 0;
  const beds = Object.values(acc.pilot_beds).reduce((sum, n) => sum + n, 0);
  return beds > 0 ? festivalGuestsIn(acc, demand, state.date, state.hour) / beds : 0;
}

/** Surge people in one building: extra guests in its beds plus its audience if it is a venue. Pure, and the same sum as the expression. */
export function surgeFor(props: { beds?: number; venue?: string }, acc: Accommodation | null, demand: Demand, state: SurgeState): { guests: number; audience: number } {
  const venue = props.venue ? demand.venues[props.venue] : undefined;
  return {
    guests: (props.beds ?? 0) * guestsPerBed(acc, demand, state),
    audience: venue ? presentAt(demand, venue, state.date, state.hour) : 0,
  };
}

/** The same sum as a MapLibre expression, with only the chosen date and hour inlined. */
export function surgeExpression(acc: Accommodation | null, demand: Demand, state: SurgeState): ExpressionSpecification {
  const perBed = guestsPerBed(acc, demand, state);
  const match: unknown[] = ['match', ['get', 'venue']];
  let venues = 0;
  for (const [key, venue] of Object.entries(demand.venues)) {
    if (venue.kind !== 'building') continue;
    const present = presentAt(demand, venue, state.date, state.hour);
    if (present < 1) continue;
    match.push(key, Math.round(present));
    venues++;
  }
  match.push(0);
  const audience = venues > 0 ? (match as ExpressionSpecification) : 0;
  return ['+', ['*', ['coalesce', ['get', 'beds'], 0], perBed], audience] as ExpressionSpecification;
}

/** Fill colour for a surge expression: the ordinary building colour (venues purple, public mint) until the surge reaches the first step. */
export function surgeFill(dark: boolean, surge: ExpressionSpecification): ExpressionSpecification {
  const colours = SURGE_COLOURS[dark ? 'dark' : 'light'];
  const step: unknown[] = ['step', surge, buildingColour(dark)];
  SURGE_BREAKS.forEach((limit, i) => step.push(limit, colours[i]));
  return step as ExpressionSpecification;
}

/** Discs for the crowds that have no footprint: Fringe hubs and the Esplanade. `p` is the people there in the hour. */
export function crowdFeatures(demand: Demand, state: SurgeState): CrowdCollection {
  const features: Crowd[] = [];
  for (const [key, venue] of Object.entries(demand.venues)) {
    if (venue.kind === 'building') continue;
    const p = Math.round(presentAt(demand, venue, state.date, state.hour));
    if (p < 1) continue;
    features.push({ type: 'Feature', properties: { key, name: venue.name, p }, geometry: { type: 'Point', coordinates: [venue.lon, venue.lat] } });
  }
  return { type: 'FeatureCollection', features };
}

export class FestivalLayer {
  private map: maplibregl.Map | null = null;
  private dark = false;
  private state: SurgeState | null = null;
  private visible = true;

  constructor(
    private readonly demand: Demand,
    private readonly accommodation: Accommodation | null,
  ) {}

  /** Adds the crowd discs to the map's current style (after the building layers, so discs sit above them). Call on every 'style.load'. */
  install(map: maplibregl.Map, dark: boolean): void {
    this.map = map;
    this.dark = dark;
    map.addSource(CROWD_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const radius = (scale: number) => ['*', ['sqrt', ['get', 'p']], scale];
    map.addLayer({
      id: CROWD_LAYER,
      type: 'circle',
      source: CROWD_SOURCE,
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, radius(0.12), 17, radius(0.55)] as unknown as ExpressionSpecification,
        'circle-color': dark ? '#c9a2ff' : '#7b2fbe',
        'circle-opacity': 0.4,
        'circle-stroke-color': dark ? '#e6d4ff' : '#4b1c7a',
        'circle-stroke-width': 1,
        'circle-pitch-alignment': 'map',
      },
    });
    if (this.state) this.apply();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.apply();
  }

  /** Repaints for a date and hour. Cheap enough to call on every slider step. */
  update(state: SurgeState, dark: boolean): void {
    this.state = state;
    this.dark = dark;
    this.apply();
  }

  /** The surge, summed over the pilot area, for the headline. */
  headline(): { guests: number; audience: number; occupancy: number } | null {
    if (!this.state || !this.accommodation) return null;
    const { date, hour } = this.state;
    const beds = Object.values(this.accommodation.pilot_beds).reduce((sum, n) => sum + n, 0);
    const audience = Object.values(this.demand.venues).reduce((sum, v) => sum + presentAt(this.demand, v, date, hour), 0);
    return { guests: beds * guestsPerBed(this.accommodation, this.demand, this.state), audience, occupancy: occupancyOn(this.accommodation, this.demand, date) };
  }

  private apply(): void {
    const map = this.map;
    if (!map || !this.state || !map.getLayer(BUILDINGS_LAYER)) return;
    const fill = this.visible ? surgeFill(this.dark, surgeExpression(this.accommodation, this.demand, this.state)) : buildingColour(this.dark);
    map.setPaintProperty(BUILDINGS_LAYER, 'fill-extrusion-color', fill); // tower parts and inferred buildings carry no beds or venue, so they keep their colour
    if (map.getLayer(CROWD_LAYER)) map.setLayoutProperty(CROWD_LAYER, 'visibility', this.visible ? 'visible' : 'none');
    map.getSource<maplibregl.GeoJSONSource>(CROWD_SOURCE)?.setData(crowdFeatures(this.demand, this.state));
  }
}
