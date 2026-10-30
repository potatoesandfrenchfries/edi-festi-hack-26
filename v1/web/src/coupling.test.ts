import { describe, expect, it } from 'vitest';
import { createModel, type Bus, type BusData, type BusLeg } from './buses';
import { BUS_FLOATS, BUS_MOVING, BUS_OFF_ROAD, BUS_STOPPED, FLOATS_PER_CAR } from './cars-protocol';
import { BusCarCoupling, SLOW_CAR_SPEED, busStates, carPressure, type BusSide, type CarSide } from './coupling';
import { BusTraffic, cellKey, type CarCell } from './traffic';

const car = (lon: number, lat: number, speed: number) => [lon, lat, 90, speed, 1];
const frame = (...cars: number[][]) => Float32Array.from(cars.flat());

describe('carPressure', () => {
  it('counts cars per cell and which of them are crawling', () => {
    const cells = carPressure(frame(car(-3.19, 55.95, 10), car(-3.19, 55.95, 1), car(-3.19, 55.95, 0), car(-3.1, 55.95, 8)));
    expect(cells.size).toBe(2);
    const here = cells.get(cellKey(-3.19, 55.95));
    expect(here).toMatchObject({ cars: 3, slow: 2 });
    expect(here!.lon / here!.slow).toBeCloseTo(-3.19, 5); // the summed position of the crawling cars, to be divided by their count
    expect(cells.get(cellKey(-3.1, 55.95))).toMatchObject({ cars: 1, slow: 0 });
  });
  it('uses the same threshold as the congestion cells, and copes with no frame', () => {
    expect(SLOW_CAR_SPEED).toBe(3);
    expect(carPressure(frame(car(-3.19, 55.95, 2.9))).values().next().value).toMatchObject({ slow: 1 });
    expect(carPressure(frame(car(-3.19, 55.95, 3.1))).values().next().value).toMatchObject({ slow: 0 });
    expect(carPressure(null).size).toBe(0);
    expect(FLOATS_PER_CAR).toBe(5);
  });
});

describe('busStates', () => {
  const bus = (over: Partial<Bus>): Bus => ({ id: 'a', route: {} as never, leg: 0, atStop: false, layover: false, nextStop: 0, lon: -3.19, lat: 55.95, bearing: 45, ...over });
  it('encodes position, bearing and whether the bus is moving, stopped at a stop or off the road', () => {
    const out = busStates([bus({}), bus({ atStop: true }), bus({ atStop: true, layover: true })]);
    expect(out).toHaveLength(3 * BUS_FLOATS);
    expect([out[3], out[7], out[11]]).toEqual([BUS_MOVING, BUS_STOPPED, BUS_OFF_ROAD]);
    expect(out[0]).toBeCloseTo(-3.19, 5);
    expect(out[2]).toBe(45);
  });
});

describe('BusCarCoupling', () => {
  const sides = () => {
    const log: string[] = [];
    let busVisible = true;
    let carVisible = true;
    const bus: BusSide = { isVisible: () => busVisible, buses: () => [], setCarPressure: (c) => void log.push(c ? 'bus:pressure' : 'bus:clear') };
    const cars: CarSide = { isVisible: () => carVisible, latestFrame: () => frame(car(-3.19, 55.95, 0)), setBusStates: (d) => void log.push(d ? 'car:buses' : 'car:clear') };
    return { log, bus, cars, hide: { bus: () => (busVisible = false), car: () => (carVisible = false) } };
  };
  it('swaps what each side needs once per update', () => {
    const { log, bus, cars } = sides();
    new BusCarCoupling(bus, cars).update();
    expect(log).toEqual(['bus:pressure', 'car:buses']);
  });
  it('makes each side forget the other, once, when coupling is switched off or a layer is hidden', () => {
    const { log, bus, cars, hide } = sides();
    const coupling = new BusCarCoupling(bus, cars);
    coupling.update();
    log.length = 0;
    coupling.setEnabled(false);
    coupling.update();
    expect(log).toEqual(['bus:clear', 'car:clear']); // not repeated on the second call
    coupling.setEnabled(true); // applies straight away, since both layers are showing
    log.length = 0;
    hide.car();
    coupling.update();
    expect(log).toEqual(['bus:clear', 'car:clear']); // hiding the cars stops the buses being held up by them
  });
  it('does nothing at all while a layer was never showing', () => {
    const { log, bus, cars, hide } = sides();
    hide.bus();
    const coupling = new BusCarCoupling(bus, cars);
    coupling.update();
    coupling.setEnabled(false);
    expect(log).toEqual([]);
  });
});

describe('cars slowing buses', () => {
  const SCALE = 100000;
  const shape = [-319000, 5595000, ...Array.from({ length: 12 }, () => [1000, 0]).flat()];
  const stops = [0, 1, 2, 3, 4, 5];
  const leg: BusLeg = { shape: 0, stops, dists: stops.map((i) => i * 1500), times: stops.flatMap((i) => [i * 150, i * 150 + (i === 0 || i === 5 ? 0 : 15)]), headsign: 'x' };
  const data: BusData = {
    meta: { feedVersion: 'x', typicalDay: 'x', coordScale: SCALE, layover: 60, source: 't' },
    stops: stops.map((i) => [-3.19 + i * 0.024, 55.95, `S${i}`] as [number, number, string]),
    shapes: [shape],
    routes: [{ name: '1', agency: 'LOTH', headway: 150, legs: [leg, leg] }],
  };
  /** Crawling cars every 40 m along the whole road, in every cell the buses pass through. */
  const jam = (): Map<number, CarCell> => carPressure(frame(...Array.from({ length: 200 }, (_, i) => car(-3.19 + i * 0.0006, 55.95, 0.5))));

  const averageKmh = (pressure: Map<number, CarCell> | null) => {
    const t = new BusTraffic(createModel(data), 0, { seed: 9, disturbances: false });
    t.setCarPressure(pressure);
    let sum = 0, n = 0;
    for (let i = 0; i < 3000; i++) {
      t.step();
      if (i > 600 && i % 20 === 0) { sum += t.stats().avgKmh; n++; }
    }
    return sum / n;
  };

  it('buses are slower when the street is full of crawling cars than when it is empty', () => {
    expect(averageKmh(jam())).toBeLessThan(averageKmh(null) * 0.8);
  });
  it('free-flowing cars do not hold buses up', () => {
    const free = carPressure(frame(...Array.from({ length: 200 }, (_, i) => car(-3.19 + i * 0.0006, 55.95, 12))));
    expect(averageKmh(free)).toBeGreaterThan(averageKmh(null) * 0.9);
  });
  it('flags the congestion where cars are crawling even with no bus there', () => {
    const t = new BusTraffic(createModel(data), 0, { seed: 9 });
    t.setCarPressure(carPressure(frame(...Array.from({ length: 20 }, () => car(-3.1, 55.953, 0.2)))));
    for (let i = 0; i < 20; i++) t.step();
    const glow = t.congestionCells().features;
    expect(glow.some((f) => Math.abs(f.geometry.coordinates[0] + 3.1) < 0.001)).toBe(true);
  });
});
