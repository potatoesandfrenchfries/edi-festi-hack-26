import { describe, expect, it } from 'vitest';
import { describeBuilding, describeInferred, formatCount, formatPeople, hourLabel } from './popup';
import type { Profiles } from './presence';

const curve = (v: number) => ({ weekday: Array(24).fill(v), saturday: Array(24).fill(v), sunday: Array(24).fill(v) });
const profiles = {
  status: 'placeholder', values: 'template', day_types: ['weekday', 'saturday', 'sunday'], residents: curve(1) as never,
  workers: { office: curve(1), unknown: curve(0) } as never, festival: { min: 1, max: 1.5, step: 0.05, default: 1 },
  scale: { density_breaks: [1], total_breaks: [1] }, totals: { buildings: 1, residents: 0, workers: {} },
} as unknown as Profiles;
const building = { id: 'b1', name: 'The Hub', height_m: 52, height_src: 'lidar', height_conf: 'high', use_class: 'office', use_src: 'osm', res_pop: 0, work_pop: 40, floor_area_m2: 2000 };
const at = { day: 'weekday', hour: 9, festival: 1 } as const;

describe('describeBuilding', () => {
  it('states the estimate, density, class and height source', () => {
    const { title, rows } = describeBuilding(building, at, profiles);
    expect(title).toBe('The Hub');
    expect(Object.fromEntries(rows)).toMatchObject({
      ID: 'b1',
      'Use class': 'office (from OpenStreetMap tags)',
      Height: '52 m (LiDAR)',
      'Estimate, weekday 09:00': 'about 40 people',
      'Per 1000 m² of floor area': 'about 20',
    });
  });
  it('always says the value is a template estimate, and flags low-confidence heights and the festival scenario', () => {
    const { flags } = describeBuilding({ ...building, height_conf: 'low', height_flag: 'steep_terrain' }, { ...at, festival: 1.25 }, profiles);
    expect(flags).toContain('Low confidence in the height');
    expect(flags).toContain('Height flag: steep terrain');
    expect(flags.some((f) => f.startsWith('Festival scenario ×1.25'))).toBe(true);
    expect(flags).toContain('Template value from floor area, not a census figure');
  });
  it('does not invent a source for an untagged building', () => {
    const { rows } = describeBuilding({ id: 'x', height_m: 8, height_src: 'default' }, at, profiles);
    expect(Object.fromEntries(rows)['Use class']).toBe('unknown (no tag says)');
  });
  it('describes an inferred building without an estimate', () => {
    const { rows, flags } = describeInferred({ height_m: 13 });
    expect(rows).toHaveLength(1);
    expect(flags[0]).toContain('no people estimate');
  });
});

describe('formatting', () => {
  it('shows one decimal below 10 people and whole numbers above', () => {
    expect(formatPeople(0.04)).toBe('0.0');
    expect(formatPeople(7.26)).toBe('7.3');
    expect(formatPeople(10.4)).toBe('10');
  });
  it('formats hours', () => expect(hourLabel(7)).toBe('07:00'));
  it('rounds headline counts so an estimate does not look exact', () => {
    expect(formatCount(46502.1)).toBe('46,500');
    expect(formatCount(9876.4)).toBe('9,876');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(154792)).toBe('154,800');
  });
});
