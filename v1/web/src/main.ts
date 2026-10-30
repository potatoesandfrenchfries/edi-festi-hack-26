import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './styles.css';
import {
  addBuildings, BUILDING_COLOUR, BUILDINGS_LAYER, BUILDINGS_SOURCE, INFERRED_COLOUR, INFERRED_LAYER, PARTS_LAYER, registerPmtiles,
  setBuildingsMinZoom, setHeights, setInferredColour, setInferredVisible, setOccupancyColour, setTowersVisible, tilesAvailable, TILES_PATH,
} from './buildings';
import { PILOT_CENTRE, PILOT_VIEW, basemapStyleUrl } from './config';
import { initControls } from './controls';
import { PRESETS, SPEED_TEST_SECONDS, pixelRatioFor, speedAdvice } from './display';
import { PALETTE } from './palette';
import { measureScrub } from './perf';
import { describeBuilding, describeInferred, formatCount, showPopup, type BuildingProps } from './popup';
import { colourExpression, legendRows, METRIC_LABELS, totalsAt, type Profiles } from './presence';
import { loadSettings, saveSettings, type Settings, type Theme } from './settings';
import { blankStyle } from './style';

maplibregl.setWorkerUrl(workerUrl);
registerPmtiles();

const PROFILES_PATH = 'data/profiles.json';
const PLAY_STEP_MS = 700;
const PLAY_STEP_REDUCED_MS = 1800; // reduced motion: slower, discrete steps

const colourScheme = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const tilesUrl = new URL(TILES_PATH, document.baseURI).href;
const darkFor = (theme: Theme) => theme === 'dark' || (theme === 'system' && colourScheme.matches);

const hideLoading = () => document.getElementById('loading')?.classList.add('is-done');

async function loadProfiles(): Promise<Profiles | null> {
  try {
    const response = await fetch(new URL(PROFILES_PATH, document.baseURI));
    if (!response.ok) return null;
    const data = (await response.json()) as Profiles;
    return data.workers?.unknown && data.residents?.weekday && data.totals ? data : null;
  } catch {
    return null;
  }
}

async function main() {
  const profiles = await loadProfiles();
  const range = profiles?.festival ?? { min: 1, max: 1.5, step: 0.05, default: 1 };
  const settings = loadSettings(range);

  // The basemap comes from a public service. If it cannot be loaded the map falls back to a flat background, so the buildings still show.
  let basemapFailed = false;
  let styleLoaded = false;
  const styleFor = (theme: Theme) => (basemapFailed ? null : basemapStyleUrl(darkFor(theme))) ?? blankStyle(darkFor(theme));
  const applyStyle = (theme: Theme) => {
    styleLoaded = false;
    map.setStyle(styleFor(theme), { diff: false }); // a full reload, so 'style.load' fires and the building layers are added again
  };

  const map = new maplibregl.Map({
    container: 'map',
    style: styleFor(settings.theme),
    center: PILOT_CENTRE,
    ...PILOT_VIEW,
    minZoom: 9,
    maxPitch: 70,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Buildings: © OpenStreetMap contributors, Overture Maps · Heights: LiDAR for Scotland (OGL v3.0)',
    }),
    'bottom-right',
  );

  const state = { buildings: false };
  const handle: Record<string, unknown> = { map, state };
  // Read-only handle for browser tests and debugging.
  (window as unknown as { edinburghPresence: unknown }).edinburghPresence = handle;

  const dataReady = (async () => profiles !== null && (await tilesAvailable(tilesUrl)))();
  let app: ReturnType<typeof createApp> | null = null;

  map.on('style.load', async () => {
    styleLoaded = true;
    state.buildings = false;
    if (!profiles || !(await dataReady)) {
      const notice = document.getElementById('notice');
      if (notice) notice.hidden = false;
      hideLoading();
      return;
    }
    app ??= createApp(map, profiles, settings, handle, applyStyle, () => basemapFailed);
    app.install();
    state.buildings = true;
    map.once('idle', hideLoading); // the first frame with the buildings drawn
    setTimeout(hideLoading, 15000); // never leave the overlay up if the map never goes idle
  });
  map.on('error', () => {
    if (styleLoaded || basemapFailed) return;
    basemapFailed = true; // the style itself could not load (offline, blocked or a bad URL)
    applyStyle(app?.settings.theme ?? settings.theme);
  });
}

function createApp(
  map: maplibregl.Map,
  profiles: Profiles,
  initial: Settings,
  handle: Record<string, unknown>,
  applyStyle: (theme: Theme) => void,
  basemapFailed: () => boolean,
) {
  let settings = initial;
  let frame = 0;
  let timer: number | null = null;
  let styleDark = darkFor(initial.theme);

  const isDark = () => darkFor(settings.theme);
  const neutral = () => (isDark() ? BUILDING_COLOUR.dark : BUILDING_COLOUR.light);
  const hasLayers = () => Boolean(map.getLayer(BUILDINGS_LAYER));

  function paint() {
    frame = 0;
    if (settings.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
    if (isDark() !== styleDark) {
      styleDark = isDark();
      applyStyle(settings.theme); // 'style.load' then calls install(), which paints again
      return;
    }
    renderHeadline();
    renderLegend();
    if (!hasLayers()) return;
    setInferredColour(map, isDark());
    applyDisplay();
    setOccupancyColour(map, colourExpression(profiles, settings.metric, settings.hour, settings.day, settings.festival, PALETTE, neutral()));
  }
  // Layer switches and the performance preset. Run on every paint, so they survive a style reload.
  let pixelRatio = 0;
  function applyDisplay() {
    const preset = PRESETS[settings.preset];
    setInferredVisible(map, settings.showInferred && preset.inferred);
    setTowersVisible(map, settings.showTowers);
    setHeights(map, settings.heights3d);
    setBuildingsMinZoom(map, preset.minZoom);
    const wanted = pixelRatioFor(settings.preset, window.devicePixelRatio || 1);
    if (wanted !== pixelRatio) map.setPixelRatio((pixelRatio = wanted));
    updateZoomHint();
  }
  // Several input events in one frame (a fast scrub) cost one expression swap.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  function renderHeadline() {
    const totals = totalsAt(profiles, settings.hour, settings.day, settings.festival);
    controls.setHeadline({ people: formatCount(totals.people), residents: formatCount(totals.residents), workers: formatCount(totals.workers) });
  }

  function renderLegend() {
    const list = document.getElementById('legend');
    const title = document.getElementById('legend-title');
    const inferred = document.querySelector<HTMLElement>('#legend-inferred i');
    if (!list || !title) return;
    title.textContent = `${METRIC_LABELS[settings.metric]} (estimates)`;
    inferred?.style.setProperty('--swatch', isDark() ? INFERRED_COLOUR.dark : INFERRED_COLOUR.light);
    list.replaceChildren(
      ...legendRows(profiles, settings.metric, PALETTE, neutral()).map((row) => {
        const item = document.createElement('li');
        item.title = row.label;
        item.setAttribute('aria-label', row.label);
        const swatch = document.createElement('i');
        swatch.style.setProperty('--swatch', row.colour);
        item.append(swatch, row.short);
        return item;
      }),
    );
  }

  const controls = initControls(
    settings,
    profiles.festival,
    {
      change(next) {
        settings = next;
        saveSettings(next);
        schedule();
      },
      play(playing) {
        setPlaying(playing);
      },
      async speedTest() {
        setPlaying(false);
        const before = controls.settings.hour;
        const result = await measureScrub((hour) => controls.setHour(hour), SPEED_TEST_SECONDS);
        controls.setHour(before);
        return speedAdvice(result.medianFps, settings.preset).text;
      },
    },
    reducedMotion,
  );

  function setPlaying(playing: boolean) {
    if (timer !== null) clearInterval(timer);
    timer = null;
    controls.setPlaying(playing);
    if (playing) timer = window.setInterval(() => controls.setHour((controls.settings.hour + 1) % 24), reducedMotion.matches ? PLAY_STEP_REDUCED_MS : PLAY_STEP_MS);
  }
  // A user who turns on reduced motion mid-play gets the slower cadence straight away.
  reducedMotion.addEventListener('change', () => timer !== null && setPlaying(true));
  colourScheme.addEventListener('change', schedule);

  document.getElementById('profile-notice')!.hidden = false;
  // Buildings are drawn from zoom 13 (a whole city of extruded buildings would be too heavy), so say so when zoomed out.
  const zoomHint = document.getElementById('zoom-hint')!;
  function updateZoomHint() {
    zoomHint.hidden = map.getZoom() >= PRESETS[settings.preset].minZoom;
  }
  map.on('zoom', updateZoomHint);

  // Popups. A tower part shows the building it stands on.
  const hit = (event: maplibregl.MapMouseEvent) =>
    hasLayers() ? map.queryRenderedFeatures(event.point, { layers: [PARTS_LAYER, BUILDINGS_LAYER, INFERRED_LAYER] })[0] : undefined;
  map.on('click', (event) => {
    const feature = hit(event);
    if (!feature) return;
    const popupState = { day: settings.day, hour: settings.hour, festival: settings.festival };
    if (feature.layer.id === INFERRED_LAYER) return void showPopup(map, event.lngLat, describeInferred(feature.properties));
    let props = feature.properties as BuildingProps & { parent_id?: string };
    if (feature.layer.id === PARTS_LAYER && props.parent_id) {
      const parent = map.querySourceFeatures(BUILDINGS_SOURCE, { sourceLayer: 'buildings', filter: ['==', ['get', 'id'], props.parent_id] })[0];
      if (parent) props = parent.properties as BuildingProps;
    }
    showPopup(map, event.lngLat, describeBuilding(props, popupState, profiles));
  });
  map.on('mousemove', (event) => {
    map.getCanvas().style.cursor = hit(event) ? 'pointer' : '';
  });

  handle.settings = () => ({ ...settings });
  handle.measureScrub = (seconds?: number) => measureScrub((hour) => controls.setHour(hour), seconds);

  return {
    /** Adds the building layers to the current style and paints them. Called on every 'style.load'. */
    install() {
      addBuildings(map, tilesUrl, isDark());
      paint();
      if (basemapFailed()) controls.setStatus('warning', 'Basemap unavailable. Showing a flat background.');
      else controls.setStatus('ready', `${profiles.totals.buildings.toLocaleString('en-GB')} buildings · modelled estimates`);
    },
    get settings() {
      return settings;
    },
  };
}

void main();
