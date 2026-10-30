import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, sanitiseState } from './festival-panel';

const par = { min: 0, max: 0.6 };

describe('festival panel state', () => {
  it('keeps valid values', () => {
    expect(sanitiseState({ dateIndex: 5, showSurge: false, trips: false, parkAndRide: 0.3 }, 29, par)).toEqual({ dateIndex: 5, showSurge: false, trips: false, parkAndRide: 0.3 });
  });
  it('clamps the date to the dates there are and the lever to its range', () => {
    expect(sanitiseState({ dateIndex: 400, parkAndRide: 9 }, 29, par)).toMatchObject({ dateIndex: 28, parkAndRide: 0.6 });
    expect(sanitiseState({ dateIndex: -3, parkAndRide: -1 }, 29, par)).toMatchObject({ dateIndex: 0, parkAndRide: 0 });
  });
  it('falls back to the defaults for stale or hand-edited storage', () => {
    expect(sanitiseState(null, 29, par)).toEqual(DEFAULT_STATE);
    expect(sanitiseState('nonsense', 29, par)).toEqual(DEFAULT_STATE);
    expect(sanitiseState({ dateIndex: 1.5, parkAndRide: Number.NaN }, 29, par)).toMatchObject({ dateIndex: DEFAULT_STATE.dateIndex, parkAndRide: 0 });
  });
  it('a one-date or no-date season still gives a valid index', () => {
    expect(sanitiseState({ dateIndex: 12 }, 1, par).dateIndex).toBe(0);
    expect(sanitiseState({ dateIndex: 12 }, 0, par).dateIndex).toBe(0);
  });
});
