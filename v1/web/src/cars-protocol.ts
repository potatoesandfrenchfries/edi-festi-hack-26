// Messages between the main thread and the car worker (cars.worker.ts), and the packed frame layout.
import type { TripRates, TripStats, TripVenue } from './trips';
import type { Roads } from './engine/car-sim.mjs';

export interface InitMessage {
  type: 'init';
  roads: Roads;
  /** Cars on the road at a demand of 1. */
  population: number;
  seed: number;
  /** Highest demand that will be asked for, so the engine has car slots for it. Defaults to 1. */
  maxDemand?: number;
  /** Festival venues cars can be sent to, and how many extra car slots to keep for those trips. Without venues there are no trips. */
  venues?: TripVenue[];
  tripSlots?: number;
}
/** `fraction` is the cars on the road as a multiple of the init population: the hour's share of the day times the demand slider. */
export interface DemandMessage {
  type: 'demand';
  fraction: number;
}
/** `speed` is how many simulated seconds pass per real second; `running` false pauses. `frameMs` is the minimum time between frames. */
export interface RunMessage {
  type: 'run';
  speed: number;
  running: boolean;
  frameMs: number;
}
/** Where the buses are, for the cars to react to: BUS_FLOATS numbers per bus, or null to clear their effect. */
export interface BusesMessage {
  type: 'buses';
  data: Float32Array | null;
}
/** The roads closed to vehicles right now (festival street closures), as edge indexes in the road graph. Replaces the previous set. */
export interface ClosedMessage {
  type: 'closed';
  edges: number[];
}
/** How many festival cars to start per simulated second at each venue (in the init order), arriving and leaving, and where they come from. */
export interface TripsMessage {
  type: 'trips';
  rates: TripRates;
}
export type ToWorker = InitMessage | RunMessage | DemandMessage | BusesMessage | ClosedMessage | TripsMessage;

export const BUS_FLOATS = 4; // longitude, latitude, bearing (degrees), state
export const BUS_MOVING = 0;
export const BUS_STOPPED = 1; // dwelling at a stop, holding up its lane
export const BUS_OFF_ROAD = 2; // laying over at a terminus

export interface CarStatsMessage {
  type: 'stats';
  cars: number;
  averageKmh: number;
  /** Cars stopped for over two minutes. */
  gridlocked: number;
  /** Simulated seconds per real second actually achieved: below the requested speed means the worker cannot keep up. */
  achievedSpeed: number;
  signals: number;
  /** Cars moved to a free road after being stuck too long, since the run began. */
  relocated: number;
  /** Roads currently slowed because a bus is on them (0 unless the cars and buses are coupled). */
  slowedByBuses: number;
  /** Since the last stats message: simulated seconds that passed, and over them the car-seconds lost to slow traffic (below the speed a
   *  car would choose on a clear road), car-seconds spent at a standstill, and metres driven. Rates are these over `simSeconds`. */
  simSeconds: number;
  delayCarSeconds: number;
  idleCarSeconds: number;
  distanceM: number;
  /** Festival trips since the run began; absent when no venues were given. */
  trips?: TripStats;
}
export interface ReadyMessage {
  type: 'ready';
  cars: number;
  capacity: number;
  /** For each venue given at init, whether a road lies within reach of it. */
  venuesPlaced?: boolean[];
}
/** `data` holds FLOATS_PER_CAR numbers per car: longitude, latitude, bearing (degrees), speed (m/s), personality index. */
export interface FrameMessage {
  type: 'frame';
  time: number;
  data: Float32Array;
}
export interface ErrorMessage {
  type: 'error';
  message: string;
}
export type FromWorker = ReadyMessage | FrameMessage | CarStatsMessage | ErrorMessage;

export const FLOATS_PER_CAR = 5;
