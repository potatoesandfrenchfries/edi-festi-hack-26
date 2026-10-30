import { describe, expect, it } from 'vitest';
import { PRESETS, PRESET_NAMES, pixelRatioFor, speedAdvice } from './display';

describe('presets', () => {
  it('get lighter in order: fewer pixels, later zoom, fewer layers', () => {
    const [detailed, balanced, light] = PRESET_NAMES.map((name) => PRESETS[name]);
    expect(detailed!.minZoom).toBeLessThanOrEqual(balanced!.minZoom);
    expect(balanced!.minZoom).toBeLessThanOrEqual(light!.minZoom);
    expect(detailed!.inferred).toBe(true);
    expect(light!.inferred).toBe(false);
  });
  it('cap the pixel ratio but never raise it', () => {
    expect(pixelRatioFor('detailed', 3)).toBe(3);
    expect(pixelRatioFor('balanced', 3)).toBe(1.5);
    expect(pixelRatioFor('balanced', 1)).toBe(1);
    expect(pixelRatioFor('light', 2)).toBe(1);
  });
  it('never draw buildings below the zoom the tiles were built for', () => {
    for (const name of PRESET_NAMES) expect(PRESETS[name].minZoom).toBeGreaterThanOrEqual(13);
  });
});

describe('speedAdvice', () => {
  it('says a fast machine needs no change', () => {
    expect(speedAdvice(60, 'detailed')).toMatchObject({ level: 'smooth', suggest: null });
  });
  it('suggests Balanced for a middling machine and Light for a slow one', () => {
    expect(speedAdvice(35, 'detailed')).toMatchObject({ level: 'usable', suggest: 'balanced' });
    expect(speedAdvice(12, 'detailed')).toMatchObject({ level: 'slow', suggest: 'light' });
    expect(speedAdvice(12, 'balanced')).toMatchObject({ level: 'slow', suggest: 'light' });
  });
  it('does not suggest a preset that is no lighter than the current one', () => {
    expect(speedAdvice(12, 'light').suggest).toBeNull();
    expect(speedAdvice(35, 'balanced').suggest).toBeNull();
    expect(speedAdvice(35, 'light').suggest).toBeNull();
  });
  it('reports whole frames per second', () => {
    expect(speedAdvice(19.6, 'detailed').text).toContain('20 fps');
  });
});
