// The festival controls, added to the existing panel from here rather than written into index.html: a date for the building layer,
// the festival surge figures, a switch that sends audiences to venues in cars, the park-and-ride lever, and the table of configurations
// the scenario sweep tried. It keeps its own small state (saved on its own) and tells main.ts what changed. Modelled estimates only.
import { dateLabel } from './demand';
import { rows, summary, type Objective, type SweepFile } from './scenario-view';
import type { Levers } from './trip-demand';

const KEY = 'edinburgh-festival-settings';

export interface FestivalState {
  /** Index into the festival dates. */
  dateIndex: number;
  showSurge: boolean;
  trips: boolean;
  parkAndRide: number;
}

export interface FestivalEvents {
  change(state: FestivalState): void;
  /** The user chose a row of the results table: set these levers. */
  apply(levers: Levers): void;
}

export interface SurgeFigures {
  audience: number;
  guests: number;
  occupancy: number;
}

export const DEFAULT_STATE: FestivalState = { dateIndex: 12, showSurge: true, trips: true, parkAndRide: 0 };

export function sanitiseState(raw: unknown, dates: number, parkAndRide: { min: number; max: number }): FestivalState {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const index = typeof input.dateIndex === 'number' && Number.isInteger(input.dateIndex) ? input.dateIndex : DEFAULT_STATE.dateIndex;
  const par = typeof input.parkAndRide === 'number' && Number.isFinite(input.parkAndRide) ? input.parkAndRide : DEFAULT_STATE.parkAndRide;
  return {
    dateIndex: Math.min(Math.max(index, 0), Math.max(dates - 1, 0)),
    showSurge: input.showSurge !== false,
    trips: input.trips !== false,
    parkAndRide: Math.min(Math.max(par, parkAndRide.min), parkAndRide.max),
  };
}

function load(dates: number, range: { min: number; max: number }): FestivalState {
  try {
    const text = window.localStorage.getItem(KEY);
    return sanitiseState(text ? JSON.parse(text) : null, dates, range);
  } catch {
    return sanitiseState(null, dates, range);
  }
}
function save(state: FestivalState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not saving is fine.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const toggle = (id: string, title: string, hint: string) =>
  el('div', { className: 'toggle-card' }, el('label', { className: 'layer-toggle' }, el('span', { className: 'layer-text' }, title, el('small', { textContent: hint })), Object.assign(document.createElement('input'), { type: 'checkbox', id, role: 'switch' })));

export class FestivalPanel {
  private current: FestivalState;
  private readonly date: HTMLInputElement;
  private readonly surge: HTMLInputElement;
  private readonly trips: HTMLInputElement;
  private readonly par: HTMLInputElement;
  private readonly stats: Record<'audience' | 'guests' | 'occupancy', HTMLElement>;
  private readonly tripInfo: HTMLElement;
  private objective: Objective = 'cost';

  constructor(
    private readonly dates: readonly string[],
    private readonly parRange: { min: number; max: number; step: number },
    private readonly sweep: SweepFile | null,
    private readonly hasCars: boolean,
    private readonly events: FestivalEvents,
  ) {
    this.current = load(dates.length, parRange);

    // Explore: the date, the surge figures, and the map switch.
    const explore = document.getElementById('view-explore');
    this.date = Object.assign(document.createElement('input'), { type: 'range', id: 'festival-date', min: '0', max: String(Math.max(dates.length - 1, 0)), step: '1' });
    this.date.setAttribute('aria-label', 'Festival date');
    const dateOut = el('output', { id: 'festival-date-label' });
    const stat = (label: string, id: string) => {
      const dd = el('dd', { id, textContent: '…' });
      return { box: el('div', { className: 'stat' }, el('dt', { textContent: label }), dd), dd };
    };
    const [audience, guests, occupancy] = [stat('At venues now', 'surge-audience'), stat('Extra guests in beds', 'surge-guests'), stat('Beds occupied that night', 'surge-occupancy')];
    this.stats = { audience: audience.dd, guests: guests.dd, occupancy: occupancy.dd };
    this.surge = toggle('festival-surge', 'Festival surge on the map', 'Shades buildings by the extra people the festivals put in them: audiences at venues and guests in beds.').querySelector('input')!;
    explore?.querySelector('.section-heading')?.after(
      el('div', { className: 'card', id: 'festival-explore' },
        el('div', { className: 'card-head' }, el('span', { textContent: 'Festival date' }), dateOut),
        this.date,
        el('div', { className: 'range-labels' }, el('span', { textContent: dateLabel(dates[0] ?? '') }), el('span', { textContent: dateLabel(dates[dates.length - 1] ?? '') })),
      ),
      el('dl', { className: 'stats', ariaLabel: 'Festival surge in the mapped area, estimated' }, audience.box, guests.box, occupancy.box),
      this.surge.closest('.toggle-card')!,
      el('p', { className: 'hint', textContent: 'Audiences come from 2026 ticket counts (Fringe venues sit on assumed hubs); guests are beds in hotels, halls and licensed short-term lets above the usual occupancy. Estimates, not counts.' }),
    );
    // The old day-type buttons are replaced by the date; the date sets the day type.
    document.getElementById('day-types')?.setAttribute('hidden', '');

    // Scenario: the trips, the park-and-ride lever and the results. The manual multiplier it replaces is hidden.
    const scenario = document.getElementById('view-scenario');
    const oldHeading = scenario?.querySelector('.section-heading');
    const oldCard = document.getElementById('festival')?.closest('.card');
    const oldHint = oldCard?.nextElementSibling;
    for (const node of [oldHeading, oldCard, oldHint]) node?.setAttribute('hidden', '');
    this.trips = toggle('festival-trips', 'Send audiences to venues by car', 'Cars follow the ticket counts: they enter by the road for where their booker lives and drive to the venue, then leave after the show.').querySelector('input')!;
    this.par = Object.assign(document.createElement('input'), { type: 'range', id: 'park-and-ride', min: String(parRange.min), max: String(parRange.max), step: String(parRange.step) });
    this.par.setAttribute('aria-label', 'Share of out-of-town drivers sent to park-and-ride');
    this.tripInfo = el('p', { className: 'hint', id: 'festival-trips-info', role: 'status' });
    const results = el('div', { id: 'scenario-results' });
    scenario?.prepend(
      el('div', { className: 'section-heading' }, el('h2', { textContent: 'Festival travel' }), el('p', { textContent: 'Audiences drive to the venues the tickets name. Change how they get there and see what it costs.' })),
      this.trips.closest('.toggle-card')!,
      el('div', { className: 'card' },
        el('div', { className: 'card-head' }, el('span', { textContent: 'Park-and-ride' }), el('output', { id: 'park-and-ride-label' })),
        this.par,
        el('div', { className: 'range-labels' }, el('span', { textContent: 'None' }), el('span', { textContent: `${Math.round(parRange.max * 100)}% of out-of-town drivers` })),
      ),
      this.tripInfo,
      el('div', { className: 'section-heading section-heading-next' }, el('h2', { textContent: 'Best configuration' }), el('p', { textContent: 'Every combination of bus frequency, park-and-ride and closures, run through the same evening.' })),
      results,
    );
    this.renderResults(results);

    this.date.addEventListener('input', () => this.update({ dateIndex: Number(this.date.value) }));
    this.surge.addEventListener('change', () => this.update({ showSurge: this.surge.checked }));
    this.trips.addEventListener('change', () => this.update({ trips: this.trips.checked }));
    this.par.addEventListener('input', () => this.update({ parkAndRide: Number(this.par.value) }));
    this.trips.disabled = !hasCars;
    this.par.disabled = !hasCars;
    this.render();
  }

  state(): FestivalState {
    return { ...this.current };
  }

  currentDate(): string {
    return this.dates[this.current.dateIndex] ?? '';
  }

  /** Moves the controls to these values without announcing a change (used when a table row is applied). */
  set(next: Partial<FestivalState>): void {
    this.current = sanitiseState({ ...this.current, ...next }, this.dates.length, this.parRange);
    save(this.current);
    this.render();
  }

  setSurge(figures: SurgeFigures | null): void {
    const f = (n: number) => Math.round(n).toLocaleString('en-GB');
    this.stats.audience.textContent = figures ? f(figures.audience) : '–';
    this.stats.guests.textContent = figures ? f(figures.guests) : '–';
    this.stats.occupancy.textContent = figures ? `${Math.round(figures.occupancy * 100)}%` : '–';
  }

  setTripInfo(text: string): void {
    this.tripInfo.textContent = text;
  }

  private update(next: Partial<FestivalState>): void {
    this.current = sanitiseState({ ...this.current, ...next }, this.dates.length, this.parRange);
    save(this.current);
    this.render();
    this.events.change(this.state());
  }

  private render(): void {
    const s = this.current;
    this.date.value = String(s.dateIndex);
    const label = dateLabel(this.currentDate());
    document.getElementById('festival-date-label')!.textContent = label;
    this.date.setAttribute('aria-valuetext', label);
    this.surge.checked = s.showSurge;
    this.trips.checked = s.trips && this.hasCars;
    this.par.value = String(s.parkAndRide);
    document.getElementById('park-and-ride-label')!.textContent = s.parkAndRide > 0 ? `${Math.round(s.parkAndRide * 100)}%` : 'none';
  }

  private renderResults(root: HTMLElement): void {
    if (!this.sweep) {
      root.replaceChildren(el('p', { className: 'hint', textContent: 'Not built. Run npm run scenarios in web/ (several minutes), then reload.' }));
      return;
    }
    const sweep = this.sweep;
    const by = this.objective;
    const choose = (name: Objective, label: string) => {
      const button = el('button', { type: 'button', className: name === by ? 'btn-primary' : 'btn-soft', textContent: label });
      button.setAttribute('aria-pressed', String(name === by));
      button.addEventListener('click', () => {
        this.objective = name;
        this.renderResults(root);
      });
      return button;
    };
    const table = el('table', { className: 'scenario-table' }, el('thead', {}, el('tr', {}, ...['Configuration', 'Cost', 'Festival adds', 'Revenue', 'CO₂e', 'vs today', ''].map((h) => el('th', { textContent: h, scope: 'col' })))));
    const body = el('tbody');
    for (const row of rows(sweep, 8, by)) {
      const use = el('button', { type: 'button', className: 'btn-soft', textContent: row.isToday ? 'Today' : 'Use' });
      use.disabled = row.isToday;
      use.addEventListener('click', () => this.events.apply(row.levers));
      body.append(el('tr', { className: row.isBest ? 'is-best' : '' }, el('td', { textContent: row.label + (row.isBest ? (by === 'cost' ? ' (cheapest)' : ' (lowest carbon)') : '') }), el('td', { textContent: row.cost }), el('td', { textContent: row.extraCost }), el('td', { textContent: row.revenue }), el('td', { textContent: row.co2 }), el('td', { textContent: row.change }), el('td', {}, use)));
    }
    table.append(body);
    root.replaceChildren(el('div', { className: 'row' }, choose('cost', 'Cheapest'), choose('co2', 'Lowest carbon')), ...summary(sweep, by).map((line) => el('p', { className: 'hint', textContent: line })), table, el('p', { className: 'hint', textContent: `Costs for ${sweep.date}, 18:00 to midnight: lost time, fuel and carbon (placeholder prices). "Festival adds" is the run less the same evening without the festival. "Revenue" is bus fares, the visitor levy for the night and parking, less extra bus running (placeholder rates; blank if the sweep was built without it). Built ${sweep.generated}.` }));
  }
}
