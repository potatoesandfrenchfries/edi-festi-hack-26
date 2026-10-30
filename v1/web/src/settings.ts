import { PRESET_NAMES, type Preset } from './display';
import { DAY_TYPES, type DayType, type Metric } from './presence';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  day: DayType;
  hour: number;
  metric: Metric;
  festival: number;
  theme: Theme;
  minimised: boolean;
  showInferred: boolean;
  showTowers: boolean;
  heights3d: boolean;
  preset: Preset;
}

export const DEFAULT_SETTINGS: Settings = { day: 'weekday', hour: 9, metric: 'density', festival: 1, theme: 'system', minimised: false, showInferred: true, showTowers: true, heights3d: true, preset: 'detailed' };
const KEY = 'edinburgh-presence-settings';

/** Keeps only values that are valid now, so stale or hand-edited storage can never break the page. */
export function sanitise(raw: unknown, festival: { min: number; max: number }): Settings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
  const hour = typeof input.hour === 'number' && Number.isInteger(input.hour) && input.hour >= 0 && input.hour <= 23 ? input.hour : DEFAULT_SETTINGS.hour;
  const scalar = typeof input.festival === 'number' && Number.isFinite(input.festival) ? input.festival : DEFAULT_SETTINGS.festival;
  return {
    day: pick(input.day, DAY_TYPES, DEFAULT_SETTINGS.day),
    hour,
    metric: pick(input.metric, ['density', 'total'] as const, DEFAULT_SETTINGS.metric),
    festival: Math.min(Math.max(scalar, festival.min), festival.max),
    theme: pick(input.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    minimised: input.minimised === true,
    showInferred: input.showInferred !== false,
    showTowers: input.showTowers !== false,
    heights3d: input.heights3d !== false,
    preset: pick(input.preset, PRESET_NAMES, DEFAULT_SETTINGS.preset),
  };
}

// Storage can be missing or throw (private windows, blocked site data), so every access is guarded and the page works without it.
export function loadSettings(festival: { min: number; max: number }, storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const text = storage?.getItem(KEY);
    return sanitise(text ? JSON.parse(text) : null, festival);
  } catch {
    return sanitise(null, festival);
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
