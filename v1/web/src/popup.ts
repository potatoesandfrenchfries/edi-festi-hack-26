import * as maplibregl from 'maplibre-gl';
import { DAY_LABELS, estimate, type DayType, type Profiles, type ValueProps } from './presence';

export interface BuildingProps extends ValueProps {
  id?: string;
  name?: string;
  height_m?: number;
  height_src?: string;
  height_conf?: string;
  height_flag?: string;
  use_src?: string;
  /** Visitor bed-spaces (hotels, halls, licensed short-term lets) and the festival venue key, when the tiles carry them. */
  beds?: number;
  stay?: string;
  venue?: string;
}

export interface PopupState {
  day: DayType;
  hour: number;
  festival: number;
  /** The festival's extra people in this building at this date and hour (festival-layer.ts), when the festival data is loaded. */
  surge?: { audience: number; guests: number; date: string };
}

export interface PopupContent {
  title: string;
  rows: [label: string, value: string][];
  flags: string[];
}

const HEIGHT_SOURCES: Record<string, string> = {
  osm_tag: 'OpenStreetMap tag',
  lidar: 'LiDAR',
  overture: 'Overture',
  floors: 'storeys × floor height',
  gba: 'Global Building Atlas',
  manual: 'curated landmark',
  default: 'default',
};
const USE_SOURCES: Record<string, string> = { osm: 'OpenStreetMap tags', overture: 'Overture tags' };

export const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** Whole people for counts above 10, one decimal below, so a small estimate is not shown as a false zero. */
export function formatPeople(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** A headline count: whole numbers below 10,000, rounded to the nearest 100 above so a model estimate does not look exact. */
export function formatCount(value: number): string {
  const rounded = value >= 10000 ? Math.round(value / 100) * 100 : Math.round(value);
  return rounded.toLocaleString('en-GB');
}

/** What the popup says about one building. Pure, so it can be tested without a map. Values are estimates, not counts. */
export function describeBuilding(props: BuildingProps, state: PopupState, profiles: Profiles): PopupContent {
  const now = estimate(props, state.hour, state.day, profiles, state.festival);
  const useClass = props.use_class ?? 'unknown';
  const rows: PopupContent['rows'] = [
    ['ID', props.id ?? 'unknown'],
    ['Use class', props.use_src ? `${useClass} (from ${USE_SOURCES[props.use_src] ?? props.use_src})` : `${useClass} (no tag says)`],
    ['Height', `${props.height_m ?? '?'} m (${HEIGHT_SOURCES[props.height_src ?? ''] ?? props.height_src ?? 'unknown source'})`],
    [`Estimate, ${DAY_LABELS[state.day].toLowerCase()} ${hourLabel(state.hour)}`, `about ${formatPeople(now.people)} people`],
    ['Per 1000 m² of floor area', `about ${formatPeople(now.density)}`],
    ['Of which', `residents ${formatPeople(now.residents)}, workers ${formatPeople(now.workers)}`],
  ];
  const surge = state.surge;
  if (surge && (surge.audience >= 1 || surge.guests >= 1)) {
    const parts = [];
    if (surge.audience >= 1) parts.push(`about ${formatPeople(surge.audience)} at the show or shows`);
    if (surge.guests >= 1) parts.push(`about ${formatPeople(surge.guests)} extra guests staying (${props.beds ?? 0} bed-spaces)`);
    rows.push([`Festival surge, ${hourLabel(state.hour)}`, parts.join('; ')]);
  } else if (props.beds && props.beds >= 1) {
    rows.push(['Visitor beds', `${props.beds} bed-spaces (${props.stay === 'hotel' ? 'hotel or similar' : props.stay === 'halls' ? 'halls of residence' : 'licensed short-term lets'})`]);
  }
  const flags: string[] = [];
  if (props.height_conf === 'low') flags.push('Low confidence in the height');
  if (props.height_flag) flags.push(`Height flag: ${props.height_flag.replaceAll('_', ' ')}`);
  if (state.festival > 1) flags.push(`Festival scenario ×${state.festival.toFixed(2)} applied to workers (manual, not measured)`);
  if (profiles.values === 'template') flags.push('Template value from floor area, not a census figure');
  return { title: props.name || 'Building', rows, flags };
}

export function describeInferred(props: { height_m?: number }): PopupContent {
  return {
    title: 'Inferred building',
    rows: [['Height', `${props.height_m ?? '?'} m (estimated from neighbours or LiDAR)`]],
    flags: ['Not mapped in OpenStreetMap, so it has no people estimate'],
  };
}

function render(content: PopupContent): HTMLElement {
  const root = document.createElement('div');
  root.className = 'popup';
  const title = document.createElement('strong');
  title.textContent = content.title;
  root.append(title);
  const list = document.createElement('dl');
  for (const [label, value] of content.rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    list.append(term, detail);
  }
  root.append(list);
  if (content.flags.length) {
    const flags = document.createElement('ul');
    for (const flag of content.flags) {
      const item = document.createElement('li');
      item.textContent = flag;
      flags.append(item);
    }
    root.append(flags);
  }
  return root;
}

let current: maplibregl.Popup | null = null;

/** Shows (or replaces) the single popup. Text is set with textContent, never as HTML. */
export function showPopup(map: maplibregl.Map, lngLat: maplibregl.LngLatLike, content: PopupContent): maplibregl.Popup {
  current?.remove();
  current = new maplibregl.Popup({ maxWidth: '300px', closeButton: true }).setLngLat(lngLat).setDOMContent(render(content)).addTo(map);
  return current;
}
