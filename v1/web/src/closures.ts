// Festival street closures: streets that vehicles may not enter at set times on a typical Fringe day (the council's Summertime Streets
// and Tattoo restrictions, from ../../../closures, written to data/closures.json by `uv run python -m closures.web`). The schedule says
// which OSM ways are closed and when; the car road graph keeps each edge's OSM way id, so the two are joined on it. A closure on a way
// that is not in the graph (pedestrian streets are left out of it) cannot be shown, and `unmatched` says so.
import * as maplibregl from 'maplibre-gl';
import type { DayType } from './presence';
import type { Roads } from './engine/car-sim.mjs';

export const CLOSURES_PATH = 'data/closures.json';
export const CLOSURES_SOURCE = 'closures';
export const CLOSURES_LAYER = 'closures-line';
const CLOSED_COLOUR = '#dc2626';

export interface Closure {
  id: string;
  location: string;
  name: string;
  festival: string;
  type: string;
  /** Seconds since midnight: closed from `from` up to (not including) `to`. */
  from: number;
  to: number;
  /** OSM way ids. */
  ways: number[];
  confidence: 'high' | 'medium' | 'low';
}
export interface ClosureDay {
  date: string;
  closures: Closure[];
  unmapped: { id: string; location: string; reason: string }[];
}
export interface ClosureData {
  source: string;
  built: string;
  days: Record<DayType, ClosureDay>;
}

export async function loadClosures(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<ClosureData | null> {
  try {
    const response = await fetchFn(new URL(CLOSURES_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as ClosureData;
    return data.days?.weekday && data.days.saturday && data.days.sunday ? data : null;
  } catch {
    return null;
  }
}

/** The closures in force at this time of day. */
export function activeAt(day: ClosureDay, clockSeconds: number): Closure[] {
  const t = ((clockSeconds % 86400) + 86400) % 86400;
  return day.closures.filter((c) => c.from <= t && t < c.to);
}

export interface ClosedNow {
  /** Edge indexes in the road graph, ascending. */
  edges: number[];
  /** The closures in force, including any that could not be put on the graph. */
  active: Closure[];
}

type GeoData = Parameters<maplibregl.GeoJSONSource['setData']>[0];
const EMPTY: GeoData = { type: 'FeatureCollection', features: [] };

export class ClosureSchedule {
  private readonly edgesOfWay = new Map<number, number[]>();

  constructor(private readonly data: ClosureData, private readonly roads: Roads) {
    roads.edges.forEach((edge, index) => {
      const way = edge[9] as number;
      const list = this.edgesOfWay.get(way);
      if (list) list.push(index);
      else this.edgesOfWay.set(way, [index]);
    });
  }

  date(day: DayType): string {
    return this.data.days[day].date;
  }

  edgesOf(closure: Closure): number[] {
    return closure.ways.flatMap((way) => this.edgesOfWay.get(way) ?? []);
  }

  /** What is closed to vehicles at this time of day on the representative Fringe day of this day type. */
  at(day: DayType, clockSeconds: number): ClosedNow {
    const active = activeAt(this.data.days[day], clockSeconds);
    const edges = [...new Set(active.flatMap((c) => this.edgesOf(c)))].sort((a, b) => a - b);
    return { edges, active };
  }

  /** Closures of this day type whose streets are not in the road graph, so they have no effect on the cars. */
  unmatched(day: DayType): Closure[] {
    return this.data.days[day].closures.filter((c) => this.edgesOf(c).length === 0);
  }

  /** The closed roads as map lines. */
  streets(edges: readonly number[]): GeoData {
    return {
      type: 'FeatureCollection',
      features: edges.map((index) => {
        const flat = (this.roads.edges[index] as (number | number[])[])[8] as number[];
        const coordinates: [number, number][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) coordinates.push([flat[i] as number, flat[i + 1] as number]);
        return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } };
      }),
    };
  }
}

/** The closed roads drawn as red dashed lines. Added again after every style reload; the last streets set are kept so they come back. */
export class ClosureLayer {
  private map: maplibregl.Map | null = null;
  private streets: GeoData = EMPTY;

  install(map: maplibregl.Map): void {
    this.map = map;
    map.addSource(CLOSURES_SOURCE, { type: 'geojson', data: this.streets });
    map.addLayer({
      id: CLOSURES_LAYER,
      type: 'line',
      source: CLOSURES_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': CLOSED_COLOUR,
        'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 5, 18, 9],
        'line-dasharray': [1.5, 1.2],
      },
    });
  }

  setStreets(streets: GeoData | null): void {
    this.streets = streets ?? EMPTY;
    this.map?.getSource<maplibregl.GeoJSONSource>(CLOSURES_SOURCE)?.setData(this.streets);
  }
}
