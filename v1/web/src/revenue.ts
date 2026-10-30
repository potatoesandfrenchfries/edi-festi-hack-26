// What the festival brings in, to set beside what it loses: bus fares, the visitor levy and parking. A modelled ESTIMATE from placeholder
// constants (../../config/revenue.yaml, written to data/revenue.json by `make revenue`), never an accounts figure. Pure functions, so
// they are tested without a map, a worker or a clock. Only the festival's own increment is counted: the same evening without it earns 0.
//
// The revenue falls on different people from the losses (the council and bus operators gain cash; drivers and riders lose time), so it
// is reported next to the cost, never subtracted from it. The bus fuel in `running` is also inside the cost's fuel line: do not add both.

export const REVENUE_PATH = 'data/revenue.json';

export interface RevenueConfig {
  status: string;
  fares: { average_fare_gbp: number; shuttle_fare_gbp: number };
  operations: { bus_operating_gbp_per_km: number };
  levy: { rate: number; paid_share: number; guests_per_room: number; nightly_rate_gbp: number; levied_night_share: number };
  parking: { council_paid_share: number; charge_gbp: number };
}

/** What a run did, in the units the revenue is earned in. The festival flag is false for the festival-free reference run. */
export interface RevenueDrivers {
  festival: boolean;
  /** Bus riders wanting a seat in the window (both directions, including park-and-ride shuttle riders), and those a full bus turned away. */
  busRiders: number;
  turnedAway: number;
  /** Riders park-and-ride sent to shuttles. */
  diverted: number;
  /** Real cars arriving for the festival in the window. */
  carArrivals: number;
  /** People who need a bed on the date's night because of the festival. */
  stayingPeople: number;
  /** Bus-kilometres added to (or, if negative, saved from) today's timetable, shuttles included, and the fuel they burn. */
  busKm: number;
  busFuelGbp: number;
}

export interface Revenue {
  /** Riders who got on a town bus or tram, and who got on a shuttle, in the window. */
  boardings: number;
  shuttleBoardings: number;
  /** Room-nights charged the levy on the date's night. */
  roomNights: number;
  fares: number;
  shuttleFares: number;
  parking: number;
  levy: number;
  /** Extra bus running: kilometres at the operating rate plus their fuel. A saving (negative) when the timetable is thinned. */
  running: number;
  /** fares + shuttleFares + parking + levy − running. */
  net: number;
}

export async function loadRevenue(fetchFn: typeof fetch = fetch, base: string = document.baseURI): Promise<RevenueConfig | null> {
  try {
    const response = await fetchFn(new URL(REVENUE_PATH, base));
    if (!response.ok) return null;
    const data = (await response.json()) as RevenueConfig;
    return data.fares && data.operations && data.levy && data.parking ? data : null;
  } catch {
    return null;
  }
}

/**
 * Revenue for one run. Riders who boarded are the riders less those turned away; the share of them that park-and-ride sent to a shuttle
 * pays the shuttle fare, the rest the average town fare. Parking comes from the cars that arrive and park in a council-charged space.
 * The levy is for the whole night of the date, not just the evening window: it is charged per room-night, from the people who need a bed.
 */
export function revenueOf(config: RevenueConfig, d: RevenueDrivers): Revenue {
  const riders = d.festival ? d.busRiders : 0;
  const boarded = Math.max(riders - d.turnedAway, 0);
  const shuttleShare = riders > 0 ? Math.min(d.diverted / riders, 1) : 0;
  const shuttleBoardings = boarded * shuttleShare;
  const boardings = boarded - shuttleBoardings;
  const rooms = d.festival ? (d.stayingPeople * config.levy.paid_share) / config.levy.guests_per_room : 0;
  const roomNights = rooms * config.levy.levied_night_share;
  const fares = boardings * config.fares.average_fare_gbp;
  const shuttleFares = shuttleBoardings * config.fares.shuttle_fare_gbp;
  const parking = d.festival ? d.carArrivals * config.parking.council_paid_share * config.parking.charge_gbp : 0;
  const levy = roomNights * config.levy.nightly_rate_gbp * config.levy.rate;
  const running = d.busKm * config.operations.bus_operating_gbp_per_km + d.busFuelGbp;
  return { boardings, shuttleBoardings, roomNights, fares, shuttleFares, parking, levy, running, net: fares + shuttleFares + parking + levy - running };
}
