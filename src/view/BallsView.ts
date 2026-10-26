// Draws all POLLEN and NECTAR from a world state (instanced, one mesh per color), using the
// shapes from the official game element CAD (tools/convert-balls.mjs).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { asset } from './assets';
import type { FieldLayout } from '../field/layout';
import { NECTAR_RADIUS, POLLEN_RADIUS } from '../field/layout';
import { ballSpecs, type BallColor, type BallSpec } from '../sim/BallSim';
import type { WorldState } from '../sim/state';

// Deep enough to stay red and blue (not pink) under the field spotlight.
export const BALL_COLORS: Record<BallColor, string> = { yellow: '#f5c518', red: '#b8121a', blue: '#1747c8' };

const matrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Vector3(0, 0, 0);

export interface BallShapes {
  pollen: THREE.BufferGeometry;
  nectar: THREE.BufferGeometry;
}

/** Ball meshes from public/assets/balls.glb (spheres if the file cannot be loaded). */
export async function loadBallShapes(): Promise<BallShapes> {
  const fallback = { pollen: new THREE.SphereGeometry(POLLEN_RADIUS, 24, 16), nectar: new THREE.SphereGeometry(NECTAR_RADIUS, 24, 16) };
  try {
    const gltf = await new GLTFLoader().loadAsync(asset('assets/balls.glb'));
    const shape = (name: string) => {
      const mesh = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!mesh) return null;
      return mesh.geometry;
    };
    return { pollen: shape('pollen') ?? fallback.pollen, nectar: shape('nectar') ?? fallback.nectar };
  } catch {
    return fallback;
  }
}

export class BallsView {
  /** Same order as the simulation's ball ids. */
  readonly specs: BallSpec[];
  private readonly meshes = new Map<BallColor, THREE.InstancedMesh>();
  private readonly slot: number[] = [];

  constructor(layout: FieldLayout, scene: THREE.Scene, geo: BallShapes) {
    this.specs = ballSpecs(layout);
    const used = new Map<BallColor, number>();
    for (const s of this.specs) {
      const n = used.get(s.color) ?? 0;
      used.set(s.color, n + 1);
      this.slot.push(n);
    }
    for (const [color, count] of used) {
      const mesh = new THREE.InstancedMesh(color === 'yellow' ? geo.pollen : geo.nectar, new THREE.MeshStandardMaterial({ color: BALL_COLORS[color], roughness: 0.5 }), count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.set(color, mesh);
    }
  }

  /** `held` places balls that are inside a robot (by ball id); other held balls are hidden. */
  update(balls: WorldState['balls'], held: Map<number, [number, number, number]> = new Map()): void {
    const t = balls.transforms;
    this.specs.forEach((s, i) => {
      if (balls.states[i] === 1) {
        const p = held.get(i);
        if (p) matrix.compose(pos.set(...p), quat.identity(), ONE);
        else matrix.compose(ZERO, quat.identity(), ZERO);
      } else {
        matrix.compose(pos.set(t[i * 7], t[i * 7 + 1], t[i * 7 + 2]), quat.set(t[i * 7 + 3], t[i * 7 + 4], t[i * 7 + 5], t[i * 7 + 6]).normalize(), ONE);
      }
      this.meshes.get(s.color)!.setMatrixAt(this.slot[i], matrix);
    });
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }
}
