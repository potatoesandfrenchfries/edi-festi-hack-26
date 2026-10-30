// How buses hold up cars. A bus stopped for passengers blocks its lane, and cars behind it crawl until it leaves; a moving bus is slower
// than a car and cars queue behind it. The car engine has no obstacles other than signals and closures, but it reads each road's speed
// every step, so a road with a bus on it is given a lower speed for as long as the bus is there and put back when it leaves.
import { BUS_FLOATS, BUS_OFF_ROAD, BUS_STOPPED } from './cars-protocol';
import type { CarSim } from './engine/car-sim.mjs';

// All `placeholder`: plausible, not measured.
export const STOPPED_BUS_FACTOR = 0.3; // share of the free speed on a road where a bus is stopped
export const MOVING_BUS_FACTOR = 0.8; // and where one is driving
export const SNAP_METRES = 20; // a bus counts as on a road this close to it...
export const MAX_BEARING_DIFF = 60; // ...travelling within this many degrees of the road's direction
const CELL_METRES = 30;

export class BusRoadEffects {
  private readonly base: Float32Array;
  private readonly grid = new Map<number, number[]>();
  private touched = new Set<number>();

  constructor(private readonly sim: CarSim) {
    this.base = Float32Array.from(sim.speed);
    for (let e = 0; e < sim.E; e++) {
      const first = sim.ptStart[e] as number;
      const last = (sim.ptStart[e + 1] as number) - 1;
      for (let p = first; p < last; p++) this.addSegment(e, p);
    }
  }

  private key(x: number, y: number): number {
    return Math.floor(x / CELL_METRES) * 100003 + Math.floor(y / CELL_METRES);
  }
  private x(lon: number): number {
    return lon * this.sim.mPerLon;
  }
  private y(lat: number): number {
    return lat * this.sim.mPerLat;
  }

  /** Registers road `e`'s segment starting at point `p` in every grid cell it passes through, sampled every few metres. */
  private addSegment(e: number, p: number): void {
    const { lon, lat } = this.sim;
    const x0 = this.x(lon[p] as number);
    const y0 = this.y(lat[p] as number);
    const x1 = this.x(lon[p + 1] as number);
    const y1 = this.y(lat[p + 1] as number);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL_METRES / 3)));
    for (let s = 0; s <= steps; s++) {
      const k = this.key(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
      const cell = this.grid.get(k);
      if (!cell) this.grid.set(k, [e]);
      else if (!cell.includes(e)) cell.push(e);
    }
  }

  /** The roads a bus at this spot, heading this way, is on: within SNAP_METRES and pointing the same way as the road. */
  private roadsOf(lon: number, lat: number, bearing: number): number[] {
    const px = this.x(lon);
    const py = this.y(lat);
    const found: number[] = [];
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.grid.get(this.key(px + dx * CELL_METRES, py + dy * CELL_METRES));
        for (const e of cell ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          if (this.matches(e, px, py, bearing)) found.push(e);
        }
      }
    }
    return found;
  }

  private matches(e: number, px: number, py: number, bearing: number): boolean {
    const { lon, lat } = this.sim;
    const first = this.sim.ptStart[e] as number;
    const last = (this.sim.ptStart[e + 1] as number) - 1;
    let best = Infinity;
    let along = 0;
    for (let p = first; p < last; p++) {
      const x0 = this.x(lon[p] as number);
      const y0 = this.y(lat[p] as number);
      const dx = this.x(lon[p + 1] as number) - x0;
      const dy = this.y(lat[p + 1] as number) - y0;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2));
      const d = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
      if (d < best) {
        best = d;
        along = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      }
    }
    if (best > SNAP_METRES) return false;
    const turn = Math.abs(((bearing - along + 540) % 360) - 180);
    return turn <= MAX_BEARING_DIFF;
  }

  /**
   * Sets every road's speed for the buses now on it, and restores the roads they have left. `buses` holds BUS_FLOATS numbers per
   * bus (longitude, latitude, bearing, state), or null to restore everything. Returns how many roads are slowed.
   */
  apply(buses: Float32Array | null): number {
    const factor = new Map<number, number>();
    if (buses) {
      for (let i = 0; i + BUS_FLOATS <= buses.length; i += BUS_FLOATS) {
        const state = buses[i + 3] as number;
        if (state === BUS_OFF_ROAD) continue;
        const f = state === BUS_STOPPED ? STOPPED_BUS_FACTOR : MOVING_BUS_FACTOR;
        for (const e of this.roadsOf(buses[i] as number, buses[i + 1] as number, buses[i + 2] as number)) {
          factor.set(e, Math.min(factor.get(e) ?? 1, f));
        }
      }
    }
    for (const e of this.touched) if (!factor.has(e)) this.sim.speed[e] = this.base[e] as number;
    for (const [e, f] of factor) this.sim.speed[e] = (this.base[e] as number) * f;
    this.touched = new Set(factor.keys());
    return factor.size;
  }

  /** Test hook: the free speed of road `e`, as built. */
  freeSpeed(e: number): number {
    return this.base[e] as number;
  }
}

