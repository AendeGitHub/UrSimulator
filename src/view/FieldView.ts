// BIOBUZZ field graphics: the official CAD model, the tile floor and the LOADING ZONES where robots
// PARK (the venue is view/Arena.ts).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createTileTexture } from '../field/floorTexture';
import type { FieldLayout } from '../field/layout';
import { buildZones, type Rect } from '../field/zones';
import { DURATION, type Period } from '../sim/Match';
import type { Alliance } from '../robot/robotConfig';
import { asset } from './assets';

/** The only field parts that cast shadows */
const SHADOW_CASTERS = ['hive_red', 'hive_blue', 'frame'];
/** The field model stores no normals (tools/lighten-model.mjs); edges sharper than this stay sharp. */
const CREASE_ANGLE = (32 * Math.PI) / 180;
/**
 * The LOADING ZONE: the real 1-inch tape is hard to see from the drivers' side, so the zone also
 * gets a light wash of its alliance colour, which pulses in the last seconds of AUTO and of the
 * match, when PARK is scored (manual 10.5).
 */
const PARKING = { opacity: 0.2, pulse: 0.3, autoHint: 8, teleopHint: 15 };
const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#ff3434', blue: '#3a78ff' };

export class FieldView {
  readonly root = new THREE.Group();
  /** Rotating hive assemblies; the pivot axis is the local X axis. */
  private readonly hivePivots: Record<Alliance, THREE.Group> = { red: new THREE.Group(), blue: new THREE.Group() };
  private readonly parking: THREE.MeshBasicMaterial[] = [];

  private constructor(readonly layout: FieldLayout) {}

  static async load(layout: FieldLayout, scene: THREE.Scene, onProgress?: (p: number) => void): Promise<FieldView> {
    const view = new FieldView(layout);
    const gltf = await new GLTFLoader().loadAsync(asset('assets/field.glb'), e => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    view.build(gltf.scene);
    scene.add(view.root);
    return view;
  }

  /** The LOADING ZONES pulse while PARK is about to be scored. */
  setParkingHint(period: Period | null, periodTime: number, time: number): void {
    const left = period === 'auto' ? DURATION.auto - periodTime : period === 'teleop' ? DURATION.teleop - periodTime : Infinity;
    const hint = (period === 'auto' && left <= PARKING.autoHint) || (period === 'teleop' && left <= PARKING.teleopHint);
    const opacity = PARKING.opacity + (hint ? PARKING.pulse * (0.5 + 0.5 * Math.sin(time * 7)) : 0);
    for (const m of this.parking) m.opacity = opacity;
  }

  setHiveAngles(angles: Record<Alliance, number>): void {
    this.hivePivots.red.rotation.x = angles.red;
    this.hivePivots.blue.rotation.x = angles.blue;
  }

  private build(cad: THREE.Group): void {
    this.root.add(cad);
    cad.updateMatrixWorld(true);

    cad.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!obj.geometry.getAttribute('normal')) obj.geometry = toCreasedNormals(obj.geometry, CREASE_ANGLE);
      const mat = obj.material as THREE.MeshStandardMaterial;
      if (mat.transparent) mat.depthWrite = false;
    });
    // Only the HIVE (its cells and the frame they turn on) casts a shadow, onto the floor.
    for (const name of SHADOW_CASTERS) {
      cad.getObjectByName(name)?.traverse(obj => {
        if (obj instanceof THREE.Mesh) obj.castShadow = !(obj.material as THREE.Material).transparent;
      });
    }

    // Hives rotate around their pivot axle; wrap them so rotation.x tips them.
    for (const alliance of ['red', 'blue'] as const) {
      const node = cad.getObjectByName(`hive_${alliance}`);
      if (node) clearPanels(node);
      const pivot = this.hivePivots[alliance];
      pivot.position.fromArray(this.layout.hives[alliance].pivot);
      this.root.add(pivot);
      if (node) pivot.attach(node);
    }

    // Tile floor.
    const half = this.layout.wallInnerHalf;
    const tiles = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshStandardMaterial({ map: createTileTexture(), roughness: 0.95, metalness: 0 }),
    );
    tiles.rotation.x = -Math.PI / 2;
    tiles.receiveShadow = true;
    this.root.add(tiles);

    // Tape lines from the CAD measurements: simplifying the field model lost most of its thin tape
    // strips, so they are drawn here instead, glowing a little to read in the dim hall.
    cad.getObjectByName('tape')?.removeFromParent();
    for (const alliance of ['red', 'blue'] as const) {
      const strips = this.layout.tape.filter(t => t.color === alliance).map(({ min, max }) =>
        new THREE.PlaneGeometry(max[0] - min[0], max[2] - min[2])
          .rotateX(-Math.PI / 2)
          .translate((min[0] + max[0]) / 2, max[1] + 0.002, (min[2] + max[2]) / 2));
      const merged = strips.length ? mergeGeometries(strips) : null;
      if (!merged) continue;
      const tape = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: ALLIANCE_COLOR[alliance], emissive: ALLIANCE_COLOR[alliance], emissiveIntensity: 0.55, roughness: 0.85 }));
      tape.receiveShadow = true;
      this.root.add(tape);
    }
    for (const [alliance, zone] of Object.entries(buildZones(this.layout).loading) as [Alliance, Rect][]) {
      const wash = new THREE.MeshBasicMaterial({ color: ALLIANCE_COLOR[alliance], transparent: true, opacity: PARKING.opacity, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
      this.parking.push(wash);
      const area = new THREE.Mesh(new THREE.PlaneGeometry(zone.maxX - zone.minX, zone.maxZ - zone.minZ), wash);
      area.rotation.x = -Math.PI / 2;
      area.position.set((zone.minX + zone.maxX) / 2, 0.002, (zone.minZ + zone.maxZ) / 2);
      this.root.add(area);
    }

  }
}

/** The hive cells' white panels are clear polycarbonate, so you can see the balls inside. */
function clearPanels(hive: THREE.Object3D): void {
  hive.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    const { r, g, b } = mat.color;
    if (Math.min(r, g, b) < 0.55 || Math.max(r, g, b) - Math.min(r, g, b) > 0.08) return;
    obj.material = new THREE.MeshStandardMaterial({
      color: '#eef4ff', transparent: true, opacity: 0.22, roughness: 0.08, metalness: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    obj.castShadow = false;
  });
}
