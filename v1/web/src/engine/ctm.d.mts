// Types for ctm.mjs, the Cell Transmission Model experiment. The engine is plain JavaScript, so these are written by hand.
import type { Roads } from './car-sim.mjs';

export interface CellStats {
  vehicles: number;
  averageSpeedMps: number;
  /** Share of the vehicles that are in cells above the critical density (queueing or about to). */
  congestedShare: number;
  /** Vehicles waiting outside a road for room to enter. */
  waiting: number;
  exited: number;
  entered: number;
}

export class CellModel {
  constructor(roads: Roads, options?: { population?: number; dt?: number; seed?: number });
  E: number;
  nodes: number;
  /** Seconds per step. */
  dt: number;
  /** Simulated seconds so far. */
  time: number;
  /** Total number of cells, and the first cell of each road (`cellStart[e]` to `cellStart[e + 1] - 1`). */
  cells: number;
  cellStart: Int32Array;
  /** Vehicles in each cell. */
  n: Float64Array;
  closed: Uint8Array;
  lanes: Uint8Array;
  speed: Float32Array;
  length: Float32Array;
  /** Vehicles per second per lane at capacity, and the density (vehicles per metre per lane) where capacity is reached. */
  laneCapacity: Float64Array;
  criticalDensity: Float64Array;
  /** Length in metres of each road's cells. */
  cellLength: Float64Array;
  /** Most vehicles a cell holds (jam density x lanes x cell length). */
  room: Float64Array;
  from: Int32Array;
  to: Int32Array;
  /** The roads leaving each node (`out`, from `outStart`), as in the car engine. */
  outStart: Int32Array;
  out: Int32Array;
  /** Share of vehicles from road `e` that take each road leaving its end node: `turn[betaStart[e] + j]` for the j-th of them. */
  betaStart: Int32Array;
  turn: Float64Array;
  /** True when vehicles may leave the end of road `e` at time `t` (default now): green, or no signal. Amber counts as red. */
  green(e: number, t?: number): boolean;
  setClosed(edges: ArrayLike<number>, closed: boolean): void;
  /** Vehicles per hour wanting in at the start of a road, bound for destination `k` (routed mode; `k` is 0 otherwise). */
  setSource(edge: number, perHour: number, k?: number): void;
  /**
   * Routed mode: commodity k is heading for junction `nodes[k]` by the quickest way round closed roads. Empties the network and the sources.
   * Vehicles enter at sources and leave at their destination.
   */
  setDestinations(nodes: ArrayLike<number>): void;
  /** Number of destinations (0 when circulating). */
  K: number;
  /** Vehicles that have entered at sources and that have left, in total. */
  entered: number;
  exited: number;
  /** Vehicles that have left at each destination. */
  exitedBy: Float64Array;
  /** Vehicles on road `e` heading for destination `k`. */
  vehiclesFor(e: number, k: number): number;
  setSinks(nodes: ArrayLike<number>): void;
  /** Spreads `population` vehicles over the roads and resets the clock. */
  seed(population: number): void;
  advance(seconds: number): void;
  step(): void;
  vehicles(e: number): number;
  cellSpeed(e: number, count: number): number;
  edgeSpeed(e: number): number;
  /** Fraction of the road's jam capacity in use, 0 to 1. */
  occupancy(e: number): number;
  stats(): CellStats;
  mass(): number;
}
