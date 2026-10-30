import type { BusSpeed } from './buses';
import type { CarStatsMessage } from './cars-protocol';
import type { TrafficStats } from './traffic';
import { PRESETS, PRESET_NAMES, type Preset } from './display';
import type { Range } from './impact';
import { hourLabel } from './popup';
import type { DayType } from './presence';
import type { Settings, Theme } from './settings';

const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = {
  system: 'Theme: follow system. Activate to use light.',
  light: 'Theme: light. Activate to use dark.',
  dark: 'Theme: dark. Activate to follow system.',
};

export interface ControlEvents {
  change(settings: Settings): void;
  /** Play was toggled. The caller owns the timer. */
  play(playing: boolean): void;
  /** The speed test button was pressed. Resolves with the text to show. */
  speedTest(): Promise<string>;
  /** The Restart the day button was pressed: the caller owns the ledger. */
  restartDay(): void;
}

export type Status = 'loading' | 'ready' | 'warning' | 'error';

/** The Impact tab's text. Strings are already formatted, so the DOM code here stays dumb. */
export interface ImpactView {
  total: string;
  time: string;
  fuel: string;
  co2: string;
  carbon: string;
  cars: string;
  buses: string;
  clock: string;
  lines: string[];
}

export interface Headline {
  people: string;
  residents: string;
  workers: string;
}

/** Wires the panel in index.html. All state lives in `settings`; the DOM is only a view of it. */
export function initControls(
  initial: Settings,
  festivalRange: { min: number; max: number; step: number },
  events: ControlEvents,
  reducedMotion: MediaQueryList,
  /** Bounds of the traffic scenario sliders, from config/economics.yaml. Without them the sliders keep the markup's bounds. */
  scenario?: { busFrequency: Range; carDemand: Range },
) {
  const settings = { ...initial };
  const panel = $('panel');
  const hour = $<HTMLInputElement>('hour');
  const festival = $<HTMLInputElement>('festival');
  const play = $<HTMLButtonElement>('play');
  const theme = $<HTMLButtonElement>('theme');
  const minimise = $<HTMLButtonElement>('minimise');
  const showInferred = $<HTMLInputElement>('show-inferred');
  const showTowers = $<HTMLInputElement>('show-towers');
  const showHeights = $<HTMLInputElement>('show-heights');
  const showBuses = $<HTMLInputElement>('show-buses');
  const busTraffic = $<HTMLInputElement>('bus-traffic');
  const showCars = $<HTMLInputElement>('show-cars');
  const coupling = $<HTMLInputElement>('bus-car-coupling');
  const busFrequency = $<HTMLInputElement>('bus-frequency');
  const carDemand = $<HTMLInputElement>('car-demand');
  const speedTest = $<HTMLButtonElement>('speed-test');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const indicator = panel.querySelector<HTMLElement>('.tab-indicator')!;

  festival.min = String(festivalRange.min);
  festival.max = String(festivalRange.max);
  festival.step = String(festivalRange.step);

  for (const [input, range] of [[busFrequency, scenario?.busFrequency], [carDemand, scenario?.carDemand]] as const) {
    if (!range) continue;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
  }
  const normal = { busFrequency: scenario?.busFrequency.default ?? 1, carDemand: scenario?.carDemand.default ?? 1 };

  for (const name of PRESET_NAMES) $(`preset-${name}`).textContent = PRESETS[name].description;
  const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];

  function render() {
    for (const radio of radios('day')) radio.checked = radio.value === settings.day;
    hour.value = String(settings.hour);
    hour.setAttribute('aria-valuetext', hourLabel(settings.hour));
    $('hour-label').textContent = hourLabel(settings.hour);
    festival.value = String(settings.festival);
    $('festival-label').textContent = `×${settings.festival.toFixed(2)}`;
    festival.setAttribute('aria-valuetext', `multiplier ${settings.festival.toFixed(2)}`);
    $('festival-reset').hidden = settings.festival === festivalRange.min;
    busFrequency.value = String(settings.busFrequency);
    $('bus-frequency-label').textContent = `×${settings.busFrequency.toFixed(2)}`;
    busFrequency.setAttribute('aria-valuetext', `${settings.busFrequency.toFixed(2)} times the timetable`);
    busFrequency.disabled = showBuses.disabled; // no bus data, nothing to change
    $('bus-frequency-reset').hidden = settings.busFrequency === normal.busFrequency;
    carDemand.value = String(settings.carDemand);
    $('car-demand-label').textContent = `×${settings.carDemand.toFixed(2)}`;
    carDemand.setAttribute('aria-valuetext', `${settings.carDemand.toFixed(2)} times a normal day`);
    carDemand.disabled = showCars.disabled;
    $('car-demand-reset').hidden = settings.carDemand === normal.carDemand;
    showInferred.checked = settings.showInferred;
    showTowers.checked = settings.showTowers;
    showHeights.checked = settings.heights3d;
    showBuses.checked = settings.showBuses;
    busTraffic.checked = settings.busTraffic;
    showCars.checked = settings.showCars;
    coupling.checked = settings.busCarCoupling;
    // Coupling needs both layers on; say why it is idle rather than letting the switch look broken.
    $('coupling-hint').textContent = settings.showCars && !showCars.disabled
      ? 'A bus stopped at a stop slows the cars behind it; queued cars hold buses up. Needs both layers.'
      : 'Needs the simulated cars as well as the buses.';
    $('car-stats').hidden = !settings.showCars || showCars.disabled;
    for (const radio of radios('busspeed')) radio.checked = Number(radio.value) === settings.busSpeed;
    $('bus-speeds').hidden = !settings.showBuses || showBuses.disabled;
    $('bus-traffic-card').hidden = !settings.showBuses || showBuses.disabled;
    for (const radio of radios('preset')) radio.checked = radio.value === settings.preset;
    theme.dataset.themeSetting = settings.theme;
    theme.setAttribute('aria-label', THEME_LABEL[settings.theme]);
    panel.dataset.minimised = String(settings.minimised);
    minimise.setAttribute('aria-expanded', String(!settings.minimised));
    minimise.setAttribute('aria-label', settings.minimised ? 'Expand controls' : 'Minimise controls');
    minimise.innerHTML = settings.minimised
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
  }
  const update = (patch: Partial<Settings>) => {
    Object.assign(settings, patch);
    render();
    if (patch.minimised === false) placeIndicator(false);
    events.change({ ...settings });
  };

  // Tabs: roving tabindex, arrow keys, and a pill that slides to the selected tab.
  function placeIndicator(animate: boolean) {
    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    if (!selected || selected.offsetWidth === 0) return; // hidden while the panel is minimised
    indicator.classList.toggle('is-animating', animate && !reducedMotion.matches);
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.transform = `translateX(${selected.offsetLeft}px)`;
    indicator.classList.add('is-positioned');
  }
  function selectTab(tab: HTMLButtonElement, focus = false) {
    for (const other of tabs) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      other.tabIndex = on ? 0 : -1;
      $(other.getAttribute('aria-controls')!).hidden = !on;
    }
    placeIndicator(true);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const target = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i + tabs.length - 1) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] }[event.key];
      if (!target) return;
      event.preventDefault();
      selectTab(target, true);
    });
  });
  new ResizeObserver(() => placeIndicator(false)).observe(indicator.parentElement!);

  for (const radio of radios('day')) radio.addEventListener('change', () => radio.checked && update({ day: radio.value as DayType }));
  hour.addEventListener('input', () => update({ hour: Number(hour.value) }));
  festival.addEventListener('input', () => update({ festival: Number(festival.value) }));
  $('festival-reset').addEventListener('click', () => update({ festival: festivalRange.min }));
  busFrequency.addEventListener('input', () => update({ busFrequency: Number(busFrequency.value) }));
  $('bus-frequency-reset').addEventListener('click', () => update({ busFrequency: normal.busFrequency }));
  carDemand.addEventListener('input', () => update({ carDemand: Number(carDemand.value) }));
  $('car-demand-reset').addEventListener('click', () => update({ carDemand: normal.carDemand }));
  $('impact-restart').addEventListener('click', () => events.restartDay());
  showInferred.addEventListener('change', () => update({ showInferred: showInferred.checked }));
  showTowers.addEventListener('change', () => update({ showTowers: showTowers.checked }));
  showHeights.addEventListener('change', () => update({ heights3d: showHeights.checked }));
  showBuses.addEventListener('change', () => update({ showBuses: showBuses.checked }));
  busTraffic.addEventListener('change', () => update({ busTraffic: busTraffic.checked }));
  showCars.addEventListener('change', () => update({ showCars: showCars.checked }));
  coupling.addEventListener('change', () => update({ busCarCoupling: coupling.checked }));
  for (const radio of radios('busspeed')) radio.addEventListener('change', () => radio.checked && update({ busSpeed: Number(radio.value) as BusSpeed }));
  for (const radio of radios('preset')) radio.addEventListener('change', () => radio.checked && update({ preset: radio.value as Preset }));
  speedTest.addEventListener('click', async () => {
    speedTest.disabled = true;
    speedTest.textContent = 'Testing…';
    $('speed-result').textContent = 'Scrubbing the hour for a few seconds. Please wait.';
    try {
      $('speed-result').textContent = await events.speedTest();
    } finally {
      speedTest.disabled = false;
      speedTest.textContent = 'Test speed';
    }
  });
  theme.addEventListener('click', () => update({ theme: THEME_NEXT[settings.theme] }));
  minimise.addEventListener('click', () => update({ minimised: !settings.minimised }));
  play.addEventListener('click', () => events.play(play.getAttribute('aria-pressed') !== 'true'));

  render();
  panel.hidden = false;
  placeIndicator(false);
  // The map's own controls need to sit above the panel when it is a bottom sheet on a phone.
  new ResizeObserver(() => document.documentElement.style.setProperty('--panel-h', `${panel.offsetHeight}px`)).observe(panel);

  return {
    /** Sets the hour from outside the panel (the play timer) without treating it as a user gesture. */
    setHour(value: number) {
      update({ hour: value });
    },
    setPlaying(playing: boolean) {
      play.setAttribute('aria-pressed', String(playing));
      play.textContent = playing ? 'Pause' : 'Play';
    },
    setStatus(status: Status, text: string) {
      const line = $('status');
      line.dataset.status = status;
      line.querySelector('span')!.textContent = text;
    },
    /** Live traffic figures under the bus switches, or a note that the timetable replay (no interaction) is showing. */
    setBusStats(stats: TrafficStats | null) {
      $('bus-stats').textContent = stats
        ? `${stats.buses} buses · average ${stats.avgKmh.toFixed(0)} km/h · ${stats.slow} slow (under 11 km/h) · ${stats.congestedCells} congested ${stats.congestedCells === 1 ? 'spot' : 'spots'}`
        : 'Timetable replay: buses never react to each other.';
    },
    /** Without the road graph (`make cars` not run) the cars switch is disabled and says why. */
    setCarsAvailable(available: boolean) {
      showCars.disabled = !available;
      $('show-cars-hint').textContent = available
        ? 'Cars driving the mapped streets, queueing at signals. Not real traffic.'
        : 'Not built. Run make cars, then reload.';
      render();
    },
    /** The car worker's live figures, or null while the cars are off or stopped. */
    setCarStats(stats: (CarStatsMessage & { requestedSpeed: number }) | null) {
      const line = $('car-stats');
      if (!stats) {
        line.textContent = '';
        return;
      }
      const behind = stats.achievedSpeed > 0 && stats.achievedSpeed < stats.requestedSpeed * 0.8;
      line.textContent =
        `${stats.cars.toLocaleString('en-GB')} cars · average ${stats.averageKmh.toFixed(0)} km/h · ${stats.gridlocked} stuck · ` +
        `${stats.signals} signals · ${stats.relocated.toLocaleString('en-GB')} moved to unjam · running at ${stats.achievedSpeed.toFixed(0)}×` +
        (stats.slowedByBuses > 0 ? ` · ${stats.slowedByBuses} roads slowed by buses` : '') +
        (behind ? ` (asked for ${stats.requestedSpeed}×)` : '');
    },
    /** Without the bus data (`make buses` not run) the switch is disabled and says why. */
    setBusesAvailable(available: boolean) {
      showBuses.disabled = !available;
      $('show-buses-hint').textContent = available
        ? 'Lothian routes on a regular headway. A simulation, not live positions.'
        : 'Not built. Run make buses, then reload.';
      render();
    },
    /** The Impact tab: the day's running totals and the generated sentences about them. */
    setImpact(view: ImpactView) {
      $('impact-total').textContent = view.total;
      $('impact-time').textContent = view.time;
      $('impact-fuel').textContent = view.fuel;
      $('impact-co2').textContent = view.co2;
      $('impact-carbon').textContent = view.carbon;
      $('impact-cars').textContent = view.cars;
      $('impact-buses').textContent = view.buses;
      $('impact-clock').textContent = view.clock;
      const box = $('impact-commentary');
      const same = box.childElementCount === view.lines.length && view.lines.every((line, i) => box.children[i]?.textContent === line);
      if (same) return;
      box.replaceChildren(...view.lines.map((line) => Object.assign(document.createElement('p'), { textContent: line })));
    },
    setHeadline(values: Headline) {
      $('stat-people').textContent = values.people;
      $('stat-residents').textContent = values.residents;
      $('stat-workers').textContent = values.workers;
    },
    get settings() {
      return { ...settings };
    },
  };
}
