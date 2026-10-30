// The George Square Spiegeltent: a temporary festival venue, so no building footprint to colour. A small Three.js custom layer draws it
// as a round big top in the venue colour, inside the map's own WebGL context so the buildings hide and are hidden by it properly.
import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { VENUE_COLOUR } from './buildings';
import { metresPerPixel } from './bus3d';

export const TENT_LAYER = 'tent-3d';

/** The open middle of George Square Gardens. Keep in step with the `tent` row of config/venues.csv (a test checks this). */
export const TENT_POSITION: [number, number] = [-3.188285, 55.94386];

const WALL_RADIUS_M = 9;
const WALL_HEIGHT_M = 3.2;
const ROOF_RADIUS_M = 9.8; // the canvas overhangs the wall
const ROOF_HEIGHT_M = 5.5;
const SIDES = 28;
export const TENT_PX = 26; // least on-screen width (CSS pixels) of the tent, so it does not vanish when the map is zoomed out
const MAX_SCALE = 5;

/** How much to enlarge the tent so it is at least `TENT_PX` wide on screen: 1 (real size) once zoomed in far enough. */
export function tentScale(zoom: number, lat: number): number {
  const real = (2 * ROOF_RADIUS_M) / metresPerPixel(zoom, lat);
  return Math.min(MAX_SCALE, Math.max(1, TENT_PX / real));
}

/** Wall, roof and finial of the tent in metres, centred on the origin with z up. */
export function tentGeometry(): { wall: THREE.BufferGeometry; roof: THREE.BufferGeometry; finial: THREE.BufferGeometry } {
  const upright = (geometry: THREE.BufferGeometry, z: number) => geometry.rotateX(Math.PI / 2).translate(0, 0, z); // three's cylinders point along y
  return {
    wall: upright(new THREE.CylinderGeometry(WALL_RADIUS_M, WALL_RADIUS_M, WALL_HEIGHT_M, SIDES), WALL_HEIGHT_M / 2),
    roof: upright(new THREE.ConeGeometry(ROOF_RADIUS_M, ROOF_HEIGHT_M, SIDES), WALL_HEIGHT_M + ROOF_HEIGHT_M / 2),
    finial: new THREE.SphereGeometry(0.5, 12, 8).translate(0, 0, WALL_HEIGHT_M + ROOF_HEIGHT_M + 0.3),
  };
}

export class TentLayer implements maplibregl.CustomLayerInterface {
  readonly id = TENT_LAYER;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private renderer: THREE.WebGLRenderer | null = null;
  private map: maplibregl.Map | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly tent = new THREE.Group();
  private readonly origin = maplibregl.MercatorCoordinate.fromLngLat(TENT_POSITION);
  private disposables: { dispose(): void }[] = [];

  constructor(private readonly dark: boolean) {}

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.map = map;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false; // the map has already drawn into this frame
      this.build();
    } catch (error) {
      console.warn('3D tent unavailable', error);
      this.renderer = null;
    }
  }

  onRemove(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
    this.scene.clear();
    this.tent.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }

  render(_gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void {
    const { map, renderer } = this;
    if (!map || !renderer) return;
    this.tent.scale.setScalar(tentScale(map.getZoom(), TENT_POSITION[1]));

    // Scene units are metres east, north and up of the tent; this matrix takes them to clip space through the map's projection.
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
    const colour = VENUE_COLOUR[this.dark ? 'dark' : 'light'];
    const geometry = tentGeometry();
    const parts: [THREE.BufferGeometry, string][] = [
      [geometry.wall, colour], // the venue colour, like every other festival venue
      [geometry.roof, colour],
      [geometry.finial, '#e8c04a'],
    ];
    for (const [geo, color] of parts) {
      const material = new THREE.MeshLambertMaterial({ color });
      this.disposables.push(geo, material);
      this.tent.add(new THREE.Mesh(geo, material));
    }
    const sun = new THREE.DirectionalLight('#ffffff', 1.8);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(this.tent, new THREE.AmbientLight('#ffffff', 1.6), sun);
  }
}
