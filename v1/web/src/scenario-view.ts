// What the scenario sweep (scenario.ts) says, in words and table rows. Pure, so it is tested without a page.
// All figures are modelled estimates from placeholder constants (config/transport.yaml, config/economics.yaml).
import type { Outcome, Sweep } from './scenario';
import type { Levers } from './trip-demand';

export const SCENARIOS_PATH = 'data/scenarios.json';

export interface SweepFile extends Sweep {
  generated: string;
  status: string;
}

export async function loadSweep(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<SweepFile | null> {
  try {
    const response = await fetchFn(new URL(SCENARIOS_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as SweepFile;
    return Array.isArray(data.outcomes) && data.outcomes.length > 0 && data.reference && data.outcomes[data.best] ? data : null;
  } catch {
    return null;
  }
}

/** Pounds, rounded to what an estimate can support: £2,300 not £2,314.82. */
export function pounds(value: number): string {
  const sign = value < 0 ? '−' : '';
  const v = Math.abs(value);
  if (v >= 1_000_000) return `${sign}£${(v / 1_000_000).toFixed(2)}m`;
  if (v >= 10_000) return `${sign}£${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${sign}£${(v / 1000).toFixed(1)}k`;
  return `${sign}£${Math.round(v)}`;
}

export const tonnes = (kg: number): string => `${(kg / 1000).toFixed(Math.abs(kg) >= 10_000 ? 0 : 1)} t`;

/** What the festival itself added to the evening's cost: the run with it, less the same evening without it. */
export function marginal(outcome: Outcome, reference: Outcome): { cost: number; co2Kg: number; delayHours: number } {
  return {
    cost: outcome.costs.total - reference.costs.total,
    co2Kg: outcome.co2Kg - reference.co2Kg,
    delayHours: outcome.delayPersonHours + outcome.walkPersonHours + outcome.waitPersonHours - reference.delayPersonHours - reference.walkPersonHours - reference.waitPersonHours,
  };
}

/** What to minimise: the total cost in pounds (time, fuel and carbon valued), or the carbon emitted alone. */
export type Objective = 'cost' | 'co2';
const score = (outcome: Outcome, by: Objective): number => (by === 'cost' ? outcome.costs.total : outcome.co2Kg);

/** Index of the outcome that is lowest on the objective. */
export function bestIndex(sweep: Sweep, by: Objective = 'cost'): number {
  return sweep.outcomes.reduce((best, o, i) => (score(o, by) < score(sweep.outcomes[best] as Outcome, by) ? i : best), 0);
}

export function describeLevers(levers: Levers): string {
  const buses = levers.busFrequency === 1 ? "today's buses" : `buses ×${levers.busFrequency}`;
  const par = levers.parkAndRide > 0 ? `park-and-ride ${Math.round(levers.parkAndRide * 100)}%` : 'no park-and-ride';
  return `${buses}, ${par}, ${levers.closures ? 'Fringe closures on' : 'closures off'}`;
}

export interface Row {
  index: number;
  levers: Levers;
  label: string;
  cost: string;
  extraCost: string;
  co2: string;
  /** What the festival brings in on the evening (fares, levy, parking, less extra bus running), or '–' when the sweep has no revenue. */
  revenue: string;
  /** Change in the festival's marginal cost against today's choices, as a signed percentage, e.g. "−18%". */
  change: string;
  isBest: boolean;
  isToday: boolean;
}

/** Rows for the table, cheapest first. Today's choices are always included, even if they are not among the cheapest. */
export function rows(sweep: Sweep, limit = 8, by: Objective = 'cost'): Row[] {
  const today = sweep.outcomes[sweep.today] as Outcome;
  const todayCost = marginal(today, sweep.reference).cost;
  const best = bestIndex(sweep, by);
  const order = sweep.outcomes.map((_, i) => i).sort((a, b) => score(sweep.outcomes[a] as Outcome, by) - score(sweep.outcomes[b] as Outcome, by));
  const shown = new Set(order.slice(0, limit));
  shown.add(sweep.today);
  return order.filter((i) => shown.has(i)).map((index) => {
    const o = sweep.outcomes[index] as Outcome;
    const m = marginal(o, sweep.reference);
    return {
      index,
      levers: o.scenario.levers,
      label: describeLevers(o.scenario.levers),
      cost: pounds(o.costs.total),
      extraCost: pounds(m.cost),
      co2: tonnes(o.co2Kg),
      revenue: o.revenue ? pounds(o.revenue.net) : '–',
      change: index === sweep.today || todayCost <= 0 ? '–' : `${m.cost <= todayCost ? '−' : '+'}${Math.abs(Math.round(((m.cost - todayCost) / todayCost) * 100))}%`,
      isBest: index === best,
      isToday: index === sweep.today,
    };
  });
}

/** Sentences for the panel: what the festival costs today, and what the best configuration found would change. */
export function summary(sweep: Sweep, by: Objective = 'cost'): string[] {
  const today = sweep.outcomes[sweep.today] as Outcome;
  const bestAt = bestIndex(sweep, by);
  const best = sweep.outcomes[bestAt] as Outcome;
  const now = marginal(today, sweep.reference);
  const lines = [
    `On this evening the festival adds about ${pounds(now.cost)} of lost time, fuel and carbon on top of the ${pounds(sweep.reference.costs.total)} the roads cost without it, and ${tonnes(now.co2Kg)} of CO₂e.`,
  ];
  if (bestAt === sweep.today) {
    lines.push(`None of the ${sweep.outcomes.length} configurations tried beats today's choices.`);
  } else {
    const m = marginal(best, sweep.reference);
    const saved = now.cost - m.cost;
    const carbonSaved = now.co2Kg - m.co2Kg;
    const lead = by === 'cost' ? 'Cheapest' : 'Lowest carbon';
    lines.push(
      `${lead} of ${sweep.outcomes.length} tried: ${describeLevers(best.scenario.levers)}. It ${saved >= 0 ? 'cuts' : 'raises'} the festival's cost by ${pounds(Math.abs(saved))} (${Math.round((Math.abs(saved) / Math.max(now.cost, 1)) * 100)}%) and ${carbonSaved >= 0 ? 'cuts' : 'raises'} its CO₂e by ${tonnes(Math.abs(carbonSaved))}.`,
    );
    if (best.turnedAway > today.turnedAway) lines.push('It turns more riders away from full buses than today, so check that the extra capacity is enough.');
  }
  const earned = today.revenue;
  if (earned) {
    const pick = bestAt === sweep.today ? '' : ` In the ${by === 'cost' ? 'cheapest' : 'lowest-carbon'} configuration it is ${pounds((best.revenue ?? earned).net)}.`;
    lines.push(
      `Against that the festival brings in about ${pounds(earned.net)} net: ${pounds(earned.fares + earned.shuttleFares)} of bus fares, ${pounds(earned.levy)} of visitor levy for the night and ${pounds(earned.parking)} of parking, less ${pounds(earned.running)} of extra bus running.${pick} The revenue goes to the council and bus operators and the losses fall on drivers and riders, so the two are not netted.`,
    );
  }
  lines.push(`Run on ${sweep.date}, 18:00 to midnight, in a sample of cars scaled up by a placeholder factor. Treat the ranking as more reliable than the pounds.`);
  return lines;
}
