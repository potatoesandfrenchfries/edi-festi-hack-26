import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarRunner, STEP_SECONDS } from './cars-runner';
import { FLOATS_PER_CAR, type FromWorker, type ToWorker } from './cars-protocol';
import { CarSimulation, MAX_CAR_SPEED, carColours, carFeatures, lerpFrame, loadCarData, type CarData, type CarWorker } from './cars';
import { gridRoads } from './grid-roads.testutil';
import { CarSim, type Roads } from './engine/car-sim.mjs';

function collect() {
  const messages: FromWorker[] = [];
  const runner = new CarRunner((m) => void messages.push(m));
  return { messages, runner, frames: () => messages.filter((m) => m.type === 'frame'), stats: () => messages.filter((m) => m.type === 'stats') };
}
const init = (roads: Roads, population = 40): ToWorker => ({ type: 'init', roads, population, seed: 7 });
const run = (speed: number, running = true, frameMs = 100): ToWorker => ({ type: 'run', speed, running, frameMs });

describe('frame helpers', () => {
  const frame = (...cars: [number, number, number, number?, number?][]) => Float32Array.from(cars.flatMap(([lon, lat, bearing, speed = 5, kind = 1]) => [lon, lat, bearing, speed, kind]));

  it('lerpFrame moves part-way and turns the short way round', () => {
    const out = lerpFrame(frame([-3.19, 55.95, 350]), frame([-3.188, 55.951, 10]), 0.5);
    expect(out[0]).toBeCloseTo(-3.189, 5);
    expect(out[1]).toBeCloseTo(55.9505, 5);
    expect(out[2]).toBeCloseTo(0, 4); // 350 -> 10 passes through north, not through south
  });
  it('lerpFrame snaps a car that jumped and ignores frames of a different size', () => {
    const far = lerpFrame(frame([-3.19, 55.95, 0]), frame([-3.1, 55.95, 0]), 0.3);
    expect(far[0]).toBeCloseTo(-3.1, 5);
    const to = frame([-3.1, 55.95, 0], [-3.2, 55.95, 0]);
    expect(lerpFrame(frame([-3.19, 55.95, 0]), to, 0.5)).toBe(to);
  });
  it('carFeatures writes one point per car with its personality and speed in km/h', () => {
    const data = carFeatures(frame([-3.19, 55.95, 90, 10, 2], [-3.18, 55.96, 0, 0, 0])) as { features: { properties: { kind: number; speed: number }; geometry: { coordinates: number[] } }[] };
    expect(data.features).toHaveLength(2);
    expect(data.features[0]!.properties).toEqual({ kind: 2, speed: 36 });
    expect(data.features[0]!.geometry.coordinates[0]).toBeCloseTo(-3.19, 5);
  });
  it('lightens the neutral car on a dark map and keeps the other colours', () => {
    expect(carColours(true).neutral).not.toBe(carColours(false).neutral);
    expect(carColours(true).aggressive).toBe(carColours(false).aggressive);
  });
});

describe('loadCarData', () => {
  const respond = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body }) as Response) as typeof fetch;
  it('accepts a built road graph and rejects anything else', async () => {
    expect(await loadCarData(respond(gridRoads()), 'http://localhost/')).toMatchObject({ nodes: 25 });
    expect(await loadCarData(respond(null, false), 'http://localhost/')).toBeNull();
    expect(await loadCarData(respond({ edges: [], nodes: 0 }), 'http://localhost/')).toBeNull();
    expect(await loadCarData((async () => { throw new Error('offline'); }) as typeof fetch, 'http://localhost/')).toBeNull();
  });
});

describe('CarRunner', () => {
  it('reports ready with the car count and caps the population at the network capacity', () => {
    const { runner, messages } = collect();
    runner.handle(init(gridRoads(), 1_000_000));
    const ready = messages.find((m) => m.type === 'ready');
    expect(ready).toMatchObject({ type: 'ready' });
    if (ready?.type === 'ready') expect(ready.cars).toBeLessThanOrEqual(ready.capacity);
  });

  it('posts frames of finite car positions inside the network, on the requested cadence', () => {
    const { runner, frames } = collect();
    runner.handle(init(gridRoads(), 30));
    runner.handle(run(20));
    for (let t = 0; t <= 2000; t += 40) runner.tick(1000 + t);
    const all = frames();
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.length).toBeLessThanOrEqual(25); // about 100 ms apart over 2 s
    const last = all.at(-1);
    if (last?.type !== 'frame') throw new Error('no frame');
    expect(last.data.length).toBe(30 * FLOATS_PER_CAR);
    for (let i = 0; i < last.data.length; i += FLOATS_PER_CAR) {
      expect(last.data[i]).toBeGreaterThan(-3.2);
      expect(last.data[i]).toBeLessThan(-3.17);
      expect(last.data[i + 1]).toBeGreaterThan(55.94);
      expect(last.data[i + 1]).toBeLessThan(55.97);
      expect(last.data[i + 2]).toBeGreaterThanOrEqual(0);
      expect(last.data[i + 2]).toBeLessThan(360);
    }
  });

  it('does not advance while paused, and runs faster when asked to', () => {
    const elapsed = (speed: number, running: boolean) => {
      const { runner, frames } = collect();
      runner.handle(init(gridRoads(), 20));
      runner.handle(run(speed, running));
      for (let t = 0; t <= 1000; t += 40) runner.tick(5000 + t);
      const last = frames().at(-1);
      return last?.type === 'frame' ? last.time : -1;
    };
    expect(elapsed(10, false)).toBe(0);
    const slow = elapsed(2, true);
    const fast = elapsed(20, true);
    expect(fast).toBeGreaterThan(slow * 5);
    expect(fast).toBeGreaterThan(10); // about 20 s simulated in 1 s real
  });

  it('is deterministic for a seed', () => {
    const final = () => {
      const { runner, frames } = collect();
      runner.handle(init(gridRoads(), 25));
      runner.handle(run(20));
      for (let t = 0; t <= 1500; t += 40) runner.tick(t);
      const last = frames().at(-1);
      return last?.type === 'frame' ? Array.from(last.data).join() : '';
    };
    expect(final()).toBe(final());
  });

  it('reports speed, signal and gridlock figures about once a second', () => {
    const { runner, stats } = collect();
    runner.handle(init(gridRoads(), 40));
    runner.handle(run(20));
    for (let t = 0; t <= 3500; t += 40) runner.tick(t);
    const all = stats();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const s = all.at(-1);
    if (s?.type !== 'stats') throw new Error('no stats');
    expect(s.cars).toBe(40);
    expect(s.signals).toBe(1);
    expect(s.averageKmh).toBeGreaterThan(0);
    expect(s.achievedSpeed).toBeGreaterThan(5);
  });

  it('turns a failure into an error message instead of throwing', () => {
    const { runner, messages } = collect();
    expect(() => runner.handle(init(null as unknown as Roads))).not.toThrow();
    expect(messages.at(-1)).toMatchObject({ type: 'error' });
  });

  it('steps in the engine step size', () => {
    expect(STEP_SECONDS).toBe(0.2);
  });

  describe('demand', () => {
    const withDemand = (population = 40) => {
      const c = collect();
      c.runner.handle({ type: 'init', roads: gridRoads(), population, seed: 7, maxDemand: 1.5 });
      return c;
    };
    it('starts at a demand of 1 even with spare slots for more', () => {
      const { runner } = withDemand();
      expect(runner.figures().cars).toBe(40);
    });
    it('adds cars at once when demand rises, up to the slots asked for at init', () => {
      const { runner } = withDemand();
      runner.handle({ type: 'demand', fraction: 1.5 });
      expect(runner.figures().cars).toBe(60);
      runner.handle({ type: 'demand', fraction: 9 });
      expect(runner.figures().cars).toBe(60);
    });
    it('lets cars go at their next junction when demand falls, and brings them back', () => {
      const { runner } = withDemand();
      runner.handle({ type: 'demand', fraction: 0.5 });
      runner.simulate(600);
      expect(runner.figures().cars).toBe(20);
      runner.handle({ type: 'demand', fraction: 1 });
      expect(runner.figures().cars).toBe(40);
    });
    it('cancels exits that have not happened yet', () => {
      const { runner } = withDemand();
      runner.handle({ type: 'demand', fraction: 0.5 });
      runner.handle({ type: 'demand', fraction: 1 });
      runner.simulate(60);
      expect(runner.figures().cars).toBe(40);
    });
    it('keeps the cars it has when the demand is a no-op', () => {
      const { runner, messages } = withDemand();
      runner.handle({ type: 'demand', fraction: 1 });
      expect(messages.some((m) => m.type === 'error')).toBe(false);
      expect(runner.figures().cars).toBe(40);
    });
  });

  describe('congestion sums', () => {
    it('reports the simulated time, distance driven and slow time since the last message, and starts again each time', () => {
      const { runner, stats } = collect();
      runner.handle(init(gridRoads(), 40));
      runner.handle(run(20));
      for (let t = 0; t <= 4500; t += 40) runner.tick(t);
      const all = stats().filter((m) => m.type === 'stats');
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const s of all) {
        if (s.type !== 'stats') continue;
        expect(s.simSeconds).toBeGreaterThan(0);
        expect(s.distanceM).toBeGreaterThan(0);
        expect(s.delayCarSeconds).toBeGreaterThanOrEqual(0);
        expect(s.idleCarSeconds).toBeGreaterThanOrEqual(0);
        expect(s.delayCarSeconds).toBeLessThanOrEqual(s.simSeconds * 40 + 1e-6); // no car can lose more than all of its time
        expect(s.idleCarSeconds).toBeLessThanOrEqual(s.simSeconds * 40 + 1e-6);
      }
      const total = all.reduce((sum, s) => sum + (s.type === 'stats' ? s.simSeconds : 0), 0);
      expect(total).toBeGreaterThan(40); // about 4 s real at 20x
      expect(total).toBeLessThan(120);
    });
    it('reports nothing for a paused simulation', () => {
      const { runner, stats } = collect();
      runner.handle(init(gridRoads(), 40));
      runner.handle(run(20, false));
      for (let t = 0; t <= 2500; t += 40) runner.tick(t);
      const last = stats().at(-1);
      expect(last).toMatchObject({ simSeconds: 0, delayCarSeconds: 0, idleCarSeconds: 0, distanceM: 0 });
    });
    it('counts cars held at a signal as delayed and standing', () => {
      const { runner, stats } = collect();
      runner.handle(init(gridRoads(), 200)); // crowded enough on the small grid to queue
      runner.handle(run(20));
      for (let t = 0; t <= 6500; t += 40) runner.tick(t);
      const total = (key: 'delayCarSeconds' | 'idleCarSeconds') => stats().reduce((sum, s) => sum + (s.type === 'stats' ? s[key] : 0), 0);
      expect(total('delayCarSeconds')).toBeGreaterThan(0);
      expect(total('idleCarSeconds')).toBeGreaterThan(0);
      expect(total('idleCarSeconds')).toBeLessThanOrEqual(total('delayCarSeconds') + 1e-6); // standing is the extreme case of delay
    });
  });
});

describe('CarSimulation', () => {
  class FakeWorker implements CarWorker {
    sent: ToWorker[] = [];
    onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
    terminated = false;
    postMessage(message: ToWorker) { this.sent.push(message); }
    terminate() { this.terminated = true; }
    emit(message: FromWorker) { this.onmessage?.({ data: message } as MessageEvent<FromWorker>); }
  }
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('document', { hidden: false, baseURI: 'http://localhost/' });
  });
  afterEach(() => vi.unstubAllGlobals());

  const make = () => {
    const worker = new FakeWorker();
    const sim = new CarSimulation({ ...gridRoads(), sim: { area: 'pilot', capacity: 999, population: 77, seed: 3 } }, 100, () => worker);
    return { worker, sim };
  };

  it('starts the worker with the road graph and the configured population, only when started', () => {
    const { worker, sim } = make();
    expect(worker.sent).toEqual([]); // nothing runs before start(), which waits for the map to go idle
    sim.start();
    expect(worker.sent[0]).toMatchObject({ type: 'init', population: 77, seed: 3 });
    expect(worker.sent.at(-1)).toMatchObject({ type: 'run', running: true });
  });

  it('caps the speed it asks of the worker, and pauses it when hidden', () => {
    const { worker, sim } = make();
    sim.start();
    sim.setSpeed(200);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'run', speed: MAX_CAR_SPEED, running: true });
    sim.setSpeed(5);
    expect(worker.sent.at(-1)).toMatchObject({ speed: 5 });
    sim.setVisible(false);
    expect(worker.sent.at(-1)).toMatchObject({ running: false });
    sim.setVisible(true);
    expect(worker.sent.at(-1)).toMatchObject({ running: true });
  });

  it('passes the worker figures on with the requested speed, and clears them if the worker fails', () => {
    const { worker, sim } = make();
    const seen: unknown[] = [];
    sim.onStats = (s) => void seen.push(s);
    sim.start();
    sim.setSpeed(60);
    worker.emit({ type: 'stats', cars: 77, averageKmh: 18, gridlocked: 1, achievedSpeed: 9, signals: 1, relocated: 4, slowedByBuses: 0, simSeconds: 1, delayCarSeconds: 0, idleCarSeconds: 0, distanceM: 0 });
    expect(seen.at(-1)).toMatchObject({ cars: 77, achievedSpeed: 9, requestedSpeed: MAX_CAR_SPEED });
    worker.emit({ type: 'error', message: 'boom' });
    expect(seen.at(-1)).toBeNull();
    expect(worker.terminated).toBe(true);
    sim.start(); // a failed simulation does not restart
    expect(worker.sent.filter((m) => m.type === 'init')).toHaveLength(1);
  });
});

describe.skipIf(!existsSync(new URL('../public/data/roads.json', import.meta.url)))('on the real Edinburgh road graph', () => {
  const roads = () => JSON.parse(readFileSync(new URL('../public/data/roads.json', import.meta.url), 'utf8')) as CarData;
  const runnerFor = (relief: boolean, population?: number) => {
    const data = roads();
    const runner = new CarRunner(() => undefined, relief);
    runner.handle({ type: 'init', roads: data, population: population ?? data.sim?.population ?? 1000, seed: 1 });
    return { runner, data };
  };

  it('without relief the network gridlocks: cars stopped for over two minutes pile up and never clear', () => {
    // The finding that the relief exists for, kept as a test so a change to the road data or the engine that fixes it shows up.
    const { runner } = runnerFor(false, 2283);
    runner.simulate(450);
    expect(runner.figures().stuck).toBeGreaterThan(300);
  }, 60000);

  it('with relief it keeps flowing for half an hour of simulated traffic, at a plausible speed', () => {
    const { runner } = runnerFor(true);
    const started = performance.now();
    runner.simulate(1800);
    const msPerStep = (performance.now() - started) / (1800 / STEP_SECONDS);
    const figures = runner.figures();
    expect(figures.stuck).toBeLessThan(figures.cars * 0.03);
    expect(figures.averageKmh).toBeGreaterThan(5); // moving, not jammed solid
    expect(figures.averageKmh).toBeLessThan(50); // and under the posted limits
    expect(figures.relocated).toBeLessThan(figures.cars * 2); // relief is a safety valve, not how the traffic moves
    expect(msPerStep).toBeLessThan(40); // a 0.2 s step must cost far less than the 200 ms it simulates
  }, 120000); // about 10 s of work on a busy machine, over vitest's 5 s default

  it('keeps every car inside the area, and relief does not change where a seed puts the cars', () => {
    const first = runnerFor(true, 600).runner;
    const second = runnerFor(false, 600).runner;
    first.simulate(0);
    second.simulate(0);
    expect(first.figures().cars).toBe(second.figures().cars);
    const data = roads();
    const sim = new CarSim(data, { population: 300, seed: 1 });
    sim.reseed({ population: 300 });
    sim.step(0.2);
    const where = [0, 0, 0];
    const [west, south, east, north] = data.bbox as number[];
    for (let i = 0; i < sim.n; i++) {
      sim.locate(i, where);
      expect(where[0]).toBeGreaterThan((west as number) - 0.002);
      expect(where[0]).toBeLessThan((east as number) + 0.002);
      expect(where[1]).toBeGreaterThan((south as number) - 0.002);
      expect(where[1]).toBeLessThan((north as number) + 0.002);
    }
  });
});
