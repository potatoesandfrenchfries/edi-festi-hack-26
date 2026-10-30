// Types for the part of car-sim.mjs this app uses. The engine is plain JavaScript, so these are written by hand.

/** The road graph written by pipeline/stage08_roads.py: edges are [from, to, class index, lanes, speed m/s, inferred, two-way, length m, [lon, lat, ...], way id, name index]. */
export interface Roads {
  bbox?: number[];
  classes: string[];
  nodes: number;
  names?: string[];
  signals?: number[];
  edges: (number | number[])[][];
}

export interface CarStats {
  averageSpeedMps: number;
  gridlocked: number;
  extraCars: number;
  fleet: number;
}

/** The engine's seeded random generator. */
export function mulberry32(seed: number): () => number;

export class CarSim {
  constructor(roads: Roads, options: { population: number; seed?: number; runId?: number });
  /** Number of car slots; ids are 0..n-1 and never change. */
  n: number;
  /** Number of directed road edges. */
  E: number;
  /** Simulated seconds so far. */
  time: number;
  active: Uint8Array;
  /** Index into PERSONALITIES for each car. */
  kind: Uint8Array;
  /** Speed of each car, m/s. */
  v: Float32Array;
  /** Each car's desired-speed factor (about 0.8 to 1.2) and the posted speed of each road, m/s. */
  factor: Float32Array;
  speed: Float32Array;
  /** A leaving car is switched off at its next junction. Group is -1 for a car that is not part of a demand group. */
  leaving: Uint8Array;
  group: Int32Array;
  switchOff(i: number): void;
  /** The road graph: node count, each road's end nodes and class index, and the roads leaving (`out`, from `outStart`) and entering (`inEdges`, from `inStart`) each node. */
  nodes: number;
  from: Int32Array;
  to: Int32Array;
  cls: Uint8Array;
  outStart: Int32Array;
  out: Int32Array;
  inStart: Int32Array;
  inEdges: Int32Array;
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  /** Position in the route (`route[i]`) of the next road to take. */
  routeStep: Int32Array;
  /** Quickest route (road ids) from node `start` to node `goal` on roads that are not dead, or null. Cached until the closures change. */
  findDetour(start: number, goal: number): Int32Array | null;
  /** 1 for a road that is closed, or whose every way on is closed. */
  dead: Uint8Array;
  signalCount: number;
  redHolds: number;
  // Per-car and per-road state, read and written by the gridlock relief in cars-runner.ts (the same fields the engine's own `spawn` sets).
  edge: Int32Array;
  lane: Uint8Array;
  /** Metres along the car's road. */
  pos: Float32Array;
  /** Seconds the car has been (almost) stopped. */
  wait: Float32Array;
  cooldown: Float32Array;
  seg: Int32Array;
  back: Uint8Array;
  route: (unknown | null)[];
  /** Per road lane (edge * 4 + lane): the rearmost car on it, or -1. */
  rear: Int32Array;
  lanes: Uint8Array;
  length: Float32Array;
  /** Speed limit of each road, m/s. The engine reads it every step, so changing it changes how fast cars drive there. */
  speed: Float32Array;
  /** Longitude and latitude of every road's polyline points, `ptStart[e]` to `ptStart[e + 1] - 1` for road `e`, in the direction of travel. */
  lon: Float64Array;
  lat: Float64Array;
  mPerLon: number;
  mPerLat: number;
  ptStart: Int32Array;
  laneCapacity(e: number): number;
  /** Chooses the road after `e` and the lane to enter it on. */
  pickNext(i: number, e: number): void;
  /** Places every car (keeping ids) by road weight, at safe spacing. Without `weights` roads are weighted by lane-kilometres and class. */
  reseed(options?: { population?: number; weights?: ArrayLike<number>; speeds?: ArrayLike<number>; runId?: number }): void;
  /** How many cars the network can hold at the engine's safe spacing. */
  capacity(weights?: ArrayLike<number>): number;
  step(dt: number): void;
  /** Writes [longitude, latitude, bearing in degrees] of car `i` into `out` (offset to its lane) and returns it. */
  locate(i: number, out: number[]): number[];
  stats(gridlockSeconds?: number): CarStats;
  personalityCounts(): Record<string, number>;
}
