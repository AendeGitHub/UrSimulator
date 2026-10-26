// BIOBUZZ field graphics: the official CAD model and the tile floor (the venue is view/Arena.ts).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createTileTexture } from '../field/floorTexture';
import type { FieldLayout } from '../field/layout';
import type { Alliance } from '../robot/robotConfig';

export class FieldView {
  readonly root = new THREE.Group();
  /** Rotating hive assemblies; the pivot axis is the local X axis. */
  private readonly hivePivots: Record<Alliance, THREE.Group> = { red: new THREE.Group(), blue: new THREE.Group() };

  private constructor(readonly layout: FieldLayout) {}

  static async load(layout: FieldLayout, scene: THREE.Scene, onProgress?: (p: number) => void): Promise<FieldView> {
    const view = new FieldView(layout);
    const gltf = await new GLTFLoader().loadAsync('assets/field.glb', e => {
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
