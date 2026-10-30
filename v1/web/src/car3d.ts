// Small 3D cars: a Three.js custom layer drawn inside the map's own WebGL context, one instanced mesh per part, so
// buildings hide and are hidden by the cars properly. Same approach as the 3D buses in bus3d.ts, with car proportions
// (4.2 m long, windscreen, rear window and side windows). Zoomed out the cars are enlarged so
// they still read, but far less than the buses, since there are so many of them.
import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOATS_PER_CAR } from './cars-protocol';
import { localMetres, metresPerPixel } from './bus3d';

export const CAR3D_LAYER = 'cars-3d';

const MAX_INSTANCES = 16384; // far above the number of simulated cars; the draw is clamped to it
const ORIGIN: [number, number] = [-3.19, 55.95]; // scene origin near the middle of Edinburgh, so float32 offsets stay in metres
const CULL_PAD_DEG = 0.002; // cars just outside the view are kept so they do not pop in at the edge
export const CAR_LENGTH_M = 4.2; // keep in step with carGeometry
export const CAR_PX_AT_REF_ZOOM = 12; // on-screen length (CSS pixels) at `REF_ZOOM`, about the car's real size there
const REF_ZOOM = 17;
const SIZE_PER_ZOOM = 0.5; // on-screen size changes by 2^0.5 per zoom level, against 2 for the map
const MAX_FOOTPRINT_SCALE = 8;
const MAX_HEIGHT_SCALE = 3;
/** Cars below this zoom are not drawn at all: at city scale they are specks and only cost frame time. */
export const MIN_ZOOM = 12;

/** On-screen length of a car in CSS pixels once enlarged. */
export function carPixels(zoom: number): number {
  return CAR_PX_AT_REF_ZOOM * 2 ** (SIZE_PER_ZOOM * (zoom - REF_ZOOM));
}

/** How much to enlarge a car so it is `carPixels` long on screen: 1 (real size) once zoomed in far enough. */
export function carScale(zoom: number, lat: number): { footprint: number; height: number } {
  const real = CAR_LENGTH_M / metresPerPixel(zoom, lat);
  const footprint = Math.min(MAX_FOOTPRINT_SCALE, Math.max(1, carPixels(zoom) / real));
  return { footprint, height: Math.min(MAX_HEIGHT_SCALE, footprint) };
}

const box = (w: number, l: number, h: number, z: number, y = 0) => new THREE.BoxGeometry(w, l, h).translate(0, y, z);

/** Body, glass and wheels of one car in metres: x across, y along (front is +y, north at bearing 0), z up, centred on the car. */
export function carGeometry(): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; wheels: THREE.BufferGeometry } {
  const body = mergeGeometries([box(1.8, 4.2, 0.75, 0.55), box(1.6, 2.2, 0.6, 1.22, -0.2)]);
  const glass = mergeGeometries([
    box(1.45, 0.04, 0.45, 1.22, 0.9), // windscreen
    box(1.45, 0.04, 0.45, 1.22, -1.3), // rear window
    box(0.035, 1.9, 0.42, 1.24, -0.2).translate(-0.81, 0, 0), // side windows
    box(0.035, 1.9, 0.42, 1.24, -0.2).translate(0.81, 0, 0),
  ]);
  const wheels = mergeGeometries(
    [-1, 1].flatMap((x) =>
      [-1, 1].map((y) => new THREE.CylinderGeometry(0.33, 0.33, 0.22, 10).rotateZ(Math.PI / 2).translate(x * 0.85, y * 1.4, 0.33)),
    ),
  );
  return { body: body ?? new THREE.BufferGeometry(), glass: glass ?? new THREE.BufferGeometry(), wheels: wheels ?? new THREE.BufferGeometry() };
}

export class Car3dLayer implements maplibregl.CustomLayerInterface {
  readonly id = CAR3D_LAYER;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private frame: Float32Array = new Float32Array(0);
  private colours: THREE.Color[] = [];
  private visible = true;
  private ready = false;
  private map: maplibregl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private body: THREE.InstancedMesh | null = null;
  private parts: THREE.InstancedMesh[] = [];
  private materials: THREE.MeshLambertMaterial[] = [];
  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN);

  /** `onUnavailable` runs if the models cannot be set up, so the caller can keep the dots visible. */
  constructor(private readonly onUnavailable: () => void) {}

  /** The cars to draw: FLOATS_PER_CAR numbers each (longitude, latitude, bearing, speed, personality index). */
  setFrame(frame: Float32Array): void {
    this.frame = frame;
  }
  /** One colour per personality index. */
  setColours(colours: readonly string[]): void {
    this.colours = colours.map((c) => new THREE.Color(c));
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
      console.warn('3D cars unavailable, keeping the dots', error);
      this.ready = false;
      this.onUnavailable();
    }
  }

  onRemove(): void {
    this.ready = false;
    for (const mesh of this.parts) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.scene.clear();
    this.parts = [];
    this.materials = [];
    this.body = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  render(_gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void {
    const { map, renderer, body } = this;
    if (!this.ready || !this.visible || !map || !renderer || !body || map.getZoom() < MIN_ZOOM) return;

    const count = this.place(map, body);
    if (count === 0) return;
    for (const mesh of this.parts) mesh.count = count;

    // Scene units are metres east, north and up of the origin; this matrix takes them to clip space through the map's projection.
    const metre = this.origin.meterInMercatorCoordinateUnits();
    const toMercator = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(metre, -metre, metre));
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(toMercator);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    renderer.resetState();
    renderer.render(this.scene, this.camera);
  }

  private build(): void {
    const geometry = carGeometry();
    const make = (geo: THREE.BufferGeometry, colour: string) => {
      const material = new THREE.MeshLambertMaterial({ color: colour });
      this.materials.push(material);
      const mesh = new THREE.InstancedMesh(geo, material, MAX_INSTANCES);
      mesh.frustumCulled = false; // the instances' bounds are not the geometry's
      mesh.count = 0;
      this.parts.push(mesh);
      this.scene.add(mesh);
      return mesh;
    };
    const body = make(geometry.body, '#ffffff'); // white so the per-instance colour is the driver's personality colour
    body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
    for (const [geo, colour] of [[geometry.glass, '#9cc4d8'], [geometry.wheels, '#101010']] as const) {
      make(geo, colour).instanceMatrix = body.instanceMatrix; // same placement as the body
    }
    this.body = body;
    const sun = new THREE.DirectionalLight('#ffffff', 1.8);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(new THREE.AmbientLight('#ffffff', 1.6), sun);
  }

  /** Writes the matrix and colour of every car in view into the shared instance buffers; returns how many. */
  private place(map: maplibregl.Map, body: THREE.InstancedMesh): number {
    const view = map.getBounds();
    const west = view.getWest() - CULL_PAD_DEG;
    const east = view.getEast() + CULL_PAD_DEG;
    const south = view.getSouth() - CULL_PAD_DEG;
    const north = view.getNorth() + CULL_PAD_DEG;
    const { footprint, height } = carScale(map.getZoom(), ORIGIN[1]);
    const dummy = new THREE.Object3D();
    dummy.scale.set(footprint, footprint, height);
    const fallback = new THREE.Color('#1f1f1f');
    let n = 0;
    for (let i = 0; i + FLOATS_PER_CAR <= this.frame.length && n < MAX_INSTANCES; i += FLOATS_PER_CAR) {
      const lon = this.frame[i] as number;
      const lat = this.frame[i + 1] as number;
      if (lon < west || lon > east || lat < south || lat > north) continue;
      const at = localMetres(this.origin, lon, lat);
      dummy.position.set(at.east, at.north, 0);
      dummy.rotation.set(0, 0, (-(this.frame[i + 2] as number) * Math.PI) / 180); // clockwise from north
      dummy.updateMatrix();
      body.setMatrixAt(n, dummy.matrix);
      body.setColorAt(n, this.colours[this.frame[i + 4] as number] ?? fallback);
      n++;
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    return n;
  }
}
