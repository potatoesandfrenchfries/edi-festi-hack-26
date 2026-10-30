// Buses and cars share the street, so each is slowed by the other. Once a second this reads the cars' positions and speeds into per-cell
// figures for the buses to react to (queued cars crowd a bus and hold it up), and the buses' positions and stop states into a message for
// the car worker (a bus stopped at a stop, or driving, lowers the speed of the road it is on). It is the only place that knows both.
//
// The two run on their own simulation clocks (buses up to 200x, cars up to 60x), so they are coupled in real time, not simulated time.
import type { Bus } from './buses';
import { BUS_FLOATS, BUS_MOVING, BUS_OFF_ROAD, BUS_STOPPED, FLOATS_PER_CAR } from './cars-protocol';
import { cellKey, type CarCell } from './traffic';

export const SLOW_CAR_SPEED = 3; // m/s, 10.8 km/h: the same threshold as the congestion cells
export const COUPLE_EVERY_MS = 1000;

/** Summarises a car frame per 150 m cell: how many cars, how many are crawling, and the summed position of the crawling ones. */
export function carPressure(frame: Float32Array | null): Map<number, CarCell> {
  const cells = new Map<number, CarCell>();
  if (!frame) return cells;
  for (let i = 0; i + FLOATS_PER_CAR <= frame.length; i += FLOATS_PER_CAR) {
    const lon = frame[i] as number;
    const lat = frame[i + 1] as number;
    const key = cellKey(lon, lat);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { cars: 0, slow: 0, lon: 0, lat: 0 }));
    cell.cars++;
    if ((frame[i + 3] as number) < SLOW_CAR_SPEED) {
      cell.slow++;
      cell.lon += lon;
      cell.lat += lat;
    }
  }
  return cells;
}

/** The buses as the car worker reads them: longitude, latitude, bearing and a state (moving, stopped at a stop, or off the road). */
export function busStates(buses: readonly Bus[]): Float32Array {
  const out = new Float32Array(buses.length * BUS_FLOATS);
  buses.forEach((b, k) => {
    out.set([b.lon, b.lat, b.bearing, b.layover ? BUS_OFF_ROAD : b.atStop ? BUS_STOPPED : BUS_MOVING], k * BUS_FLOATS);
  });
  return out;
}

/** What coupling needs from the bus side. */
export interface BusSide {
  isVisible(): boolean;
  buses(): readonly Bus[];
  setCarPressure(cells: ReadonlyMap<number, CarCell> | null): void;
}
/** What coupling needs from the car side. */
export interface CarSide {
  isVisible(): boolean;
  latestFrame(): Float32Array | null;
  setBusStates(data: Float32Array | null): void;
}

export class BusCarCoupling {
  private enabled = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private applied = false;

  constructor(private readonly bus: BusSide, private readonly car: CarSide) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.update();
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), COUPLE_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One exchange. If either side is off (or coupling is), each forgets the other, once, so nothing stays slowed by a vehicle that is gone. */
  update(): void {
    if (!this.enabled || !this.bus.isVisible() || !this.car.isVisible()) {
      if (this.applied) {
        this.bus.setCarPressure(null);
        this.car.setBusStates(null);
        this.applied = false;
      }
      return;
    }
    this.bus.setCarPressure(carPressure(this.car.latestFrame()));
    this.car.setBusStates(busStates(this.bus.buses()));
    this.applied = true;
  }
}
