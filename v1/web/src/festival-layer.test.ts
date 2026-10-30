import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { crowdFeatures, guestsPerBed, SURGE_BREAKS, SURGE_COLOURS, surgeExpression, surgeFill, surgeFor } from './festival-layer';
import { buildingColour } from './buildings';
import { dateLabel, dayTypeOf, festivalDates, loadDemand, occupancyOn, presentAt, slotAt, surgeTotal, type Accommodation, type Demand } from './demand';

const SLOTS = 96;
const day = (fill: (slot: number) => number) => ({ a: Array(SLOTS).fill(0), d: Array(SLOTS).fill(0), p: Array.from({ length: SLOTS }, (_, i) => fill(i)) });
const demand: Demand = {
  status: 'placeholder',
  note: '',
  slot_minutes: 15,
  first_day: '2026-08-14',
  venues: {
    hall: { name: 'Hall', lon: -3.19, lat: 55.95, festival: 'International', kind: 'building', tickets: 100, days: { '2026-08-15': day((i) => (i >= 76 && i < 84 ? 800 : 0)) } },
    hub: { name: 'Hub', lon: -3.18, lat: 55.95, festival: 'Fringe', kind: 'hub', tickets: 100, days: { '2026-08-15': day((i) => (i >= 76 && i < 84 ? 300 : 0)) } },
  },
  origins: { eif: { local: 0.7, daytrip: 0.1, stay: 0.2 }, tattoo: { local: 0.1, daytrip: 0.1, stay: 0.8 }, fringe: { local: 0.4, daytrip: 0.1, stay: 0.5 }, sectors: { north: 0.3, west: 0.3, south: 0.4 } },
  staying_people: { '2026-08-14': 1000, '2026-08-15': 3000, '2026-08-16': 0 },
};
const acc: Accommodation = {
  status: 'placeholder',
  occupancy: { base: 0.6, max: 0.98 },
  night_profile: Array.from({ length: 24 }, (_, h) => (h < 8 ? 1 : 0.2)),
  pilot_beds: { hotel: 800, str: 200 },
  city_beds: { str: 4000, hotel: 6000 },
};
const state = { date: '2026-08-15', hour: 20 };

function evaluate(expression: unknown, properties: Record<string, unknown>, type: 'number' | 'color' = 'number') {
  const parsed = createExpression(expression as never, { type } as never);
  if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
  return parsed.value.evaluate({ zoom: 15 } as never, { type: 'Polygon', properties } as never);
}

describe('demand helpers', () => {
  it('averages the slots of an hour and reads a day with no show as empty', () => {
    expect(presentAt(demand, demand.venues.hall!, '2026-08-15', 20)).toBe(800); // slots 76..83 hold 800 each in the fixture
    expect(presentAt(demand, demand.venues.hall!, '2026-08-15', 21)).toBe(0);
    expect(presentAt(demand, demand.venues.hall!, '2026-08-15', 19)).toBe(800); // 76..79
    expect(presentAt(demand, demand.venues.hall!, '2026-08-20', 19)).toBe(0);
  });
  it('dates, day types and the slot of a clock time', () => {
    expect(festivalDates(demand)).toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
    expect(dayTypeOf('2026-08-15')).toBe('saturday');
    expect(dayTypeOf('2026-08-16')).toBe('sunday');
    expect(dayTypeOf('2026-08-17')).toBe('weekday');
    expect(dateLabel('2026-08-15')).toContain('15');
    expect(slotAt(demand, 19.5 * 3600)).toBe(78);
    expect(slotAt(demand, 86400 + 1800)).toBe(2); // wraps past midnight
  });
  it('occupancy rises with staying visitors and is capped', () => {
    expect(occupancyOn(acc, demand, '2026-08-16')).toBe(0.6);
    expect(occupancyOn(acc, demand, '2026-08-15')).toBeCloseTo(0.6 + 3000 / 10000);
    expect(occupancyOn(acc, { ...demand, staying_people: { x: 1e9 } }, 'x')).toBe(0.98);
  });
  it('sums the surge from venues and guests', () => {
    const night = surgeTotal(acc, demand, '2026-08-15', 3);
    expect(night.venues).toBe(0);
    expect(night.guests).toBeCloseTo(1000 * 0.3 * 1); // 1000 pilot beds, occupancy 0.9 against a base of 0.6, everyone in at 03:00
    expect(surgeTotal(null, demand, '2026-08-15', 19)).toEqual({ venues: 1100, guests: 0, total: 1100 });
  });
  it('a failed or malformed load is null, not a throw', async () => {
    expect(await loadDemand((async () => ({ ok: false })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadDemand((async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadDemand((async () => { throw new Error('offline'); }) as unknown as typeof fetch, 'http://x/')).toBeNull();
  });
});

describe('surge expression', () => {
  it('matches the per-building function for a hotel, a venue and an ordinary building', () => {
    const at = { date: '2026-08-15', hour: 19 };
    const expression = surgeExpression(acc, demand, at);
    for (const props of [{ beds: 100 }, { venue: 'hall' }, {}, { beds: 40, venue: 'hall' }]) {
      const f = surgeFor(props, acc, demand, at);
      expect(evaluate(expression, props)).toBeCloseTo(f.guests + f.audience, 6);
    }
    expect(evaluate(expression, { venue: 'hall' })).toBe(800);
  });
  it('counts extra guests only above the base occupancy, scaled by the night profile', () => {
    const perBed = guestsPerBed(acc, demand, { date: '2026-08-15', hour: 3 });
    expect(perBed).toBeCloseTo(0.3, 6); // occupancy 0.9 less the 0.6 base, with everyone in at 03:00
    expect(guestsPerBed(acc, demand, { date: '2026-08-16', hour: 3 })).toBe(0);
    expect(guestsPerBed(null, demand, state)).toBe(0);
  });
  it('is valid with no venues on show', () => {
    const empty = { ...demand, venues: {} };
    expect(evaluate(surgeExpression(acc, empty, state), { beds: 10 })).toBeGreaterThanOrEqual(0);
  });
});

describe('surge fill', () => {
  it('keeps the ordinary colour below the first step and ramps up through every step', () => {
    const fill = surgeFill(false, ['coalesce', ['get', 's'], 0]);
    const colour = (s: number, extra: Record<string, unknown> = {}) => JSON.stringify(evaluate(fill, { s, ...extra }, 'color'));
    const base = JSON.stringify(evaluate(buildingColour(false), {}, 'color'));
    expect(colour(0)).toBe(base);
    expect(colour(SURGE_BREAKS[0] - 0.01)).toBe(base);
    const seen = new Set(SURGE_BREAKS.map((limit) => colour(limit)));
    expect(seen.size).toBe(SURGE_BREAKS.length);
    expect(SURGE_COLOURS.light.length).toBe(SURGE_BREAKS.length);
    expect(SURGE_COLOURS.dark.length).toBe(SURGE_BREAKS.length);
  });
});

describe('crowd discs', () => {
  it('draw only places without a footprint, and only while people are there', () => {
    const at = crowdFeatures(demand, { date: '2026-08-15', hour: 19 });
    expect(at.features.map((feature) => feature.properties.key)).toEqual(['hub']);
    expect(at.features[0]!.properties.p).toBe(300);
    expect(crowdFeatures(demand, { date: '2026-08-15', hour: 3 }).features).toEqual([]);
  });
});
