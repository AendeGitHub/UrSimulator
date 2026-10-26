// A robot on the field: the team's CAD model (see tools/convert-robot.mjs) with alliance robot signs.
// Moving parts of the model turn with the robot's state: turret toward the target, mecanum wheels
// with their motor powers, intake and transfer rollers when running, flywheel with its speed.
// Robot frame: forward = +X, right = +Z, origin on the floor at the footprint center.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Alliance } from '../robot/robotConfig';
import type { RobotDefinition } from '../robot/robots';
import type { WheelPowers } from '../robot/mecanum';
import type { RobotState } from '../sim/state';
import { asset } from './assets';

const ALLIANCE_COLORS: Record<Alliance, string> = { red: '#d42a2a', blue: '#1f5fd6' };
/** Edges sharper than this stay sharp when normals are rebuilt. */
const CREASE_ANGLE = (32 * Math.PI) / 180;
/**
 * On-screen spin speeds, rad/s. Real speeds (a flywheel at ~150 rad/s turns 150° per frame) strobe:
 * the part looks frozen or turning backwards, like car wheels on film. About 8–11° per frame at
 * 60 fps reads as a clear spin in the right direction.
 */
const SPIN = { wheelMax: 9, intake: 8, transfer: 7, flywheel: 11 };

type Axis = 'x' | 'y' | 'z';

interface Spinner {
  node: THREE.Object3D;
  axis: Axis;
}

const models = new Map<string, Promise<THREE.Group>>();

/** Loads each robot model once; every robot on the field gets a clone sharing its geometry. */
function loadModel(url: string): Promise<THREE.Group> {
  let model = models.get(url);
  if (!model) {
    model = new GLTFLoader().loadAsync(asset(url)).then(gltf => {
      const parts: THREE.Object3D[] = [];
      gltf.scene.traverse(obj => {
        if (obj.children.some(c => c instanceof THREE.Mesh)) parts.push(obj);
      });
      for (const part of parts) mergePart(part);
      return gltf.scene;
    });
    models.set(url, model);
  }
  return model;
}

/**
 * The CAD export has one mesh per colour per part (~80 for a robot), and each costs a draw call
 * in every render pass. Meshes of one part are merged into one per surface finish, with the CAD
 * colours kept as vertex colours: about 25 draw calls per robot instead of ~80.
 */
function mergePart(part: THREE.Object3D): void {
  const groups = new Map<string, { metalness: number; roughness: number; geometries: THREE.BufferGeometry[] }>();
  const meshes = part.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
  for (const mesh of meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    // Normals are rebuilt with creases so flat CAD faces stay flat and edges stay sharp.
    const src = toCreasedNormals(mesh.geometry, CREASE_ANGLE);
    // Quantized positions carry their scale in the mesh transform: bake it into plain floats.
    mesh.updateMatrix();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrix);
    const pos = src.getAttribute('position');
    const nor = src.getAttribute('normal');
    const count = pos.count;
    const p = new Float32Array(count * 3);
    const n = new Float32Array(count * 3);
    const c = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix).toArray(p, i * 3);
      v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize().toArray(n, i * 3);
      mat.color.toArray(c, i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const key = `${mat.metalness.toFixed(2)}|${mat.roughness.toFixed(2)}`;
    const group = groups.get(key) ?? { metalness: mat.metalness, roughness: mat.roughness, geometries: [] };
    group.geometries.push(geo);
    groups.set(key, group);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    src.dispose();
  }
  for (const { metalness, roughness, geometries } of groups.values()) {
    const merged = new THREE.Mesh(mergeGeometries(geometries), new THREE.MeshStandardMaterial({ vertexColors: true, metalness, roughness }));
    merged.castShadow = true;
    merged.receiveShadow = true;
    part.add(merged);
    for (const g of geometries) g.dispose();
  }
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
  private turret: THREE.Object3D | null = null;
  private flywheel: Spinner | null = null;
  private readonly wheels = new Map<keyof WheelPowers, Spinner>();
  private readonly intake: Spinner[] = [];
  private readonly transfer: Spinner[] = [];

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
      if (this.disposed) return;
      const robot = model.clone();
      this.root.add(robot);
      robot.traverse(node => {
        const axis = node.userData.spin as Axis | undefined;
        if (!axis) return;
        const spinner = { node, axis };
        if (node.name === 'turret') {
          this.turret = node;
          // Shooter facing forward until the robot starts aiming.
          node.rotation.y = def.shooter.modelYaw;
        }
        else if (node.name === 'flywheel') this.flywheel = spinner;
        else if (node.name.startsWith('wheel_')) this.wheels.set(node.name.slice(6) as keyof WheelPowers, spinner);
        else if (node.name.startsWith('intake')) this.intake.push(spinner);
        else if (node.name.startsWith('transfer')) this.transfer.push(spinner);
      });
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

  apply(s: RobotState, dt: number): void {
    this.root.position.set(s.x, 0.002, s.z);
    this.root.rotation.set(0, s.yaw, 0);
    if (this.turret) this.turret.rotation.y = s.turretYaw + this.def.shooter.modelYaw;
    // Driving forward turns the wheels backward about the side axis (right-hand rule).
    for (const [k, w] of this.wheels) spin(w, -s.powers[k] * SPIN.wheelMax * dt);
    for (const r of this.intake) spin(r, -s.intakeDir * SPIN.intake * dt);
    if (s.transfer) for (const r of this.transfer) spin(r, -SPIN.transfer * dt);
    if (this.flywheel) spin(this.flywheel, -Math.min(1, s.flywheel * 2) * SPIN.flywheel * dt);
  }
}

function spin({ node, axis }: Spinner, angle: number): void {
  node.rotation[axis] = (node.rotation[axis] + angle) % (Math.PI * 2);
}
