import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './styles.css';
import { BUSES_LAYER, BusSimulation, describeBus, loadBusData, type BusData } from './buses';
import { TENT_LAYER, TentLayer } from './tent';
import { CarSimulation, loadCarData } from './cars';
import { ClosureLayer, ClosureSchedule, loadClosures } from './closures';
import { BusCarCoupling } from './coupling';
import {
  addBuildings, BUILDINGS_LAYER, BUILDINGS_SOURCE, INFERRED_LAYER, PARTS_LAYER, registerPmtiles,
  setBuildingsMinZoom, setHeights, setInferredVisible, setTowersVisible, tilesAvailable, TILES_PATH,
} from './buildings';
import { PILOT_CENTRE, PILOT_VIEW, basemapStyleUrl } from './config';
import { initControls } from './controls';
import { dayTypeOf, festivalDates, loadAccommodation, loadDemand, slotAt, type Accommodation, type Demand } from './demand';
import { FestivalLayer, surgeFor } from './festival-layer';
import { FestivalPanel } from './festival-panel';
import { loadEconomics, type Economics } from './impact';
import { ImpactTracker } from './impact-tracker';
import { PRESETS, SPEED_TEST_SECONDS, pixelRatioFor, speedAdvice } from './display';
import { measureScrub } from './perf';
import { describeBuilding, describeInferred, formatCount, showPopup, type BuildingProps, type PopupState } from './popup';
import { totalsAt, type Profiles } from './presence';
import { departuresPerHour } from './scenario';
import { loadSweep, type SweepFile } from './scenario-view';
import { loadTransport, planSlot, tripVenues, type Transport } from './trip-demand';
import { emptyRates } from './trips';
import { loadSettings, saveSettings, type Settings, type Theme } from './settings';
import { renderLegend } from './legend';
import { blankStyle } from './style';

maplibregl.setWorkerUrl(workerUrl);
registerPmtiles();

const PROFILES_PATH = 'data/profiles.json';
/** The simulated day starts here when festival traffic is on, so the evening's audiences arrive within a minute or two of watching. */
const FESTIVAL_DAY_START_S = 17 * 3600;
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
  // Optional: without `make economics` there are no cost figures, and the Impact tab says so.
  const economics = await loadEconomics();
  const scenario = economics ? { busFrequency: economics.demand.bus_frequency, carDemand: economics.demand.car_demand } : undefined;
  const settings = loadSettings(range, undefined, scenario);

  // The basemap comes from a public service. If it cannot be loaded the map falls back to a flat background, so the buildings still show.
  let basemapFailed = false;
  let styleLoaded = false;
  const styleFor = (theme: Theme) => (basemapFailed ? null : basemapStyleUrl(darkFor(theme))) ?? blankStyle(darkFor(theme));
  const applyStyle = (theme: Theme) => {
    styleLoaded = false;
    map.setStyle(styleFor(theme), { diff: false }); // a full reload, so 'style.load' fires and the building layers are added again
  };

  // Optional: without `make buses` the map works as before and the bus switch says it is unavailable.
  // Awaited before the map exists: awaiting after would let 'style.load' fire before its handler is registered, leaving the overlay up.
  const busData = await loadBusData();
  const buses = busData ? new BusSimulation(busData, reducedMotion.matches ? 1000 : 33) : null;
  // Likewise optional: without `make cars` there are no cars and their switch says so.
  const carData = await loadCarData();
  const cars = carData ? new CarSimulation(carData, reducedMotion.matches ? 1000 : 100) : null;
  // Also optional (`make closures`): streets closed to vehicles on a Fringe day. They only matter to the cars, so need the road graph.
  const closureData = await loadClosures();
  const closures = carData && closureData ? new ClosureSchedule(closureData, carData) : null;
  // Also optional: the ticket-driven festival layer (`make demand accommodation tiles`), its travel assumptions (`make transport`) and the
  // sweep of configurations (`npm run scenarios`). Each is used if present and the page works without it.
  const festival = { demand: await loadDemand(), accommodation: await loadAccommodation(), transport: await loadTransport(), sweep: await loadSweep() };

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
    app ??= createApp(map, profiles, settings, handle, applyStyle, () => basemapFailed, buses, busData, cars, economics, closures, festival);
    app.install();
    state.buildings = true;
    // The first frame with the buildings drawn. The buses only start moving after this: they keep the map from ever going idle.
    const ready = () => {
      hideLoading();
      buses?.start();
      cars?.start();
    };
    map.once('idle', ready);
    setTimeout(ready, 15000); // never leave the overlay up if the map never goes idle
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
  buses: BusSimulation | null,
  busData: BusData | null,
  cars: CarSimulation | null,
  economics: Economics | null,
  closures: ClosureSchedule | null,
  festival: { demand: Demand | null; accommodation: Accommodation | null; transport: Transport | null; sweep: SweepFile | null },
) {
  const closureLayer = new ClosureLayer();
  // Buses and cars slow each other down; only when both exist (see coupling.ts).
  const coupling = buses && cars ? new BusCarCoupling(buses, cars) : null;
  let settings = initial;
  let frame = 0;
  let timer: number | null = null;
  let styleDark = darkFor(initial.theme);
  let tracker: ImpactTracker | null = null; // set once the controls exist; the controls' events use it

  const isDark = () => darkFor(settings.theme);
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
    const legend = document.getElementById('legend');
    if (legend) renderLegend(legend, isDark());
    renderHeadline();
    if (!hasLayers()) return;
    renderFestival();
    applyDisplay();
  }
  // Layer switches and the performance preset. Run on every paint, so they survive a style reload.
  let pixelRatio = 0;
  function applyDisplay() {
    const preset = PRESETS[settings.preset];
    setInferredVisible(map, settings.showInferred && preset.inferred);
    setTowersVisible(map, settings.showTowers);
    setHeights(map, settings.heights3d);
    buses?.setVisible(settings.showBuses);
    buses?.setSpeed(settings.busSpeed);
    buses?.setTraffic(settings.busTraffic);
    buses?.setFrequency(settings.busFrequency);
    cars?.setVisible(settings.showCars);
    cars?.setSpeed(settings.busSpeed);
    coupling?.setEnabled(settings.busCarCoupling);
    tracker?.setScenario({
      carsOn: cars !== null && settings.showCars,
      busesOn: buses !== null && settings.showBuses,
      busFrequency: settings.busFrequency,
      carDemand: settings.carDemand,
      day: settings.day,
      closuresOn: settings.festivalClosures,
    });
    if (closures) controls.setClosuresAvailable(true, closuresInfo());
    setBuildingsMinZoom(map, preset.minZoom);
    const wanted = pixelRatioFor(settings.preset, window.devicePixelRatio || 1);
    if (wanted !== pixelRatio) map.setPixelRatio((pixelRatio = wanted));
    updateZoomHint();
  }
  /** Which Fringe day the closures come from, and how many of them are on streets the cars can drive. */
  function closuresInfo(): string {
    if (!closures) return '';
    const date = new Date(`${closures.date(settings.day)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const missing = closures.unmatched(settings.day);
    const note = missing.length ? ` ${missing.length} (${missing.map((c) => c.name).join(', ')}) are not on streets in the car roads, so they change nothing here.` : '';
    return `Closures of ${date}, a typical Fringe ${settings.day}.${note}`;
  }
  // Several input events in one frame (a fast scrub) cost one repaint.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  function renderHeadline() {
    const totals = totalsAt(profiles, settings.hour, settings.day, settings.festival);
    controls.setHeadline({ people: formatCount(totals.people), residents: formatCount(totals.residents), workers: formatCount(totals.workers) });
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
      restartDay() {
        tracker?.restart(panel ? FESTIVAL_DAY_START_S : undefined);
        if (tracker) controls.setImpact(tracker.view());
      },
    },
    reducedMotion,
    economics ? { busFrequency: economics.demand.bus_frequency, carDemand: economics.demand.car_demand } : undefined,
  );

  // The cost of traffic: a ledger fed by the car worker's figures and the bus fleet's rates, shown once a second.
  if (economics) {
    tracker = new ImpactTracker(economics, {
      busRates: () => buses?.rates() ?? null,
      setCarDemand: (fraction) => cars?.setDemand(fraction),
      setClosedEdges: (edges) => {
        cars?.setClosedEdges(edges);
        closureLayer.setStreets(closures ? closures.streets(edges) : null);
      },
      speed: () => settings.busSpeed,
      hidden: () => document.hidden,
      now: () => performance.now(),
    }, closures);
    const impact = tracker;
    impact.setScenario({ carsOn: cars !== null && settings.showCars, busesOn: buses !== null && settings.showBuses, busFrequency: settings.busFrequency, carDemand: settings.carDemand, day: settings.day, closuresOn: settings.festivalClosures });
    controls.setImpact(impact.view());
    window.setInterval(() => {
      impact.tick();
      controls.setImpact(impact.view());
    }, 1000);
  } else {
    controls.setImpact({ total: '–', time: '–', fuel: '–', co2: '–', carbon: '–', cars: '–', buses: '–', clock: '–', lines: ['Not built. Run make economics, then reload.'] });
  }

  controls.setBusesAvailable(buses !== null);
  if (buses) window.setInterval(() => controls.setBusStats(settings.showBuses ? buses.trafficStats() : null), 1000);
  reducedMotion.addEventListener('change', () => buses?.setDrawInterval(reducedMotion.matches ? 1000 : 33));
  controls.setCarsAvailable(cars !== null);
  controls.setClosuresAvailable(closures !== null);

  // The festival: buildings shaded by the ticket-driven surge, and cars that drive to the venues the tickets name.
  const festivalLayer = festival.demand ? new FestivalLayer(festival.demand, festival.accommodation) : null;
  const dates = festival.demand ? festivalDates(festival.demand) : [];
  const departures = festival.transport ? departuresPerHour(busData, festival.transport) : 0;
  const venueCount = festival.demand ? tripVenues(festival.demand).length : 0;
  let lastTrips = '';
  /** Tells the car worker how many festival cars to start at each venue for the current slot of the simulated day. */
  function feedTrips() {
    if (!cars || !festival.demand || !festival.transport || !panel) return;
    const state = panel.state();
    const on = state.trips && settings.showCars;
    const date = panel.currentDate();
    const slot = slotAt(festival.demand, tracker?.ledger.clock ?? FESTIVAL_DAY_START_S);
    const key = [on, date, slot, settings.busFrequency, state.parkAndRide].join('|');
    if (key === lastTrips) return;
    lastTrips = key;
    const levers = { busFrequency: settings.busFrequency, parkAndRide: state.parkAndRide, closures: settings.festivalClosures };
    cars.setTripRates(on ? planSlot(festival.demand, festival.transport, date, slot, levers, departures).rates : emptyRates(venueCount));
  }
  /** Shades the buildings for the chosen date and hour, shows the surge figures, and keeps the day type in step with the date. */
  function renderFestival() {
    if (!panel || !festivalLayer) return;
    const wantedDay = dayTypeOf(panel.currentDate());
    // The date decides the day type; the day-type buttons are hidden, so the click comes from here (it reaches the controls as usual).
    if (settings.day !== wantedDay) document.querySelector<HTMLInputElement>(`input[name="day"][value="${wantedDay}"]`)?.click();
    festivalLayer.setVisible(panel.state().showSurge);
    festivalLayer.update({ date: panel.currentDate(), hour: settings.hour }, isDark());
    panel.setSurge(festivalLayer.headline());
  }
  const panel =
    festival.demand && dates.length > 0
      ? new FestivalPanel(dates, festival.transport?.levers.park_and_ride ?? { min: 0, max: 0.6, step: 0.15 }, festival.sweep, cars !== null && festival.transport !== null, {
          change() {
            lastTrips = '';
            schedule();
            feedTrips();
          },
          apply(levers) {
            // Drive the existing sliders and switch, so the settings, the buses and the closures all follow as if the user had moved them.
            const frequency = document.getElementById('bus-frequency') as HTMLInputElement;
            frequency.value = String(levers.busFrequency);
            frequency.dispatchEvent(new Event('input', { bubbles: true }));
            const closing = document.getElementById('festival-closures') as HTMLInputElement;
            if (closing.checked !== levers.closures) closing.click();
            const index = festival.sweep ? dates.indexOf(festival.sweep.date) : -1;
            panel?.set({ parkAndRide: levers.parkAndRide, ...(index >= 0 ? { dateIndex: index } : {}) });
            lastTrips = '';
            schedule();
            feedTrips();
          },
        })
      : null;
  if (cars && festival.demand) cars.setTripVenues(tripVenues(festival.demand));
  if (panel && cars && tracker) {
    tracker.restart(FESTIVAL_DAY_START_S);
    controls.setImpact(tracker.view());
  }
  if (panel) window.setInterval(feedTrips, 1000);
  coupling?.start();
  if (cars) {
    cars.onStats = (stats) => {
      controls.setCarStats(settings.showCars ? stats : null);
      tracker?.onCarStats(settings.showCars ? stats : null);
      if (stats?.trips) panel?.setTripInfo(`${stats.trips.active} festival cars on the road · ${stats.trips.arrived} have reached a venue · ${stats.trips.left} have left one${stats.trips.abandoned ? ` · ${stats.trips.abandoned} gave up` : ''}${stats.trips.walkMetres > 0 ? ` · drivers walked ${Math.round(stats.trips.walkMetres / Math.max(stats.trips.arrived, 1))} m on average` : ''}.`);
    };
  }
  reducedMotion.addEventListener('change', () => cars?.setFrameInterval(reducedMotion.matches ? 1000 : 100));

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
  const busAt = (event: maplibregl.MapMouseEvent) =>
    buses && map.getLayer(BUSES_LAYER) && settings.showBuses ? map.queryRenderedFeatures(event.point, { layers: [BUSES_LAYER] })[0] : undefined;
  map.on('click', (event) => {
    const picked = busAt(event);
    if (picked && buses && busData) {
      const bus = buses.find(String(picked.properties.id));
      if (bus) {
        buses.selectBus(bus);
        showPopup(map, [bus.lon, bus.lat], describeBus(bus, busData)).once('close', () => buses.selectBus(null));
        return;
      }
    }
    const feature = hit(event);
    if (!feature) return;
    const popupState: PopupState = { day: settings.day, hour: settings.hour, festival: settings.festival };
    if (feature.layer.id === INFERRED_LAYER) return void showPopup(map, event.lngLat, describeInferred(feature.properties));
    let props = feature.properties as BuildingProps & { parent_id?: string };
    if (feature.layer.id === PARTS_LAYER && props.parent_id) {
      const parent = map.querySourceFeatures(BUILDINGS_SOURCE, { sourceLayer: 'buildings', filter: ['==', ['get', 'id'], props.parent_id] })[0];
      if (parent) props = parent.properties as BuildingProps;
    }
    if (festival.demand && panel) {
      const date = panel.currentDate();
      const s = surgeFor(props, festival.accommodation, festival.demand, { date, hour: settings.hour });
      popupState.surge = { ...s, date };
    }
    showPopup(map, event.lngLat, describeBuilding(props, popupState, profiles));
  });
  map.on('mousemove', (event) => {
    map.getCanvas().style.cursor = busAt(event) || hit(event) ? 'pointer' : '';
  });

  handle.settings = () => ({ ...settings });
  handle.measureScrub = (seconds?: number) => measureScrub((hour) => controls.setHour(hour), seconds);

  return {
    /** Adds the building layers to the current style and paints them. Called on every 'style.load'. */
    install() {
      addBuildings(map, tilesUrl, isDark());
      festivalLayer?.install(map, isDark());
      closureLayer.install(map); // under the cars
      cars?.install(map, isDark()); // before the buses, so cars are drawn under them
      buses?.install(map, isDark());
      if (!map.getLayer(TENT_LAYER)) map.addLayer(new TentLayer(isDark()));
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
