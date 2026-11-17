import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import { CarRunner } from './cars-runner';
import type { FromWorker } from './cars-protocol';
import { gridRoads } from './grid-roads.testutil';
import { MIN_PUSH_MS, SIGNALS_LAYER, SIGNALS_MIN_ZOOM, SIGNALS_SOURCE, SIGNAL_AMBER, SIGNAL_COLOURS, SIGNAL_GREEN, SIGNAL_RED, SignalLayer, signalFeatures } from './signals';

describe('signalFeatures', () => {
  it('makes one point per approach carrying its state', () => {
    const data = signalFeatures(Float64Array.of(-3.19, 55.95, -3.18, 55.96), Uint8Array.of(SIGNAL_RED, SIGNAL_GREEN));
    expect(data).toMatchObject({ type: 'FeatureCollection' });
    const features = (data as { features: { properties: { s: number }; geometry: { coordinates: number[] } }[] }).features;
    expect(features.map((f) => f.properties.s)).toEqual([SIGNAL_RED, SIGNAL_GREEN]);
    expect(features[1]!.geometry.coordinates).toEqual([-3.18, 55.96]);
  });
  it('uses the shorter list when positions and states disagree', () => {
    const features = (signalFeatures(Float64Array.of(1, 2, 3, 4, 5, 6), Uint8Array.of(0, 1)) as { features: unknown[] }).features;
    expect(features).toHaveLength(2);
  });
});

describe('SignalLayer', () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeMap = () => {
    const calls = { sources: [] as string[], layers: [] as { id: string; minzoom?: number; paint: Record<string, unknown> }[], data: [] as { features: { properties: { s: number } }[] }[], visibility: [] as string[] };
    const source = { setData: (d: { features: { properties: { s: number } }[] }) => calls.data.push(d) };
    const map = {
      addSource: (id: string) => calls.sources.push(id),
      addLayer: (layer: { id: string; minzoom?: number; paint: Record<string, unknown> }) => calls.layers.push(layer),
      getSource: (id: string) => (calls.sources.includes(id) ? source : undefined),
      getLayer: (id: string) => calls.layers.find((l) => l.id === id),
      setLayoutProperty: (_layer: string, _name: string, value: string) => calls.visibility.push(value),
    };
    return { map: map as unknown as maplibregl.Map, calls };
  };
  const clock = (start = 1000) => {
    let now = start;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (ms: number) => {
      now += ms;
    };
  };

  it('adds its source and a layer that starts at the signal zoom, in the colours of the theme', () => {
    const { map, calls } = fakeMap();
    new SignalLayer().install(map, true);
    expect(calls.sources).toEqual([SIGNALS_SOURCE]);
    expect(calls.layers[0]).toMatchObject({ id: SIGNALS_LAYER, minzoom: SIGNALS_MIN_ZOOM });
    expect(calls.layers[0]!.paint['circle-stroke-color']).toBe(SIGNAL_COLOURS.dark.ring);
    expect(JSON.stringify(calls.layers[0]!.paint['circle-color'])).toContain(SIGNAL_COLOURS.dark.red);
  });

  it('draws nothing until it has both where the signals are and what they show, then draws them all', () => {
    const { map, calls } = fakeMap();
    const layer = new SignalLayer();
    layer.install(map, false);
    layer.setStates(Uint8Array.of(0, 2));
    expect(calls.data).toEqual([]);
    layer.setPositions(Float64Array.of(-3.19, 55.95, -3.18, 55.96));
    expect(calls.data).toHaveLength(1);
    expect(calls.data[0]!.features.map((f) => f.properties.s)).toEqual([0, 2]);
  });

  it('does not touch the map for a frame that shows the same states, and limits how often it does', () => {
    const advance = clock();
    const { map, calls } = fakeMap();
    const layer = new SignalLayer();
    layer.install(map, false);
    layer.setPositions(Float64Array.of(-3.19, 55.95, -3.18, 55.96));
    layer.setStates(Uint8Array.of(0, 2));
    expect(calls.data).toHaveLength(1);
    advance(MIN_PUSH_MS * 2);
    layer.setStates(Uint8Array.of(0, 2)); // the same states: nothing to draw
    expect(calls.data).toHaveLength(1);
    layer.setStates(Uint8Array.of(2, 0)); // changed, and long enough since the last push: drawn at once
    expect(calls.data).toHaveLength(2);
    advance(MIN_PUSH_MS / 4);
    layer.setStates(Uint8Array.of(1, 0)); // changed again, but only just after: held back
    expect(calls.data).toHaveLength(2);
    advance(MIN_PUSH_MS);
    layer.setStates(Uint8Array.of(1, 0)); // the next frame after the wait gets through
    expect(calls.data).toHaveLength(3);
    expect(calls.data[2]!.features.map((f) => f.properties.s)).toEqual([SIGNAL_AMBER, SIGNAL_GREEN]);
  });

  it('shows and hides with the cars, and draws again after a style reload', () => {
    clock();
    const { map, calls } = fakeMap();
    const layer = new SignalLayer();
    layer.install(map, false);
    layer.setPositions(Float64Array.of(-3.19, 55.95));
    layer.setStates(Uint8Array.of(2));
    layer.setVisible(false);
    layer.setVisible(true);
    expect(calls.visibility).toEqual(['none', 'visible']);
    const reloaded = fakeMap();
    layer.setVisible(false);
    layer.install(reloaded.map, true);
    expect(reloaded.calls.layers[0]).toMatchObject({ layout: { visibility: 'none' } });
    expect(reloaded.calls.data).toHaveLength(1); // the last signals come straight back
  });
});

describe('the signals the car worker reports', () => {
  // gridRoads has one signalised junction, in the middle of the first block (node 8), with four roads into it.
  const run = (seconds: number) => {
    const messages: FromWorker[] = [];
    const runner = new CarRunner((m) => messages.push(m));
    runner.handle({ type: 'init', roads: gridRoads(7), population: 20, seed: 4 });
    runner.handle({ type: 'run', speed: 20, running: true, frameMs: 100 });
    for (let t = 0; t <= seconds * 50; t += 40) runner.tick(1000 + t);
    const ready = messages.find((m) => m.type === 'ready');
    const frames = messages.filter((m) => m.type === 'frame');
    return { ready: ready?.type === 'ready' ? ready : undefined, frames: frames.flatMap((f) => (f.type === 'frame' ? [f] : [])) };
  };

  it('says where each approach is, once, and the state of each in every frame', () => {
    const { ready, frames } = run(30);
    expect(ready?.signalPositions).toBeInstanceOf(Float64Array);
    const approaches = (ready?.signalPositions?.length ?? 0) / 2;
    expect(approaches).toBe(4);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) {
      expect(f.signals).toHaveLength(approaches);
      expect([...(f.signals ?? [])].every((s) => s === 0 || s === 1 || s === 2)).toBe(true);
    }
  });

  it('puts each dot by the junction it belongs to, at its stop line, not at the junction itself', () => {
    const { ready } = run(1);
    const [lon, lat] = [-3.19 + 1 * 0.002, 55.95 + 1 * 0.002]; // node 8: column 1, row 1
    for (let k = 0; k < 4; k++) {
      const x = ((ready!.signalPositions![2 * k] as number) - lon) * 62400;
      const y = ((ready!.signalPositions![2 * k + 1] as number) - lat) * 111200;
      const metres = Math.hypot(x, y);
      expect(metres).toBeGreaterThan(2);
      expect(metres).toBeLessThan(15);
    }
  });

  it('never shows go in both directions at once, and every approach goes through green, amber and red', () => {
    const { frames } = run(240);
    const seen = [new Set<number>(), new Set<number>(), new Set<number>(), new Set<number>()];
    let allRed = 0;
    for (const f of frames) {
      const s = [...(f.signals ?? [])];
      s.forEach((v, k) => seen[k]!.add(v));
      if (s.every((v) => v === SIGNAL_RED)) allRed++; // the engine holds a short all-red between the two phases
      expect(s.filter((v) => v === SIGNAL_GREEN).length).toBeLessThanOrEqual(2); // two of the four share a phase; never all four at once
    }
    expect(allRed / frames.length).toBeLessThan(0.1); // 2 s of a 45 s phase
    for (const states of seen) expect([...states].sort()).toEqual([SIGNAL_GREEN, SIGNAL_AMBER, SIGNAL_RED]);
  });
});
