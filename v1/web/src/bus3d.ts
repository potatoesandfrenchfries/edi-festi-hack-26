// 3D double-decker buses at every zoom: a Three.js custom layer drawn inside the map's own WebGL context, so buildings hide and are
// hidden by the buses properly. Zoomed out the models are blown up past real size (see `busScale`) so they still read as buses.
import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BUS3D_LAYER = 'buses-3d';

const MAX_INSTANCES = 4096; // far above the number of simulated buses; the draw is clamped to it
const ORIGIN: [number, number] = [-3.19, 55.95]; // scene origin near the middle of Edinburgh, so float32 offsets stay in metres
const CULL_PAD_DEG = 0.003; // buses just outside the view are kept so they do not pop in at the edge
const BUS_LENGTH_M = 11; // keep in step with busGeometry
export const BUS_PX_AT_REF_ZOOM = 30; // on-screen length of a bus (CSS pixels) at `REF_ZOOM`, about its real size there
const REF_ZOOM = 17;
const SIZE_PER_ZOOM = 0.4; // a bus's on-screen size changes by 2^0.4 per zoom level, against 2^1 for the map: it shrinks more slowly
const MAX_FOOTPRINT_SCALE = 40; // caps how far length and width are blown up at very low zoom
const MAX_HEIGHT_SCALE = 5; // height grows less, so zoomed-out buses stay flat and do not tower over the buildings
const TILE_PX = 512;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const LAYOVER_GREY = new THREE.Color('#8a8f98');

export interface BusMarker {
  lon: number;
  lat: number;
  /** Degrees clockwise from north. */
  bearing: number;
  colour: string;
  layover: boolean;
}

/** Ground metres covered by one CSS pixel of the map at this zoom and latitude. */
export function metresPerPixel(zoom: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
}

/** On-screen length of a bus, in CSS pixels, once enlarged: follows the zoom, but more gently than the map, so far-out buses stay readable. */
export function busPixels(zoom: number): number {
  return BUS_PX_AT_REF_ZOOM * 2 ** (SIZE_PER_ZOOM * (zoom - REF_ZOOM));
}

/** How much to enlarge a bus so it is `busPixels` long on screen: 1 (real size) once zoomed in far enough. */
export function busScale(zoom: number, lat: number): { footprint: number; height: number } {
  const real = BUS_LENGTH_M / metresPerPixel(zoom, lat);
  const footprint = Math.min(MAX_FOOTPRINT_SCALE, Math.max(1, busPixels(zoom) / real));
  return { footprint, height: Math.min(MAX_HEIGHT_SCALE, footprint) };
}

/** Metres east and north of `origin` in the map's own projection, so the models sit exactly where the dots do. */
export function localMetres(origin: maplibregl.MercatorCoordinate, lon: number, lat: number): { east: number; north: number } {
  const metre = origin.meterInMercatorCoordinateUnits();
  const p = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
  return { east: (p.x - origin.x) / metre, north: -(p.y - origin.y) / metre };
}

const box = (w: number, l: number, h: number, z: number, y = 0) => new THREE.BoxGeometry(w, l, h).translate(0, y, z);

/** Body, glass and wheels of one bus in metres: x across, y along (front is +y, north at bearing 0), z up. */
export function busGeometry(): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; wheels: THREE.BufferGeometry } {
  const body = box(2.55, 11, 3.9, 0.5 + 3.9 / 2);
  const glass = mergeGeometries([
    box(2.58, 9.6, 0.75, 1.9), // lower deck windows
    box(2.58, 9.6, 0.75, 3.55), // upper deck windows
    box(2.58, 0.15, 1.7, 2.9, 5.45), // windscreens across both decks
  ]);
  const wheels = mergeGeometries(
    [-1, 1].flatMap((x) =>
      [-1, 1].map((y) =>
        new THREE.CylinderGeometry(0.5, 0.5, 0.32, 14).rotateZ(Math.PI / 2).translate(x * 1.2, y * 3.4, 0.5),
      ),
    ),
  );
  return { body, glass: glass ?? new THREE.BufferGeometry(), wheels: wheels ?? new THREE.BufferGeometry() };
}

export class Bus3dLayer implements maplibregl.CustomLayerInterface {
  readonly id = BUS3D_LAYER;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private markers: readonly BusMarker[] = [];
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
  private readonly colours = new Map<string, THREE.Color>();
  private readonly scratch = new THREE.Color();

  /** `onUnavailable` runs if the models cannot be set up, so the caller can keep the dots visible at every zoom. */
  constructor(private readonly onUnavailable: () => void) {}

  setMarkers(markers: readonly BusMarker[]): void {
    this.markers = markers;
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
      console.warn('3D buses unavailable, keeping the dots', error);
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
    if (!this.ready || !this.visible || !map || !renderer || !body) return;

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
    const geometry = busGeometry();
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
    const body = make(geometry.body, '#ffffff'); // white so the per-instance colour is the operator colour
    body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
    for (const [geo, colour] of [[geometry.glass, '#1b2430'], [geometry.wheels, '#111318']] as const) {
      make(geo, colour).instanceMatrix = body.instanceMatrix; // same placement as the body
    }
    this.body = body;
    const sun = new THREE.DirectionalLight('#ffffff', 1.8);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(new THREE.AmbientLight('#ffffff', 1.6), sun);
  }

  /** Writes the matrix and colour of every bus in view into the shared instance buffers; returns how many. */
  private place(map: maplibregl.Map, body: THREE.InstancedMesh): number {
    const view = map.getBounds();
    const west = view.getWest() - CULL_PAD_DEG;
    const east = view.getEast() + CULL_PAD_DEG;
    const south = view.getSouth() - CULL_PAD_DEG;
    const north = view.getNorth() + CULL_PAD_DEG;
    const { footprint, height } = busScale(map.getZoom(), ORIGIN[1]);
    const dummy = new THREE.Object3D();
    dummy.scale.set(footprint, footprint, height);
    let n = 0;
    for (const bus of this.markers) {
      if (n >= MAX_INSTANCES) break;
      if (bus.lon < west || bus.lon > east || bus.lat < south || bus.lat > north) continue;
      const at = localMetres(this.origin, bus.lon, bus.lat);
      dummy.position.set(at.east, at.north, 0);
      dummy.rotation.set(0, 0, (-bus.bearing * Math.PI) / 180); // clockwise from north
      dummy.updateMatrix();
      body.setMatrixAt(n, dummy.matrix);
      body.setColorAt(n, this.colour(bus));
      n++;
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    return n;
  }

  private colour(bus: BusMarker): THREE.Color {
    let base = this.colours.get(bus.colour);
    if (!base) this.colours.set(bus.colour, (base = new THREE.Color(bus.colour)));
    return bus.layover ? this.scratch.copy(base).lerp(LAYOVER_GREY, 0.55) : base; // setColorAt copies, so reusing one colour is safe
  }
}
