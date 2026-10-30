import { describe, expect, it } from 'vitest';
import { loadRevenue, revenueOf, type RevenueConfig, type RevenueDrivers } from './revenue';

const config: RevenueConfig = {
  status: 'placeholder',
  fares: { average_fare_gbp: 2, shuttle_fare_gbp: 3 },
  operations: { bus_operating_gbp_per_km: 2.5 },
  levy: { rate: 0.05, paid_share: 0.8, guests_per_room: 2, nightly_rate_gbp: 100, levied_night_share: 0.5 },
  parking: { council_paid_share: 0.25, charge_gbp: 4 },
};
const drivers = (over: Partial<RevenueDrivers> = {}): RevenueDrivers => ({ festival: true, busRiders: 1000, turnedAway: 200, diverted: 0, carArrivals: 400, stayingPeople: 1000, busKm: 0, busFuelGbp: 0, ...over });

describe('revenue', () => {
  it('fares come from the riders who got on, not those a full bus turned away', () => {
    const r = revenueOf(config, drivers());
    expect(r.boardings).toBe(800);
    expect(r.fares).toBe(1600);
    expect(r.shuttleFares).toBe(0);
  });
  it('riders park-and-ride sent to shuttles pay the shuttle fare, in proportion to the share of riders they are', () => {
    const r = revenueOf(config, drivers({ diverted: 250 }));
    expect(r.shuttleBoardings).toBeCloseTo(200); // 800 boarded, a quarter of them on shuttles
    expect(r.boardings).toBeCloseTo(600);
    expect(r.fares).toBeCloseTo(1200);
    expect(r.shuttleFares).toBeCloseTo(600);
  });
  it('the levy is a share of the room-night charge, over the people who need a bed and are in paid rooms', () => {
    const r = revenueOf(config, drivers());
    expect(r.roomNights).toBe(200); // 1000 people × 0.8 paid / 2 per room × 0.5 inside the cap
    expect(r.levy).toBe(200 * 100 * 0.05);
  });
  it('parking is the cars that arrive, the share in council-charged spaces and the charge', () => {
    expect(revenueOf(config, drivers()).parking).toBe(400 * 0.25 * 4);
  });
  it('park-and-ride trades parking for shuttle fares: fewer cars arrive and the parking income falls', () => {
    const base = revenueOf(config, drivers());
    const par = revenueOf(config, drivers({ carArrivals: 250, diverted: 150 }));
    expect(par.parking).toBeLessThan(base.parking);
    expect(par.shuttleFares).toBeGreaterThan(0);
  });
  it('running costs take away from the net, and a thinned timetable adds to it', () => {
    const more = revenueOf(config, drivers({ busKm: 100, busFuelGbp: 40 }));
    expect(more.running).toBe(100 * 2.5 + 40);
    expect(more.net).toBeCloseTo(more.fares + more.levy + more.parking - 290);
    const fewer = revenueOf(config, drivers({ busKm: -100, busFuelGbp: -40 }));
    expect(fewer.running).toBe(-290);
    expect(fewer.net).toBeGreaterThan(more.net);
  });
  it('the festival-free reference run earns nothing', () => {
    const r = revenueOf(config, drivers({ festival: false }));
    expect([r.fares, r.shuttleFares, r.parking, r.levy, r.net]).toEqual([0, 0, 0, 0, 0]);
  });
  it('no riders is not a division by zero', () => {
    const r = revenueOf(config, drivers({ busRiders: 0, turnedAway: 0, diverted: 0 }));
    expect(r.fares).toBe(0);
    expect(r.shuttleFares).toBe(0);
  });
  it('a missing or malformed file is null', async () => {
    expect(await loadRevenue((async () => ({ ok: false })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadRevenue((async () => ({ ok: true, json: async () => ({ fares: {} }) })) as unknown as typeof fetch, 'http://x/')).toBeNull();
    expect(await loadRevenue((async () => ({ ok: true, json: async () => config })) as unknown as typeof fetch, 'http://x/')).toEqual(config);
  });
});
