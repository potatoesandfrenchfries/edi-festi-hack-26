// 3D traffic signals: a Three.js custom layer drawn inside the map's own WebGL context (the same approach as the cars in car3d.ts and the buses
// in bus3d.ts), so buildings hide the signals and are hidden by them properly. Each approach is a pole on the left kerb (traffic drives on the
// left) with a signal head facing the oncoming traffic: a dark housing with three lamps, the lit one in the state's colour, and a cap on
// top in the same colour, so the state still reads from straight above, where the lamps face sideways. The state is the car engine's modelled
// 90-second cycle, not real timings. Zoomed out the signals are enlarged so they still read. If the models cannot be set up, the caller keeps
// the dots of signals.ts.
import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { localMetres, metresPerPixel } from './bus3d';
import { SIGNALS_MIN_ZOOM, SIGNAL_AMBER, SIGNAL_COLOURS, SIGNAL_GREEN, SIGNAL_RED } from './signals';

export const SIGNAL3D_LAYER = 'signals-3d';

const MAX_APPROACHES = 2048; // far above the real count (about 350); the draw is clamped to it
const ORIGIN: [number, number] = [-3.19, 55.95];
const CULL_PAD_DEG = 0.002;
/** Metres from the stop line's lane to the pole, to its left: about the kerb of a two-lane road. */
export const KERB_OFFSET_M = 3;
export const HEAD_HEIGHT_M = 1.3; // keep in step with signalGeometry
export const SIGNAL_PX_AT_REF_ZOOM = 9; // on-screen height of a signal head (CSS pixels) at `REF_ZOOM`, about twice its real size there
const REF_ZOOM = 17;
const SIZE_PER_ZOOM = 0.5; // on-screen size changes by 2^0.5 per zoom level, against 2 for the map
export const MAX_SCALE = 6;
/** Signals are not drawn below this zoom (the same as the dots). */
export const MIN_ZOOM = SIGNALS_MIN_ZOOM;

/** How much to enlarge a signal so its head is `SIGNAL_PX_AT_REF_ZOOM` pixels tall at the reference zoom: 1 (real size) once zoomed in far enough. */
export function signalScale(zoom: number, lat: number): number {
  const real = HEAD_HEIGHT_M / metresPerPixel(zoom, lat);
  const wanted = SIGNAL_PX_AT_REF_ZOOM * 2 ** (SIZE_PER_ZOOM * (zoom - REF_ZOOM));
  return Math.min(MAX_SCALE, Math.max(1, wanted / real));
}

/** Where the pole stands relative to the stop line, in metres east and north: `metres` to the left of a vehicle travelling at `travelBearing`. */
export function poleOffset(travelBearing: number, metres = KERB_OFFSET_M): { east: number; north: number } {
  const b = (travelBearing * Math.PI) / 180;
  return { east: -Math.cos(b) * metres, north: Math.sin(b) * metres }; // left of the direction (sin b, cos b)
}

/** The way the head faces: back along the road, towards the oncoming traffic. */
export const faceBearing = (travelBearing: number): number => (travelBearing + 180) % 360;

/** Lamp heights above the housing's centre, red at the top, and the lamp the state lights: 0 red, 1 amber, 2 green. */
export const LAMP_Z = [0.42, 0, -0.42] as const;
export const LIT_LAMP = { [SIGNAL_RED]: 0, [SIGNAL_AMBER]: 1, [SIGNAL_GREEN]: 2 } as const;
const DIM = { light: ['#4a1a1f', '#4d3d10', '#14382c'], dark: ['#2e1417', '#322810', '#0f2a21'] } as const;

/** Colour of lamp `lamp` (0 top, 1 middle, 2 bottom) when the signal shows `state`: the state's colour if it is the lit lamp, a dark tint of its own colour if not. */
export function lampColour(state: number, lamp: number, dark: boolean): string {
  const set = SIGNAL_COLOURS[dark ? 'dark' : 'light'];
  if (LIT_LAMP[state as 0 | 1 | 2] === lamp) return [set.red, set.amber, set.green][lamp] as string;
  return DIM[dark ? 'dark' : 'light'][lamp] as string;
}
/** Colour of the cap on top of the head: the state's colour. */
export function capColour(state: number, dark: boolean): string {
  const set = SIGNAL_COLOURS[dark ? 'dark' : 'light'];
  return state === SIGNAL_RED ? set.red : state === SIGNAL_AMBER ? set.amber : set.green;
}

const box = (w: number, l: number, h: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, l, h).translate(x, y, z);

/** The parts of one signal in metres, at its pole: x across, y along (the head's face is +y), z up. */
export function signalGeometry(): { structure: THREE.BufferGeometry; cap: THREE.BufferGeometry; lamp: THREE.BufferGeometry } {
  const headZ = 3.75; // centre of the head, on top of a 4.4 m pole
  const structure = mergeGeometries([
    box(0.16, 0.16, 4.4, 0, 0, 2.2), // pole
    box(0.5, 0.32, HEAD_HEIGHT_M, 0, 0.2, headZ), // housing
    box(0.78, 0.04, 1.6, 0, 0.03, headZ), // backing board behind the lamps
  ]);
  const cap = box(0.5, 0.32, 0.1, 0, 0.2, headZ + HEAD_HEIGHT_M / 2 + 0.05);
  const lamp = new THREE.CylinderGeometry(0.13, 0.13, 0.06, 12); // a cylinder's axis is y, so its flat face looks along +y, the head's face
  return { structure: structure ?? new THREE.BufferGeometry(), cap, lamp };
}

export class Signal3dLayer implements maplibregl.CustomLayerInterface {
  readonly id = SIGNAL3D_LAYER;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private positions: Float64Array = new Float64Array(0);
  private bearings: Float32Array = new Float32Array(0);
  private states: Uint8Array = new Uint8Array(0);
  private dark = false;
  private visible = true;
  private ready = false;
  private map: maplibregl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private structure: THREE.InstancedMesh | null = null;
  private cap: THREE.InstancedMesh | null = null;
  private lamps: THREE.InstancedMesh | null = null;
  private materials: THREE.Material[] = [];
  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN);

  /** `onUnavailable` runs if the models cannot be set up, so the caller can keep the dots visible. */
  constructor(private readonly onUnavailable: () => void) {}

  /** Where each approach's stop line is ([longitude, latitude, ...]) and the bearing its traffic travels in, in degrees clockwise from north. */
  setSignals(positions: Float64Array | undefined, bearings: Float32Array | undefined): void {
    if (!positions || !bearings) return;
    this.positions = positions;
    this.bearings = bearings;
  }
  /** The state of each approach, in the same order: 0 green, 1 amber, 2 red. */
  setStates(states: Uint8Array | undefined): void {
    if (states) this.states = states;
  }
  setDark(dark: boolean): void {
    this.dark = dark;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.map = map;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false; // the map has already drawn into this frame
      this.build();
      this.ready = true;
    } catch (error) {
      console.warn('3D signals unavailable, keeping the dots', error);
      this.ready = false;
      this.onUnavailable();
    }
  }

  onRemove(): void {
    this.ready = false;
    for (const mesh of [this.structure, this.cap, this.lamps]) {
      mesh?.geometry.dispose();
      mesh?.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.scene.clear();
    this.materials = [];
    this.structure = this.cap = this.lamps = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  render(_gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void {
    const { map, renderer, structure, cap, lamps } = this;
    if (!this.ready || !this.visible || !map || !renderer || !structure || !cap || !lamps || map.getZoom() < MIN_ZOOM) return;
    const count = this.place(map, structure, cap, lamps);
    if (count === 0) return;
    structure.count = cap.count = count;
    lamps.count = count * 3;

    const metre = this.origin.meterInMercatorCoordinateUnits();
    const toMercator = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, this.origin.z).scale(new THREE.Vector3(metre, -metre, metre));
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(toMercator);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    renderer.resetState();
    renderer.render(this.scene, this.camera);
  }

  private build(): void {
    const geometry = signalGeometry();
    const instanced = (geo: THREE.BufferGeometry, material: THREE.Material, count: number, colours: boolean) => {
      this.materials.push(material);
      const mesh = new THREE.InstancedMesh(geo, material, count);
      mesh.frustumCulled = false; // the instances' bounds are not the geometry's
      mesh.count = 0;
      if (colours) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      this.scene.add(mesh);
      return mesh;
    };
    this.structure = instanced(geometry.structure, new THREE.MeshLambertMaterial({ color: '#2a2e35' }), MAX_APPROACHES, false);
    // The cap and the lamps give out their colour (unlit), so a lit lamp glows whatever the light on the map; white so the per-instance colour is exact.
    this.cap = instanced(geometry.cap, new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAX_APPROACHES, true);
    this.lamps = instanced(geometry.lamp, new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAX_APPROACHES * 3, true);
    const sun = new THREE.DirectionalLight('#ffffff', 1.8);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(new THREE.AmbientLight('#ffffff', 1.6), sun);
  }

  /** Writes the matrices and colours of every signal in view into the instance buffers; returns how many. */
  private place(map: maplibregl.Map, structure: THREE.InstancedMesh, cap: THREE.InstancedMesh, lamps: THREE.InstancedMesh): number {
    const view = map.getBounds();
    const west = view.getWest() - CULL_PAD_DEG;
    const east = view.getEast() + CULL_PAD_DEG;
    const south = view.getSouth() - CULL_PAD_DEG;
    const north = view.getNorth() + CULL_PAD_DEG;
    const s = signalScale(map.getZoom(), ORIGIN[1]);
    const head = new THREE.Object3D();
    const lamp = new THREE.Object3D();
    const colour = new THREE.Color();
    const approaches = Math.min(this.states.length, this.bearings.length, Math.floor(this.positions.length / 2));
    let n = 0;
    for (let k = 0; k < approaches && n < MAX_APPROACHES; k++) {
      const lon = this.positions[2 * k] as number;
      const lat = this.positions[2 * k + 1] as number;
      if (lon < west || lon > east || lat < south || lat > north) continue;
      const travel = this.bearings[k] as number;
      const at = localMetres(this.origin, lon, lat);
      const side = poleOffset(travel);
      head.position.set(at.east + side.east, at.north + side.north, 0);
      head.rotation.set(0, 0, (-faceBearing(travel) * Math.PI) / 180);
      head.scale.set(s, s, s);
      head.updateMatrix();
      structure.setMatrixAt(n, head.matrix);
      cap.setMatrixAt(n, head.matrix);
      const state = this.states[k] as number;
      cap.setColorAt(n, colour.set(capColour(state, this.dark)));
      for (let l = 0; l < 3; l++) {
        // A lamp sits on the head's face (y 0.37), at its height, and takes the head's placement and scale.
        lamp.position.set(0, 0.37, 3.75 + (LAMP_Z[l] as number));
        lamp.updateMatrix();
        const m = new THREE.Matrix4().multiplyMatrices(head.matrix, lamp.matrix);
        lamps.setMatrixAt(n * 3 + l, m);
        lamps.setColorAt(n * 3 + l, colour.set(lampColour(state, l, this.dark)));
      }
      n++;
    }
    for (const mesh of [structure, cap, lamps]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return n;
  }
}
