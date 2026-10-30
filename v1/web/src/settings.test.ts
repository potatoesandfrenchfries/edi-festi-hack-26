import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, sanitise, saveSettings } from './settings';

const range = { min: 1, max: 1.5 };

describe('settings', () => {
  it('keeps valid values', () => {
    const saved = { day: 'saturday', hour: 14, festival: 1.25, theme: 'dark', minimised: true, showInferred: false, showTowers: false, heights3d: false, preset: 'light', showBuses: false, busSpeed: 60, busTraffic: false, showCars: false, busCarCoupling: false, busFrequency: 2, carDemand: 0.5 };
    expect(sanitise(saved, range)).toEqual(saved);
  });
  it('replaces invalid or hostile values with defaults and clamps the festival multiplier', () => {
    expect(sanitise({ day: 'monday', hour: 24, festival: 9, theme: 'pink', minimised: 'yes', showInferred: 'no', showTowers: 0, heights3d: null, preset: 'ultra', showBuses: 'no', busSpeed: 7, busTraffic: 0, showCars: 'yes', busCarCoupling: 'on', busFrequency: 'lots', carDemand: null }, range)).toEqual({ ...DEFAULT_SETTINGS, festival: 1.5 });
    expect(sanitise({ hour: 1.5, festival: Number.NaN }, range)).toEqual(DEFAULT_SETTINGS);
    expect(sanitise('nonsense', range)).toEqual(DEFAULT_SETTINGS);
  });
  it('clamps the bus frequency and car demand to the slider ranges', () => {
    expect(sanitise({ busFrequency: 50, carDemand: -3 }, range)).toMatchObject({ busFrequency: 3, carDemand: 0.25 });
    expect(sanitise({ busFrequency: 50, carDemand: 9 }, range, { busFrequency: { min: 0.5, max: 4 }, carDemand: { min: 0.1, max: 2 } })).toMatchObject({ busFrequency: 4, carDemand: 2 });
    expect(sanitise({ busFrequency: Number.NaN }, range).busFrequency).toBe(1);
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
