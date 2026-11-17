// The cell model's flow drawn as moving cars. The model only knows how many vehicles are in each stretch of road and how fast they go,
// so each road gets one dot per `dotScale` vehicles, spaced evenly along it and carried at the road's mean speed. The dots are a
// DRAWING of the flow: nobody can follow one, and a dot is not a vehicle. Packed in the car engine's frame layout (cars-protocol.ts) so
// the 3D car layer draws them.
import type { CellModel } from './engine/ctm.mjs';
import type { Roads } from './engine/car-sim.mjs';
import { FLOATS_PER_CAR } from './cars-protocol';

/** Colour classes the frame carries in the personality slot: free flow, slowing, crawling. */
export const FLOW_KINDS = ['free', 'slowing', 'crawling'] as const;
export const FLOW_COLOURS = ['#34b36a', '#f0b429', '#e5484d']; // the road tint: free, slowing, crawling

/** The dots' colours by colour class: ordinary cars keep the car layer's neutral colour (so they show against the green tint), slow and queued ones take the tint's amber and red. */
export const flowDotColours = (neutral: string): string[] => [neutral, FLOW_COLOURS[1]!, FLOW_COLOURS[2]!];
const SLOW_BELOW = 0.7; // share of the free-flow speed below which dots turn amber
const CRAWL_BELOW = 0.35; // ... and red
const HYSTERESIS = 0.7; // a road's dot count changes only when the true count is this far from it, so dots do not flicker
const LANE_OFFSET_M = 2; // dots drive on the left (UK), this far from the road's centre line
export const MAX_DOTS = 8000;

export function kindOf(speed: number, freeFlow: number): number {
  const ratio = freeFlow > 0 ? speed / freeFlow : 1;
  return ratio < CRAWL_BELOW ? 2 : ratio < SLOW_BELOW ? 1 : 0;
}

export class FlowDots {
  private readonly coords: Float64Array[];
  private readonly cumulative: Float64Array[];
  private readonly count: Int32Array;
  private readonly phase: Float64Array;
  private out = new Float32Array(0);
  private readonly mPerLon: number;
  private readonly mPerLat: number;

  /** `dotScale` is how many vehicles one dot stands for. */
  constructor(private readonly model: CellModel, roads: Roads, private readonly dotScale: number) {
    this.mPerLon = model.mPerLon;
    this.mPerLat = model.mPerLat;
    this.coords = roads.edges.map((e) => Float64Array.from(e[8] as number[]));
    this.cumulative = this.coords.map((c) => {
      const out = new Float64Array(c.length / 2);
      for (let k = 1; k < out.length; k++) out[k] = (out[k - 1] as number) + Math.hypot(((c[2 * k] as number) - (c[2 * k - 2] as number)) * this.mPerLon, ((c[2 * k + 1] as number) - (c[2 * k - 1] as number)) * this.mPerLat);
      return out;
    });
    this.count = new Int32Array(model.E);
    this.phase = new Float64Array(model.E);
  }

  /** Dots now on road `e`. */
  dotsOn(e: number): number {
    return this.count[e] as number;
  }

  /** Moves the dots on by `seconds` of simulated time and re-counts them against the model. Call after the model has stepped. */
  advance(seconds: number): void {
    const { model } = this;
    for (let e = 0; e < model.E; e++) {
      const true_ = model.vehicles(e) / this.dotScale;
      const held = this.count[e] as number;
      if (Math.abs(true_ - held) > HYSTERESIS) this.count[e] = Math.max(0, Math.round(true_));
      if ((this.count[e] as number) > 0) {
        const length = (this.cumulative[e] as Float64Array)[(this.cumulative[e] as Float64Array).length - 1] as number;
        this.phase[e] = (((this.phase[e] as number) + model.edgeSpeed(e) * seconds) % Math.max(length, 1) + length) % Math.max(length, 1);
      }
    }
  }

  /** The dots as a frame: FLOATS_PER_CAR numbers each (longitude, latitude, bearing, speed, colour class). Reused between calls. */
  frame(): Float32Array {
    const { model } = this;
    let total = 0;
    for (let e = 0; e < model.E; e++) total += this.count[e] as number;
    total = Math.min(total, MAX_DOTS);
    if (this.out.length !== total * FLOATS_PER_CAR) this.out = new Float32Array(total * FLOATS_PER_CAR);
    let n = 0;
    for (let e = 0; e < model.E && n < total; e++) {
      const dots = this.count[e] as number;
      if (!dots) continue;
      const cum = this.cumulative[e] as Float64Array, c = this.coords[e] as Float64Array;
      const length = cum[cum.length - 1] as number;
      const speed = model.edgeSpeed(e), kind = kindOf(speed, model.speed[e] as number);
      const spacing = length / dots;
      let seg = 0;
      for (let j = 0; j < dots && n < total; j++, n++) {
        const s = ((this.phase[e] as number) + j * spacing) % Math.max(length, 1e-6);
        while (seg > 0 && (cum[seg] as number) > s) seg--; // dots come in increasing s, but the wrap can send one back
        while (seg < cum.length - 2 && (cum[seg + 1] as number) < s) seg++;
        const a = seg, span = Math.max((cum[a + 1] as number) - (cum[a] as number), 1e-9), t = Math.min(1, Math.max(0, (s - (cum[a] as number)) / span));
        const x0 = c[2 * a] as number, y0 = c[2 * a + 1] as number, x1 = c[2 * a + 2] as number, y1 = c[2 * a + 3] as number;
        const east = (x1 - x0) * this.mPerLon, north = (y1 - y0) * this.mPerLat, norm = Math.hypot(east, north) || 1;
        const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
        const left = [-north / norm, east / norm]; // 90 degrees anticlockwise of the direction of travel, as (east, north)
        const at = n * FLOATS_PER_CAR;
        this.out[at] = x0 + (x1 - x0) * t + (left[0] as number) * LANE_OFFSET_M / this.mPerLon;
        this.out[at + 1] = y0 + (y1 - y0) * t + (left[1] as number) * LANE_OFFSET_M / this.mPerLat;
        this.out[at + 2] = bearing;
        this.out[at + 3] = speed;
        this.out[at + 4] = kind;
      }
    }
    return n === total ? this.out : this.out.subarray(0, n * FLOATS_PER_CAR);
  }
}

/** Per road: `level` is how far below free flow its vehicles are moving (0 free, 1 stopped) and `load` how full it is (0 empty, 1 jammed). */
export function roadLevels(model: CellModel): { level: Float32Array; load: Float32Array } {
  const level = new Float32Array(model.E), load = new Float32Array(model.E);
  for (let e = 0; e < model.E; e++) {
    load[e] = model.occupancy(e);
    level[e] = Math.min(1, Math.max(0, 1 - model.edgeSpeed(e) / (model.speed[e] as number)));
  }
  return { level, load };
}
