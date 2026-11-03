// Models of player-made robots (robot/custom.ts). A blueprint's robot is built of plain blocks, its
// moving parts named like those of the converted CAD models (turret, flywheel, wheel_fl…, intake,
// arm) so RobotView turns them the same way. A robot with an uploaded 3D file shows that instead,
// fitted onto the robot: its units, which way is up and which way it faces.
// Robot frame: forward = +X, right = +Z, origin on the floor at the footprint center.

import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FRAME_Y, WHEEL, layoutOf, withoutMesh, type Blueprint, type IntakePart, type MeshFit, type MeshFormat, type UpAxis } from '../robot/custom';
import { getMeshFile } from '../robot/customStore';
import { turretsOf, type RobotDefinition } from '../robot/robots';

const DARK = '#1d1f22';
const METAL = '#9aa3ad';
const RUBBER = '#2c3036';
/** From the intake's mouth back: the rollers between its side plates, at least, m */
const INTAKE_DEPTH = 0.05;
/** More triangles than this and an uploaded model would slow the game down (the four team robots have ~0.8 M) */
export const MAX_TRIANGLES = 2_500_000;

type Vec = [number, number, number];

function material(color: string, env: THREE.Texture | null, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, envMap: env, envMapIntensity: metalness > 0.5 ? 0.9 : 0.4 });
}

/** A block of `size` (forward, up, right) centered at `at`. */
function block(parent: THREE.Object3D, size: Vec, at: Vec, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...at);
  mesh.userData.block = true;
  parent.add(mesh);
  return mesh;
}

/** A moving part RobotView turns about `axis`: a node at `at` to put its blocks in. */
function part(parent: THREE.Object3D, name: string, axis: 'y' | 'z', at: Vec): THREE.Group {
  const node = new THREE.Group();
  node.name = name;
  node.userData.spin = axis;
  node.position.set(...at);
  parent.add(node);
  return node;
}

/** A wheel or roller across the robot (its axle along +Z), with a bar across its faces that shows it turning. */
function roller(parent: THREE.Object3D, radius: number, width: number, mat: THREE.Material, bar: THREE.Material): void {
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), mat);
  drum.rotation.x = Math.PI / 2;
  drum.userData.block = true;
  parent.add(drum);
  block(parent, [radius * 1.96, radius * 0.25, width + 0.002], [0, 0, 0], bar);
}

/** The robot of a blueprint, of plain blocks. */
export function blockModel(bp: Blueprint, env: THREE.Texture | null): THREE.Group {
  const g = layoutOf(bp);
  const root = new THREE.Group();
  const frame = material(bp.color, env, 0.5, 0.2);
  const accent = material(bp.accent, env, 0.5, 0.15);
  const dark = material(DARK, env, 0.85, 0);
  const metal = material(METAL, env, 0.35, 0.7);
  const rubber = material(RUBBER, env, 0.8, 0);

  // The intakes: rollers between two side plates, from the mouth into the robot. One that sticks
  // out little sits in a slot in the end of the frame, between the wheels.
  const ends: { intake: IntakePart; mouth: number; dir: 1 | -1; name: string }[] = [{ intake: bp.intake, mouth: g.mouth, dir: 1, name: 'intake' }];
  if (bp.backIntake) ends.push({ intake: bp.backIntake, mouth: g.backMouth!, dir: -1, name: 'intake_back' });
  let boxFront = g.frameX + g.frameLength / 2;
  let boxBack = g.frameX - g.frameLength / 2;
  let plateZ = 0;
  for (const { intake, mouth, dir, name } of ends) {
    const end = mouth - dir * intake.reach;
    const depth = Math.max(intake.reach, INTAKE_DEPTH);
    const slot = mouth - dir * depth;
    const inSlot = depth > intake.reach;
    const plate = inSlot ? Math.min(intake.width / 2, g.frameHalf) : intake.width / 2;
    if (dir > 0) plateZ = plate;
    // Built facing forward out of its mouth, then turned to face its end.
    const mount = new THREE.Group();
    mount.position.x = mouth;
    mount.rotation.y = dir > 0 ? 0 : Math.PI;
    root.add(mount);
    for (const side of [-1, 1]) block(mount, [depth, 0.11, 0.008], [-depth / 2, 0.07, side * plate], accent);
    block(mount, [0.02, 0.02, plate * 2], [-depth + 0.01, 0.125, 0], accent);
    roller(part(mount, name, 'z', [-0.025, 0.055, 0]), 0.022, plate * 2 - 0.012, rubber, metal);
    if (depth >= 0.08) roller(part(mount, `${name}2`, 'z', [-depth + 0.04, 0.085, 0]), 0.018, plate * 2 - 0.012, rubber, metal);
    if (!inSlot) continue;
    // The frame box stops at the slot; the frame goes on beside it.
    if (dir > 0) boxFront = slot;
    else boxBack = slot;
    const width = g.frameHalf - plate;
    if (width > 0.005) for (const side of [-1, 1]) block(root, [Math.abs(end - slot), bp.frameHeight, width], [(slot + end) / 2, FRAME_Y + bp.frameHeight / 2, side * (plate + width / 2)], frame);
  }

  // The drive base: the frame box between the wheels and the four mecanum wheels.
  block(root, [boxFront - boxBack, bp.frameHeight, g.frameHalf * 2], [(boxBack + boxFront) / 2, FRAME_Y + bp.frameHeight / 2, 0], frame);
  const r = bp.wheel / 2;
  for (const [key, ahead, side] of [['fl', 1, -1], ['fr', 1, 1], ['bl', -1, -1], ['br', -1, 1]] as const) {
    const at: Vec = [g.frameX + ahead * g.wheelX, r, side * g.wheelZ];
    if (bp.drivetrain !== 'swerve') {
      roller(part(root, `wheel_${key}`, 'z', at), r, WHEEL.width, dark, metal);
      continue;
    }
    // A swerve module: the wheel in a fork under a housing, all turning together (RobotView steers it).
    const module = part(root, `steer_${key}`, 'y', at);
    block(module, [bp.wheel * 0.8, 0.016, WHEEL.width + 0.016], [0, r + 0.012, 0], accent);
    for (const fork of [-1, 1]) block(module, [0.03, r + 0.004, 0.006], [0, (r + 0.004) / 2, fork * (WHEEL.width / 2 + 0.005)], metal);
    roller(part(module, `wheel_${key}`, 'z', [0, 0, 0]), r, WHEEL.width, dark, metal);
  }
  // A tank drive's treads round the wheels on each side.
  if (bp.drivetrain === 'tank') {
    for (const side of [-1, 1]) for (const y of [0.004, 2 * r - 0.004]) block(root, [2 * g.wheelX, 0.008, WHEEL.width + 0.004], [g.frameX, y, side * g.wheelZ], rubber);
  }

  // Each turret on its tower: a turntable, the shooter's housing with the flywheel on top and the
  // hood that points where balls leave (TURRET.exit forward, at the shooter's height).
  g.turrets.forEach(({ at: [x, z], towerTop }, i) => {
    const n = i ? String(i + 1) : '';
    const tower = towerTop - g.frameTop;
    if (tower > 0.01) block(root, [0.07, tower, 0.07], [x, g.frameTop + tower / 2, z], accent);
    const turret = part(root, `turret${n}`, 'y', [x, towerTop, z]);
    block(turret, [0.11, 0.012, 0.11], [0, 0.006, 0], metal);
    block(turret, [0.1, 0.05, 0.08], [-0.005, 0.037, 0], accent);
    block(turret, [0.05, 0.022, 0.06], [0.065, 0.05, 0], accent);
    roller(part(turret, `flywheel${n}`, 'z', [-0.005, 0.062, 0]), 0.024, 0.03, dark, metal);
  });

  // Flower Mode: a U-shaped arm on a hinge over the intake, modelled lowered (RobotView raises it).
  if (g.arm) {
    const [hx, hy] = g.arm.hinge;
    const [bx, by] = g.arm.bar;
    const arm = part(root, 'arm', 'z', [hx, hy, 0]);
    const dx = bx - hx;
    const dy = by - hy;
    const armZ = Math.min(plateZ + 0.014, bp.width / 2 - 0.006);
    for (const side of [-1, 1]) block(arm, [Math.hypot(dx, dy), 0.014, 0.012], [dx / 2, dy / 2, side * armZ], accent).rotation.z = Math.atan2(dy, dx);
    block(arm, [0.02, 0.03, armZ * 2 + 0.012], [dx, dy, 0], accent);
  }
  return root;
}

// ---- uploaded 3D files -------------------------------------------------------

/** Why an uploaded file can't be shown (the Workshop says so in the player's language). */
export class ModelError extends Error {
  constructor(readonly code: 'unreadable' | 'compressed' | 'empty' | 'tooBig', readonly triangles = 0) {
    super(code);
  }
}

const UP: Record<UpAxis, THREE.Vector3> = {
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
  '-y': new THREE.Vector3(0, -1, 0),
  '-z': new THREE.Vector3(0, 0, -1),
  x: new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
};

/** The file's format from its name, or null for one the game can't read. */
export function meshFormat(fileName: string): MeshFormat | null {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'stl' ? ext : null;
}

/**
 * Reads a 3D file into one mesh (two with see-through parts): a CAD export has hundreds of parts and
 * each would cost a draw call. Colors become vertex colors; parts without a color of their own
 * (STL, OBJ without materials) are marked to take the robot's color.
 */
async function parseMesh(data: ArrayBuffer, format: MeshFormat): Promise<THREE.Group> {
  let root: THREE.Object3D;
  try {
    if (format === 'glb' || format === 'gltf') {
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      root = (await loader.parseAsync(format === 'glb' ? data : new TextDecoder().decode(data), '')).scene;
    } else if (format === 'obj') {
      root = new OBJLoader().parse(new TextDecoder().decode(data));
    } else {
      const geometry = new STLLoader().parse(data);
      root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: !!geometry.getAttribute('color') }));
    }
  } catch (err) {
    throw new ModelError(/draco|ktx|basis/i.test(String(err)) ? 'compressed' : 'unreadable');
  }
  // OBJ without an MTL file and STL have no colors of their own.
  return mergeModel(root, format === 'obj' || format === 'stl');
}

function mergeModel(root: THREE.Object3D, plain: boolean): THREE.Group {
  root.updateMatrixWorld(true);
  const solid: THREE.BufferGeometry[] = [];
  const clear: THREE.BufferGeometry[] = [];
  let triangles = 0;
  let paintable = plain;
  const v = new THREE.Vector3();
  const color = new THREE.Color();
  root.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return;
    const src = obj.geometry as THREE.BufferGeometry;
    const pos = src.getAttribute('position');
    if (!pos) return;
    const count = pos.count;
    triangles += (src.index ? src.index.count : count) / 3;
    if (triangles > MAX_TRIANGLES) throw new ModelError('tooBig', triangles);
    let index: Uint32Array;
    if (src.index) {
      index = Uint32Array.from(src.index.array);
    } else {
      index = new Uint32Array(count);
      for (let i = 0; i < count; i++) index[i] = i;
    }
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld).toArray(p, i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    // A mirrored part (negative scale) would be inside out.
    if (obj.matrixWorld.determinant() < 0) for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    // The file's normals keep its sharp edges. Without them (many STL exports write zeros), new ones.
    const normals = src.getAttribute('normal');
    const n = new Float32Array(count * 3);
    let given = !!normals;
    if (normals) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
      for (let i = 0; i < count && given; i++) {
        v.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix);
        given = v.lengthSq() > 1e-8;
        v.normalize().toArray(n, i * 3);
      }
    }
    if (given) geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    else geo.computeVertexNormals();

    // Vertex colors: the file's own, or each material's color over the triangles it covers.
    const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]) as (THREE.Material & { color?: THREE.Color; vertexColors?: boolean })[];
    const c = new Float32Array(count * 3).fill(1);
    const own = src.getAttribute('color');
    if (own && materials[0]?.vertexColors) {
      for (let i = 0; i < count; i++) color.fromBufferAttribute(own as THREE.BufferAttribute, i).toArray(c, i * 3);
      paintable = false;
    } else {
      const groups = src.groups.length ? src.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
      for (const group of groups) {
        const m = materials[group.materialIndex ?? 0] ?? materials[0];
        if (!m?.color) continue;
        for (let k = group.start; k < Math.min(index.length, group.start + group.count); k++) m.color.toArray(c, index[k] * 3);
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const m0 = materials[0];
    (m0?.transparent && m0.opacity < 0.95 ? clear : solid).push(geo);
  });
  if (!triangles) throw new ModelError('empty');

  const model = new THREE.Group();
  for (const [list, opacity] of [[solid, 1], [clear, 0.4]] as const) {
    if (!list.length) continue;
    const merged = mergeGeometries(list);
    for (const g of list) g.dispose();
    const see = opacity < 1;
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, transparent: see, opacity, depthWrite: !see }));
    mesh.userData.paintable = paintable;
    model.add(mesh);
  }
  return model;
}

/** Parsed files by MeshFit.id: kept while the game runs, so refitting a model doesn't read it again. */
const sources = new Map<string, Promise<THREE.Group>>();

/** A file the player just picked (not saved yet): read it now. Rejects with a ModelError. */
export function addMeshSource(id: string, data: ArrayBuffer, format: MeshFormat): Promise<THREE.Group> {
  const source = parseMesh(data, format);
  sources.set(id, source);
  source.catch(() => sources.delete(id));
  return source;
}

/** Lets go of a parsed file that nothing shows any more (a gallery robot looked at earlier). */
export function forgetMeshSource(id: string): void {
  sources.delete(id);
}

function meshSource(fit: MeshFit): Promise<THREE.Group> {
  let source = sources.get(fit.id);
  if (!source) {
    source = getMeshFile(fit.id).then(data => {
      if (!data) throw new ModelError('empty');
      return parseMesh(data, fit.format);
    });
    sources.set(fit.id, source);
    source.catch(() => sources.delete(fit.id));
  }
  return source;
}

/** The uploaded model turned upright and to face forward, at its scale, before it is placed. */
function orient(source: THREE.Object3D, fit: MeshFit): THREE.Group {
  const upright = new THREE.Group();
  upright.add(source);
  upright.quaternion.setFromUnitVectors(UP[fit.up], new THREE.Vector3(0, 1, 0));
  upright.scale.setScalar(fit.scale);
  const turned = new THREE.Group();
  turned.add(upright);
  turned.rotation.y = (fit.turn * Math.PI) / 2;
  turned.updateMatrixWorld(true);
  return turned;
}

/** The size of an uploaded model on the robot (forward, up, right), m. */
export async function meshSize(fit: MeshFit): Promise<Vec> {
  const turned = orient((await meshSource(fit)).clone(), fit);
  const size = new THREE.Box3().setFromObject(turned).getSize(new THREE.Vector3());
  return [size.x, size.y, size.z];
}

/**
 * What a new file most likely is: its units from its size (an FTC robot is 30–46 cm: hundreds of
 * mm, tens of cm, a dozen or more inches) and the up axis of its kind of file.
 */
export function guessFit(source: THREE.Object3D, format: MeshFormat): Pick<MeshFit, 'scale' | 'up'> {
  const size = new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const scale = longest > 100 ? 0.001 : longest > 25 ? 0.01 : longest > 2 ? 0.0254 : 1;
  // glTF is Y-up by its rules; STL files come from 3D printing, where Z is up.
  return { scale, up: format === 'stl' ? 'z' : 'y' };
}

/** The uploaded model on the robot: its footprint centered on the robot's (not the lowered arm's), standing on the floor. */
function fitMesh(source: THREE.Group, bp: Blueprint, env: THREE.Texture | null): THREE.Group {
  const model = source.clone();
  model.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const m = (obj.material as THREE.MeshStandardMaterial).clone();
    if (obj.userData.paintable) m.color.set(bp.color);
    m.envMap = env;
    m.envMapIntensity = 0.4;
    obj.material = m;
  });
  const turned = orient(model, bp.mesh!);
  const box = new THREE.Box3().setFromObject(turned);
  const center = box.getCenter(new THREE.Vector3());
  const body = -layoutOf(bp).total / 2 + bp.length / 2;
  turned.position.set(body - center.x, -box.min.y, -center.z);
  const placed = new THREE.Group();
  placed.add(turned);
  return placed;
}

// ---- the models RobotView shows -------------------------------------------------

/** Models by RobotDefinition.model (it changes with the blueprint); robots on the field share each one. */
const models = new Map<string, Promise<THREE.Group>>();
/** The Workshop's robot being edited: only the newest few versions are kept. */
export const DRAFT_ROBOT = 'custom-draft';
const DRAFTS_KEPT = 3;

/** The model of a player-made robot: its blocks, or its uploaded file (blocks again if that can't be read). */
function buildModel(bp: Blueprint, env: THREE.Texture | null): Promise<THREE.Group> {
  return bp.mesh
    ? meshSource(bp.mesh).then(source => fitMesh(source, bp, env), () => blockModel(withoutMesh(bp), env))
    : Promise.resolve(blockModel(bp, env));
}

/** A player-made robot's model, made once for every robot on the field that shows it. */
export function customModel(def: RobotDefinition, env: THREE.Texture | null): Promise<THREE.Group> {
  let model = models.get(def.model);
  if (!model) {
    model = buildModel(def.custom!, env);
    models.set(def.model, model);
    if (def.id === DRAFT_ROBOT) forgetOldDrafts();
  }
  return model;
}

/** Frees what a model made for one use has of its own: its materials, and the geometry of its blocks. */
function disposeModel(group: THREE.Object3D): void {
  group.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData.block) obj.geometry.dispose();
    (obj.material as THREE.Material).dispose();
  });
}

function forgetOldDrafts(): void {
  const drafts = [...models.keys()].filter(k => k.startsWith(`custom:${DRAFT_ROBOT}#`));
  for (const key of drafts.slice(0, -DRAFTS_KEPT)) {
    const old = models.get(key)!;
    models.delete(key);
    // Blocks have geometry of their own; an uploaded model's is shared by every fitting of it.
    void old.then(disposeModel);
  }
}

/**
 * What the robot's model doesn't show by itself, for fitting an uploaded one: the box that collides,
 * where the intakes take balls (green), where balls leave the shooters (orange) and the lowered arm's box.
 */
export function robotHelpers(def: RobotDefinition): THREE.Group {
  const group = new THREE.Group();
  const cfg = def.config;
  const frame = cfg.frame ?? { length: cfg.length, offset: 0 };
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(frame.length, cfg.height - 0.012, cfg.width)),
    new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 }),
  );
  edges.position.set(frame.offset, 0.012 + (cfg.height - 0.012) / 2, 0);
  group.add(edges);
  const zone = (size: Vec, at: Vec, color: string) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
    mesh.position.set(...at);
    group.add(mesh);
  };
  // Mechanisms.ts INTAKE: from 6 cm inside the mouth to 9 cm in front of it, up to 16 cm.
  const mouth = def.intakeFront ?? cfg.length / 2;
  const half = def.intakeHalfWidth ?? 0.17;
  zone([0.15, 0.16, half * 2], [mouth + 0.015, 0.08, 0], '#2fd36d');
  if (def.backIntake) zone([0.15, 0.16, def.backIntake.halfWidth * 2], [-def.backIntake.back - 0.015, 0.08, 0], '#2fd36d');
  if (def.arm) {
    const { x, y } = def.arm.box;
    zone([x[1] - x[0], y[1] - y[0], cfg.width], [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, 0], '#f5c518');
  }
  for (const { shooter } of turretsOf(def)) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshBasicMaterial({ color: '#ff8a1f' }));
    // Out of the turret's side that faces where it rests.
    const facing = shooter.facing ?? 0;
    ball.position.set(shooter.at[0] + Math.cos(facing) * shooter.exit, shooter.height, shooter.at[1] - Math.sin(facing) * shooter.exit);
    group.add(ball);
  }
  return group;
}

/**
 * A picture of a player-made robot for its card (a data URL; undefined when it can't be drawn):
 * seen from the front right, on a clear background.
 */
export async function robotThumbnail(def: RobotDefinition): Promise<string | undefined> {
  // A model of its own, without the game's reflections: they belong to the game's renderer.
  const object = await buildModel(def.custom!, null);
  const scene = new THREE.Scene();
  scene.add(object, new THREE.HemisphereLight('#ffffff', '#5a6070', 2.2));
  const sun = new THREE.DirectionalLight('#ffffff', 2.4);
  sun.position.set(1.2, 2, 1.6);
  scene.add(sun);
  const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(26, 5 / 4, 0.01, 20);
  const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(13))) * 1.02;
  camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.62, 0.95).normalize().multiplyScalar(distance));
  camera.lookAt(sphere.center);

  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 256, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/webp', 0.85);
  } catch {
    return undefined;
  } finally {
    disposeModel(object);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
