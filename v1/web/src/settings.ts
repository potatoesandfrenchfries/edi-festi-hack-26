import { BUS_SPEEDS, DEFAULT_BUS_SPEED, type BusSpeed } from './buses';
import { PRESET_NAMES, type Preset } from './display';
import { DAY_TYPES, type DayType } from './presence';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  day: DayType;
  hour: number;
  festival: number;
  theme: Theme;
  minimised: boolean;
  showInferred: boolean;
  showTowers: boolean;
  heights3d: boolean;
  preset: Preset;
  showBuses: boolean;
  busSpeed: BusSpeed;
  busTraffic: boolean;
  showCars: boolean;
  busCarCoupling: boolean;
  /** How often buses run, as a multiple of the timetable. */
  busFrequency: number;
  /** How many cars are on the road, as a multiple of a normal day's hourly profile. */
  carDemand: number;
  /** Close the streets the council closes to vehicles on a Fringe day, at the hours it closes them. */
  festivalClosures: boolean;
}

export const DEFAULT_SETTINGS: Settings = { day: 'weekday', hour: 9, festival: 1, theme: 'system', minimised: false, showInferred: true, showTowers: true, heights3d: true, preset: 'detailed', showBuses: true, busSpeed: DEFAULT_BUS_SPEED, busTraffic: true, showCars: true, busCarCoupling: true, busFrequency: 1, carDemand: 1, festivalClosures: true };
/** The scenario sliders' bounds when `data/economics.json` is missing; otherwise they come from config/economics.yaml. */
export const SCENARIO_RANGES = { busFrequency: { min: 0.25, max: 3 }, carDemand: { min: 0.25, max: 1.5 } };
export type ScenarioRanges = typeof SCENARIO_RANGES;
const KEY = 'edinburgh-presence-settings';

/** Keeps only values that are valid now, so stale or hand-edited storage can never break the page. */
export function sanitise(raw: unknown, festival: { min: number; max: number }, ranges: ScenarioRanges = SCENARIO_RANGES): Settings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
  const hour = typeof input.hour === 'number' && Number.isInteger(input.hour) && input.hour >= 0 && input.hour <= 23 ? input.hour : DEFAULT_SETTINGS.hour;
  const scalar = typeof input.festival === 'number' && Number.isFinite(input.festival) ? input.festival : DEFAULT_SETTINGS.festival;
  const within = (value: unknown, range: { min: number; max: number }, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, range.min), range.max) : fallback;
  return {
    day: pick(input.day, DAY_TYPES, DEFAULT_SETTINGS.day),
    hour,
    festival: Math.min(Math.max(scalar, festival.min), festival.max),
    theme: pick(input.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    minimised: input.minimised === true,
    showInferred: input.showInferred !== false,
    showTowers: input.showTowers !== false,
    heights3d: input.heights3d !== false,
    preset: pick(input.preset, PRESET_NAMES, DEFAULT_SETTINGS.preset),
    showBuses: input.showBuses !== false,
    busSpeed: pick(input.busSpeed, BUS_SPEEDS, DEFAULT_SETTINGS.busSpeed),
    busTraffic: input.busTraffic !== false,
    showCars: input.showCars !== false,
    busCarCoupling: input.busCarCoupling !== false,
    busFrequency: within(input.busFrequency, ranges.busFrequency, DEFAULT_SETTINGS.busFrequency),
    carDemand: within(input.carDemand, ranges.carDemand, DEFAULT_SETTINGS.carDemand),
    festivalClosures: input.festivalClosures !== false,
  };
}

// Storage can be missing or throw (private windows, blocked site data), so every access is guarded and the page works without it.
export function loadSettings(
  festival: { min: number; max: number },
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
  ranges: ScenarioRanges = SCENARIO_RANGES,
): Settings {
  try {
    const text = storage?.getItem(KEY);
    return sanitise(text ? JSON.parse(text) : null, festival, ranges);
  } catch {
    return sanitise(null, festival, ranges);
  }
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not saving is fine.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
