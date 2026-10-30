import { describe, expect, it } from 'vitest';
import { bestIndex, describeLevers, loadSweep, marginal, pounds, rows, summary, tonnes, type SweepFile } from './scenario-view';
import type { Outcome } from './scenario';

const outcome = (levers: Outcome['scenario']['levers'], total: number, co2Kg = 1000, turnedAway = 0, festival = true): Outcome => ({
  scenario: { date: '2026-08-15', levers, festival },
  windowHours: [18, 24],
  delayPersonHours: total / 20,
  walkPersonHours: 0,
  waitPersonHours: 0,
  litres: 100,
  co2Kg,
  costs: { time: total * 0.7, fuel: total * 0.2, carbon: total * 0.1, total },
  trips: null,
  busRiders: 0,
  turnedAway,
  diverted: 0,
  festivalCarTrips: 0,
  closedStreets: [],
});
const earning = (o: Outcome, net: number): Outcome => ({
  ...o,
  revenue: { boardings: 0, shuttleBoardings: 0, roomNights: 0, fares: net * 0.5, shuttleFares: 0, parking: net * 0.1, levy: net * 0.5, running: net * 0.1, net },
});
const levers = (busFrequency = 1, parkAndRide = 0, closures = false) => ({ busFrequency, parkAndRide, closures });
const sweep: SweepFile = {
  generated: '2026-10-30',
  status: 'placeholder',
  date: '2026-08-15',
  reference: outcome(levers(), 100_000, 50_000, 0, false),
  outcomes: [outcome(levers(), 160_000, 90_000), outcome(levers(2), 140_000, 80_000), outcome(levers(2, 0.3, true), 120_000, 70_000, 5), outcome(levers(0.5), 180_000, 95_000)],
  best: 2,
  today: 0,
};

describe('formatting', () => {
  it('rounds pounds to what an estimate supports', () => {
    expect(pounds(850)).toBe('£850');
    expect(pounds(2314.8)).toBe('£2.3k');
    expect(pounds(41_000)).toBe('£41k');
    expect(pounds(1_234_567)).toBe('£1.23m');
    expect(pounds(-2500)).toBe('−£2.5k');
    expect(tonnes(1500)).toBe('1.5 t');
    expect(tonnes(25_000)).toBe('25 t');
  });
  it('describes the levers in plain words', () => {
    expect(describeLevers(levers())).toBe("today's buses, no park-and-ride, closures off");
    expect(describeLevers(levers(2, 0.3, true))).toBe('buses ×2, park-and-ride 30%, Fringe closures on');
  });
});

describe('the sweep in words and rows', () => {
  it("the festival's own cost is the run less the same evening without it", () => {
    expect(marginal(sweep.outcomes[0]!, sweep.reference).cost).toBe(60_000);
    expect(marginal(sweep.outcomes[0]!, sweep.reference).co2Kg).toBe(40_000);
  });
  it('rows come cheapest first, mark the best and today, and give the change against today', () => {
    const table = rows(sweep);
    expect(table.map((r) => r.index)).toEqual([2, 1, 0, 3]);
    expect(table[0]!.isBest).toBe(true);
    expect(table[0]!.change).toBe('−67%'); // marginal 20k against 60k
    expect(table.find((r) => r.isToday)!.change).toBe('–');
    expect(table.find((r) => r.index === 3)!.change).toBe('+33%');
  });
  it("always includes today's choices even when the row limit would cut them", () => {
    expect(rows(sweep, 1).map((r) => r.index)).toEqual([2, 0]);
  });
  it('the summary names the best, how much it saves, and warns when it turns more riders away', () => {
    const lines = summary(sweep);
    expect(lines[0]).toContain('£60k');
    expect(lines[1]).toContain('buses ×2, park-and-ride 30%, Fringe closures on');
    expect(lines[1]).toContain('£40k');
    expect(lines.some((l) => l.includes('turns more riders away'))).toBe(true);
  });
  it('can rank by carbon instead of cost, and says whether a pick raises either', () => {
    const carbon: SweepFile = { ...sweep, outcomes: [outcome(levers(), 160_000, 90_000), outcome(levers(2), 140_000, 80_000), outcome(levers(2, 0.3, true), 120_000, 85_000), outcome(levers(3), 150_000, 60_000)] };
    expect(bestIndex(carbon, 'cost')).toBe(2);
    expect(bestIndex(carbon, 'co2')).toBe(3);
    expect(rows(carbon, 8, 'co2')[0]!.index).toBe(3);
    expect(rows(carbon, 8, 'co2')[0]!.isBest).toBe(true);
    expect(summary(carbon, 'co2')[1]).toContain('Lowest carbon of 4 tried: buses ×3');
    const worse: SweepFile = { ...carbon, outcomes: [outcome(levers(), 100_000, 60_000), outcome(levers(3), 150_000, 50_000)], today: 0 };
    expect(summary(worse, 'co2')[1]).toContain("raises the festival's cost by");
  });
  it('shows revenue beside the cost when the sweep has it, and a dash when it does not', () => {
    expect(rows(sweep)[0]!.revenue).toBe('–');
    const withRevenue: SweepFile = { ...sweep, outcomes: sweep.outcomes.map((o, i) => earning(o, 10_000 * (i + 1))) };
    expect(rows(withRevenue).find((r) => r.index === 0)!.revenue).toBe('£10k');
    const lines = summary(withRevenue);
    expect(lines.some((l) => l.includes('brings in about £10k net') && l.includes('£5.0k of bus fares') && l.includes('not netted'))).toBe(true);
    expect(lines.some((l) => l.includes('cheapest configuration it is £30k'))).toBe(true);
    expect(summary(sweep).some((l) => l.includes('brings in'))).toBe(false);
  });
  it('says so when nothing beats today', () => {
    const same: SweepFile = { ...sweep, outcomes: [outcome(levers(), 100_000), ...sweep.outcomes.slice(1)], best: 0 };
    expect(summary(same)[1]).toContain('None of the 4');
  });
  it('a missing or malformed file is null', async () => {
    expect(await loadSweep((async () => ({ ok: false })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadSweep((async () => ({ ok: true, json: async () => ({ outcomes: [] }) })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadSweep((async () => ({ ok: true, json: async () => sweep })) as unknown as typeof fetch, 'http://x/')).toEqual(sweep);
  });
});
