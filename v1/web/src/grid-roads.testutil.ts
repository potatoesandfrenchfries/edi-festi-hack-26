// A small synthetic road network for tests, in the format pipeline/stage08_roads.py writes.
import type { CarData } from './cars';

/** A side x side grid of two-way streets 0.002 degrees (about 125 m by 220 m) apart, with one signalised junction. */
export function gridRoads(side = 5): CarData {
  const pos = (i: number): [number, number] => [-3.19 + (i % side) * 0.002, 55.95 + Math.floor(i / side) * 0.002];
  const edges: (number | number[])[][] = [];
  let way = 1;
  const connect = (a: number, b: number) => {
    const [lon1, lat1] = pos(a);
    const [lon2, lat2] = pos(b);
    const length = Math.round(Math.hypot((lon2 - lon1) * 62400, (lat2 - lat1) * 111200));
    edges.push([a, b, 0, 1, 13, 0, 1, length, [lon1, lat1, lon2, lat2], way, 0]);
    edges.push([b, a, 0, 1, 13, 0, 1, length, [lon2, lat2, lon1, lat1], way, 0]);
    way++;
  };
  for (let i = 0; i < side * side; i++) {
    if (i % side < side - 1) connect(i, i + 1);
    if (i + side < side * side) connect(i, i + side);
  }
  return { bbox: [-3.2, 55.94, -3.17, 55.97], classes: ['residential'], nodes: side * side, names: [''], signals: [side + 1], edges };
}
