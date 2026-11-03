// Where a robot may start a match (manual G304): fully on its own ALLIANCE's side of the FIELD,
// touching the FIELD perimeter wall, not contacting a FLOWER, not in the LOADING ZONE, and clear of
// the GARDEN's POLLEN and the other robots. Drivers can pick a start of their own before a game.
// Starts are kept as they are on the red side (-X); a blue start is the same turned 180° about the
// field center, so one saved start works for either alliance.

import type { Alliance, RobotConfig } from '../robot/robotConfig';
import { slotAlliance, type Slot } from '../sim/types';
import type { FieldLayout } from './layout';
import { footprint, polygonOverlapsRect, polygonsOverlap, type Rect, type Zones } from './zones';

export interface StartPose {
  x: number;
  z: number;
  /** Yaw 0 faces +X (away from the red drivers) */
  yaw: number;
}

/** A robot's outline on the floor: corners (x, z) */
export type Outline = [number, number][];

/** The rule a start breaks (G304), in the order they are checked */
export type StartProblem = 'side' | 'wall' | 'flower' | 'loading' | 'garden' | 'robot';

/** The red side's limits for a start */
export interface StartField {
  wall: number;
  loading: Rect;
  garden: Rect;
  flowers: Rect[];
}

/** Closer to the wall than this, a robot touches it, m */
const TOUCH = 0.01;
/** Robots stop this far short of the wall, so they don't start pressed into it, m */
const WALL_GAP = 0.004;
/** Closer to a FLOWER than this counts as contacting it, m */
const FLOWER_CONTACT = 0.005;
/** The default starts on the red side by driver station: against the alliance wall, facing the field */
const STATION_Z: Record<1 | 2, number> = { 1: -0.25, 2: 1.15 };

export const slotStation = (slot: Slot): 1 | 2 => (slot.endsWith('1') ? 1 : 2);

export function startField(layout: FieldLayout, zones: Zones): StartField {
  return {
    wall: zones.wall,
    loading: zones.loading.red,
    garden: zones.garden.red,
    flowers: layout.flowers.map(f => ({ minX: f.min[0], maxX: f.max[0], minZ: f.min[2], maxZ: f.max[2] })),
  };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A red-side start as it is for `alliance`, and back (blue: turned 180° about the field center). */
export function forAlliance(p: StartPose, alliance: Alliance): StartPose {
  return alliance === 'red' ? p : { x: -p.x, z: -p.z, yaw: wrapAngle(p.yaw + Math.PI) };
}

/** A driver station's usual start (red side) for a robot `length` long. */
export function defaultStart(station: 1 | 2, length: number, wall: number): StartPose {
  return { x: -(wall - length / 2 - WALL_GAP), z: STATION_Z[station], yaw: 0 };
}

/** The robot's outline in its STARTING CONFIGURATION: a folding arm stays up, so only the frame counts. */
export function startOutline(p: StartPose, cfg: RobotConfig): Outline {
  const frame = cfg.frame ?? { length: cfg.length, offset: 0 };
  return footprint(p.x + Math.cos(p.yaw) * frame.offset, p.z - Math.sin(p.yaw) * frame.offset, p.yaw, frame.length, cfg.width);
}

/** Pushes a red-side start back onto the red side: the walls and the center line stop the robot. */
export function clampStart(p: StartPose, cfg: RobotConfig, wall: number): StartPose {
  const outline = startOutline(p, cfg);
  const xs = outline.map(c => c[0]);
  const zs = outline.map(c => c[1]);
  const limit = wall - WALL_GAP;
  const push = (min: number, max: number, low: number, high: number) => (min < low ? low - min : max > high ? high - max : 0);
  return {
    x: p.x + push(Math.min(...xs), Math.max(...xs), -limit, 0),
    z: p.z + push(Math.min(...zs), Math.max(...zs), -limit, limit),
    yaw: wrapAngle(p.yaw),
  };
}

/** A robot turned in place keeps touching the walls it touched before the turn (red side). */
export function keepOnWalls(before: StartPose, turned: StartPose, cfg: RobotConfig, wall: number): StartPose {
  // Gaps to the alliance wall (-X) and the side walls (-Z, +Z)
  const gaps = (p: StartPose) => {
    const outline = startOutline(p, cfg);
    const xs = outline.map(c => c[0]);
    const zs = outline.map(c => c[1]);
    return { back: Math.min(...xs) + wall, left: Math.min(...zs) + wall, right: wall - Math.max(...zs) };
  };
  const was = gaps(before);
  const now = gaps(turned);
  let { x, z } = turned;
  if (was.back < TOUCH) x -= now.back - WALL_GAP;
  if (was.left < TOUCH) z -= now.left - WALL_GAP;
  else if (was.right < TOUCH) z += now.right - WALL_GAP;
  return clampStart({ x, z, yaw: turned.yaw }, cfg, wall);
}

/** The first rule of G304 a red-side start breaks, or null where the robot may start; `others`: robots already placed on that side. */
export function checkStart(p: StartPose, cfg: RobotConfig, field: StartField, others: readonly Outline[] = []): StartProblem | null {
  const outline = startOutline(p, cfg);
  const w = field.wall;
  // Fully inside the perimeter on the red half (columns A–C).
  if (outline.some(([x, z]) => x > 1e-6 || x < -w - 1e-6 || Math.abs(z) > w + 1e-6)) return 'side';
  // The red side's walls: the alliance wall and both side walls.
  if (!outline.some(([x, z]) => Math.max(-x, Math.abs(z)) >= w - TOUCH)) return 'wall';
  const grow = (r: Rect, m: number): Rect => ({ minX: r.minX - m, maxX: r.maxX + m, minZ: r.minZ - m, maxZ: r.maxZ + m });
  if (field.flowers.some(f => polygonOverlapsRect(outline, grow(f, FLOWER_CONTACT)))) return 'flower';
  if (polygonOverlapsRect(outline, field.loading)) return 'loading';
  if (polygonOverlapsRect(outline, field.garden)) return 'garden';
  if (others.some(o => polygonsOverlap(outline, o))) return 'robot';
  return null;
}

/** A start saved or sent by someone else: null unless it is a pose inside the field. */
export function cleanStart(value: unknown): StartPose | null {
  if (!value || typeof value !== 'object') return null;
  const { x, z, yaw } = value as Record<string, unknown>;
  const ok = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
  return ok(x, 2) && ok(z, 2) && ok(yaw, 10) ? { x, z, yaw: wrapAngle(yaw) } : null;
}

export interface StartEntry {
  slot: Slot;
  cfg: RobotConfig;
  /** The start its driver picked (red side), if any */
  start?: StartPose | null;
}

/**
 * Where each robot starts on the field (world poses). A driver's own start counts if G304 allows
 * it next to the starts already taken; everyone else gets their station's usual spot, or the other
 * station's when a picked start is in the way.
 */
export function resolveStarts(entries: readonly StartEntry[], field: StartField): Map<Slot, StartPose> {
  const taken: Record<Alliance, Outline[]> = { red: [], blue: [] };
  const starts = new Map<Slot, StartPose>();
  const place = (e: StartEntry, p: StartPose) => {
    const alliance = slotAlliance(e.slot);
    starts.set(e.slot, forAlliance(p, alliance));
    taken[alliance].push(startOutline(p, e.cfg));
  };
  for (const e of entries) {
    if (e.start && !checkStart(e.start, e.cfg, field, taken[slotAlliance(e.slot)])) place(e, e.start);
  }
  for (const e of entries) {
    if (starts.has(e.slot)) continue;
    const station = slotStation(e.slot);
    const spots = [station, station === 1 ? 2 : 1].map(s => defaultStart(s as 1 | 2, e.cfg.length, field.wall));
    place(e, spots.find(p => !checkStart(p, e.cfg, field, taken[slotAlliance(e.slot)])) ?? spots[0]);
  }
  return starts;
}
