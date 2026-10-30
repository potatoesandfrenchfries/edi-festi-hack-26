import type { ExpressionSpecification } from 'maplibre-gl';

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Metric = 'density' | 'total';

export const DAY_TYPES: readonly DayType[] = ['weekday', 'saturday', 'sunday'];
export const DAY_LABELS: Record<DayType, string> = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };
export const METRIC_LABELS: Record<Metric, string> = { density: 'People per 1000 m² of floor area', total: 'People in building' };

/** Contents of data/profiles.json, written by pipeline stage 06 from config/profiles.yaml and config/model.yaml. */
export interface Profiles {
  status: string; // "placeholder" until calibrated (M4)
  values: string; // "template" while building values are stand-ins rather than the census allocation
  day_types: DayType[];
  residents: Record<DayType, number[]>;
  workers: Record<string, Record<DayType, number[]>>;
  festival: { min: number; max: number; step: number; default: number };
  scale: { density_breaks: number[]; total_breaks: number[] };
  totals: { buildings: number; residents: number; workers: Record<string, number> }; // template totals for the pilot area
}

/** The per-building properties the hourly expression reads. */
export interface ValueProps {
  use_class?: string;
  res_pop?: number;
  work_pop?: number;
  floor_area_m2?: number;
}

export interface Estimate {
  residents: number;
  workers: number;
  people: number;
  density: number; // people per 1000 m² of floor area
}

function workerCurves(profiles: Profiles, useClass: string | undefined) {
  return (useClass && profiles.workers[useClass]) || profiles.workers.unknown!;
}

/** Modelled people in one building: P = res_pop * f_res + work_pop * f_work * festival. An estimate, never a count. */
export function estimate(props: ValueProps, hour: number, day: DayType, profiles: Profiles, festival = 1): Estimate {
  const residents = (props.res_pop ?? 0) * profiles.residents[day][hour]!;
  const workers = (props.work_pop ?? 0) * workerCurves(profiles, props.use_class)[day][hour]! * festival;
  const people = residents + workers;
  return { residents, workers, people, density: (people / Math.max(props.floor_area_m2 ?? 1, 1)) * 1000 };
}

/** Pilot-wide people for an hour: the per-building formula summed over the class totals. A modelled estimate. */
export function totalsAt(profiles: Profiles, hour: number, day: DayType, festival = 1): { residents: number; workers: number; people: number } {
  const residents = profiles.totals.residents * profiles.residents[day][hour]!;
  let workers = 0;
  for (const [useClass, total] of Object.entries(profiles.totals.workers)) workers += total * workerCurves(profiles, useClass)[day][hour]! * festival;
  return { residents, workers, people: residents + workers };
}

/** The same formula as a MapLibre expression. Only the numbers for the chosen hour and day type are inlined, so changing the hour swaps the expression. */
export function peopleExpression(profiles: Profiles, hour: number, day: DayType, festival: number): ExpressionSpecification {
  const classes = Object.keys(profiles.workers).filter((name) => name !== 'unknown');
  const match: unknown[] = ['match', ['get', 'use_class']];
  for (const name of classes) match.push(name, profiles.workers[name]![day][hour]!);
  match.push(profiles.workers.unknown![day][hour]!); // fallback for a class with no curve
  return [
    '+',
    ['*', ['coalesce', ['get', 'res_pop'], 0], profiles.residents[day][hour]!],
    ['*', ['coalesce', ['get', 'work_pop'], 0], match as ExpressionSpecification, festival],
  ];
}

export function metricExpression(profiles: Profiles, metric: Metric, hour: number, day: DayType, festival: number): ExpressionSpecification {
  const people = peopleExpression(profiles, hour, day, festival);
  if (metric === 'total') return people;
  return ['/', ['*', people, 1000], ['max', ['coalesce', ['get', 'floor_area_m2'], 1], 1]];
}

/** Fixed break points for every hour (plan C25), so the city visibly fills and empties. Below the first break a building keeps the neutral colour. */
export function colourExpression(
  profiles: Profiles,
  metric: Metric,
  hour: number,
  day: DayType,
  festival: number,
  palette: readonly string[],
  neutral: string,
): ExpressionSpecification {
  const breaks = metric === 'density' ? profiles.scale.density_breaks : profiles.scale.total_breaks;
  if (palette.length !== breaks.length) throw new Error(`palette has ${palette.length} colours for ${breaks.length} break points`);
  const steps: unknown[] = [];
  breaks.forEach((value, i) => steps.push(value, palette[i]));
  return ['step', metricExpression(profiles, metric, hour, day, festival), neutral, ...steps] as ExpressionSpecification;
}

/** Legend rows, lowest first: a swatch colour and a label for each colour class. */
export function legendRows(profiles: Profiles, metric: Metric, palette: readonly string[], neutral: string) {
  const breaks = metric === 'density' ? profiles.scale.density_breaks : profiles.scale.total_breaks;
  const rows = [{ colour: neutral, label: `Under ${breaks[0]}`, short: `<${breaks[0]}` }];
  breaks.forEach((low, i) => {
    const high = breaks[i + 1];
    rows.push({ colour: palette[i]!, label: high === undefined ? `${low} or more` : `${low} to ${high}`, short: high === undefined ? `${low}+` : `${low}–${high}` });
  });
  return rows;
}
