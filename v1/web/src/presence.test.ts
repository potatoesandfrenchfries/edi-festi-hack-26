import { existsSync, readFileSync } from 'node:fs';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { PALETTE } from './palette';
import { describeBuilding, formatPeople, hourLabel } from './popup';
import { colourExpression, estimate, legendRows, metricExpression, peopleExpression, totalsAt, type DayType, type Profiles } from './presence';

const flat = (value: number) => ({ weekday: Array(24).fill(value), saturday: Array(24).fill(value), sunday: Array(24).fill(value) }) as Record<DayType, number[]>;
const profiles: Profiles = {
  status: 'placeholder',
  values: 'template',
  day_types: ['weekday', 'saturday', 'sunday'],
  residents: { ...flat(0.5), weekday: [...Array(24).fill(0.5)].map((v, h) => (h === 12 ? 0.25 : v)) },
  workers: { office: flat(1), retail: flat(0.5), unknown: flat(0.1) },
  festival: { min: 1, max: 1.5, step: 0.05, default: 1 },
  scale: { density_breaks: [2, 4, 8, 15, 25], total_breaks: [3, 10, 30, 100, 300] },
  totals: { buildings: 3, residents: 100, workers: { office: 40, retail: 20, castle: 10 } },
};

/** Evaluates a MapLibre expression for one feature's properties, exactly as the renderer would. */
function evaluate(expression: unknown, properties: Record<string, unknown>) {
  const parsed = createExpression(expression as never, { type: 'color' } as never);
  if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
  const value = parsed.value.evaluate({ zoom: 15 } as never, { type: 'Polygon', properties } as never);
  return value;
}
const evaluateNumber = (expression: unknown, properties: Record<string, unknown>) => {
  const parsed = createExpression(expression as never, { type: 'number' } as never);
  if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
  return parsed.value.evaluate({ zoom: 15 } as never, { type: 'Polygon', properties } as never) as number;
};

describe('estimate', () => {
  it('adds residents and workers using the hour, day type and class', () => {
    const e = estimate({ use_class: 'office', res_pop: 10, work_pop: 20, floor_area_m2: 1000 }, 12, 'weekday', profiles);
    expect(e.residents).toBeCloseTo(2.5);
    expect(e.workers).toBeCloseTo(20);
    expect(e.people).toBeCloseTo(22.5);
    expect(e.density).toBeCloseTo(22.5);
  });
  it('uses the unknown curve for a class with no curve and treats missing values as zero', () => {
    expect(estimate({ use_class: 'castle', work_pop: 10 }, 3, 'sunday', profiles).workers).toBeCloseTo(1);
    expect(estimate({}, 3, 'sunday', profiles).people).toBe(0);
  });
  it('scales workers, not residents, by the festival multiplier', () => {
    const base = estimate({ use_class: 'office', res_pop: 10, work_pop: 20, floor_area_m2: 100 }, 3, 'sunday', profiles);
    const festival = estimate({ use_class: 'office', res_pop: 10, work_pop: 20, floor_area_m2: 100 }, 3, 'sunday', profiles, 1.5);
    expect(festival.residents).toBe(base.residents);
    expect(festival.workers).toBeCloseTo(base.workers * 1.5);
  });
});

describe('paint expressions agree with estimate()', () => {
  const props = { use_class: 'retail', res_pop: 4, work_pop: 30, floor_area_m2: 800 };
  it('people expression', () => {
    const expected = estimate(props, 12, 'weekday', profiles, 1.2).people;
    expect(evaluateNumber(peopleExpression(profiles, 12, 'weekday', 1.2), props)).toBeCloseTo(expected);
  });
  it('density and total metrics', () => {
    const e = estimate(props, 12, 'weekday', profiles, 1);
    expect(evaluateNumber(metricExpression(profiles, 'density', 12, 'weekday', 1), props)).toBeCloseTo(e.density);
    expect(evaluateNumber(metricExpression(profiles, 'total', 12, 'weekday', 1), props)).toBeCloseTo(e.people);
  });
  it('a feature with no values gets the neutral colour instead of an error', () => {
    expect(evaluate(colourExpression(profiles, 'density', 12, 'weekday', 1, PALETTE, '#b8a99a'), { id: 'x' })).toBe('#b8a99a');
  });
  it('colour steps follow the fixed break points', () => {
    // At 03:00 on a weekday the resident factor is 0.5; a 1000 m2 building then has density res_pop * 0.5.
    const colourAt = (density: number) =>
      evaluate(colourExpression(profiles, 'density', 3, 'weekday', 1, PALETTE, '#b8a99a'), { use_class: 'unknown', res_pop: density * 2, floor_area_m2: 1000 });
    expect(colourAt(1)).toBe('#b8a99a'); // under the first break (2)
    expect(colourAt(3)).toBe(PALETTE[0]); // 2 to 4
    expect(colourAt(10)).toBe(PALETTE[3 - 1]); // 8 to 15 is the third class
    expect(colourAt(30)).toBe(PALETTE[4]); // 25 or more
  });
  it('rejects a palette that does not match the breaks', () => {
    expect(() => colourExpression(profiles, 'density', 3, 'weekday', 1, PALETTE.slice(1), '#000')).toThrow();
  });
});

describe('totalsAt', () => {
  it('sums the per-building formula over the class totals', () => {
    // 12:00 on a weekday: residents 100 * 0.25; workers office 40 * 1 + retail 20 * 0.5 + unlisted class 10 * the unknown curve 0.1.
    const t = totalsAt(profiles, 12, 'weekday');
    expect(t.residents).toBeCloseTo(25);
    expect(t.workers).toBeCloseTo(40 + 10 + 1);
    expect(t.people).toBeCloseTo(76);
  });
  it('applies the festival multiplier to workers only', () => {
    const base = totalsAt(profiles, 12, 'weekday');
    const festival = totalsAt(profiles, 12, 'weekday', 1.5);
    expect(festival.residents).toBe(base.residents);
    expect(festival.workers).toBeCloseTo(base.workers * 1.5);
  });
});

describe('legend', () => {
  it('has short labels that fit under a swatch', () => {
    expect(legendRows(profiles, 'density', PALETTE, '#000').map((r) => r.short)).toEqual(['<2', '2–4', '4–8', '8–15', '15–25', '25+']);
  });
  it('has one neutral row plus one per colour class', () => {
    const rows = legendRows(profiles, 'density', PALETTE, '#b8a99a');
    expect(rows.map((r) => r.label)).toEqual(['Under 2', '2 to 4', '4 to 8', '8 to 15', '15 to 25', '25 or more']);
    expect(rows.map((r) => r.colour)).toEqual(['#b8a99a', ...PALETTE]);
  });
});

// The pipeline writes data/out/oracle.json with 20 sampled buildings and the values its own implementation expects.
const oraclePath = new URL('../../data/out/oracle.json', import.meta.url);
const realProfilesPath = new URL('../public/data/profiles.json', import.meta.url);
describe.skipIf(!existsSync(oraclePath) || !existsSync(realProfilesPath))('pipeline-side oracle (run `make tiles` first)', () => {
  const real = JSON.parse(readFileSync(realProfilesPath, 'utf8')) as Profiles;
  const cases = JSON.parse(readFileSync(oraclePath, 'utf8')) as {
    id: string; use_class: string; res_pop: number; work_pop: number; floor_area_m2: number;
    expected: { day: DayType; hour: number; festival: number; people: number; density: number }[];
  }[];
  it('covers 20 buildings', () => expect(cases).toHaveLength(20));
  it.each(cases.map((c) => [c.id, c] as const))('estimate() and the paint expression match the pipeline for %s', (_id, c) => {
    for (const { day, hour, festival, people, density } of c.expected) {
      const e = estimate(c, hour, day, real, festival);
      expect(e.people).toBeCloseTo(people, 3);
      expect(e.density).toBeCloseTo(density, 3);
      expect(evaluateNumber(metricExpression(real, 'total', hour, day, festival), c)).toBeCloseTo(people, 3);
      expect(evaluateNumber(metricExpression(real, 'density', hour, day, festival), c)).toBeCloseTo(density, 3);
      // The popup shows the same number the pipeline computes.
      const rows = Object.fromEntries(describeBuilding(c, { day, hour, festival }, real).rows);
      const label = Object.keys(rows).find((key) => key.startsWith('Estimate'))!;
      expect(label.endsWith(hourLabel(hour))).toBe(true);
      expect(rows[label]).toBe(`about ${formatPeople(people)} people`);
    }
  });
});
