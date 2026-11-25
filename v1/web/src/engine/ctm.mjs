// Cell Transmission Model (Daganzo 1994, 1995) on the same directed road graph the car engine uses (roads.json).
//
// A macroscopic alternative to car-sim.mjs: no individual cars, only how many vehicles are in each short cell of each road. Every
// step a cell sends what is in it, up to the road's capacity, into the next cell if that has room (a triangular fundamental diagram:
// free-flow speed, a capacity per lane, a jam density per lane). Queues, spillback and shockwaves come out of those three numbers;
// capacity is an explicit parameter here, where in the car engine it emerges from car-following and cannot be set or calibrated.
//
// What it keeps from the car engine, so the two can be compared: the graph, closures (setClosed), fixed-time signals (same 90 s cycle,
// phases and seeded offsets), and the turn weights (road class x lanes, U-turns a last resort).
// Two modes. Without destinations (the default) vehicles circulate and split at junctions by fixed turn weights. With destinations
// (setDestinations) every vehicle belongs to a commodity, the node it is heading for: it splits at each junction by the shortest way to
// that node (a multi-commodity CTM), enters at sources and leaves at its destination. That is the mode a festival trip needs.
// What it cannot do: follow one vehicle, or draw a car; vehicles here are a continuous quantity.
//
// ESTIMATE: the capacities are placeholders (docs/city_wide_traffic_plan.md section 3.3 lists them as "verify").
import { CYCLE, mulberry32 } from './car-sim.mjs';

const PHASE = CYCLE / 2, GREEN_SECONDS = 40; // as car-sim.mjs: two phases, 40 s green each, then amber and all-red
// placeholder: weight of a road when choosing the next road at a junction; copied from car-sim.mjs (its table is not exported)
const POPULARITY = { motorway: 4, trunk: 3, primary: 3, secondary: 2, tertiary: 1.5, unclassified: 1, residential: 1, living_street: .5, service: .3 };
const U_TURN = .02; // as car-sim.mjs turnWeight: a last resort
// placeholder: vehicles per hour per lane one road can pass in free flow (plan section 3.3: motorway about 2000, urban single
// carriageway 900 to 1200, residential 400 to 700; all marked "verify" there)
const CAPACITY_PER_HOUR = { motorway: 2000, trunk: 1800, primary: 1200, secondary: 1200, tertiary: 900, unclassified: 700, residential: 600, living_street: 400 };
const DEFAULT_CAPACITY = 700;
const SIGNAL_SATURATION = 1800; // literature (plan section 3.3, "verify"): vehicles per hour of green per lane on a signalised approach
const JAM_DENSITY = 1 / 7.5; // vehicles per metre per lane: the car engine's slot (4.5 m car + 2 m gap + 1 m) so both fill a lane alike
const HOUR = 3600;
const ROUTE_SPREAD_S = 30; // placeholder: a way on that is this much slower than the best still takes 1/e of the share (a logit choice)
const REROUTE_EVERY_S = 60; // placeholder: how often drivers look again at how long each road is taking
const REROUTE_SMOOTHING = 0.5; // placeholder: weight of the newest travel times in the average, so flow does not flip between two ways each time
const MIN_ROUTE_SPEED = 1; // m/s: a jammed road is slow, but never infinitely so, or a route through it would be unreachable
const U_TURN_S = 90; // placeholder: extra seconds a U-turn costs when choosing a way to a destination

const baseClass = name => name.replace(/_link$/, '');

export class CellModel {
  /**
   * @param roads the road graph (roads.json layout)
   * @param options population: vehicles to spread over the network (by class x lanes x length, like the car engine's seeding);
   *   dt: seconds per step, which also sets the cell length (each cell is at least free-flow speed x dt long, the stability condition);
   *   seed: fixes the signal offsets (the same as CarSim with the same seed)
   */
  constructor(roads, { population = 0, dt = 2, seed = 1 } = {}) {
    const edges = roads.edges, E = edges.length, nodes = roads.nodes;
    this.E = E; this.nodes = nodes; this.dt = dt; this.time = 0;
    this.adaptive = false;
    this.K = 0; // destinations (commodities); 0 is the circulating mode, see setDestinations
    this.from = Int32Array.from(edges, e => e[0]); this.to = Int32Array.from(edges, e => e[1]);
    this.lanes = Uint8Array.from(edges, e => Math.max(1, e[3]));
    this.speed = Float32Array.from(edges, e => e[4]); // free-flow speed, the posted limit
    this.length = Float32Array.from(edges, e => Math.max(1, e[7]));
    this.classOf = Uint8Array.from(edges, e => e[2]);
    this.classNames = roads.classes;
    this.popularity = Float32Array.from(edges, (e, i) => (POPULARITY[baseClass(roads.classes[e[2]])] ?? 1) * this.lanes[i]);
    this.closed = new Uint8Array(E);
    // Geometry the trip helpers (trips.ts) read: the same fields the car engine has.
    this.cls = this.classOf;
    this.mPerLat = 111_320; this.mPerLon = 111_320 * Math.cos((roads.bbox ? (roads.bbox[1] + roads.bbox[3]) / 2 : 51.5) * Math.PI / 180);
    this.nodeLon = new Float64Array(nodes); this.nodeLat = new Float64Array(nodes);
    for (const edge of edges) {
      const c = edge[8];
      this.nodeLon[edge[0]] = c[0]; this.nodeLat[edge[0]] = c[1];
      this.nodeLon[edge[1]] = c[c.length - 2]; this.nodeLat[edge[1]] = c[c.length - 1];
    }

    // Incoming and outgoing edges per node (CSR).
    this.outStart = new Int32Array(nodes + 1); this.inStart = new Int32Array(nodes + 1);
    for (let e = 0; e < E; e++) { this.outStart[this.from[e] + 1]++; this.inStart[this.to[e] + 1]++; }
    for (let n = 0; n < nodes; n++) { this.outStart[n + 1] += this.outStart[n]; this.inStart[n + 1] += this.inStart[n]; }
    this.out = new Int32Array(E); this.inEdges = new Int32Array(E);
    const fillOut = this.outStart.slice(0, nodes), fillIn = this.inStart.slice(0, nodes);
    for (let e = 0; e < E; e++) { this.out[fillOut[this.from[e]]++] = e; this.inEdges[fillIn[this.to[e]]++] = e; }

    // Cells: each edge is cut into whole cells at least speed x dt long. Per edge: capacity, jam density and wave speed.
    this.cellStart = new Int32Array(E + 1);
    for (let e = 0; e < E; e++) this.cellStart[e + 1] = this.cellStart[e] + Math.max(1, Math.floor(this.length[e] / (this.speed[e] * dt)));
    const C = this.cellStart[E];
    this.cells = C;
    this.cellLength = new Float64Array(E); // metres
    this.laneCapacity = new Float64Array(E); // vehicles per second per lane
    this.waveRatio = new Float64Array(E); // wave speed / free-flow speed: how fast room opens up behind a queue, relative to free flow
    this.criticalDensity = new Float64Array(E); // vehicles per metre per lane at capacity
    this.cap = new Float64Array(C); this.room = new Float64Array(C); // per cell: most vehicles passed per step, most vehicles held
    this.signalOf = new Int32Array(E).fill(-1); this.edgePhase = new Uint8Array(E);
    this.setupSignals(roads, seed);
    for (let e = 0; e < E; e++) {
      const cells = this.cellStart[e + 1] - this.cellStart[e], lanes = this.lanes[e], vf = this.speed[e];
      // A road that ends at a signal is sized for the stop line's saturation flow, so a queue on it discharges at that rate while green.
      const perHour = Math.max(CAPACITY_PER_HOUR[baseClass(roads.classes[this.classOf[e]])] ?? DEFAULT_CAPACITY, this.signalOf[e] >= 0 ? SIGNAL_SATURATION : 0);
      // The triangular diagram needs its capacity below the jam: q/vf < kj. A very slow road would break that, so limit q.
      const qMax = Math.min(perHour / HOUR, vf * JAM_DENSITY * .5);
      const w = qMax / (JAM_DENSITY - qMax / vf);
      this.cellLength[e] = this.length[e] / cells;
      this.laneCapacity[e] = qMax; this.criticalDensity[e] = qMax / vf; this.waveRatio[e] = w / vf;
      for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) {
        this.cap[c] = qMax * lanes * dt;
        this.room[c] = JAM_DENSITY * lanes * this.cellLength[e];
      }
    }
    this.n = new Float64Array(C); // vehicles in each cell
    this.sendBuf = new Float64Array(C); this.recvBuf = new Float64Array(C); this.inBuf = new Float64Array(C); this.outBuf = new Float64Array(C);
    this.sourceRate = new Float64Array(E); this.sourceQueue = new Float64Array(E); // vehicles per second wanting in; those waiting outside
    this.sink = new Uint8Array(nodes); // 1: vehicles reaching this node leave the network
    this.exited = 0; this.entered = 0;
    let widest = 1; // scratch for the junction step: demand on, and acceptance of, each outgoing road of one junction
    for (let n = 0; n < nodes; n++) widest = Math.max(widest, this.outStart[n + 1] - this.outStart[n]);
    this.demand = new Float64Array(widest); this.scale = new Float64Array(widest);
    this.buildTurns();
    this.seed(population);
  }

  // Same signal layout as CarSim.setupSignals (phase by approach axis, seeded offsets), so a comparison run shares the signals.
  setupSignals(roads, seed) {
    const nodes = roads.signals ?? [], rng = mulberry32(seed ^ 0x5161A1);
    this.signalOffset = Float32Array.from(nodes, () => rng() * CYCLE);
    const mPerLat = 111_320, mPerLon = 111_320 * Math.cos((roads.bbox ? (roads.bbox[1] + roads.bbox[3]) / 2 : 51.5) * Math.PI / 180);
    const signalAt = new Map(nodes.map((node, s) => [node, s]));
    const axis = new Float32Array(this.E), approaches = nodes.map(() => []);
    for (let e = 0; e < this.E; e++) {
      const s = signalAt.get(this.to[e]);
      if (s === undefined) continue;
      const c = roads.edges[e][8], p = c.length - 4;
      axis[e] = ((Math.atan2((c[p + 2] - c[p]) * mPerLon, (c[p + 3] - c[p + 1]) * mPerLat) * 180 / Math.PI) + 360) % 180;
      this.signalOf[e] = s;
      approaches[s].push(e);
    }
    for (const list of approaches) {
      for (const e of list) this.edgePhase[e] = axis[e] >= 45 && axis[e] < 135 ? 1 : 0;
      if (list.length > 1 && list.every(e => this.edgePhase[e] === this.edgePhase[list[0]])) {
        for (const e of list) this.edgePhase[e] = Math.abs(((axis[e] - axis[list[0]]) % 180 + 270) % 180 - 90) > 45 ? 1 : 0;
      }
    }
  }

  /** True when vehicles may leave the end of road `e` now: green, or no signal. Amber counts as red, as the engine's cars mostly stop. */
  green(e, t = this.time) {
    const s = this.signalOf[e];
    if (s < 0) return true;
    const c = (t + this.signalOffset[s]) % CYCLE, phase = c < PHASE ? 0 : 1;
    return this.edgePhase[e] === phase && c - phase * PHASE < GREEN_SECONDS;
  }

  // Turn shares: per incoming edge, the share of its vehicles that take each outgoing edge of its end node. Closed roads get none.
  // betaStart[e] is where road e's shares start in `turn`, in the order of the end node's outgoing roads.
  buildTurns() {
    const E = this.E;
    if (!this.betaStart) {
      this.betaStart = new Int32Array(E + 1);
      for (let e = 0; e < E; e++) this.betaStart[e + 1] = this.betaStart[e] + this.outStart[this.to[e] + 1] - this.outStart[this.to[e]];
      this.turn = new Float64Array(this.betaStart[E]);
    }
    for (let e = 0; e < E; e++) {
      const node = this.to[e], base = this.betaStart[e];
      let total = 0;
      for (let k = this.outStart[node], j = 0; k < this.outStart[node + 1]; k++, j++) {
        const c = this.out[k];
        const w = this.closed[c] ? 0 : this.popularity[c] * (this.to[c] === this.from[e] ? U_TURN : 1);
        this.turn[base + j] = w; total += w;
      }
      for (let j = 0; j < this.outStart[node + 1] - this.outStart[node]; j++) this.turn[base + j] = total ? this.turn[base + j] / total : 0;
    }
  }

  /** Closes or reopens roads. Vehicles on a closed road drain out of it; none can enter, and turn shares re-form around it. */
  setClosed(edges, closed) {
    for (const e of edges) this.closed[e] = closed ? 1 : 0;
    this.buildTurns();
    if (this.K) this.buildRoutes();
  }

  /** Vehicles `perHour` want to enter at the start of road `e`, bound for destination `k` (routed mode); they wait outside when it has no room. */
  setSource(e, perHour, k = 0) { this.sourceRate[e * Math.max(1, this.K) + k] = perHour / HOUR; }

  /**
   * Switches to routed mode: vehicle commodity k is heading for junction `nodes[k]`. Empties the network and the sources. Routes are the
   * quickest way at free-flow speed round closed roads (a logit mix of near-equal ways), and are re-made when closures change.
   */
  setDestinations(nodes) {
    const K = this.K = nodes.length, C = this.cells;
    this.destNode = Int32Array.from(nodes);
    this.destsAt = new Map();
    nodes.forEach((node, k) => this.destsAt.set(node, [...(this.destsAt.get(node) ?? []), k]));
    this.nk = new Float64Array(C * K); this.dk = new Float64Array(C * K); // vehicles of each commodity in each cell, and this step's change
    this.sourceRate = new Float64Array(this.E * K); this.sourceQueue = new Float64Array(this.E * K);
    this.exitedBy = new Float64Array(K);
    this.routeShare = new Float64Array(this.betaStart[this.E] * K); // (betaStart[e] + j) * K + k: share of commodity k from road e into its j-th way on
    this.reaches = new Uint8Array(this.E * K); // 1 if a vehicle of commodity k on road e can get anywhere (or is at its destination)
    let widest = 1, deepest = 1;
    for (let n = 0; n < this.nodes; n++) { widest = Math.max(widest, this.outStart[n + 1] - this.outStart[n]); deepest = Math.max(deepest, this.inStart[n + 1] - this.inStart[n]); }
    this.mix = new Float64Array(deepest * K); this.mixShare = new Float64Array(deepest * widest); this.mixSend = new Float64Array(deepest); this.mixExit = new Float64Array(deepest);
    this.n.fill(0); this.exited = 0; this.entered = 0; this.time = 0;
    this.cost = Float64Array.from({ length: this.E }, (_, e) => this.length[e] / this.speed[e]); // seconds to drive each road, as the drivers believe it
    this.nextReroute = REROUTE_EVERY_S;
    this.buildRoutes();
  }

  /** Whether drivers re-plan by current road speeds (true) or always by free-flow times (false). Routed mode only. */
  setAdaptive(on) {
    this.adaptive = on;
    if (!on && this.K) { for (let e = 0; e < this.E; e++) this.cost[e] = this.length[e] / this.speed[e]; this.buildRoutes(); }
  }

  // Drivers' belief of each road's time moves towards what it is taking now, and routes are made again.
  reroute() {
    for (let e = 0; e < this.E; e++) {
      const now = this.length[e] / Math.max(MIN_ROUTE_SPEED, this.edgeSpeed(e));
      this.cost[e] += REROUTE_SMOOTHING * (now - this.cost[e]);
    }
    this.buildRoutes();
  }

  // Quickest time from every junction to node `target`, over roads that are not closed (a reverse Dijkstra with a binary heap).
  timesTo(target) {
    const dist = new Float64Array(this.nodes).fill(Infinity), heapKey = [], heapNode = [];
    const push = (key, node) => {
      let i = heapKey.length; heapKey.push(key); heapNode.push(node);
      while (i > 0) { const up = (i - 1) >> 1; if (heapKey[up] <= key) break; heapKey[i] = heapKey[up]; heapNode[i] = heapNode[up]; i = up; }
      heapKey[i] = key; heapNode[i] = node;
    };
    const pop = () => {
      const key = heapKey[0], node = heapNode[0], lastKey = heapKey.pop(), lastNode = heapNode.pop();
      if (heapKey.length) {
        let i = 0;
        for (;;) {
          let child = 2 * i + 1;
          if (child >= heapKey.length) break;
          if (child + 1 < heapKey.length && heapKey[child + 1] < heapKey[child]) child++;
          if (heapKey[child] >= lastKey) break;
          heapKey[i] = heapKey[child]; heapNode[i] = heapNode[child]; i = child;
        }
        heapKey[i] = lastKey; heapNode[i] = lastNode;
      }
      return [key, node];
    };
    dist[target] = 0; push(0, target);
    while (heapKey.length) {
      const [d, node] = pop();
      if (d > dist[node]) continue;
      for (let i = this.inStart[node]; i < this.inStart[node + 1]; i++) {
        const e = this.inEdges[i];
        if (this.closed[e]) continue;
        const nd = d + this.cost[e];
        if (nd < dist[this.from[e]]) { dist[this.from[e]] = nd; push(nd, this.from[e]); }
      }
    }
    return dist;
  }

  // Per commodity and road, the share taken into each way on: a logit over (this way's time + the time on from there), U-turns dearer.
  buildRoutes() {
    const K = this.K;
    this.routeShare.fill(0); this.reaches.fill(0);
    for (let k = 0; k < K; k++) {
      const dist = this.timesTo(this.destNode[k]);
      for (let e = 0; e < this.E; e++) {
        const node = this.to[e], base = this.betaStart[e];
        if (node === this.destNode[k]) { this.reaches[e * K + k] = 1; continue; }
        let best = Infinity;
        const time = [];
        for (let o = this.outStart[node], j = 0; o < this.outStart[node + 1]; o++, j++) {
          const c = this.out[o];
          const t = this.closed[c] ? Infinity : this.cost[c] + dist[this.to[c]] + (this.to[c] === this.from[e] ? U_TURN_S : 0);
          time.push(t); if (t < best) best = t;
        }
        if (best === Infinity) continue;
        let total = 0;
        for (let j = 0; j < time.length; j++) { const w = Math.exp(-(time[j] - best) / ROUTE_SPREAD_S); this.routeShare[(base + j) * K + k] = w; total += w; }
        for (let j = 0; j < time.length; j++) this.routeShare[(base + j) * K + k] /= total;
        this.reaches[e * K + k] = 1;
      }
    }
  }

  /** Vehicles reaching these nodes leave the network (up to what the road can pass). */
  setSinks(nodes) { this.sink.fill(0); for (const n of nodes) this.sink[n] = 1; }

  // Spreads `population` vehicles over the roads by class x lanes x length (the car engine's seeding weights), evenly along each road.
  seed(population) {
    this.n.fill(0); this.sourceQueue.fill(0); this.exited = 0; this.entered = 0; this.time = 0;
    if (this.K) { this.nk.fill(0); this.exitedBy.fill(0); this.nextReroute = REROUTE_EVERY_S; return; } // routed mode starts empty: vehicles come in at sources
    if (!population) return;
    let total = 0;
    const w = new Float64Array(this.E);
    for (let e = 0; e < this.E; e++) { w[e] = this.closed[e] ? 0 : this.popularity[e] * this.length[e] * this.lanes[e]; total += w[e]; } // lanes count twice, as CarSim.seed does
    let placed = 0;
    for (let e = 0; e < this.E; e++) {
      const cells = this.cellStart[e + 1] - this.cellStart[e], share = population * w[e] / total / cells;
      for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) {
        const put = Math.min(share, this.room[c] * .5); // never start beyond half of jam density
        this.n[c] = put; placed += put;
      }
    }
    if (placed < population * .98) throw new Error(`requested ${population} vehicles but only ${Math.round(placed)} fit at half of jam density`);
  }

  /** Advances by `seconds`, in whole steps of `dt` (the remainder is dropped). */
  advance(seconds) { for (let k = Math.floor(seconds / this.dt + 1e-9); k > 0; k--) this.step(); }

  // Per cell: what it can send this step and what it can take.
  limits() {
    const { E, cellStart, n, cap, room, sendBuf: send, recvBuf: recv } = this;
    for (let e = 0; e < E; e++) {
      const delta = this.waveRatio[e];
      for (let c = cellStart[e]; c < cellStart[e + 1]; c++) {
        send[c] = Math.min(n[c], cap[c]);
        recv[c] = Math.min(cap[c], delta * Math.max(0, room[c] - n[c]));
      }
    }
  }

  step() {
    if (this.K) return this.stepRouted();
    const { E, dt, cellStart, n, sendBuf: send, recvBuf: recv, inBuf: inflow, outBuf: outflow } = this;
    inflow.fill(0); outflow.fill(0);
    this.limits();
    // Within a road: a cell passes what it can send and the next cell can take.
    for (let e = 0; e < E; e++) {
      for (let c = cellStart[e]; c < cellStart[e + 1] - 1; c++) {
        const y = Math.min(send[c], recv[c + 1]);
        outflow[c] += y; inflow[c + 1] += y;
      }
    }
    // At a junction: each incoming road sends towards its outgoing roads by the turn shares, each outgoing road takes what it has room
    // for, and a road whose vehicles are held back on one turn is held back on all of them (first in, first out: no overtaking in the queue).
    for (let node = 0; node < this.nodes; node++) {
      const i0 = this.inStart[node], i1 = this.inStart[node + 1];
      if (i0 === i1) continue;
      const o0 = this.outStart[node], o1 = this.outStart[node + 1];
      if (this.sink[node]) {
        for (let i = i0; i < i1; i++) {
          const last = cellStart[this.inEdges[i] + 1] - 1;
          if (!this.green(this.inEdges[i])) continue;
          outflow[last] += send[last]; this.exited += send[last];
        }
        continue;
      }
      if (o0 === o1) continue;
      // Demand on each outgoing road, summed over incoming roads that may go now.
      let any = false;
      for (let k = o0; k < o1; k++) this.demand[k - o0] = 0;
      for (let i = i0; i < i1; i++) {
        const e = this.inEdges[i];
        if (!this.green(e)) continue;
        const s = send[cellStart[e + 1] - 1];
        if (s <= 0) continue;
        any = true;
        for (let k = o0, j = 0; k < o1; k++, j++) this.demand[j] += s * this.turn[this.betaStart[e] + j];
      }
      if (!any) continue;
      for (let k = o0, j = 0; k < o1; k++, j++) {
        const c = this.out[k], first = cellStart[c];
        const accept = this.closed[c] ? 0 : recv[first];
        this.scale[j] = this.demand[j] > accept ? accept / this.demand[j] : 1;
      }
      for (let i = i0; i < i1; i++) {
        const e = this.inEdges[i];
        if (!this.green(e)) continue;
        const last = cellStart[e + 1] - 1, s = send[last];
        if (s <= 0) continue;
        let r = 1;
        for (let k = o0, j = 0; k < o1; k++, j++) if (this.turn[this.betaStart[e] + j] > 0) r = Math.min(r, this.scale[j]);
        if (r <= 0) continue;
        outflow[last] += r * s;
        for (let k = o0, j = 0; k < o1; k++, j++) {
          const share = this.turn[this.betaStart[e] + j];
          if (share > 0) inflow[cellStart[this.out[k]]] += r * s * share;
        }
      }
    }
    // Sources: vehicles waiting outside enter a road's first cell with whatever room the junction flows left.
    for (let e = 0; e < E; e++) {
      if (!this.sourceRate[e] && !this.sourceQueue[e]) continue;
      this.sourceQueue[e] += this.sourceRate[e] * dt;
      const first = cellStart[e];
      const y = this.closed[e] ? 0 : Math.min(this.sourceQueue[e], Math.max(0, recv[first] - inflow[first]));
      inflow[first] += y; this.sourceQueue[e] -= y; this.entered += y;
    }
    for (let c = 0; c < this.cells; c++) n[c] += inflow[c] - outflow[c];
    this.time += dt;
  }


  // One step in routed mode: the same limits as `step`, but each vehicle follows the shares for its own destination, and each movement at a
  // junction is limited by its own onward road (no first-in-first-out blocking across movements).
  stepRouted() {
    const { E, K, dt, cellStart, n, nk, dk, sendBuf: send, recvBuf: recv, inBuf: inflow } = this;
    this.limits();
    inflow.fill(0); dk.fill(0);
    for (let e = 0; e < E; e++) { // within a road, every commodity moves on in proportion to its share of the cell
      for (let c = cellStart[e]; c < cellStart[e + 1] - 1; c++) {
        const y = Math.min(send[c], recv[c + 1]);
        if (y <= 0 || n[c] <= 0) continue;
        const f = y / n[c], a = c * K, b = (c + 1) * K;
        for (let k = 0; k < K; k++) { const m = nk[a + k] * f; dk[a + k] -= m; dk[b + k] += m; }
        inflow[c + 1] += y;
      }
    }
    for (let node = 0; node < this.nodes; node++) {
      const i0 = this.inStart[node], i1 = this.inStart[node + 1], o0 = this.outStart[node], o1 = this.outStart[node + 1];
      if (i0 === i1) continue;
      const width = o1 - o0, here = this.destsAt.get(node);
      let any = false;
      for (let j = 0; j < width; j++) this.demand[j] = 0;
      // Pass 1: for each incoming road that may go, the vehicles that can move (at their destination, or with a way on), their shares
      // by commodity, and so the demand each way on would get.
      for (let i = i0; i < i1; i++) {
        const e = this.inEdges[i], slot = i - i0, last = cellStart[e + 1] - 1;
        this.mixSend[slot] = 0;
        if (!this.green(e) || n[last] <= 0) continue;
        let movable = 0;
        for (let k = 0; k < K; k++) if (this.reaches[e * K + k]) movable += nk[last * K + k];
        const s = Math.min(send[last], movable);
        if (s <= 1e-12) continue;
        this.mixSend[slot] = s; any = true;
        for (let j = 0; j < width; j++) this.mixShare[slot * width + j] = 0;
        let exit = 0;
        for (let k = 0; k < K; k++) {
          const g = this.reaches[e * K + k] ? nk[last * K + k] / movable : 0;
          this.mix[slot * K + k] = g;
          if (g > 0 && here && here.includes(k)) { exit += g; continue; }
          if (g > 0) for (let j = 0; j < width; j++) this.mixShare[slot * width + j] += g * this.routeShare[(this.betaStart[e] + j) * K + k];
        }
        this.mixExit[slot] = exit;
        for (let j = 0; j < width; j++) this.demand[j] += s * this.mixShare[slot * width + j];
      }
      if (!any) continue;
      for (let j = 0; j < width; j++) {
        const c = this.out[o0 + j], accept = this.closed[c] ? 0 : recv[cellStart[c]];
        this.scale[j] = this.demand[j] > accept ? accept / this.demand[j] : 1;
      }
      // Pass 2: each movement is held back only by its own way on, as if every turn had its own lane. (Strict first-in-first-out, where one
      // full way on stops the whole road, locks the network at the first spillback, because the route shares have thin tails.)
      for (let i = i0; i < i1; i++) {
        const e = this.inEdges[i], slot = i - i0, s = this.mixSend[slot];
        if (s <= 0) continue;
        const last = cellStart[e + 1] - 1;
        for (let k = 0; k < K; k++) {
          const g = this.mix[slot * K + k];
          if (g <= 0) continue;
          if (here && here.includes(k)) { const moved = s * g; dk[last * K + k] -= moved; this.exitedBy[k] += moved; this.exited += moved; continue; }
          for (let j = 0; j < width; j++) {
            const share = this.routeShare[(this.betaStart[e] + j) * K + k];
            if (share <= 0) continue;
            const moved = s * g * share * this.scale[j], first = cellStart[this.out[o0 + j]];
            if (moved <= 0) continue;
            dk[last * K + k] -= moved; dk[first * K + k] += moved; inflow[first] += moved;
          }
        }
      }
    }
    // Sources: what waits outside enters a road's first cell with the room the junction flows left, shared out by queue length.
    for (let e = 0; e < E; e++) {
      let queued = 0;
      for (let k = 0; k < K; k++) { this.sourceQueue[e * K + k] += this.sourceRate[e * K + k] * dt; queued += this.sourceQueue[e * K + k]; }
      if (queued <= 0) continue;
      const first = cellStart[e], y = this.closed[e] ? 0 : Math.min(queued, Math.max(0, recv[first] - inflow[first]));
      if (y <= 0) continue;
      const f = y / queued;
      for (let k = 0; k < K; k++) { const m = this.sourceQueue[e * K + k] * f; dk[first * K + k] += m; this.sourceQueue[e * K + k] -= m; }
      inflow[first] += y; this.entered += y;
    }
    for (let c = 0; c < this.cells; c++) {
      let total = 0;
      for (let k = 0; k < K; k++) { const v = Math.max(0, nk[c * K + k] + dk[c * K + k]); nk[c * K + k] = v; total += v; }
      n[c] = total;
    }
    this.time += dt;
    if (this.adaptive && this.time >= this.nextReroute) { this.nextReroute = this.time + REROUTE_EVERY_S; this.reroute(); }
  }

  /** Vehicles on road `e` heading for destination `k` (routed mode). */
  vehiclesFor(e, k) { let s = 0; for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) s += this.nk[c * this.K + k]; return s; }

  /** Vehicles on road `e`. */
  vehicles(e) { let s = 0; for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) s += this.n[c]; return s; }

  /** Equilibrium speed (m/s) for a cell on road `e` holding `count` vehicles: free flow below the critical density, falling to 0 at jam. */
  cellSpeed(e, count) {
    const k = count / (this.cellLength[e] * this.lanes[e]); // vehicles per metre per lane
    if (k <= this.criticalDensity[e]) return this.speed[e];
    return Math.max(0, this.waveRatio[e] * this.speed[e] * (JAM_DENSITY - k) / k);
  }

  /** Mean speed of the vehicles on road `e`, m/s (the free-flow speed when it is empty). */
  edgeSpeed(e) {
    let weighted = 0, count = 0;
    for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) { weighted += this.n[c] * this.cellSpeed(e, this.n[c]); count += this.n[c]; }
    return count > 1e-9 ? weighted / count : this.speed[e];
  }

  /** Fraction of the road's jam capacity in use, 0 to 1. */
  occupancy(e) {
    let held = 0, room = 0;
    for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) { held += this.n[c]; room += this.room[c]; }
    return held / room;
  }

  /** Network totals: vehicles, their mean speed, and the share of vehicles in congested cells (above critical density). */
  stats() {
    let count = 0, weighted = 0, congested = 0, queued = 0;
    for (let e = 0; e < this.E; e++) {
      const limit = this.criticalDensity[e] * this.cellLength[e] * this.lanes[e];
      for (let c = this.cellStart[e]; c < this.cellStart[e + 1]; c++) {
        const v = this.n[c]; count += v; weighted += v * this.cellSpeed(e, v);
        if (v > limit) congested += v;
      }
    }
    for (let i = 0; i < this.sourceQueue.length; i++) queued += this.sourceQueue[i];
    return { vehicles: count, averageSpeedMps: count > 1e-9 ? weighted / count : 0, congestedShare: count > 1e-9 ? congested / count : 0, waiting: queued, exited: this.exited, entered: this.entered };
  }

  /** Vehicles in the network (not those waiting to enter). Constant in a closed system; otherwise it changes by entered minus exited. */
  mass() { let m = 0; for (let c = 0; c < this.cells; c++) m += this.n[c]; return m; }
}
