// A robot on the field: the team's CAD model (see tools/convert-robot.mjs) with alliance robot signs.
// Robot frame: forward = +X, right = +Z, origin on the floor at the footprint center.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Alliance } from '../robot/robotConfig';
import type { RobotDefinition } from '../robot/robots';
import type { RobotState } from '../sim/state';

const ALLIANCE_COLORS: Record<Alliance, string> = { red: '#d42a2a', blue: '#1f5fd6' };
/** Edges sharper than this stay sharp when normals are rebuilt. */
const CREASE_ANGLE = (35 * Math.PI) / 180;

const models = new Map<string, Promise<THREE.Group>>();

/** Loads each robot model once; every robot on the field gets a clone sharing its geometry. */
function loadModel(url: string): Promise<THREE.Group> {
  let model = models.get(url);
  if (!model) {
    model = new GLTFLoader().loadAsync(url).then(gltf => {
      gltf.scene.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry = toCreasedNormals(obj.geometry, CREASE_ANGLE);
        obj.castShadow = true;
        obj.receiveShadow = true;
      });
      return gltf.scene;
    });
    models.set(url, model);
  }
  return model;
}

function signTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.font = 'bold 80px system-ui, -apple-system, Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 4, c.width - 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class RobotView {
  readonly root = new THREE.Group();
  private readonly signs: THREE.Mesh[] = [];
  private alliance: Alliance;
  private name: string;
  private disposed = false;

  constructor(readonly def: RobotDefinition, alliance: Alliance, name: string) {
    this.alliance = alliance;
    this.name = name;
    const { length, width } = def.config;

    // Robot signs (FTC R402) on both sides, low on the frame like bumpers.
    for (const side of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(0.3, length * 0.7), 0.07), new THREE.MeshStandardMaterial({ roughness: 0.6 }));
      sign.position.set(0, 0.075, side * (width / 2 + 0.003));
      sign.rotation.y = side > 0 ? 0 : Math.PI;
      this.root.add(sign);
      this.signs.push(sign);
    }
    this.paintSigns();

    loadModel(def.model).then(model => {
      if (!this.disposed) this.root.add(model.clone());
    });
  }

  /** Robot signs show the alliance color and the driver's name. */
  setIdentity(alliance: Alliance, name: string): void {
    if (alliance === this.alliance && name === this.name) return;
    this.alliance = alliance;
    this.name = name;
    this.paintSigns();
  }

  private paintSigns(): void {
    for (const sign of this.signs) {
      const mat = sign.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.map = signTexture(this.name.slice(0, 14), ALLIANCE_COLORS[this.alliance]);
      mat.needsUpdate = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    for (const sign of this.signs) {
      sign.geometry.dispose();
      (sign.material as THREE.MeshStandardMaterial).map?.dispose();
    }
  }

  apply(s: RobotState): void {
    this.root.position.set(s.x, 0.002, s.z);
    this.root.rotation.set(0, s.yaw, 0);
  }
}
