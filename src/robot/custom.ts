// Robots players make themselves in the Workshop. A handful of numbers (a Blueprint) — the drive
// base, the intakes, the turrets, the Flower Mode arm — make a RobotDefinition that plays like the
// teams' robots. Its model is built of plain blocks (view/customModel.ts), or it is the player's own
// 3D file. The server checks the blueprints of robots brought into online rooms with
// cleanBlueprint(), so nothing here needs the DOM or three.js.

import { NECTAR_RADIUS, POLLEN_RADIUS } from '../field/layout';
import type { BallKind } from '../sim/BallSim';
import { CUSTOM_ROBOT, addCustomRobot, wheelSpeed, type ArmSpec, type DriveSpec, type RobotDefinition, type RobotSign, type Storage, type TurretDef } from './robots';

export type IntakeKind = 'pollen' | 'nectar' | 'both';
export const INTAKE_KINDS: IntakeKind[] = ['pollen', 'nectar', 'both'];

/** Mecanum wheels, swerve modules that steer each wheel, or a tank drive of plain wheels */
export type Drivetrain = 'mecanum' | 'swerve' | 'tank';
export const DRIVETRAINS: Drivetrain[] = ['mecanum', 'swerve', 'tank'];

export type MeshFormat = 'glb' | 'gltf' | 'obj' | 'stl';
export const MESH_FORMATS: MeshFormat[] = ['glb', 'gltf', 'obj', 'stl'];

/** The model's axis that points up (CAD programs differ: glTF is Y-up, many STL exports Z-up). */
export type UpAxis = 'y' | 'z' | '-y' | '-z' | 'x' | '-x';
export const UP_AXES: UpAxis[] = ['y', 'z', '-z', '-y', 'x', '-x'];

/** A 3D file the player uploaded to show instead of the blocks, and how it sits on the robot. */
export interface MeshFit {
  /** Where the file is kept in this browser (robot/customStore.ts) */
  id: string;
  /** The file's name, as the player knows it */
  file: string;
  format: MeshFormat;
  /** Metres per model unit */
  scale: number;
  up: UpAxis;
  /** Quarter turns to the left, so that the model's front faces the robot's */
  turn: number;
  /** The robot signs (FTC R402) on its sides: a model may have its own */
  signs: boolean;
}

/** An intake: rollers between two side plates that take balls off the tiles. */
export interface IntakePart {
  kind: IntakeKind;
  /** How wide its mouth takes balls and how far it sticks out of the frame, m */
  width: number;
  reach: number;
  /** Balls a second it takes in */
  rate: number;
}

/** A turret on its tower on the frame, with a flywheel shooter. */
export interface TurretPart {
  /** Its axis forward of the frame's center and to the right of the center line, m */
  x: number;
  z: number;
  /** The balls it shoots: one kind, or 'both' (any the robot holds) */
  shoots: IntakeKind;
  /** Where balls leave the shooter, above the tiles, m */
  height: number;
  /** Where it rests, the middle of its turn: degrees to the left of straight ahead */
  facing: number;
  /** How far it turns each way from there, degrees (0: not at all, the driver aims the robot) */
  range: number;
  /** Seconds from the first to the last of 4 balls */
  rapidFire: number;
  /** ShooterSpec.spin: 1 frontspin, 0 none, negative backspin */
  spin: number;
}

export interface Blueprint {
  name: string;
  team: string;
  /** FTC team number for the signs (digits; empty: the name) */
  number: string;
  /** The frame's color and the mechanisms', #rrggbb */
  color: string;
  accent: string;
  /** The whole robot inside the 18-inch starting box: front of the intake to the back, side to side, m */
  length: number;
  width: number;
  /** The drive base's frame box, m */
  frameHeight: number;
  drivetrain: Drivetrain;
  /** Wheel diameter, m, and drive motor speed, RPM */
  wheel: number;
  rpm: number;
  /** kg */
  mass: number;
  /** The intake at the front, and the second one at the back of a robot that takes balls both ways */
  intake: IntakePart;
  backIntake: IntakePart | null;
  /** Flower Mode: an arm in front of the front intake that pulls POLLEN out of the bottom of a FLOWER */
  arm: boolean;
  /** 1 to MAX_TURRETS turrets; the first is the main one, whose shots the HUD shows */
  turrets: TurretPart[];
  mesh: MeshFit | null;
}

type Range = { min: number; max: number; step: number };
type Ranges<T> = Record<{ [K in keyof T]: T[K] extends number ? K : never }[keyof T], Range>;

/** Each number's range and the step the Workshop changes it by (sizes in m). */
export const LIMITS: Ranges<Blueprint> = {
  // FTC: a robot starts inside an 18-inch (45.7 cm) cube.
  length: { min: 0.25, max: 0.457, step: 0.005 },
  width: { min: 0.25, max: 0.457, step: 0.005 },
  frameHeight: { min: 0.03, max: 0.15, step: 0.005 },
  wheel: { min: 0.06, max: 0.14, step: 0.002 },
  rpm: { min: 100, max: 1200, step: 5 },
  mass: { min: 4, max: 20, step: 0.1 },
};
export const INTAKE_LIMITS: Ranges<IntakePart> = {
  width: { min: 0.12, max: 0.457, step: 0.005 },
  reach: { min: 0, max: 0.1, step: 0.005 },
  rate: { min: 1.5, max: 6, step: 0.1 },
};
export const TURRET_LIMITS: Ranges<TurretPart> = {
  // Within the frame (and its width): cleanBlueprint() keeps it there.
  x: { min: -0.2, max: 0.2, step: 0.005 },
  z: { min: -0.2, max: 0.2, step: 0.005 },
  height: { min: 0.15, max: 0.42, step: 0.005 },
  facing: { min: -180, max: 180, step: 15 },
  range: { min: 0, max: 360, step: 5 },
  rapidFire: { min: 0.2, max: 2, step: 0.05 },
  spin: { min: -0.5, max: 1, step: 0.25 },
};
export const MAX_TURRETS = 5;

/** Fastest a player-made robot drives, m/s: a little quicker than the quickest team robot. */
export const MAX_SPEED = 3.2;
/** The frame needs this much length between the intakes, m */
const MIN_FRAME = 0.16;
/** A turret's axis stays this far in from the frame's ends and the robot's sides, m */
const TURRET_MARGIN = 0.06;
/**
 * A tank drive's plain wheels grip better than mecanum rollers: it accelerates (and pushes) this much
 * harder. Swerve modules turn the robot this much slower: they steer their wheels round first.
 */
const TANK_GRIP = 1.25;
const SWERVE_TURN = 0.8;

export const DEFAULT_INTAKE: IntakePart = { kind: 'pollen', width: 0.3, reach: 0.04, rate: 3 };
export const DEFAULT_TURRET: TurretPart = { x: -0.06, z: 0, shoots: 'both', height: 0.33, facing: 0, range: 180, rapidFire: 0.6, spin: 0 };

export const DEFAULT_BLUEPRINT: Blueprint = {
  name: 'Robot',
  team: '',
  number: '',
  color: '#2f6fe4',
  accent: '#f5c518',
  length: 0.43,
  width: 0.4,
  frameHeight: 0.07,
  drivetrain: 'mecanum',
  wheel: 0.104,
  rpm: 435,
  mass: 10,
  intake: DEFAULT_INTAKE,
  backIntake: null,
  arm: false,
  turrets: [DEFAULT_TURRET],
  mesh: null,
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const round = (v: number) => Math.round(v * 10000) / 10000;
/** A number within its range (`fallback` if `raw` isn't one). */
const inRange = (raw: unknown, fallback: number, { min, max }: Range) => round(clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback, min, max));
const fields = <T>(value: unknown) => (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof T, unknown>>;

/** Printable text, one line, at most `max` characters. */
function cleanText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || fallback;
}

const cleanColor = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback);
const cleanKind = (value: unknown, fallback: IntakeKind) => (INTAKE_KINDS.includes(value as IntakeKind) ? value as IntakeKind : fallback);

function cleanMesh(value: unknown): MeshFit | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Partial<Record<keyof MeshFit, unknown>>;
  if (typeof m.id !== 'string' || !/^[a-z0-9]{4,24}$/.test(m.id) || !MESH_FORMATS.includes(m.format as MeshFormat)) return null;
  const scale = typeof m.scale === 'number' && Number.isFinite(m.scale) && m.scale > 0 ? clamp(m.scale, 1e-5, 100) : 1;
  return {
    id: m.id,
    file: cleanText(m.file, 60, 'model'),
    format: m.format as MeshFormat,
    scale,
    up: UP_AXES.includes(m.up as UpAxis) ? m.up as UpAxis : 'y',
    turn: typeof m.turn === 'number' && Number.isFinite(m.turn) ? ((Math.round(m.turn) % 4) + 4) % 4 : 0,
    signs: m.signs !== false,
  };
}

function cleanIntake(value: unknown): IntakePart {
  const v = fields<IntakePart>(value);
  return {
    kind: cleanKind(v.kind, DEFAULT_INTAKE.kind),
    width: inRange(v.width, DEFAULT_INTAKE.width, INTAKE_LIMITS.width),
    reach: inRange(v.reach, DEFAULT_INTAKE.reach, INTAKE_LIMITS.reach),
    rate: inRange(v.rate, DEFAULT_INTAKE.rate, INTAKE_LIMITS.rate),
  };
}

function cleanTurret(value: unknown): TurretPart {
  const v = fields<TurretPart>(value);
  const num = (key: keyof typeof TURRET_LIMITS) => inRange(v[key], DEFAULT_TURRET[key], TURRET_LIMITS[key]);
  return { x: num('x'), z: num('z'), shoots: cleanKind(v.shoots, 'both'), height: num('height'), facing: num('facing'), range: num('range'), rapidFire: num('rapidFire'), spin: num('spin') };
}

/**
 * The turrets of a robot made before robots had more than two: one turret's numbers on their own
 * (`turretAt`, `shooterHeight`…), and `turrets: 2` for a second one beside it, for NECTAR.
 */
function olderTurrets(v: Record<string, unknown>, width: number): unknown[] {
  const turret = { x: v.turretAt, z: 0, shoots: 'both', height: v.shooterHeight, facing: 0, range: v.turretRange, rapidFire: v.rapidFire, spin: v.spin };
  if (v.turrets !== 2 || v.intake !== 'both') return [turret];
  const side = Math.min(0.1, width / 2 - TURRET_MARGIN);
  return [{ ...turret, z: -side, shoots: 'pollen' }, { ...turret, z: side, shoots: 'nectar' }];
}

/** The frame's length: the robot's without its intakes, m */
const frameLength = (bp: Pick<Blueprint, 'length' | 'intake' | 'backIntake'>) => bp.length - bp.intake.reach - (bp.backIntake?.reach ?? 0);

/** How far from the frame's center a turret's axis may be: forward or back, and to either side, m */
export function turretBounds(bp: Pick<Blueprint, 'length' | 'width' | 'intake' | 'backIntake'>): [number, number] {
  return [frameLength(bp) / 2 - TURRET_MARGIN, bp.width / 2 - TURRET_MARGIN];
}

const kindsOf = (kind: IntakeKind): BallKind[] => (kind === 'both' ? ['pollen', 'nectar'] : [kind]);

/** The balls a blueprint's robot can hold: what its intakes take, and POLLEN (every robot's pre-loads). */
export function heldKinds(bp: Pick<Blueprint, 'intake' | 'backIntake'>): BallKind[] {
  const taken = [bp.intake, bp.backIntake].flatMap(intake => (intake ? kindsOf(intake.kind) : []));
  return taken.includes('nectar') ? ['pollen', 'nectar'] : ['pollen'];
}

/** The balls a robot's intakes take, as one kind ('both' for both kinds). */
export function intakeKind(bp: Pick<Blueprint, 'intake' | 'backIntake'>): IntakeKind {
  const kinds = new Set([bp.intake, bp.backIntake].flatMap(intake => (intake ? kindsOf(intake.kind) : [])));
  return kinds.size > 1 ? 'both' : kinds.has('nectar') ? 'nectar' : 'pollen';
}

/**
 * A blueprint with every number inside its range and fitting the others (intakes no wider than the
 * robot, wheels that fit the frame, turrets on it…), or null when `value` isn't one at all. Missing
 * fields get the defaults; a robot saved before it could have more turrets and a back intake gets
 * those it had. Cleaning a clean blueprint changes nothing.
 */
export function cleanBlueprint(value: unknown): Blueprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<Record<keyof Blueprint, unknown>> & Record<string, unknown>;
  const num = (key: keyof typeof LIMITS) => inRange(v[key], DEFAULT_BLUEPRINT[key], LIMITS[key]);
  const width = num('width');
  // Older robots: the intake's numbers on their own (`intake` was its kind) and the turrets' too.
  const intake = typeof v.intake === 'string' ? { kind: v.intake, width: v.intakeWidth, reach: v.intakeReach, rate: v.intakeRate } : v.intake;
  const turrets = (Array.isArray(v.turrets) ? v.turrets : olderTurrets(v, width)).slice(0, MAX_TURRETS).map(cleanTurret);
  const bp: Blueprint = {
    name: cleanText(v.name, 24, DEFAULT_BLUEPRINT.name),
    team: cleanText(v.team, 24),
    number: typeof v.number === 'string' ? v.number.replace(/\D/g, '').slice(0, 6) : '',
    color: cleanColor(v.color, DEFAULT_BLUEPRINT.color),
    accent: cleanColor(v.accent, DEFAULT_BLUEPRINT.accent),
    length: num('length'),
    width,
    frameHeight: num('frameHeight'),
    drivetrain: DRIVETRAINS.includes(v.drivetrain as Drivetrain) ? v.drivetrain as Drivetrain : 'mecanum',
    wheel: num('wheel'),
    rpm: Math.round(num('rpm')),
    mass: num('mass'),
    intake: cleanIntake(intake),
    backIntake: v.backIntake && typeof v.backIntake === 'object' ? cleanIntake(v.backIntake) : null,
    arm: v.arm === true,
    turrets: turrets.length ? turrets : [cleanTurret(DEFAULT_TURRET)],
    mesh: cleanMesh(v.mesh),
  };
  // The intakes stick out of a frame long enough for the wheels.
  bp.intake.reach = round(Math.min(bp.intake.reach, bp.length - MIN_FRAME));
  if (bp.backIntake) bp.backIntake.reach = round(Math.min(bp.backIntake.reach, bp.length - MIN_FRAME - bp.intake.reach));
  for (const part of [bp.intake, bp.backIntake]) if (part) part.width = round(Math.min(part.width, bp.width));
  const frame = frameLength(bp);
  // Wheels a little apart at each end of the frame.
  bp.wheel = round(Math.min(bp.wheel, (frame - 0.034) / 2));
  // The turrets stand on the frame.
  const [bx, bz] = turretBounds(bp);
  for (const t of bp.turrets) {
    t.x = round(clamp(t.x, -bx, bx));
    t.z = round(clamp(t.z, -bz, bz));
    t.height = round(Math.max(t.height, FRAME_Y + bp.frameHeight + TURRET.foot + 0.01));
  }
  // A turret shoots balls the robot has, and every ball it has goes to a turret: the main one
  // takes what no other does.
  const held = heldKinds(bp);
  for (const t of bp.turrets) if (t.shoots !== 'both' && !held.includes(t.shoots)) t.shoots = 'both';
  if (held.some(k => !bp.turrets.some(t => t.shoots === 'both' || t.shoots === k))) bp.turrets[0].shoots = 'both';
  // The arm pushes POLLEN back into the front intake.
  if (bp.intake.kind === 'nectar') bp.arm = false;
  return bp;
}

/** The same robot without the uploaded model, as other players see it. */
export const withoutMesh = (bp: Blueprint): Blueprint => ({ ...bp, mesh: null });

/** A short name for a blueprint's contents (FNV-1a over its fields in a fixed order). */
export function blueprintHash(bp: Blueprint): string {
  const text = JSON.stringify((Object.keys(DEFAULT_BLUEPRINT) as (keyof Blueprint)[]).map(k => bp[k]));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

/** The id of another player's robot in an online room: the same on every computer. */
export const sharedRobotId = (bp: Blueprint): string => `x-${blueprintHash(withoutMesh(bp))}`;

// ---- turrets' places --------------------------------------------------------------

/**
 * Neat layouts of 1 to 5 turrets: each turret's place from the middle of them all (forward, right),
 * m. Their turntables are 11 cm square, so they stand 12 cm or more apart.
 */
const PATTERNS: [number, number][][] = [
  [[0, 0]],
  [[0, -0.1], [0, 0.1]],
  [[-0.045, -0.1], [-0.045, 0.1], [0.09, 0]],
  [[-0.065, -0.1], [-0.065, 0.1], [0.065, -0.1], [0.065, 0.1]],
  [[-0.08, -0.11], [-0.08, 0.11], [0.08, -0.11], [0.08, 0.11], [0, 0]],
];

/**
 * The places of `n` turrets laid out neatly around `center` (forward, right of the frame's center).
 * The layout moves in to stay on the frame, squeezed only on a frame too small for it.
 */
function pattern(bp: Blueprint, n: number, center: [number, number]): [number, number][] {
  const bounds = turretBounds(bp);
  const offsets = PATTERNS[n - 1];
  const [cx, cz] = ([0, 1] as const).map(k => {
    const low = Math.min(...offsets.map(o => o[k]));
    const high = Math.max(...offsets.map(o => o[k]));
    return high - low > 2 * bounds[k] ? 0 : clamp(center[k], -bounds[k] - low, bounds[k] - high);
  });
  return offsets.map(([x, z]) => [round(clamp(cx + x, -bounds[0], bounds[0])), round(clamp(cz + z, -bounds[1], bounds[1]))]);
}

const middle = (turrets: TurretPart[]): [number, number] =>
  [turrets.reduce((s, t) => s + t.x, 0) / turrets.length, turrets.reduce((s, t) => s + t.z, 0) / turrets.length];

/** The turrets still stand as arrangeTurrets() put them (or as a robot with one has its turret). */
function arranged(bp: Blueprint): boolean {
  const places = pattern(bp, bp.turrets.length, middle(bp.turrets));
  return bp.turrets.every((t, i) => Math.hypot(t.x - places[i][0], t.z - places[i][1]) < 0.002);
}

/** The turrets laid out neatly where they are now, each keeping its own settings. */
export function arrangeTurrets(bp: Blueprint): TurretPart[] {
  const places = pattern(bp, bp.turrets.length, middle(bp.turrets));
  return bp.turrets.map((t, i) => ({ ...t, x: places[i][0], z: places[i][1] }));
}

/**
 * The turrets with one more, set like turret `like`. Laid out neatly they make room for it; moved
 * by the player they stay, and it goes where it is furthest from them.
 */
export function withTurret(bp: Blueprint, like: number): TurretPart[] {
  if (bp.turrets.length >= MAX_TURRETS) return bp.turrets;
  const turrets = [...bp.turrets, { ...bp.turrets[like] }];
  if (arranged(bp)) {
    const places = pattern(bp, turrets.length, middle(bp.turrets));
    return turrets.map((t, i) => ({ ...t, x: places[i][0], z: places[i][1] }));
  }
  const [bx, bz] = turretBounds(bp);
  const center = middle(bp.turrets);
  let best: [number, number] = center;
  let bestScore = -Infinity;
  for (let x = -bx; x <= bx + 1e-9; x += 0.01) {
    for (let z = -bz; z <= bz + 1e-9; z += 0.01) {
      // Furthest from the nearest turret; of equal places, the one nearest the others' middle.
      const score = Math.min(...bp.turrets.map(t => Math.hypot(t.x - x, t.z - z))) - 0.01 * Math.hypot(center[0] - x, center[1] - z);
      if (score > bestScore) {
        best = [round(x), round(z)];
        bestScore = score;
      }
    }
  }
  turrets[turrets.length - 1] = { ...turrets[turrets.length - 1], x: best[0], z: best[1] };
  return turrets;
}

/** The turrets without turret `i` (laid out neatly, the others close up). */
export function withoutTurret(bp: Blueprint, i: number): TurretPart[] {
  if (bp.turrets.length < 2) return bp.turrets;
  const turrets = bp.turrets.filter((_, k) => k !== i);
  if (!arranged(bp)) return turrets;
  const places = pattern(bp, turrets.length, middle(bp.turrets));
  return turrets.map((t, k) => ({ ...t, x: places[k][0], z: places[k][1] }));
}

// ---- the robot ---------------------------------------------------------------------

/** Mecanum wheels: how wide, how far in from the frame's ends, and the gap to the frame box, m */
export const WHEEL = { width: 0.04, inset: 0.012, gap: 0.006 };
/** The frame box's bottom above the tiles, m */
export const FRAME_Y = 0.02;
/** A turret: its foot below where balls leave, its top above it, and how far from its axis they leave, m */
export const TURRET = { foot: 0.05, above: 0.035, exit: 0.08 };
/**
 * The Flower Mode arm, like URAN V2's: lowered, its front bar lies `length` past the intake's mouth,
 * just over the tiles; its hinge is a little behind the mouth. Raised it stands up in front of the intake.
 */
export const ARM = { length: 0.095, travel: 0.4, hinge: [-0.01, 0.13], bar: [0.085, 0.045], raised: (80 * Math.PI) / 180, box: [0.025, 0.09] };

const NO_SIGN: RobotSign = { at: 0, length: 0, y: 0, height: 0, side: 0 };

/** Where everything is on a player-made robot (robot frame: forward, up, right; m). */
export interface CustomLayout {
  /** The footprint's length, with the lowered arm */
  total: number;
  frameLength: number;
  /** The frame's center, forward */
  frameX: number;
  /** Half the width of the frame box between the wheels */
  frameHalf: number;
  frameTop: number;
  /** The front intake's mouth, forward, and the back one's (the robot's back end), if it has one */
  mouth: number;
  backMouth: number | null;
  /** The wheels' axles, forward of the frame's center (±) and out from the center line (±) */
  wheelX: number;
  wheelZ: number;
  /** Each turret: its axis (forward, right), the top of its tower and where the balls it holds sit */
  turrets: { at: [number, number]; towerTop: number; storage: Storage }[];
  sign: RobotSign;
  arm: { spec: ArmSpec; hinge: [number, number]; bar: [number, number] } | null;
}

export function layoutOf(bp: Blueprint): CustomLayout {
  const armLength = bp.arm ? ARM.length : 0;
  const total = bp.length + armLength;
  const back = -total / 2;
  const length = frameLength(bp);
  const frameX = back + (bp.backIntake?.reach ?? 0) + length / 2;
  const mouth = back + bp.length;
  const r = bp.wheel / 2;
  const wheelX = length / 2 - r - WHEEL.inset;
  const frameHalf = bp.width / 2 - WHEEL.width - WHEEL.gap;
  const frameTop = FRAME_Y + bp.frameHeight;
  const nectarOnly = intakeKind(bp) === 'nectar';

  const turrets = bp.turrets.map(t => {
    const at: [number, number] = [frameX + t.x, t.z];
    const towerTop = t.height - TURRET.foot;
    // Held balls: under the turret, down the tower and along the ramp to the front intake's mouth.
    const radius = t.shoots === 'nectar' || (t.shoots === 'both' && nectarOnly) ? NECTAR_RADIUS : POLLEN_RADIUS;
    const top = [at[0], Math.max(towerTop - radius - 0.01, radius + 0.03), at[1]];
    const low = [mouth - radius - 0.015, radius + 0.008, at[1] * 0.3];
    const storage = [[0, 0], [0.3, 0.45], [0.65, 0.85], [1, 1]].map(([kx, ky]) =>
      [top[0] + (low[0] - top[0]) * kx, top[1] + (low[1] - top[1]) * ky, top[2] + (low[2] - top[2]) * kx] as [number, number, number]);
    return { at, towerTop, storage };
  });

  let sign = NO_SIGN;
  if (bp.mesh) {
    if (bp.mesh.signs) sign = { at: frameX, length: Math.min(0.3, length * 0.6), y: 0.065, height: 0.06, side: bp.width / 2 };
  } else {
    // On the frame box's sides, between the wheels.
    const between = 2 * wheelX - bp.wheel - 0.02;
    if (between >= 0.08) sign = { at: frameX, length: Math.min(0.3, between), y: FRAME_Y + bp.frameHeight / 2, height: Math.min(0.065, bp.frameHeight - 0.01), side: frameHalf };
  }

  let arm: CustomLayout['arm'] = null;
  if (bp.arm) {
    const hinge: [number, number] = [mouth + ARM.hinge[0], ARM.hinge[1]];
    const bar: [number, number] = [mouth + ARM.bar[0], ARM.bar[1]];
    const armReach = Math.hypot(bar[0] - hinge[0], bar[1] - hinge[1]);
    const lowered = Math.atan2(bar[1] - hinge[1], bar[0] - hinge[0]);
    const upAngle = ARM.raised - lowered;
    // The front bar is 2 cm deep.
    const reach = Array.from({ length: 11 }, (_, i) => hinge[0] + armReach * Math.cos(lowered + upAngle * (1 - i / 10)) + 0.01);
    arm = {
      spec: { travel: ARM.travel, upAngle, box: { x: [mouth, mouth + ARM.length], y: [ARM.box[0], ARM.box[1]] }, reach },
      hinge,
      bar,
    };
  }
  return { total, frameLength: length, frameX, frameHalf, frameTop, mouth, backMouth: bp.backIntake ? back : null, wheelX, wheelZ: bp.width / 2 - WHEEL.width / 2, turrets, sign, arm };
}

/** Top speed: the motors' wheel speed, no faster than MAX_SPEED, m/s. */
export const topSpeed = (bp: Pick<Blueprint, 'rpm' | 'wheel'>) => Math.min(MAX_SPEED, wheelSpeed({ rpm: bp.rpm, wheel: bp.wheel }));

/**
 * The card picture of a robot without one of its own: the robot from the side, in its colors, as
 * blocks, with its turrets and intakes. An SVG data URL.
 */
export function blockLogo(bp: Blueprint): string {
  const n = bp.turrets.length;
  const w = n > 1 ? Math.min(20, 64 / n) : 28;
  const turrets = bp.turrets.map((t, i) => {
    const x = 12 + (70 * (i + 1)) / (n + 1) - w / 2;
    // The hood on the side the turret faces.
    const hood = Math.cos((t.facing * Math.PI) / 180) < 0 ? x - w * 0.4 : x + w * 0.9;
    return `<rect x="${x + w * 0.3}" y="26" width="${w * 0.4}" height="20" fill="${bp.accent}" opacity="0.8"/>
<rect x="${x}" y="16" width="${w}" height="12" rx="2" fill="${bp.accent}"/>
<rect x="${hood}" y="19" width="${w * 0.5}" height="5" fill="${bp.accent}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">
<rect width="100" height="80" rx="6" fill="#121733"/>
${turrets.join('\n')}
<rect x="12" y="44" width="70" height="16" rx="2" fill="${bp.color}"/>
<rect x="82" y="46" width="8" height="16" fill="${bp.accent}"/>
${bp.backIntake ? `<rect x="4" y="46" width="8" height="16" fill="${bp.accent}"/>` : ''}
<circle cx="27" cy="61" r="9" fill="#1d1f22"/><circle cx="27" cy="61" r="3" fill="#9aa3ad"/>
<circle cx="67" cy="61" r="9" fill="#1d1f22"/><circle cx="67" cy="61" r="3" fill="#9aa3ad"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The robot a blueprint makes, under `id`. `logo`: a picture of it for its card (by default the
 * block drawing).
 */
export function customDefinition(id: string, bp: Blueprint, logo?: string): RobotDefinition {
  const g = layoutOf(bp);
  const drive: DriveSpec = { rpm: bp.rpm, wheel: bp.wheel };
  const [main, ...extra] = bp.turrets.map((t, i): TurretDef => ({
    shooter: {
      at: g.turrets[i].at,
      height: t.height,
      exit: TURRET.exit,
      // As accurate as the teams' robots.
      sweetSpot: 1.0,
      maxRange: 2.2,
      modelYaw: 0,
      facing: (t.facing * Math.PI) / 180,
      turretLimit: (t.range * Math.PI) / 180,
      rapidFire: t.rapidFire,
      spin: t.spin,
    },
    kinds: t.shoots === 'both' ? undefined : [t.shoots],
    storage: g.turrets[i].storage,
  }));
  const name = bp.name || DEFAULT_BLUEPRINT.name;
  // The model doesn't change with the name, team or number: those are on the signs RobotView paints.
  const model = `custom:${id}#${blueprintHash({ ...bp, name: '', team: '', number: '' })}`;
  const armLength = bp.arm ? ARM.length : 0;
  return {
    id,
    name,
    team: bp.team || name,
    number: bp.number || name,
    teamLogo: logo ?? blockLogo(bp),
    logoBackground: 'transparent',
    model,
    lowModel: model,
    sign: g.sign,
    drive,
    config: {
      name,
      length: g.total,
      // The lowered arm's part of the footprint only collides while it is down.
      ...(bp.arm ? { frame: { length: bp.length, offset: -armLength / 2 } } : {}),
      width: bp.width,
      height: Math.max(...bp.turrets.map(t => t.height)) + TURRET.above,
      mass: bp.mass,
      wheelRadius: bp.wheel / 2,
      drive: {
        maxWheelSpeed: topSpeed(bp),
        // Mecanum rollers lose some speed sideways, swerve modules none; a tank drive doesn't strafe.
        strafeEfficiency: bp.drivetrain === 'mecanum' ? 0.85 : bp.drivetrain === 'swerve' ? 1 : 0,
        trackWidth: bp.width - WHEEL.width,
        wheelBase: 2 * g.wheelX,
        ...(bp.drivetrain === 'mecanum' ? {} : { type: bp.drivetrain }),
      },
      // The teams' robots: lighter ones accelerate and turn harder on the same traction.
      maxAccel: clamp(6.5 - (bp.mass - 9) * 0.34, 4.5, 7.5) * (bp.drivetrain === 'tank' ? TANK_GRIP : 1),
      maxTurnAccel: clamp(34 - (bp.mass - 9) * 2, 22, 38) * (bp.drivetrain === 'swerve' ? SWERVE_TURN : 1),
    },
    shooter: main.shooter,
    shooterKinds: main.kinds,
    storage: main.storage,
    extraTurrets: extra.length ? extra : undefined,
    intakes: kindsOf(bp.intake.kind),
    intakeFront: g.mouth,
    intakeInterval: 1 / bp.intake.rate,
    intakeHalfWidth: bp.intake.width / 2,
    backIntake: bp.backIntake ? { back: -g.backMouth!, halfWidth: bp.backIntake.width / 2, kinds: kindsOf(bp.backIntake.kind), interval: 1 / bp.backIntake.rate } : undefined,
    arm: g.arm?.spec,
    custom: bp,
  };
}

// A robot this game doesn't know (another player's, in a replay): the default blocks.
addCustomRobot(customDefinition(CUSTOM_ROBOT, DEFAULT_BLUEPRINT));

/** What the share code of a robot starts with. */
export const SHARE_PREFIX = 'URSIM-ROBOT:';

/** A robot as text to paste into a chat: its blueprint without the model (that stays a file). */
export function shareCode(bp: Blueprint): string {
  const bytes = new TextEncoder().encode(JSON.stringify(withoutMesh(bp)));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return SHARE_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The blueprint in a share code, or null when the text isn't one. */
export function readShareCode(text: string): Blueprint | null {
  const at = text.indexOf(SHARE_PREFIX);
  if (at < 0) return null;
  const code = text.slice(at + SHARE_PREFIX.length).trim().split(/\s/)[0].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(code + '='.repeat((4 - (code.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    return cleanBlueprint({ ...JSON.parse(json), mesh: null });
  } catch {
    return null;
  }
}
