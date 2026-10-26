// BIOBUZZ field graphics: the official CAD model and the tile floor (the venue is view/Arena.ts).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createTileTexture } from '../field/floorTexture';
import type { FieldLayout } from '../field/layout';
import type { Alliance } from '../robot/robotConfig';
import { asset } from './assets';

export class FieldView {
  readonly root = new THREE.Group();
  /** Rotating hive assemblies; the pivot axis is the local X axis. */
  private readonly hivePivots: Record<Alliance, THREE.Group> = { red: new THREE.Group(), blue: new THREE.Group() };

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

  setHiveAngles(angles: Record<Alliance, number>): void {
    this.hivePivots.red.rotation.x = angles.red;
    this.hivePivots.blue.rotation.x = angles.blue;
  }

  private build(cad: THREE.Group): void {
    this.root.add(cad);
    cad.updateMatrixWorld(true);

    cad.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      obj.castShadow = !mat.transparent;
      obj.receiveShadow = true;
      if (mat.transparent) mat.depthWrite = false;
    });

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
