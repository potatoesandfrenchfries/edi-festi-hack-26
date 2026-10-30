import { PRESETS, PRESET_NAMES, type Preset } from './display';
import { hourLabel } from './popup';
import type { DayType, Metric } from './presence';
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
}

export type Status = 'loading' | 'ready' | 'warning' | 'error';

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
  const speedTest = $<HTMLButtonElement>('speed-test');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const indicator = panel.querySelector<HTMLElement>('.tab-indicator')!;

  festival.min = String(festivalRange.min);
  festival.max = String(festivalRange.max);
  festival.step = String(festivalRange.step);

  for (const name of PRESET_NAMES) $(`preset-${name}`).textContent = PRESETS[name].description;
  const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];

  function render() {
    for (const radio of radios('day')) radio.checked = radio.value === settings.day;
    for (const radio of radios('metric')) radio.checked = radio.value === settings.metric;
    hour.value = String(settings.hour);
    hour.setAttribute('aria-valuetext', hourLabel(settings.hour));
    $('hour-label').textContent = hourLabel(settings.hour);
    festival.value = String(settings.festival);
    $('festival-label').textContent = `×${settings.festival.toFixed(2)}`;
    festival.setAttribute('aria-valuetext', `multiplier ${settings.festival.toFixed(2)}`);
    $('festival-reset').hidden = settings.festival === festivalRange.min;
    showInferred.checked = settings.showInferred;
    showTowers.checked = settings.showTowers;
    showHeights.checked = settings.heights3d;
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
  for (const radio of radios('metric')) radio.addEventListener('change', () => radio.checked && update({ metric: radio.value as Metric }));
  hour.addEventListener('input', () => update({ hour: Number(hour.value) }));
  festival.addEventListener('input', () => update({ festival: Number(festival.value) }));
  $('festival-reset').addEventListener('click', () => update({ festival: festivalRange.min }));
  showInferred.addEventListener('change', () => update({ showInferred: showInferred.checked }));
  showTowers.addEventListener('change', () => update({ showTowers: showTowers.checked }));
  showHeights.addEventListener('change', () => update({ heights3d: showHeights.checked }));
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
