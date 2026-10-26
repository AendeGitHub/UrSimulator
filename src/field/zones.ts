// Scoring zones (manual 9.3) measured from the tape in the field CAD, and geometry helpers.
// Red alliance at -X, audience at +Z; blue zones are red zones rotated 180° about the field center.

import type { Alliance } from '../robot/robotConfig';
import type { FieldLayout, Vec3 } from './layout';

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Middle ring top and top ring of a FLOWER bound its scoring volume (manual 10.5.2). */
export const FLOWER_VOLUME = { yMin: 0.137, yMax: 0.545, radius: 0.051 };

export interface Zones {
  wall: number;
  loading: Record<Alliance, Rect>;
  garden: Record<Alliance, Rect>;
  /** Center (x, z) of each FLOWER tube */
  flowers: [number, number][];
}

const mirror = (r: Rect): Rect => ({ minX: -r.maxX, maxX: -r.minX, minZ: -r.maxZ, maxZ: -r.minZ });

export function buildZones(layout: FieldLayout): Zones {
  const w = layout.wallInnerHalf;
  const loadingRed: Rect = { minX: -w, maxX: -1.501, minZ: -1.184, maxZ: -0.607 };
  const gardenRed: Rect = { minX: -w, maxX: -1.204, minZ: 1.73, maxZ: w };
  // The pollen staged inside each flower marks the tube center exactly.
  const flowers = layout.flowers.map(f => {
    let best: Vec3 | undefined;
    for (const p of layout.pollen) {
      if (!best || Math.hypot(p[0] - f.center[0], p[2] - f.center[1]) < Math.hypot(best[0] - f.center[0], best[2] - f.center[1])) best = p;
    }
    return [best![0], best![2]] as [number, number];
  });
  return {
    wall: w,
    loading: { red: loadingRed, blue: mirror(loadingRed) },
    garden: { red: gardenRed, blue: mirror(gardenRed) },
    flowers,
  };
}

export const rectCenter = (r: Rect): [number, number] => [(r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2];

/** Ball at least partially inside a floor zone. */
export function ballInRect(p: Vec3, radius: number, r: Rect): boolean {
  return p[0] > r.minX - radius && p[0] < r.maxX + radius && p[2] > r.minZ - radius && p[2] < r.maxZ + radius && p[1] < 0.25;
}

/** Corners (x, z) of a robot footprint. Yaw 0 faces +X; right is +Z. */
export function footprint(x: number, z: number, yaw: number, length: number, width: number): [number, number][] {
  const fx = Math.cos(yaw), fz = -Math.sin(yaw);
  const rx = Math.sin(yaw), rz = Math.cos(yaw);
  const corners: [number, number][] = [];
  for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    corners.push([x + (fx * a * length) / 2 + (rx * b * width) / 2, z + (fz * a * length) / 2 + (rz * b * width) / 2]);
  }
  return corners;
}

/** Separating-axis test: convex polygon vs axis-aligned rectangle. */
export function polygonOverlapsRect(poly: [number, number][], r: Rect): boolean {
  const rect: [number, number][] = [[r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ]];
  const axes: [number, number][] = [[1, 0], [0, 1]];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    axes.push([bz - az, -(bx - ax)]);
  }
  for (const [nx, nz] of axes) {
    const project = (pts: [number, number][]) => pts.map(([px, pz]) => px * nx + pz * nz);
    const a = project(poly);
    const b = project(rect);
    if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
  }
  return true;
}

/** LEAVE: no part of the robot within `gap` of the perimeter wall. */
export function clearOfWalls(poly: [number, number][], wall: number, gap = 0.02): boolean {
  return poly.every(([x, z]) => Math.abs(x) < wall - gap && Math.abs(z) < wall - gap);
}
