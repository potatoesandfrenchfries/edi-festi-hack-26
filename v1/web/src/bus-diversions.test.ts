import { describe, expect, it } from 'vitest';
import { allBuses, BusSimulation, createModel, decodeShape, type BusData, type BusRoute } from './buses';
import { BusDiverter, DETOUR_SPEED_M_S, DIVERSION_RULES, encodeShape, findRuns, isDiverted, NEAR_M, rulesAt, type DiversionRule } from './bus-diversions';
import { gridRoads } from './grid-roads.testutil';

// The grid: node = row * 7 + col, 0.002 degrees apart (about 125 m east-west). Row 3 is the street the buses run along.
const SIDE = 7;
const roads = gridRoads(SIDE);
const lonOf = (col: number) => -3.19 + col * 0.002;
const latOf = (row: number) => 55.95 + row * 0.002;
const node = (row: number, col: number) => row * SIDE + col;
const edgeIndex = (a: number, b: number) => roads.edges.findIndex((e) => e[0] === a && e[1] === b);
/** Both directions of the road between two neighbouring nodes. */
const between = (a: number, b: number) => [edgeIndex(a, b), edgeIndex(b, a)];

const SCALE = 1e5;
const rowShape = encodeShape([0, 1, 2, 3, 4, 5, 6].map(lonOf), Array(7).fill(latOf(3)), SCALE); // west to east along row 3
const columnShape = encodeShape(Array(7).fill(lonOf(3)), [0, 1, 2, 3, 4, 5, 6].map(latOf), SCALE); // south to north along column 3, across row 3
const rowCum = decodeShape(rowShape, SCALE).cum;
const columnCum = decodeShape(columnShape, SCALE).cum;

const alongRow: BusRoute = {
  name: '9',
  agency: 'LOTH',
  headway: 600,
  legs: [{
    shape: 0,
    stops: [0, 1, 2, 3, 4, 5],
    dists: [0, 1, 2, 4, 5, 6].map((c) => rowCum[c] as number),
    times: [0, 0, 40, 50, 90, 100, 190, 200, 240, 250, 290, 290],
    headsign: 'East',
  }],
};
const acrossRow: BusRoute = {
  name: 'C',
  agency: 'LOTH',
  headway: 600,
  legs: [{ shape: 1, stops: [6, 7], dists: [columnCum[0] as number, columnCum[6] as number], times: [0, 0, 300, 300], headsign: 'North' }],
};
const data = (routes: BusRoute[]): BusData => ({
  meta: { feedVersion: 't', typicalDay: 't', coordScale: SCALE, layover: 60, source: 't' },
  routes,
  stops: [[lonOf(0), latOf(3), 'a'], [lonOf(1), latOf(3), 'b'], [lonOf(2), latOf(3), 'c'], [lonOf(4), latOf(3), 'd'], [lonOf(5), latOf(3), 'e'], [lonOf(6), latOf(3), 'f'], [lonOf(3), latOf(0), 'g'], [lonOf(3), latOf(6), 'h']],
  shapes: [rowShape, columnShape],
});

/** Row 3 between columns 2 and 4 closed, both ways: 250 m of the street the bus runs along. */
const closedStretch = [...between(node(3, 2), node(3, 3)), ...between(node(3, 3), node(3, 4))];

describe('encodeShape', () => {
  it('round trips through decodeShape to within the data file’s precision', () => {
    const lon = [lonOf(0), lonOf(1) + 0.000013, lonOf(2)];
    const lat = [latOf(3), latOf(3) + 0.00002, latOf(3)];
    const back = decodeShape(encodeShape(lon, lat, SCALE), SCALE);
    lon.forEach((x, i) => expect(Math.abs((back.lon[i] as number) - x)).toBeLessThan(1 / SCALE));
    lat.forEach((y, i) => expect(Math.abs((back.lat[i] as number) - y)).toBeLessThan(1 / SCALE));
  });
});

describe('findRuns', () => {
  const on = (lon: number, lat: number, bearing: number) => Math.abs(lat - latOf(3)) < 0.0001 && lon > lonOf(2) && lon < lonOf(4) && (bearing === 90 || bearing === 270);
  it('finds one stretch along a street, in metres along the path', () => {
    const runs = findRuns(decodeShape(rowShape, SCALE), { on });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.from).toBeGreaterThan((rowCum[2] as number) - 10);
    expect(runs[0]!.to).toBeLessThan((rowCum[4] as number) + 10);
  });
  it('ignores a path that only crosses the street (heading the wrong way, and short)', () => {
    expect(findRuns(decodeShape(columnShape, SCALE), { on })).toEqual([]);
  });
});

describe('diverting buses round a closed street', () => {
  it('changes nothing while nothing is closed', () => {
    const timetable = data([alongRow]);
    const result = new BusDiverter(roads, timetable).apply([]);
    expect(result.data).toBe(timetable);
    expect(result.stats.legs).toBe(0);
  });

  it('sends a bus that runs along the closed stretch round it, skipping the stops on it', () => {
    const timetable = data([alongRow]);
    const { data: out, stats } = new BusDiverter(roads, timetable).apply(closedStretch);
    const leg = out.routes[0]!.legs[0]!;
    expect(leg.diverted).toBe(true);
    expect(stats).toMatchObject({ legs: 1, routes: ['9'], skippedStops: 2 });
    expect(leg.stops).toEqual([0, 1, 4, 5]); // the stops at columns 2 and 4 were on the closed street
    // The new path never goes along the closed street (nothing within the closed-street distance of its middle).
    const path = decodeShape(out.shapes[leg.shape]!, SCALE);
    const middle = { x: lonOf(3) * 62400, y: latOf(3) * 111200 };
    for (let i = 0; i < path.lon.length; i++) expect(Math.hypot((path.lon[i] as number) * 62400 - middle.x, (path.lat[i] as number) * 111200 - middle.y)).toBeGreaterThan(NEAR_M);
    // It starts and ends where it did, and the later stops are further along by what the detour adds.
    expect(path.lon[0]).toBeCloseTo(lonOf(0), 5);
    expect(path.lon[path.lon.length - 1]).toBeCloseTo(lonOf(6), 5);
    const added = (leg.dists[3] as number) - (alongRow.legs[0]!.dists[5] as number);
    expect(added).toBeGreaterThan(200);
    expect(stats.extraMetres).toBeCloseTo(added, 0);
    // The bus takes longer by that distance at the detour speed; the stops before the closure keep their times.
    expect(leg.times.slice(0, 4)).toEqual([0, 0, 40, 50]);
    expect((leg.times[7] as number) - 290).toBeCloseTo(added / DETOUR_SPEED_M_S, 3);
    // The path still ends at its last stop.
    expect(leg.dists[3] as number).toBeLessThanOrEqual(path.cum[path.cum.length - 1]! + 1e-6);
  });

  it('leaves a route that crosses the closed street at a junction alone', () => {
    const timetable = data([alongRow, acrossRow]);
    const { data: out, stats } = new BusDiverter(roads, timetable).apply(closedStretch);
    expect(out.routes[1]).toBe(timetable.routes[1]);
    expect(stats.routes).toEqual(['9']);
  });

  it('lets an exempt route through', () => {
    const timetable = data([alongRow]);
    const { data: out, stats } = new BusDiverter(roads, timetable, new Set(['9'])).apply(closedStretch);
    expect(out.routes[0]).toBe(timetable.routes[0]);
    expect(stats.legs).toBe(0);
  });

  it('keeps the bus on its path and says so when there is no way round', () => {
    // Every road is closed except the two ends of row 3, so the junctions either side of the closed stretch are cut off from each other.
    const open = new Set([...between(node(3, 0), node(3, 1)), ...between(node(3, 1), node(3, 2)), ...between(node(3, 4), node(3, 5)), ...between(node(3, 5), node(3, 6))]);
    const closed = roads.edges.map((_, i) => i).filter((i) => !open.has(i));
    const timetable = data([alongRow]);
    const { data: out, stats } = new BusDiverter(roads, timetable).apply(closed);
    expect(out.routes[0]!.legs[0]!.diverted).toBeUndefined();
    expect(stats.legs).toBe(0);
    expect(stats.failed.length).toBeGreaterThan(0);
    expect(stats.failed[0]!.reason).toMatch(/way round/);
  });

  it('reopening puts the timetable back, and a new closure after it is found afresh', () => {
    const timetable = data([alongRow]);
    const diverter = new BusDiverter(roads, timetable);
    expect(diverter.apply(closedStretch).stats.legs).toBe(1);
    expect(diverter.apply([]).data).toBe(timetable);
    // A different, shorter closure: only the stretch between columns 2 and 3.
    const shorter = diverter.apply(between(node(3, 2), node(3, 3)));
    expect(shorter.stats.legs).toBe(1);
    expect(shorter.data.routes[0]!.legs[0]!.stops).not.toEqual(diverter.apply(closedStretch).data.routes[0]!.legs[0]!.stops);
    expect(diverter.apply(closedStretch)).toBe(diverter.apply(closedStretch)); // cached by the set of closed roads
  });

  it('gives a diverted timetable the model and the buses still work on', () => {
    const { data: out } = new BusDiverter(roads, data([alongRow])).apply(closedStretch);
    const model = createModel(out, 1);
    for (const t of [0, 100, 250, 400]) {
      for (const bus of allBuses(model, t)) {
        expect(Number.isFinite(bus.lon) && Number.isFinite(bus.lat)).toBe(true);
        expect(bus.lon).toBeGreaterThan(lonOf(0) - 0.0005);
        expect(bus.lon).toBeLessThan(lonOf(6) + 0.0005);
      }
    }
    expect(allBuses(model, 0).some(isDiverted)).toBe(true);
  });
});

describe('the bus simulation with closures', () => {
  it('diverts while streets are closed and goes back when they reopen', () => {
    const timetable = data([alongRow]);
    const sim = new BusSimulation(timetable);
    sim.setDiverter(new BusDiverter(roads, timetable));
    expect(sim.diversions()).toBeNull();
    sim.setClosedEdges(closedStretch);
    expect(sim.diversions()).toMatchObject({ legs: 1, routes: ['9'] });
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBe(true);
    sim.setClosedEdges([]);
    expect(sim.diversions()).toBeNull();
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBeUndefined();
  });
  it('keeps the diversion when the frequency changes', () => {
    const timetable = data([alongRow]);
    const sim = new BusSimulation(timetable);
    sim.setDiverter(new BusDiverter(roads, timetable));
    sim.setClosedEdges(closedStretch);
    sim.setFrequency(2);
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBe(true);
    expect(sim.model.routes[0]!.headway).toBe(300);
  });
  it('does nothing about closures without a diverter', () => {
    const sim = new BusSimulation(data([alongRow]));
    sim.setClosedEdges(closedStretch);
    expect(sim.diversions()).toBeNull();
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBeUndefined();
  });
});

describe('closures to buses from the notices (rules)', () => {
  // The same grid, but with the row-3 street between columns 2 and 4 missing from the car graph, as a bus-only street is, and named streets
  // to go round by: Col2 and Col4 (vertical), Up (row 4) and Down (row 2).
  const names = ['', 'Col2', 'Col4', 'Up', 'Down'];
  const nameOf = (a: number, b: number): number => {
    const [ra, ca] = [Math.floor(a / SIDE), a % SIDE];
    const [rb, cb] = [Math.floor(b / SIDE), b % SIDE];
    if (ca === 2 && cb === 2 && ra >= 2 && ra <= 4 && rb >= 2 && rb <= 4) return 1;
    if (ca === 4 && cb === 4 && ra >= 2 && ra <= 4 && rb >= 2 && rb <= 4) return 2;
    if (ra === 4 && rb === 4 && ca >= 2 && ca <= 4 && cb >= 2 && cb <= 4) return 3;
    if (ra === 2 && rb === 2 && ca >= 2 && ca <= 4 && cb >= 2 && cb <= 4) return 4;
    return 0;
  };
  const gap = new Set([node(3, 2) * 100 + node(3, 3), node(3, 3) * 100 + node(3, 2), node(3, 3) * 100 + node(3, 4), node(3, 4) * 100 + node(3, 3)]);
  const gapRoads = {
    ...roads,
    names,
    edges: roads.edges.filter((e) => !gap.has((e[0] as number) * 100 + (e[1] as number))).map((e) => [...e.slice(0, 10), nameOf(e[0] as number, e[1] as number)]),
  };
  const section = { name: 'Main Street', line: [[lonOf(2), latOf(3)], [lonOf(4), latOf(3)]] as const };
  const rule = (via: DiversionRule['via']): DiversionRule => ({ id: 'test', source: 'test', from: '2026-08-01', to: '2026-08-31', section, via });
  const westShape = encodeShape([6, 5, 4, 3, 2, 1, 0].map(lonOf), Array(7).fill(latOf(3)), SCALE);
  const westCum = decodeShape(westShape, SCALE).cum;
  const westRoute: BusRoute = {
    name: 'W', agency: 'LOTH', headway: 600,
    legs: [{ shape: 2, stops: [0, 1, 2, 3], dists: [0, 1, 5, 6].map((c) => westCum[c] as number), times: [0, 0, 40, 50, 190, 200, 240, 240], headsign: 'West' }],
  };
  const timetable = (routes: BusRoute[]): BusData => ({ ...data(routes), shapes: [rowShape, columnShape, westShape] });
  const lats = (out: BusData, route: string) => {
    const leg = out.routes.find((r) => r.name === route)!.legs[0]!;
    return Array.from(decodeShape(out.shapes[leg.shape]!, SCALE).lat);
  };
  const touches = (list: number[], lat: number) => list.some((y) => Math.abs(y - lat) < 0.00002);

  it('is in force only between its dates, and a diversion starts on its own date', () => {
    const r = rule([{ from: '2026-08-10', routes: ['9'], direction: 'east', streets: ['Col2', 'Up', 'Col4'] }]);
    expect(rulesAt('2026-07-31', [r])).toEqual([]);
    expect(rulesAt('', [r])).toEqual([]);
    expect(rulesAt('2026-08-05', [r])[0]!.via).toHaveLength(0);
    expect(rulesAt('2026-08-10', [r])[0]!.via).toHaveLength(1);
    expect(rulesAt('2026-08-31', [r])).toHaveLength(1);
    expect(rulesAt('2026-09-01', [r])).toEqual([]);
    expect(rulesAt('2026-08-05', [r])[0]!.id).not.toBe(rulesAt('2026-08-10', [r])[0]!.id); // a change in what has started is noticed
  });
  it('the Princes Street rule is there for the festival, with its section and the six routes the 5 August notice names', () => {
    const princes = DIVERSION_RULES.find((r) => r.id === 'princes-street-fire-2026')!;
    expect([princes.from, princes.to]).toEqual(['2026-07-09', '2026-08-28']);
    expect(rulesAt('2026-08-15')).toHaveLength(1);
    expect(rulesAt('2026-08-29')).toEqual([]);
    expect(princes.via.flatMap((v) => v.routes).sort()).toEqual(['106', '106', '43', '43', 'X6', 'X6']);
    expect(princes.section.line).toHaveLength(2);
  });

  it('sends every bus along the closed section round it, though no road of the graph is closed', () => {
    const diverter = new BusDiverter(gapRoads, timetable([alongRow]), new Set(), [rule([])]);
    const out = diverter.apply([], diverter.rulesAt('2026-08-15'));
    expect(out.stats).toMatchObject({ legs: 1, routes: ['9'], skippedStops: 2 });
    const y = lats(out.data, '9');
    expect(y.some((v) => Math.abs(v - latOf(3)) > 0.0005)).toBe(true); // it left row 3
  });
  it('follows the streets a notice names, in the direction it names them', () => {
    const east = new BusDiverter(gapRoads, timetable([alongRow, westRoute]), new Set(), [
      rule([
        { routes: ['9'], direction: 'east', streets: ['Col2', 'Up', 'Col4'] },
        { routes: ['W'], direction: 'west', streets: ['Col4', 'Down', 'Col2'] },
      ]),
    ]);
    const out = east.apply([], east.rulesAt('2026-08-15')).data;
    const eastY = lats(out, '9');
    const westY = lats(out, 'W');
    expect(touches(eastY, latOf(4))).toBe(true);
    expect(touches(eastY, latOf(2))).toBe(false);
    expect(touches(westY, latOf(2))).toBe(true);
    expect(touches(westY, latOf(4))).toBe(false);
  });
  it('a route not named gets the quickest way round, and a named street that is not in the graph is ignored', () => {
    const d = new BusDiverter(gapRoads, timetable([alongRow]), new Set(), [rule([{ routes: ['9'], direction: 'east', streets: ['Nowhere Road', 'Col4'] }])]);
    const out = d.apply([], d.rulesAt('2026-08-15'));
    expect(out.stats.legs).toBe(1); // diverted all the same
    const other = new BusDiverter(gapRoads, timetable([alongRow]), new Set(), [rule([{ routes: ['X'], direction: 'east', streets: ['Col2', 'Down', 'Col4'] }])]);
    expect(other.apply([], other.rulesAt('2026-08-15')).stats.legs).toBe(1); // route 9 is not X
  });
  it('joins streets that do not meet by the quickest way between them', () => {
    const d = new BusDiverter(gapRoads, timetable([alongRow]), new Set(), [rule([{ routes: ['9'], direction: 'east', streets: ['Col2', 'Col4'] }])]);
    const out = d.apply([], d.rulesAt('2026-08-15'));
    expect(out.stats.legs).toBe(1);
    expect(lats(out.data, '9').some((v) => Math.abs(v - latOf(3)) > 0.0005)).toBe(true);
  });
  it('changes nothing out of its dates, and a route that crosses the section is left alone', () => {
    const d = new BusDiverter(gapRoads, timetable([alongRow, acrossRow]), new Set(), [rule([])]);
    const before = timetable([alongRow, acrossRow]);
    expect(d.apply([], d.rulesAt('2026-09-15')).stats.legs).toBe(0);
    const out = d.apply([], d.rulesAt('2026-08-15'));
    expect(out.data.routes[1]).toEqual(before.routes[1]);
    expect(out.stats.routes).toEqual(['9']);
  });
  it('the bus simulation follows the date: diverted inside the dates, back outside, and nothing is rebuilt for the same date', () => {
    const tt = timetable([alongRow]);
    const sim = new BusSimulation(tt);
    sim.setDiverter(new BusDiverter(gapRoads, tt, new Set(), [rule([])]));
    sim.setDate('2026-08-15');
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBe(true);
    const model = sim.model;
    sim.setDate('2026-08-16');
    expect(sim.model).toBe(model);
    sim.setDate('2026-09-15');
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBeUndefined();
    expect(sim.diversions()).toBeNull();
    sim.setDate('');
    expect(sim.model.routes[0]!.legs[0]!.diverted).toBeUndefined();
  });
});
