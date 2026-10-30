import { describe, expect, it } from 'vitest';
import { ClosureSchedule, activeAt, loadClosures, type Closure, type ClosureData } from './closures';
import { gridRoads } from './grid-roads.testutil';

const closure = (over: Partial<Closure> = {}): Closure => ({
  id: 'R1', location: 'high_street', name: 'High Street', festival: 'Fringe', type: 'closed_to_vehicles',
  from: 10.5 * 3600, to: 21 * 3600, ways: [1, 3], confidence: 'medium', ...over,
});
const data = (closures: Closure[] = [closure()]): ClosureData => {
  const day = (date: string, list: Closure[]) => ({ date, closures: list, unmapped: [] });
  return { source: 'test', built: 'now', days: { weekday: day('2026-08-11', closures), saturday: day('2026-08-15', []), sunday: day('2026-08-16', closures) } };
};

describe('activeAt', () => {
  const day = data().days.weekday;
  it('is closed from the start time up to, not including, the end time', () => {
    expect(activeAt(day, 10.5 * 3600 - 1)).toHaveLength(0);
    expect(activeAt(day, 10.5 * 3600)).toHaveLength(1);
    expect(activeAt(day, 21 * 3600 - 1)).toHaveLength(1);
    expect(activeAt(day, 21 * 3600)).toHaveLength(0);
  });
  it('reads a clock that has gone past midnight as the next day', () => {
    expect(activeAt(day, 24 * 3600 + 12 * 3600)).toHaveLength(1);
    expect(activeAt(day, -3600 * 5)).toHaveLength(1); // 19:00 the day before
    expect(activeAt(day, -3600 * 2)).toHaveLength(0); // 22:00
  });
});

describe('ClosureSchedule', () => {
  const roads = gridRoads(); // way n has edges 2(n-1) and 2(n-1)+1
  it('joins closed ways to the road graph edges that carry their id', () => {
    const schedule = new ClosureSchedule(data(), roads);
    expect(schedule.at('weekday', 12 * 3600).edges).toEqual([0, 1, 4, 5]);
    expect(schedule.at('weekday', 12 * 3600).active.map((c) => c.name)).toEqual(['High Street']);
  });
  it('closes nothing outside the hours or on a day type with no closures', () => {
    const schedule = new ClosureSchedule(data(), roads);
    expect(schedule.at('weekday', 8 * 3600).edges).toEqual([]);
    expect(schedule.at('saturday', 12 * 3600).edges).toEqual([]);
  });
  it('lists each edge once when two closures share a way, in ascending order', () => {
    const schedule = new ClosureSchedule(data([closure({ ways: [3, 1] }), closure({ id: 'R2', ways: [1] })]), roads);
    expect(schedule.at('weekday', 12 * 3600).edges).toEqual([0, 1, 4, 5]);
  });
  it('reports closures whose streets are not in the graph, and still counts them as active', () => {
    const schedule = new ClosureSchedule(data([closure({ ways: [99999], name: 'Lawnmarket' })]), roads);
    expect(schedule.unmatched('weekday').map((c) => c.name)).toEqual(['Lawnmarket']);
    const now = schedule.at('weekday', 12 * 3600);
    expect(now.edges).toEqual([]);
    expect(now.active).toHaveLength(1);
  });
  it('draws each closed edge as a line along its road', () => {
    const schedule = new ClosureSchedule(data(), roads);
    const lines = schedule.streets([0, 4]) as { features: { geometry: { type: string; coordinates: number[][] } }[] };
    expect(lines.features).toHaveLength(2);
    expect(lines.features[0]!.geometry.type).toBe('LineString');
    expect(lines.features[0]!.geometry.coordinates).toEqual([[-3.19, 55.95], [-3.188, 55.95]]);
  });
  it('knows the representative date of each day type', () => {
    expect(new ClosureSchedule(data(), roads).date('saturday')).toBe('2026-08-15');
  });
});

describe('loadClosures', () => {
  const respond = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body }) as Response) as typeof fetch;
  it('accepts the built file and rejects anything else', async () => {
    expect(await loadClosures(respond(data()), 'http://localhost/')).toMatchObject({ source: 'test' });
    expect(await loadClosures(respond(null, false), 'http://localhost/')).toBeNull();
    expect(await loadClosures(respond({ days: { weekday: {} } }), 'http://localhost/')).toBeNull();
    expect(await loadClosures((async () => { throw new Error('offline'); }) as typeof fetch, 'http://localhost/')).toBeNull();
  });
});
