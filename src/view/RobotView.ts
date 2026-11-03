// A robot on the field: the team's CAD model (see tools/convert-robot.mjs) with alliance robot signs,
// and online its driver's name over it in the alliance's colour. Moving parts of the model turn
// with the robot's state: turret toward the target, mecanum wheels with their motor powers, intake
// and transfer rollers when running, flywheel with its speed.
// Robot frame: forward = +X, right = +Z, origin on the floor at the footprint center.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Alliance } from '../robot/robotConfig';
import { BOX_EXIT, boxHoleTime, turretsOf, type RobotDefinition, type ShooterSpec } from '../robot/robots';
import type { WheelPowers } from '../robot/mecanum';
import type { RobotState } from '../sim/state';
import { asset } from './assets';
import { customModel } from './customModel';

const ALLIANCE_COLORS: Record<Alliance, string> = { red: '#d42a2a', blue: '#1f5fd6' };
/**
 * A player's name over their robot: the alliance's colour (styles.css --red, --blue). The picture's
 * tone mapping lightens it to about the colour of the names in the room (.slot-taken).
 */
const TAG_COLORS: Record<Alliance, string> = { red: '#e0383d', blue: '#2f6fe4' };
/** The name tag's height as a share of the picture's: the same size near and far */
const TAG_HEIGHT = 0.042;
/** The tag's bottom over the top of the robot, m; the top until the model has loaded */
const TAG_LIFT = 0.1;
const ROBOT_TOP = 0.46;
/** Edges sharper than this stay sharp when normals are rebuilt. */
const CREASE_ANGLE = (32 * Math.PI) / 180;
/**
 * On-screen spin speeds, rad/s. Real speeds (a flywheel at ~150 rad/s turns 150° per frame) strobe:
 * the part looks frozen or turning backwards, like car wheels on film. About 8–11° per frame at
 * 60 fps reads as a clear spin in the right direction.
 */
const SPIN = { wheelMax: 9, intake: 8, transfer: 7, flywheel: 11 };
/** Shot distance (m) up to which an adjustable hood stays as it is in the CAD */
const HOOD_NEAR = 0.6;

type Axis = 'x' | 'y' | 'z';

interface Spinner {
  node: THREE.Object3D;
  axis: Axis;
  /** -1 for a part that turns the other way (the second wheel of a two-flywheel shooter) */
  sign: number;
}

const models = new Map<string, Promise<THREE.Group>>();

/**
 * Which of a robot's models to show. The team CAD is 140–210 thousand triangles a robot, so by
 * default ('auto') a robot further than LOD_DISTANCE from the camera shows its lighter model (5–6×
 * fewer triangles), where nobody can tell. Settings → Graphics: Low always the lighter one, Ultra
 * always the full one.
 */
export type ModelDetail = 'auto' | 'high' | 'low';
let modelDetail: ModelDetail = 'auto';
/** Closer than this to the camera a robot shows its full model, m (with a little hysteresis) */
const LOD_DISTANCE = 2.4;
const LOD_HYSTERESIS = 0.08;

export function setModelDetail(detail: ModelDetail): void {
  modelDetail = detail;
}

/**
 * Robots reflect the scene's environment more than the field does (its intensity is kept low
 * for the field): brushed aluminium shows highlights, plastic a soft sheen, rubber next to none.
 */
let environment: THREE.Texture | null = null;
export function setRobotEnvironment(texture: THREE.Texture | null): void {
  environment = texture;
}
const reflection = (metalness: number, roughness: number) => (metalness > 0.5 ? 0.9 : roughness > 0.7 ? 0.15 : 0.4);

/** The models a robot view shows now; a view made for other ones is rebuilt. */
export function robotModel(def: RobotDefinition): string {
  // A player-made robot has one model for every detail.
  if (def.custom) return def.model;
  return modelDetail === 'low' ? def.lowModel : modelDetail === 'high' ? def.model : `${def.model}|${def.lowModel}`;
}

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
  const groups = new Map<string, { metalness: number; roughness: number; opacity: number; geometries: THREE.BufferGeometry[] }>();
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
    // See-through panels (clear polycarbonate) stay a mesh of their own.
    const opacity = mat.transparent ? mat.opacity : 1;
    const key = `${mat.metalness.toFixed(2)}|${mat.roughness.toFixed(2)}|${opacity.toFixed(2)}`;
    const group = groups.get(key) ?? { metalness: mat.metalness, roughness: mat.roughness, opacity, geometries: [] };
    group.geometries.push(geo);
    groups.set(key, group);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    src.dispose();
  }
  for (const { metalness, roughness, opacity, geometries } of groups.values()) {
    const clear = opacity < 1;
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness, roughness, transparent: clear, opacity, depthWrite: !clear,
      envMap: environment, envMapIntensity: reflection(metalness, roughness),
    });
    part.add(new THREE.Mesh(mergeGeometries(geometries), material));
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

/** A name on a dark pill with an outline, both in the alliance's colour; its width over its height. */
function tagTexture(text: string, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const font = 'bold 56px system-ui, -apple-system, Segoe UI, sans-serif';
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = font;
  const width = Math.ceil(g.measureText(text).width) + 52;
  c.width = width;
  c.height = 88;
  // Resizing the canvas resets its state.
  g.font = font;
  g.beginPath();
  g.roundRect(3, 3, c.width - 6, c.height - 6, (c.height - 6) / 2);
  g.fillStyle = 'rgba(8, 11, 16, 0.72)';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = color;
  g.stroke();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 3);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: c.width / c.height };
}

export class RobotView {
  readonly root = new THREE.Group();
  private readonly signs: THREE.Mesh[] = [];
  private alliance: Alliance;
  private name: string;
  /** The driver's name over the robot (online), drawn over everything; what it says, in which colour */
  private tag: THREE.Sprite | null = null;
  private tagKey = '';
  private top = ROBOT_TOP;
  private disposed = false;
  // Moving parts, of the full and the lighter model alike.
  /** Each turret's nodes and flywheels (turret, turret2…; flywheel…, flywheel2…), the main one first */
  private readonly turrets: { nodes: THREE.Object3D[]; flywheels: Spinner[] }[];
  private readonly shooters: ShooterSpec[];
  private readonly arms: Spinner[] = [];
  /** A player's robot's swerve modules, which way they point (rad) and where the robot was a frame ago */
  private readonly steers: THREE.Object3D[] = [];
  private steer = 0;
  private last: [number, number] | null = null;
  private readonly wheels: { key: keyof WheelPowers; spinner: Spinner }[] = [];
  private readonly intake: Spinner[] = [];
  private readonly transfer: Spinner[] = [];
  /** A lift's stages (its slides and its box): how far each goes up from where it rests, m */
  private readonly slides: { node: THREE.Object3D; rest: number; travel: number }[] = [];
  /** The rollers in the lift's box */
  private readonly boxRollers: Spinner[] = [];
  /** A shooter's adjustable hood, turned with the shot's distance up to its swing (rad) */
  private readonly hoods: { spinner: Spinner; swing: number }[] = [];
  /** How far over the hood is: 0 as in the CAD .. 1 its whole swing */
  private hood = 0;
  /** The stopper on top of a lift's box, swung up by its servo (its swing, rad) to let the balls out */
  private readonly stoppers: { spinner: Spinner; swing: number }[] = [];
  /** How far up the stopper is: 0 shut .. 1 open */
  private stopper = 0;

  /** The model files this view shows (they change with the graphics quality) */
  readonly model: string;

  constructor(readonly def: RobotDefinition, alliance: Alliance, name: string) {
    this.alliance = alliance;
    this.name = name;
    this.model = robotModel(def);
    this.shooters = turretsOf(def).map(t => t.shooter);
    this.turrets = this.shooters.map(() => ({ nodes: [], flywheels: [] }));
    // Robot signs (FTC R402) on both sides, on the drive base's outer plates (a player's own model may have its own).
    const { at, length, y, height, side: plate } = def.sign;
    for (const side of length > 0 ? [-1, 1] : []) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(length, height), new THREE.MeshStandardMaterial({ roughness: 0.6 }));
      sign.position.set(at, y, side * (plate + 0.002));
      sign.rotation.y = side > 0 ? 0 : Math.PI;
      this.root.add(sign);
      this.signs.push(sign);
    }
    this.paintSigns();

    const loading = def.custom ? [customModel(def, environment)] : this.model.split('|').map(loadModel);
    Promise.all(loading).then(loaded => {
      if (this.disposed) return;
      const robots = loaded.map(model => model.clone());
      // Measured before it joins the robot: its own frame, wherever the robot is.
      this.top = new THREE.Box3().setFromObject(robots[0]).max.y;
      if (this.tag) this.tag.position.y = this.top + TAG_LIFT;
      if (robots.length === 1) {
        this.root.add(robots[0]);
      } else {
        const lod = new THREE.LOD();
        lod.addLevel(robots[0], 0);
        lod.addLevel(robots[1], LOD_DISTANCE, LOD_HYSTERESIS);
        this.root.add(lod);
      }
      for (const robot of robots) robot.traverse(node => this.collect(node));
    });
  }

  private collect(node: THREE.Object3D): void {
    const axis = node.userData.spin as Axis | undefined;
    if (!axis) return;
    const spinner = { node, axis, sign: node.userData.reverse ? -1 : 1 };
    // A lift's stages go up as far as the model says (`slide`), what rides on them along with them.
    if (typeof node.userData.slide === 'number') {
      this.slides.push({ node, rest: node.position.y, travel: node.userData.slide });
      return;
    }
    // Turret n's parts are named turretn and flywheeln… (the main one's without the number).
    const turret = /^turret(\d*)$/.exec(node.name);
    const flywheel = /^flywheel(\d*)/.exec(node.name);
    if (turret) {
      const i = Number(turret[1] || 1) - 1;
      this.turrets[i]?.nodes.push(node);
      // Shooter where it rests until the robot starts aiming.
      const shooter = this.shooters[i];
      if (shooter) node.rotation.y = (shooter.facing ?? 0) + shooter.modelYaw;
    }
    else if (flywheel) this.turrets[Number(flywheel[1] || 1) - 1]?.flywheels.push(spinner);
    else if (node.name === 'arm') this.arms.push(spinner);
    else if (node.name.startsWith('steer_')) this.steers.push(node);
    else if (node.name.startsWith('wheel_')) this.wheels.push({ key: node.name.slice(6) as keyof WheelPowers, spinner });
    else if (node.name.startsWith('intake')) this.intake.push(spinner);
    else if (node.name.startsWith('transfer')) this.transfer.push(spinner);
    else if (node.name.startsWith('box_')) this.boxRollers.push(spinner);
    else if (node.name === 'hood') this.hoods.push({ spinner, swing: node.userData.swing ?? 0 });
    else if (node.name === 'stopper') this.stoppers.push({ spinner, swing: node.userData.swing ?? 0 });
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

  /** The driver's name over the robot in the alliance's colour, seen through the field; null hides it. */
  setTag(text: string | null): void {
    if (!text) {
      if (this.tag) this.tag.visible = false;
      return;
    }
    if (!this.tag) {
      this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: false, depthWrite: false, fog: false }));
      // Its bottom edge on the point over the robot.
      this.tag.center.set(0.5, 0);
      this.tag.position.y = this.top + TAG_LIFT;
      this.tag.renderOrder = 10;
      this.root.add(this.tag);
    }
    const key = `${this.alliance}|${text}`;
    if (key !== this.tagKey) {
      this.tagKey = key;
      const { texture, aspect } = tagTexture(text, TAG_COLORS[this.alliance]);
      const mat = this.tag.material;
      mat.map?.dispose();
      mat.map = texture;
      mat.needsUpdate = true;
      this.tag.scale.set(TAG_HEIGHT * aspect, TAG_HEIGHT, 1);
    }
    this.tag.visible = true;
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    for (const sign of this.signs) {
      sign.geometry.dispose();
      (sign.material as THREE.MeshStandardMaterial).map?.dispose();
    }
    this.tag?.material.map?.dispose();
    this.tag?.material.dispose();
  }

  apply(s: RobotState, dt: number): void {
    this.root.position.set(s.x, 0.002, s.z);
    this.root.rotation.set(0, s.yaw, 0);
    // Driving forward turns the wheels backward about the side axis (right-hand rule).
    for (const { key, spinner } of this.wheels) spin(spinner, -s.powers[key] * SPIN.wheelMax * dt);
    for (const r of this.intake) spin(r, -s.intakeDir * SPIN.intake * dt);
    if (s.transfer) for (const r of this.transfer) spin(r, -SPIN.transfer * dt);
    // The flywheel throws balls out of the side that faces the target, so it turns that way.
    const throwSide = Math.cos(this.def.shooter.modelYaw) < 0 ? -1 : 1;
    this.turrets.forEach((t, i) => {
      const state = i ? s.extraTurrets[i - 1] : { yaw: s.turretYaw, flywheel: s.flywheel };
      if (!state) return;
      for (const node of t.nodes) node.rotation.y = state.yaw + this.shooters[i].modelYaw;
      for (const f of t.flywheels) spin(f, throwSide * Math.min(1, state.flywheel * 2) * SPIN.flywheel * dt);
    });
    for (const { node, rest, travel } of this.slides) node.position.y = rest + s.lift * travel;
    if (s.boxRollers) for (const r of this.boxRollers) spin(r, SPIN.transfer * dt);
    // The box's servo swings its stopper up while the rollers run with the box off the ramp, keeps
    // it up until the ball in the hole is out, and swings it back down to hold the balls in, as
    // fast as in the sim (Mechanisms.runBoxRollers): no ball moves until it is all the way up.
    if (this.stoppers.length && this.def.lift) {
      const open = (s.boxRollers && s.lift > 0) || (!!s.boxExit && s.boxExit.t < boxHoleTime(this.def.lift));
      this.stopper = Math.min(1, Math.max(0, this.stopper + (open ? dt : -dt) / BOX_EXIT.stopper));
      const eased = this.stopper * this.stopper * (3 - 2 * this.stopper);
      for (const { spinner, swing } of this.stoppers) spinner.node.rotation[spinner.axis] = spinner.sign * eased * swing;
    }
    // An adjustable hood follows the distance to the cell, servo-quick: as it is in the CAD up
    // close, swung all the way over at the shooter's range.
    if (this.hoods.length) {
      const far = Math.min(1, Math.max(0, (s.shotDistance - HOOD_NEAR) / (this.def.shooter.maxRange - HOOD_NEAR)));
      this.hood += (far - this.hood) * Math.min(1, dt * 6);
      for (const { spinner, swing } of this.hoods) spinner.node.rotation[spinner.axis] = spinner.sign * this.hood * swing;
    }
    // Swerve modules steer their wheels the way the robot goes, the short way round (a wheel rolls either way).
    if (this.steers.length && this.last) {
      const dx = s.x - this.last[0];
      const dz = s.z - this.last[1];
      if (Math.hypot(dx, dz) > 2e-4) {
        const cos = Math.cos(s.yaw);
        const sin = Math.sin(s.yaw);
        let angle = Math.atan2(-(dx * sin + dz * cos), dx * cos - dz * sin);
        while (angle - this.steer > Math.PI / 2) angle -= Math.PI;
        while (angle - this.steer < -Math.PI / 2) angle += Math.PI;
        this.steer += (angle - this.steer) * Math.min(1, dt * 14);
      }
      for (const node of this.steers) node.rotation.y = this.steer;
    }
    this.last = [s.x, s.z];
    // The model's arm is lowered; raising swings its front end up about the hinge.
    if (this.def.arm) for (const arm of this.arms) arm.node.rotation[arm.axis] = (1 - s.arm) * this.def.arm.upAngle;
  }
}

function spin({ node, axis, sign }: Spinner, angle: number): void {
  node.rotation[axis] = (node.rotation[axis] + sign * angle) % (Math.PI * 2);
}
