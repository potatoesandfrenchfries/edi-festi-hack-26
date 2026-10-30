import { createModel, allBuses, totalBuses } from './sim.js';

const COLORS = { LOTH: '#ff5a67', NELB: '#4cd9a0', ECBU: '#ffc857' };
const EDINBURGH = [-3.19, 55.95];
const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const empty = { type: 'FeatureCollection', features: [] };
const line = coords => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });

/** White up-pointing arrow as an SDF image, so each bus can be tinted and rotated by the map. */
function arrowImage() {
  const size = 48, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(size / 2, 4); g.lineTo(size - 10, size - 8); g.lineTo(size / 2, size - 16); g.lineTo(10, size - 8);
  g.closePath(); g.fill();
  return g.getImageData(0, 0, size, size);
}

function showError(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
}

async function main() {
  let data;
  try {
    const res = await fetch('data/lothian.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    showError(`Could not load data/lothian.json (${err.message}). Build it first: uv run python -m lothian.build`);
    return;
  }
  $('feed').textContent = data.meta.feedVersion;

  const state = {
    model: createModel(data), t: 0, playing: true, speed: Number(store.get('speed', 20)),
    frequency: Number(store.get('frequency', 1)), only: null, selected: null,
  };
  const stopFeatures = data.stops.map(([lon, lat, name]) => ({
    type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [lon, lat] },
  }));

  // ---- map ----
  const map = new maplibregl.Map({
    container: 'map', center: EDINBURGH, zoom: 11.6, maxPitch: 0, dragRotate: false,
    style: {
      version: 8,
      // Keyless OSM tiles, inverted and desaturated in the style so the buses stand out. Fine for a local
      // demo; for anything public use a tile provider with its own key (see the OSM tile usage policy).
      sources: { base: { type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
      layers: [{ id: 'base', type: 'raster', source: 'base',
        paint: { 'raster-brightness-min': 1, 'raster-brightness-max': 0.12, 'raster-saturation': -0.85, 'raster-contrast': 0.1 } }],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  const lineCoords = shape => {
    const out = [];
    for (let i = 0; i < shape.lon.length; i++) out.push([shape.lon[i], shape.lat[i]]);
    return out;
  };
  const allLines = () => ({
    type: 'FeatureCollection',
    features: state.model.shapes.map((s, i) => ({ ...line(lineCoords(s)), properties: { i } })),
  });

  await new Promise(resolve => map.on('load', resolve));
  map.addImage('arrow', arrowImage(), { sdf: true });
  map.addSource('lines', { type: 'geojson', data: empty });
  map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: stopFeatures } });
  map.addSource('route', { type: 'geojson', data: empty });
  map.addSource('buses', { type: 'geojson', data: empty });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines',
    paint: { 'line-color': '#7c89a3', 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 2] } });
  map.addLayer({ id: 'stops', type: 'circle', source: 'stops', minzoom: 13.5,
    paint: { 'circle-color': '#aeb8cc', 'circle-opacity': 0.8, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 1.2, 17, 3.5] } });
  map.addLayer({ id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 5] } });
  map.addLayer({ id: 'buses', type: 'symbol', source: 'buses',
    layout: {
      'icon-image': 'arrow', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-rotation-alignment': 'map', 'icon-rotate': ['get', 'bearing'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 13, 0.5, 16, 0.85],
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-opacity': ['case', ['get', 'layover'], 0.45, 1],
      'icon-halo-color': '#0b0e14', 'icon-halo-width': 1.5,
    } });

  const toggle = (layer, on) => map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 12, maxWidth: '260px' });
  // The highlighted path is the selected bus's leg, else every leg of the filtered route, else nothing.
  function drawRoute() {
    let legs = [];
    if (state.selected !== null) legs = [state.selected.leg];
    else if (state.only !== null) legs = state.model.routes.filter(r => r.name === state.only).flatMap(r => r.legs);
    map.getSource('route').setData({
      type: 'FeatureCollection', features: legs.map(l => line(lineCoords(state.model.shapes[l.shape]))),
    });
  }
  popup.on('close', () => { state.selected = null; drawRoute(); });

  // ---- controls ----
  const names = [...new Set(state.model.routes.map(r => r.name))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const name of names) $('route').add(new Option(name, name));
  $('route').addEventListener('change', e => {
    const name = e.target.value;
    state.only = name || null;
    if (state.selected !== null && state.only !== null && state.selected.name !== state.only) popup.remove();
    drawRoute();
    if (state.only) fitRoute(name);
  });

  const setPlaying = on => { state.playing = on; $('play').textContent = on ? 'Pause' : 'Play'; };
  $('play').addEventListener('click', () => setPlaying(!state.playing));
  const setSpeed = v => {
    state.speed = v; store.set('speed', v);
    for (const b of document.querySelectorAll('#speeds button')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === v));
  };
  for (const b of document.querySelectorAll('#speeds button')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  setSpeed(state.speed);

  const setFrequency = v => {
    state.frequency = v; store.set('frequency', v);
    $('freq').value = v; $('freq-out').textContent = `${v.toFixed(1)}×`;
    state.model = createModel(data, { frequency: v });
  };
  $('freq').addEventListener('input', e => setFrequency(Number(e.target.value)));
  setFrequency(state.frequency);

  $('lines').addEventListener('change', e => {
    if (e.target.checked && !map.getSource('lines')._data?.features?.length) map.getSource('lines').setData(allLines());
    toggle('lines', e.target.checked);
  });
  toggle('lines', false);
  $('stops').addEventListener('change', e => toggle('stops', e.target.checked));
  $('collapse').addEventListener('click', () => {
    const min = $('panel').classList.toggle('min');
    $('collapse').textContent = min ? '+' : '–';
    $('collapse').setAttribute('aria-expanded', String(!min));
    $('collapse').setAttribute('aria-label', min ? 'Expand panel' : 'Minimise panel');
  });

  function fitRoute(name) {
    const bounds = new maplibregl.LngLatBounds();
    for (const r of state.model.routes) if (r.name === name) for (const l of r.legs) {
      const s = state.model.shapes[l.shape];
      for (let i = 0; i < s.lon.length; i += 4) bounds.extend([s.lon[i], s.lat[i]]);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 340, right: 60 }, maxZoom: 14, duration: 800 });
  }

  // ---- bus selection ----
  const stopName = i => data.stops[i][2];
  function popupHtml(bus) {
    const leg = bus.route.legs[bus.leg];
    const colour = COLORS[bus.route.agency];
    const where = bus.layover ? 'Layover at' : bus.atStop ? 'At' : 'Next stop:';
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    return `<span class="pop-route" style="background:${colour}">${esc(bus.route.name)}</span>to ${esc(leg.headsign || 'terminus')}`
      + `<div class="pop-sub">${where} ${esc(stopName(bus.nextStop))}</div>`;
  }
  function select(bus) {
    state.selected = { id: bus.id, leg: bus.route.legs[bus.leg], name: bus.route.name };
    drawRoute();
    popup.setLngLat([bus.lon, bus.lat]).setHTML(popupHtml(bus)).addTo(map);
  }
  map.on('click', 'buses', e => {
    const id = e.features[0].properties.id;
    const bus = allBuses(state.model, state.t).find(b => b.id === id);
    if (bus) select(bus);
  });
  map.on('mouseenter', 'buses', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'buses', () => { map.getCanvas().style.cursor = ''; });

  // ---- frame loop ----
  let last = performance.now(), lastDraw = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (state.playing) state.t += dt * state.speed;
    if (now - lastDraw >= 33) {
      lastDraw = now;
      let buses = allBuses(state.model, state.t);
      if (state.only !== null) buses = buses.filter(b => b.route.name === state.only);
      map.getSource('buses').setData({
        type: 'FeatureCollection',
        features: buses.map(b => ({
          type: 'Feature', properties: { id: b.id, bearing: b.bearing, layover: b.layover, color: COLORS[b.route.agency] },
          geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
        })),
      });
      $('count').textContent = buses.length;
      $('routes').textContent = new Set(buses.map(b => b.route.name)).size;
      if (state.selected !== null) {
        const bus = buses.find(b => b.id === state.selected.id);
        if (bus) {
          popup.setLngLat([bus.lon, bus.lat]).setHTML(popupHtml(bus));
          // The bus turns round at the terminus, so follow it onto the other direction's path.
          const leg = bus.route.legs[bus.leg];
          if (leg !== state.selected.leg) { state.selected.leg = leg; drawRoute(); }
        } else popup.remove();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Test hook: lets the browser check read what the simulation is doing.
  window.__sim = { state, map, total: () => totalBuses(state.model) };
}

main().catch(err => showError(`Something went wrong: ${err.message}`));
