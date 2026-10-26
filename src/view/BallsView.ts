// Draws all POLLEN and NECTAR from a world state (instanced, one mesh per color).

import * as THREE from 'three';
import type { FieldLayout } from '../field/layout';
import { NECTAR_RADIUS, POLLEN_RADIUS } from '../field/layout';
import { ballSpecs, type BallColor, type BallSpec } from '../sim/BallSim';
import type { WorldState } from '../sim/state';

export const BALL_COLORS: Record<BallColor, string> = { yellow: '#f5c518', red: '#d8262b', blue: '#1f63e0' };

const matrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Vector3(0, 0, 0);

export class BallsView {
  /** Same order as the simulation's ball ids. */
  readonly specs: BallSpec[];
  private readonly meshes = new Map<BallColor, THREE.InstancedMesh>();
  private readonly slot: number[] = [];

  constructor(layout: FieldLayout, scene: THREE.Scene) {
    this.specs = ballSpecs(layout);
    const geo = {
      pollen: new THREE.SphereGeometry(POLLEN_RADIUS, 24, 16),
      nectar: new THREE.SphereGeometry(NECTAR_RADIUS, 24, 16),
    };
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

  update(balls: WorldState['balls']): void {
    const t = balls.transforms;
    this.specs.forEach((s, i) => {
      if (balls.states[i] === 1) {
        matrix.compose(ZERO, quat.identity(), ZERO); // held: drawn by the robot instead
      } else {
        matrix.compose(pos.set(t[i * 7], t[i * 7 + 1], t[i * 7 + 2]), quat.set(t[i * 7 + 3], t[i * 7 + 4], t[i * 7 + 5], t[i * 7 + 6]).normalize(), ONE);
      }
      this.meshes.get(s.color)!.setMatrixAt(this.slot[i], matrix);
    });
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }
}
