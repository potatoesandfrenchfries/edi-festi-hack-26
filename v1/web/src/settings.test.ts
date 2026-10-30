import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, sanitise, saveSettings } from './settings';

const range = { min: 1, max: 1.5 };

describe('settings', () => {
  it('keeps valid values', () => {
    const saved = { day: 'saturday', hour: 14, metric: 'total', festival: 1.25, theme: 'dark', minimised: true, showInferred: false, showTowers: false, heights3d: false, preset: 'light' };
    expect(sanitise(saved, range)).toEqual(saved);
  });
  it('replaces invalid or hostile values with defaults and clamps the festival multiplier', () => {
    expect(sanitise({ day: 'monday', hour: 24, metric: 3, festival: 9, theme: 'pink', minimised: 'yes', showInferred: 'no', showTowers: 0, heights3d: null, preset: 'ultra' }, range)).toEqual({ ...DEFAULT_SETTINGS, festival: 1.5 });
    expect(sanitise({ hour: 1.5, festival: Number.NaN }, range)).toEqual(DEFAULT_SETTINGS);
    expect(sanitise('nonsense', range)).toEqual(DEFAULT_SETTINGS);
  });
  it('falls back to defaults when storage is missing, empty, corrupt or throws', () => {
    expect(loadSettings(range, null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(range, { getItem: () => null })).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(range, { getItem: () => '{not json' })).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(range, { getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_SETTINGS);
  });
  it('saving never throws', () => {
    expect(() => saveSettings(DEFAULT_SETTINGS, null)).not.toThrow();
    expect(() => saveSettings(DEFAULT_SETTINGS, { setItem: () => { throw new Error('full'); } })).not.toThrow();
  });
  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSettings({ ...DEFAULT_SETTINGS, hour: 20, day: 'sunday' }, storage);
    expect(loadSettings(range, storage)).toMatchObject({ hour: 20, day: 'sunday' });
  });
});
