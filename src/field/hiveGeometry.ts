// HIVE cell geometry, measured from the field CAD (am-5853 Red Hive) relative to the pivot axle.
//
// "Canonical" coordinates are the red hive as staged in the CAD (state A): the upward cell is on +Z.
// Each cell is a box between two hexagonal ribs, 12 in deep along the hive arm, with the opening at
// the outer rib. The arm points 30° above horizontal, so the opening faces outward and 30° up and the
// cell floor slopes down toward the back wall. The two stable states are mirror images, 60° apart.
// The blue hive is the same part turned 180° about the vertical axis, i.e. its local Z is mirrored.

import type { Alliance } from '../robot/robotConfig';

export type Vec3 = [number, number, number];
export type HiveState = 'A' | 'B';
export type CellId = 'pos' | 'neg';

/** Rotation between the two stable states (manual figure 9-10: arms at ±30°). */
export const TIP_ANGLE = Math.PI / 3;

/** Direction in the Y/Z plane, angle measured from +Z toward +Y. */
const dir = (deg: number): Vec3 => [0, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];

interface CellBox {
  center: Vec3;
  /** Outward along the arm; the opening is at +u */
  u: Vec3;
  /** Toward the peak of the hexagonal rib ("up" inside the cell) */
  w: Vec3;
}

/** Half depth of a cell along the arm (12 in between ribs). */
export const CELL_HALF_DEPTH = 0.15;

/**
 * Hexagonal rib profile (manual figure 9-11), in the w/x plane around the cell center:
 * 20 in wide, straight sides 7.61 in tall, pointed roof up to 14 in.
 */
export const HEX = { bottom: -0.178, shoulder: -0.178 + 0.1935, peak: 0.178, halfWidth: 0.254 };

function insideHex(w: number, x: number): boolean {
  if (w < HEX.bottom || w > HEX.peak) return false;
  const half = w <= HEX.shoulder ? HEX.halfWidth : (HEX.halfWidth * (HEX.peak - w)) / (HEX.peak - HEX.shoulder);
  return Math.abs(x) < half;
}

/** The hive is symmetric about this line through the pivot; it maps one cell onto the other. */
const SYMMETRY = dir(120);

function reflect(v: Vec3): Vec3 {
  const k = 2 * (v[1] * SYMMETRY[1] + v[2] * SYMMETRY[2]);
  return [v[0], k * SYMMETRY[1] - v[1], k * SYMMETRY[2] - v[2]];
}

const POS_CELL: CellBox = { center: [0, 0.303, 0.282], u: dir(30), w: dir(120) };

export const CELLS: Record<CellId, CellBox> = {
  pos: POS_CELL,
  neg: { center: reflect(POS_CELL.center), u: reflect(POS_CELL.u), w: reflect(POS_CELL.w) },
};

export const zSign = (alliance: Alliance) => (alliance === 'red' ? 1 : -1);

/** Pivot rotation (about +X) of a hive in the given stable state. */
export function stateAngle(alliance: Alliance, state: HiveState): number {
  return state === 'A' ? 0 : zSign(alliance) * TIP_ANGLE;
}

export const upCell = (state: HiveState): CellId => (state === 'A' ? 'pos' : 'neg');

function rotX([x, y, z]: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x, y * c - z * s, y * s + z * c];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Canonical → hive-local (mirrors Z for blue). */
const toLocal = (v: Vec3, alliance: Alliance): Vec3 => [v[0], v[1], v[2] * zSign(alliance)];

/** World-space frame of a cell for a hive with pivot `pivot` rotated by `angle`. */
export function cellFrame(alliance: Alliance, cell: CellId, pivot: Vec3, angle: number): { center: Vec3; u: Vec3; w: Vec3 } {
  const box = CELLS[cell];
  return {
    center: add(pivot, rotX(toLocal(box.center, alliance), angle)),
    u: rotX(toLocal(box.u, alliance), angle),
    w: rotX(toLocal(box.w, alliance), angle),
  };
}

/** True if a ball centered at world position `p` is inside the cell (not resting on its outside). */
export function inCell(p: Vec3, alliance: Alliance, cell: CellId, pivot: Vec3, angle: number): boolean {
  const f = cellFrame(alliance, cell, pivot, angle);
  const d: Vec3 = [p[0] - f.center[0], p[1] - f.center[1], p[2] - f.center[2]];
  return Math.abs(dot(d, f.u)) < CELL_HALF_DEPTH && insideHex(dot(d, f.w), d[0]);
}

/** Where auto-aim points: just inside the middle of the cell opening. */
export function aimPoint(alliance: Alliance, cell: CellId, pivot: Vec3, angle: number): Vec3 {
  const f = cellFrame(alliance, cell, pivot, angle);
  return add(f.center, scale(f.u, CELL_HALF_DEPTH - 0.04));
}

/** Smooth fall from one stable state to the other: it eases off the dampers and settles gently. */
export function tipProgress(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}
