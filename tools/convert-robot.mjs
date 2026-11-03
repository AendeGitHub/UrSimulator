// Turns a robot CAD export into a game model with moving parts.
//
// Step 1 (STEP → GLB, native OpenCASCADE; needs `pip install cascadio==0.1.1 numpy`). A fine
// tessellation keeps round parts round (about 30 segments to a circle):
//   python3 -c "import cascadio; cascadio.step_to_glb('Robots/Uran 92 V2/Jedi92.step', 'robot-raw.glb', tol_linear=0.25, tol_angular=0.2, include_materials=True)"
// Step 2 (this script, with the robot's part list; the last argument also writes the lighter model):
//   node tools/convert-robot.mjs robot-raw.glb public/assets/robots/uran-v2.glb tools/robots/uran-v2.json public/assets/robots/uran-v2-low.glb
//
// The spec says which CAD axis points up ("up": +y or +z, Fusion exports either) and forward.
// The output faces +X (game "forward"), stands on y = 0 and is centered on its footprint.
// Moving parts (turret, flywheel, wheels, rollers) become separate nodes whose origin is their
// pivot; `extras.spin` names the game axis they turn around (and `extras.reverse` marks one that
// turns the other way, like the second wheel of a two-flywheel shooter). Everything else is one
// "body" node. A part whose axle stands at an angle in the CAD (the flywheel of a turret turned a
// few degrees) gives that axle as `axisVector` (CAD frame): it hangs in a still "<name>_axle" node
// turned onto it and spins about its own named axis, so it turns true instead of wobbling.
// Every CAD part is simplified on its own, as far as its surface may move by `detail` (`lowDetail`
// for the lighter model), in meters: thin plates keep their thickness and round parts stay round,
// where simplifying the whole robot at once to a triangle count tore plates into shards.
// Whatever turns on the axis of a roller, wheel or flywheel (its shaft, pulleys, gears, hubs,
// collars and spacers) turns with it: such parts are found by themselves (`coaxial: false` on a
// rule turns that off). A rule with `mecanum: true` rebuilds its CAD mecanum wheel as a clean one
// of the same size, roller slant and colors: barrel rollers at 45° between two plates.
// Meshes carry no normals: CAD normals split every face into its own island, which blocks
// simplification, so the game computes creased normals when it loads the model.
// `drop` names CAD assemblies left out entirely (old parts kept in the file); a rule's `ancestor`
// may be a list when one moving part is spread over several CAD nodes. `split` names CAD nodes
// whose one mesh holds several bodies (an unnamed STEP solid: a turret's ring gear with the gear
// that drives it): each connected piece then finds its own rule by its own bounds.
// STEP exports lose transparency: `translucent` lists CAD colors (clear polycarbonate panels)
// that become see-through again, each with its opacity, or CAD names (`name`) where solid parts
// share the panels' color.
// The game's arm rests lowered in the model. An arm the CAD shows raised gives `turn` (rad,
// right-hand about the part's game axis: negative swings an arm's front end down): the model is
// written with the part turned that far about its pivot, and its footprint counts it there.
// A part that slides along its axis instead (a lift's stage, with what rides on it as its
// children) gives `slide`, how far it goes (m): the game moves it that far, and parts count as
// seen when they show with it down or all the way up. `swing` (rad) is how far a part the game
// turns to an angle goes (a shooter's adjustable hood, a lift box's stopper). `colorTolerance` merges CAD colors that
// close into one material, for fewer draw calls.

import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, quantize, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [input, output, specPath, lowOutput] = process.argv.slice(2);
if (!input || !output || !specPath) {
  console.error('Usage: node tools/convert-robot.mjs <raw.glb> <out.glb> <robot-spec.json> [out-low.glb]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const DETAIL = spec.detail ?? 0.0004;
const LOW_DETAIL = spec.lowDetail ?? 0.0025;

const UNIT = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
/** CAD → Y-up: a Z-up CAD turns -90° about X. */
const UP = { '+y': p => p, '+z': ([x, y, z]) => [x, z, -y] }[spec.up ?? '+y'];
if (!UP) throw new Error('"up" must be +y or +z');
const [fx, fy, fz] = UP(UNIT[spec.forward] ?? [0, 1, 0]);
if (Math.abs(fy) > 0.5) throw new Error('"forward" must be a horizontal CAD axis such as +x or -z');
/** Yaw that turns the CAD's forward axis onto +X. */
const YAW = Math.atan2(fz, fx);
const cosY = Math.cos(YAW);
const sinY = Math.sin(YAW);
/** CAD → game rotation (up to +Y, then about +Y). */
const rot = p => {
  const [x, y, z] = UP(p);
  return [cosY * x + sinY * z, y, -sinY * x + cosY * z];
};
/** A CAD axis name expressed as a game axis name (the rotations are multiples of 90°). */
function gameAxis(axis) {
  const v = rot(UNIT[`+${axis}`]).map(Math.abs);
  return 'xyz'[v.indexOf(Math.max(...v))];
}
/** Index of the CAD axis that points up, and of the one that points forward. */
const UP_AXIS = (spec.up ?? '+y')[1] === 'z' ? 2 : 1;
const FORWARD_AXIS = 'xyz'.indexOf((spec.forward ?? '+y')[1]);

const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function ancestors(node) {
  const names = [];
  for (let n = node; n; n = n.getParentNode()) names.push(n.getName());
  return names;
}

const isFixed = names => {
  const lower = names.map(n => n.toLowerCase());
  return (spec.fixed ?? []).some(f => lower.some(n => n.includes(f.toLowerCase())));
};

/** First part whose rule matches this CAD node, or "body". */
function classify(names, center) {
  // "fixed": parts that never turn even inside a moving part's zone, e.g. a drive belt that
  // wraps around a wheel's pulley.
  if (isFixed(names)) return 'body';
  for (const part of spec.parts) {
    if (part.ancestor && ![part.ancestor].flat().some(a => names.includes(a))) continue;
    if (part.ancestorPrefix && !names.some(n => n.startsWith(part.ancestorPrefix))) continue;
    if (part.within && !Object.entries(part.within).every(([axis, [lo, hi]]) => {
      const v = center['xyz'.indexOf(axis)];
      return v >= lo && v <= hi;
    })) continue;
    if (part.cylinder) {
      const [cx, cy, cz] = part.cylinder.center;
      if (Math.abs(center[0] - cx) > part.cylinder.halfWidth || Math.hypot(center[1] - cy, center[2] - cz) > part.cylinder.radius) continue;
    }
    return part.name;
  }
  return 'body';
}

/**
 * Material from the CAD color: aluminium (light, unsaturated) shines like brushed metal, black
 * parts read as anodized metal or plastic, rubber (wheels, rollers, belts) is matte, and colored
 * parts are 3D-printed plastic.
 */
function surface([r, g, b], rubber) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (rubber && (max < 0.3 || max - min < 0.1)) return { metal: 0, rough: 0.85 };
  if (max < 0.12) return { metal: 0.25, rough: 0.5 };
  if (max - min < 0.06 && max > 0.3) return { metal: 0.85, rough: 0.36 };
  if (max - min < 0.06) return { metal: 0.6, rough: 0.42 };
  return { metal: 0.05, rough: 0.45 };
}
const RUBBER = /mecanum|gecko|wheel|roller|tread|belt|compliant|moosetake|traction|tire|tyre|flex/i;
/** Turning parts named like wheels that are metal or hard plastic. */
const HARD = /fly ?wheel|pulley|gear|sprocket|hub|insert|bearing|race/i;
/** Parts on a turning axis that don't turn: motors, gearboxes and servos driving it. */
const STILL = /motor|gearbox|planetary|servo|encoder|yellow ?jacket/i;

/** Merges vertices at the same place, so a part's faces share edges and can be simplified. */
function weldPositions(pos, idx) {
  const keys = new Map();
  const out = [];
  const remap = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${Math.round(pos[i * 3] * 2e5)},${Math.round(pos[i * 3 + 1] * 2e5)},${Math.round(pos[i * 3 + 2] * 2e5)}`;
    let v = keys.get(key);
    if (v === undefined) {
      v = out.length / 3;
      keys.set(key, v);
      out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    remap[i] = v;
  }
  const tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { P: Float32Array.from(out), I: Uint32Array.from(tris) };
}

/** A welded mesh's connected pieces, each with its own vertices, bounds, center and size. */
function pieces({ P, I }) {
  const up = Int32Array.from({ length: P.length / 3 }, (_, i) => i);
  const find = v => {
    while (up[v] !== v) v = up[v] = up[up[v]];
    return v;
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]);
    for (const v of [I[t + 1], I[t + 2]]) {
      const b = find(v);
      if (b !== a) up[b] = a;
    }
  }
  const groups = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const root = find(I[t]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return [...groups.values()].map(tris => {
    const index = new Map();
    const out = [];
    const tri = new Uint32Array(tris.length * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    tris.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const v = I[t + k];
        let n = index.get(v);
        if (n === undefined) {
          n = out.length / 3;
          index.set(v, n);
          for (let a = 0; a < 3; a++) {
            const x = P[v * 3 + a];
            out.push(x);
            min[a] = Math.min(min[a], x);
            max[a] = Math.max(max[a], x);
          }
        }
        tri[j * 3 + k] = n;
      }
    });
    const center = min.map((v, a) => (v + max[a]) / 2);
    return { P: Float32Array.from(out), I: tri, min, max, center, size: Math.max(...max.map((v, a) => v - min[a])) };
  });
}

/** Simplifies one part as far as its surface may move by `error` meters, and drops unused vertices. */
function simplifyPart({ P, I }, error) {
  if (I.length < 36) return { P, I };
  const [kept] = MeshoptSimplifier.simplify(I, P, 3, 0, error, ['ErrorAbsolute']);
  const used = new Map();
  const out = [];
  const tris = new Uint32Array(kept.length);
  kept.forEach((v, k) => {
    let n = used.get(v);
    if (n === undefined) {
      n = out.length / 3;
      used.set(v, n);
      out.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    }
    tris[k] = n;
  });
  return { P: Float32Array.from(out), I: tris };
}

// ---- a clean mecanum wheel -------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = a => scale(a, 1 / Math.hypot(...a));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A rule's axle in the CAD frame: its named axis, or `axisVector` when the part sits at an angle. */
const axleOf = rule => norm(rule.axisVector ?? UNIT[`+${rule.axis}`]);

/** How far a CAD point is from a rule's axle (the line through its pivot), m. */
function distanceToAxle(p, rule) {
  const a = axleOf(rule);
  const d = sub(p, rule.pivot);
  return Math.hypot(...sub(d, scale(a, dot(d, a))));
}

/**
 * The turn (quaternion x, y, z, w, game frame) that lays a part's named spin axis onto its real
 * axle. A turret standing a few degrees round in the CAD carries its flywheel's axle round with it;
 * spun about the named axis, the wheel would wobble. Such a part hangs in a node turned by this, so
 * it spins about its true axle. Null when the named axis is the axle.
 */
function axleTurn(rule) {
  if (!rule.axisVector) return null;
  const named = rot(UNIT[`+${rule.axis}`]).map(v => Math.abs(Math.round(v)));
  let a = norm(rot(rule.axisVector));
  // The spin axis is the node's own +x/+y/+z; take the axle's end nearest to it.
  if (dot(a, named) < 0) a = scale(a, -1);
  const c = cross(named, a);
  const q = [...c, 1 + dot(named, a)];
  const n = Math.hypot(...q);
  return q.map(v => v / n);
}

/** Rotates v by the quaternion q (x, y, z, w). */
function turn(q, v) {
  const u = q.slice(0, 3);
  const t = scale(cross(u, v), 2);
  return add(add(v, t, q[3]), cross(u, t));
}

/** Appends a surface of revolution about `axis` through `center`: `profile` is [along, radius] pairs. */
function lathe(mesh, center, axis, side, profile, segments, caps = true) {
  const other = norm([axis[1] * side[2] - axis[2] * side[1], axis[2] * side[0] - axis[0] * side[2], axis[0] * side[1] - axis[1] * side[0]]);
  const base = mesh.P.length / 3;
  for (const [s, r] of profile) {
    for (let k = 0; k < segments; k++) {
      const a = (2 * Math.PI * k) / segments;
      mesh.P.push(...add(add(center, axis, s), add(scale(side, Math.cos(a) * r), other, Math.sin(a) * r)));
    }
  }
  for (let j = 0; j + 1 < profile.length; j++) {
    for (let k = 0; k < segments; k++) {
      const a = base + j * segments + k, b = base + j * segments + ((k + 1) % segments);
      const c = a + segments, d = b + segments;
      mesh.I.push(a, b, d, a, d, c);
    }
  }
  if (caps) {
    for (const [j, flip] of [[0, true], [profile.length - 1, false]]) {
      const mid = mesh.P.length / 3;
      mesh.P.push(...add(center, axis, profile[j][0]));
      for (let k = 0; k < segments; k++) {
        const a = base + j * segments + k, b = base + j * segments + ((k + 1) % segments);
        mesh.I.push(...(flip ? [mid, b, a] : [mid, a, b]));
      }
    }
  }
}

/**
 * A mecanum wheel in CAD coordinates: `rollers` barrels whose axes lean 45° (`slant` ±1) between
 * two plates on a hub. Barrel radius follows the wheel's round outline, so it rolls like the real one.
 */
function mecanumWheel({ center, axis, radius, width, slant, rollers = 10, segments = 16 }) {
  const up = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(sub(up, scale(axis, up[0] * axis[0] + up[1] * axis[1] + up[2] * axis[2])));
  const v = norm([axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]]);
  const rubber = { P: [], I: [] };
  const metal = { P: [], I: [] };
  const r0 = radius * 0.22;
  const ring = radius - r0;
  // Barrel length: as far as the outline allows, but within the wheel's width.
  const half = Math.min(Math.sqrt(2 * (radius ** 2 - (radius - 0.5 * r0) ** 2)), (width * 0.5) / Math.SQRT1_2 - r0 * 0.3);
  const steps = Math.max(4, Math.round(segments / 2));
  const profile = [];
  for (let j = 0; j <= steps; j++) {
    const s = -half + (2 * half * j) / steps;
    profile.push([s, Math.max(r0 * 0.35, Math.sqrt(Math.max(0, radius ** 2 - (s * s) / 2)) - ring)]);
  }
  for (let i = 0; i < rollers; i++) {
    const a = (2 * Math.PI * i) / rollers;
    const n = add(scale(u, Math.cos(a)), v, Math.sin(a));
    const t = add(scale(u, -Math.sin(a)), v, Math.cos(a));
    const dir = norm(add(t, axis, slant));
    lathe(rubber, add(center, n, ring), dir, n, profile, Math.max(8, segments - 4));
  }
  // Two plates that hold the rollers' ends, and the hub between them.
  const plate = width * 0.5 - r0 * 0.15;
  const thick = Math.max(0.002, width * 0.05);
  for (const s of [-1, 1]) {
    lathe(metal, add(center, axis, s * (plate - thick / 2)), axis, u, [[-thick / 2, ring * 1.02], [thick / 2, ring * 1.02]], segments * 3);
  }
  lathe(metal, center, axis, u, [[-plate, radius * 0.2], [plate, radius * 0.2]], segments * 2);
  return { rubber, metal };
}

/**
 * Which way a CAD mecanum wheel's rollers lean, in mecanumWheel's terms: each roller (a connected
 * piece out at the rim, longer than wide) votes with the sign of (d·axis)(d·tangent) of its long
 * direction d, the tangent being axis × radial. The wheel may stand at any angle in the CAD.
 */
function rollerSlant(own, pivot, axis, radius) {
  let votes = 0;
  for (const { P, I } of own) {
    // Connected pieces (union-find over shared vertices).
    const parent = Int32Array.from({ length: P.length / 3 }, (_, i) => i);
    const find = i => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let t = 0; t < I.length; t += 3) {
      const a = find(I[t]);
      parent[find(I[t + 1])] = a;
      parent[find(I[t + 2])] = a;
    }
    const pieces = new Map();
    for (let i = 0; i < P.length / 3; i++) {
      const r = find(i);
      if (!pieces.has(r)) pieces.set(r, []);
      pieces.get(r).push(i);
    }
    for (const verts of pieces.values()) {
      if (verts.length < 12) continue;
      const c = [0, 1, 2].map(k => verts.reduce((s, i) => s + P[i * 3 + k], 0) / verts.length);
      const off = sub(c, pivot);
      const radial = sub(off, scale(axis, off[0] * axis[0] + off[1] * axis[1] + off[2] * axis[2]));
      if (Math.hypot(...radial) < 0.55 * radius) continue;
      // Long direction: the covariance's main eigenvector (power iteration).
      const cov = [0, 1, 2].map(r => [0, 1, 2].map(k => verts.reduce((s, i) => s + (P[i * 3 + r] - c[r]) * (P[i * 3 + k] - c[k]), 0)));
      let d = [1, 0.7, 0.3];
      for (let n = 0; n < 30; n++) d = norm([0, 1, 2].map(r => cov[r][0] * d[0] + cov[r][1] * d[1] + cov[r][2] * d[2]));
      const n = norm(radial);
      const tangent = [axis[1] * n[2] - axis[2] * n[1], axis[2] * n[0] - axis[0] * n[2], axis[0] * n[1] - axis[1] * n[0]];
      const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      const across = d[0] * tangent[0] + d[1] * tangent[1] + d[2] * tangent[2];
      // A roller leans about 45°: both parts well away from zero.
      if (Math.abs(along) > 0.35 && Math.abs(across) > 0.35) votes += Math.sign(along * across);
    }
  }
  return { slant: Math.sign(votes) || 1, votes };
}

// ---- what can be seen ------------------------------------------------------------------------

/**
 * How many pixels of each part show when the robot is looked at from all around and from above
 * (orthographic views with a depth buffer, the robot as it stands in the CAD). Parts that never
 * show sit inside the frame: electronics, hidden motors, the far side of plates.
 */
function visiblePixels(parts, size = 320) {
  const box = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (const it of parts) for (let k = 0; k < 3; k++) {
    box[k][0] = Math.min(box[k][0], it.min[k]);
    box[k][1] = Math.max(box[k][1], it.max[k]);
  }
  const mid = box.map(([a, b]) => (a + b) / 2);
  const reach = Math.hypot(...box.map(([a, b]) => b - a)) / 2;
  const up = UNIT[`+${'xyz'[UP_AXIS]}`];
  const fwd = UNIT[`+${'xyz'[FORWARD_AXIS]}`];
  const side = [up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]];
  const seen = new Float64Array(parts.length);
  const depth = new Float32Array(size * size);
  const owner = new Int32Array(size * size);
  const px = size / (2 * reach);
  for (const elevation of [-8, 12, 35, 60, 88]) {
    const steps = elevation > 80 ? 1 : 12;
    for (let s = 0; s < steps; s++) {
      const az = (2 * Math.PI * (s + (elevation % 2 ? 0.5 : 0))) / steps;
      const el = (elevation * Math.PI) / 180;
      // View direction (from the camera toward the robot) and the screen axes.
      const toEye = add(add(scale(fwd, Math.cos(el) * Math.cos(az)), side, Math.cos(el) * Math.sin(az)), up, Math.sin(el));
      const right = norm(Math.abs(el) > 1.5 ? side : [toEye[1] * up[2] - toEye[2] * up[1], toEye[2] * up[0] - toEye[0] * up[2], toEye[0] * up[1] - toEye[1] * up[0]]);
      const screenUp = [right[1] * toEye[2] - right[2] * toEye[1], right[2] * toEye[0] - right[0] * toEye[2], right[0] * toEye[1] - right[1] * toEye[0]];
      depth.fill(-Infinity);
      owner.fill(-1);
      const project = (P, v) => {
        const d = [P[v * 3] - mid[0], P[v * 3 + 1] - mid[1], P[v * 3 + 2] - mid[2]];
        return [
          (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * px + size / 2,
          (d[0] * screenUp[0] + d[1] * screenUp[1] + d[2] * screenUp[2]) * px + size / 2,
          d[0] * toEye[0] + d[1] * toEye[1] + d[2] * toEye[2],
        ];
      };
      parts.forEach((it, n) => {
        const { P, I } = it;
        for (let t = 0; t < I.length; t += 3) {
          const [a, b, c] = [project(P, I[t]), project(P, I[t + 1]), project(P, I[t + 2])];
          const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (Math.abs(area) < 1e-9) continue;
          const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
          const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
            const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
            const q = y * size + x;
            if (z > depth[q]) {
              depth[q] = z;
              owner[q] = n;
            }
          }
        }
      });
      for (const n of owner) if (n >= 0) seen[n]++;
    }
  }
  return seen;
}

// ---- reading the CAD -------------------------------------------------------------------------

async function main() {
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const src = await io.read(input);

  // Each CAD part on its own, simplified, in CAD coordinates.
  const items = [];
  let dropped = 0;
  let total = 0;
  for (const node of src.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const b = getBounds(node);
    const size = Math.max(...b.max.map((v, i) => v - b.min[i]));
    const tris = mesh.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0);
    total += tris;
    const names = ancestors(node);
    // Screws, nuts and pins add triangles but nothing visible at game distance.
    if (size < spec.dropSmallerThan || (spec.drop ?? []).some(d => names.includes(d))) {
      dropped += tris;
      continue;
    }
    const center = b.min.map((v, i) => (v + b.max[i]) / 2);
    const part = classify(names, center);
    // A node named in `split` holds several bodies in one mesh (an unnamed STEP solid): each
    // connected piece is a part of its own, with its own bounds and rule.
    const split = (spec.split ?? []).some(s => names.includes(s));
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const color = mat ? mat.getBaseColorFactor() : [0.6, 0.6, 0.6, 1];
      const pos = prim.getAttribute('POSITION');
      const ind = prim.getIndices();
      if (!ind) continue;
      const P = new Float32Array(pos.getCount() * 3);
      const el = [];
      for (let i = 0; i < pos.getCount(); i++) P.set(apply(m, pos.getElement(i, el)), i * 3);
      const I = new Uint32Array(ind.getCount());
      for (let i = 0; i < I.length; i++) I[i] = ind.getScalar(i);
      // A clear panel by its CAD color, or by its name where solid parts have that color too: its opacity.
      const clear = (spec.translucent ?? []).find(c => (c.name ? names.some(n => n.includes(c.name)) : c.color.every((x, k) => Math.abs(x - color[k]) < 0.01)))?.opacity;
      const rubber = RUBBER.test(names.slice(0, 2).join('|')) && !HARD.test(names.slice(0, 2).join('|'));
      const welded = weldPositions(P, I);
      for (const piece of split ? pieces(welded) : [{ ...welded, min: b.min, max: b.max, center, size }]) {
        if (split && piece.size < spec.dropSmallerThan) {
          dropped += piece.I.length / 3;
          continue;
        }
        // Small parts (screw heads, collars) may lose a little more of their shape.
        const geo = simplifyPart(piece, piece.size < 0.025 ? Math.max(DETAIL, 0.0007) : DETAIL);
        const own = split ? classify(names, piece.center) : part;
        items.push({ names, part: own, color, size: piece.size, min: piece.min, max: piece.max, center: piece.center, rubber, clear, ...geo });
      }
    }
  }
  const rules = new Map(spec.parts.map(p => [p.name, p]));

  // CAD colors closer than `colorTolerance` (a dozen near-blacks) share one material: each color
  // of each part is a draw call.
  if (spec.colorTolerance) {
    const palette = [];
    for (const it of items) {
      if (it.clear) continue;
      const near = palette.find(c => c[3] === it.color[3] && c.every((v, k) => Math.abs(v - it.color[k]) <= spec.colorTolerance));
      if (near) it.color = near;
      else palette.push(it.color);
    }
    console.log(`  ${palette.length} colors after merging`);
  }

  // Parts the CAD shows in another pose than the game model's (a raised arm), turned into it.
  for (const rule of spec.parts.filter(p => p.turn)) {
    // The CAD direction that becomes the part's game axis.
    const k = Object.values(UNIT).find(v => dot(rot(v), UNIT[`+${gameAxis(rule.axis)}`]) > 0.99);
    const [c, s] = [Math.cos(rule.turn), Math.sin(rule.turn)];
    for (const it of items.filter(it => it.part === rule.name)) {
      for (let i = 0; i < it.P.length; i += 3) {
        const v = sub([it.P[i], it.P[i + 1], it.P[i + 2]], rule.pivot);
        // Rodrigues: v cos + (k × v) sin + k (k · v)(1 − cos)
        const t = add(add(scale(v, c), cross(k, v), s), k, dot(k, v) * (1 - c));
        it.P.set(add(t, rule.pivot), i);
      }
      // New bounds (a CAD node's primitives share their bounds arrays, so these aren't changed in place).
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < it.P.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], it.P[i]);
        hi[i % 3] = Math.max(hi[i % 3], it.P[i]);
      }
      Object.assign(it, { min: lo, max: hi, center: lo.map((v, a) => (v + hi[a]) / 2) });
    }
    console.log(`  ${rule.name.padEnd(15)} turned ${((rule.turn * 180) / Math.PI).toFixed(1)}° about ${gameAxis(rule.axis)}`);
  }

  // Mecanum wheels rebuilt clean, with the CAD wheel's size, roller slant and colors.
  for (const rule of spec.parts.filter(p => p.mecanum)) {
    // The wheel's own CAD parts (`mecanum.match` names its assembly when "mecanum" alone would also
    // catch the gear that drives it); the rest of the rule keeps turning as it is.
    const { match, slant: forced } = rule.mecanum;
    const own = items.filter(it => it.part === rule.name && (match ? it.names.some(n => n.includes(match)) : /mecanum/i.test(it.names.join('|'))));
    if (!own.length) continue;
    const ai = 'xyz'.indexOf(rule.axis);
    const axis = UNIT[`+${rule.axis}`];
    const all = own.flatMap(it => Array.from(it.P));
    const pivot = rule.pivot;
    let radius = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < all.length; i += 3) {
      const d = [all[i] - pivot[0], all[i + 1] - pivot[1], all[i + 2] - pivot[2]];
      radius = Math.max(radius, Math.hypot(...d.map((x, k) => (k === ai ? 0 : x))));
      lo = Math.min(lo, all[i + ai]);
      hi = Math.max(hi, all[i + ai]);
    }
    const center = [...pivot];
    center[ai] = (lo + hi) / 2;
    // Colors by area: the outermost ones are the rollers, the middle ones the plates.
    const area = new Map();
    for (const it of own) {
      for (let t = 0; t < it.I.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map(k => Array.from(it.P.subarray(it.I[t + k] * 3, it.I[t + k] * 3 + 3)));
        const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const r = Math.hypot(...g.map((x, k) => (k === ai ? 0 : x - pivot[k]))) / radius;
        const e1 = sub(b, a), e2 = sub(c, a);
        const s = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        const zone = r > 0.82 ? 'outer' : r > 0.3 ? 'middle' : 'inner';
        const key = `${zone}|${it.color.join(',')}`;
        area.set(key, (area.get(key) ?? 0) + s);
      }
    }
    const top = zone => [...area].filter(([k]) => k.startsWith(zone)).sort((a, b) => b[1] - a[1]).map(([k]) => k.split('|')[1].split(',').map(Number));
    const rollerColor = top('outer')[0] ?? [0.1, 0.1, 0.1, 1];
    const plateColor = top('middle').find(c => c.join() !== rollerColor.join()) ?? [0.6, 0.6, 0.6, 1];
    // The barrels lean whichever way the CAD wheel's do.
    // `mecanum.slant` sets it when the CAD has the wrong hand of wheel in a corner.
    const { slant: found, votes } = rollerSlant(own, pivot, axis, radius);
    const slant = forced ?? found;
    const params = { center, axis, radius, width: hi - lo, slant, rollers: rule.mecanum.rollers ?? 10 };
    for (const it of own) it.part = null;
    const box = [0, 1, 2].map(k => (k === ai ? [lo, hi] : [pivot[k] - radius, pivot[k] + radius]));
    for (const [key, color, rubber] of [['rubber', rollerColor, true], ['metal', plateColor, false]]) {
      items.push({ names: [`${rule.name} (rebuilt)`], part: rule.name, color, rubber, gen: { params, key }, min: box.map(b => b[0]), max: box.map(b => b[1]), center });
    }
    console.log(`  ${rule.name.padEnd(15)} rebuilt: ⌀${(radius * 2000).toFixed(0)} mm × ${((hi - lo) * 1000).toFixed(0)} mm, rollers lean ${slant > 0 ? '+' : '-'} (${votes} roller votes${forced ? ', set by the spec' : ''})`);
  }

  // Shafts, pulleys, gears and hubs on the axis of a roller, wheel or flywheel turn with it.
  for (const rule of spec.parts) {
    if (rule.coaxial === false || !/^(intake|transfer|flywheel|wheel_|box_)/.test(rule.name)) continue;
    const ai = 'xyz'.indexOf(rule.axis);
    const [bi, ci] = [0, 1, 2].filter(k => k !== ai);
    const own = items.filter(it => it.part === rule.name);
    if (!own.length) continue;
    const lo = Math.min(...own.map(it => it.min[ai])) - 0.06;
    const hi = Math.max(...own.map(it => it.max[ai])) + 0.06;
    const from = new Set(['body', rule.parent ?? 'body']);
    const taken = new Set();
    for (const it of items) {
      // A motor in line with its wheel or roller stays still around its turning shaft.
      if (!from.has(it.part) || isFixed(it.names) || STILL.test(it.names.join('|'))) continue;
      const eb = it.max[bi] - it.min[bi], ec = it.max[ci] - it.min[ci];
      const onAxis = rule.axisVector
        ? distanceToAxle(it.center, rule) < 0.004
        : Math.abs(it.center[bi] - rule.pivot[bi]) < 0.004 && Math.abs(it.center[ci] - rule.pivot[ci]) < 0.004;
      if (!onAxis || it.max[ai] <= lo || it.min[ai] >= hi || Math.max(eb, ec) > 0.2 || Math.min(eb, ec) < 0.8 * Math.max(eb, ec)) continue;
      // Round (or hexagonal) about the axis: no corner sticks out further than a circle in its box
      // would. A square bracket around the shaft doesn't turn.
      let reach = 0;
      for (let i = 0; i < it.P.length; i += 3) reach = Math.max(reach, Math.hypot(it.P[i + bi] - it.center[bi], it.P[i + ci] - it.center[ci]));
      if (reach < 0.6 * Math.max(eb, ec) + 0.0005) {
        it.part = rule.name;
        taken.add(it.names[0]);
      }
    }
    if (taken.size) console.log(`  ${rule.name.padEnd(15)} + ${[...taken].slice(0, 6).join(', ')}${taken.size > 6 ? ` (+${taken.size - 6})` : ''}`);
  }

  // Parts that can't be seen from anywhere around or above the robot are left out, and parts that
  // barely show are simplified further. See-through panels hide nothing.
  if (!spec.keepHidden) {
    const cad = items.filter(it => it.part && !it.gen && !it.clear);
    const seen = visiblePixels(cad);
    // A lift's stages are looked at all the way up too (with what rides on them): what they hide
    // while down, and what hides inside each other, shows then.
    const slideOf = name => {
      let d = [0, 0, 0];
      for (let r = rules.get(name); r; r = r.parent ? rules.get(r.parent) : undefined) if (r.slide) d = add(d, UNIT[`+${r.axis}`], r.slide);
      return d;
    };
    if (spec.parts.some(p => p.slide)) {
      const up = visiblePixels(cad.map(it => {
        const d = slideOf(it.part);
        if (!d.some(Boolean)) return it;
        const P = Float32Array.from(it.P, (v, i) => v + d[i % 3]);
        return { ...it, P, min: it.min.map((v, k) => v + d[k]), max: it.max.map((v, k) => v + d[k]) };
      }));
      up.forEach((n, i) => (seen[i] = Math.max(seen[i], n)));
    }
    let hidden = 0, faint = 0;
    cad.forEach((it, n) => {
      if (seen[n] === 0) {
        hidden += it.I.length / 3;
        it.part = null;
      } else if (seen[n] < 40) {
        const before = it.I.length / 3;
        Object.assign(it, simplifyPart(it, Math.max(DETAIL, 0.0012)));
        faint += before - it.I.length / 3;
      }
    });
    console.log(`hidden parts: ${hidden} triangles left out, ${faint} saved on barely visible ones`);
  }
  const kept = items.filter(it => it.part);
  if (process.env.STATS) {
    // The heaviest CAD parts, to see where the triangles go.
    const heavy = new Map();
    for (const it of kept) {
      if (it.gen) continue;
      const key = `${it.part} · ${it.names[Math.max(0, it.names.length - 2)]}`;
      heavy.set(key, (heavy.get(key) ?? 0) + it.I.length / 3);
    }
    for (const [k, n] of [...heavy].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.STATS) || 25)) console.log(`    ${String(n).padStart(7)}  ${k}`);
  }
  // Footprint center to the origin, wheels on the floor (computed in game orientation, from the
  // CAD parts, rebuilt wheels included as they were).
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const it of items) {
    if (it.gen) continue;
    for (const corner of [it.min, it.max]) {
      const p = rot(corner);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  const toGame = p => rot(p).map((v, k) => v + offset[k]);

  console.log(`size (forward × height × side): ${max.map((v, k) => (v - min[k]).toFixed(3)).join(' × ')} m`);
  for (const [file, detail, segments] of [[output, DETAIL, 16], [lowOutput, LOW_DETAIL, 10]]) {
    if (!file) continue;
    // The lighter model, seen from afar, also leaves out the smallest parts.
    const parts = kept.filter(it => detail === DETAIL || it.gen || it.size >= (spec.lowDropSmallerThan ?? 0.02)).map(it => {
      if (!it.gen) return detail === DETAIL ? it : { ...it, ...simplifyPart(it, detail) };
      const g = mecanumWheel({ ...it.gen.params, segments })[it.gen.key];
      return { ...it, P: Float32Array.from(g.P), I: Uint32Array.from(g.I) };
    });
    await write(file, parts, toGame, rules);
  }
  console.log(`${total} source triangles (${dropped} in tiny parts dropped)`);
}

// ---- writing the game model ------------------------------------------------------------------

async function write(file, parts, toGame, rules) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const root = doc.createNode('robot');
  doc.createScene('robot').addChild(root);
  const pivots = { body: [0, 0, 0] };
  const nodes = { body: doc.createNode('body') };
  root.addChild(nodes.body);
  for (const part of spec.parts) {
    pivots[part.name] = toGame(part.pivot);
    nodes[part.name] = doc.createNode(part.name).setExtras({
      spin: gameAxis(part.axis),
      ...(part.reverse ? { reverse: true } : {}),
      ...(part.slide ? { slide: part.slide } : {}),
      ...(part.swing ? { swing: part.swing } : {}),
    });
  }
  const turns = {};
  for (const part of spec.parts) {
    const parent = part.parent ?? 'body';
    // Node origin = pivot, expressed relative to the parent's pivot.
    const at = pivots[part.name].map((v, k) => v - pivots[parent][k]);
    const into = parent === 'body' ? root : nodes[parent];
    const q = axleTurn(part);
    if (!q) {
      nodes[part.name].setTranslation(at);
      into.addChild(nodes[part.name]);
      continue;
    }
    if (spec.parts.some(p => p.parent === part.name)) throw new Error(`${part.name}: a part turned onto its axle can't carry other parts`);
    // Held at its axle's angle by a still node; the part itself spins about its own named axis.
    turns[part.name] = [-q[0], -q[1], -q[2], q[3]];
    const holder = doc.createNode(`${part.name}_axle`).setTranslation(at).setRotation(q);
    into.addChild(holder);
    holder.addChild(nodes[part.name]);
  }

  // One mesh per part, color and finish.
  const groups = new Map();
  for (const it of parts) {
    const key = `${it.part}|${it.color.map(v => v.toFixed(3)).join(',')}|${it.rubber}|${it.clear ?? ''}`;
    if (!groups.has(key)) groups.set(key, { part: it.part, color: it.color, rubber: it.rubber, clear: it.clear, list: [] });
    groups.get(key).list.push(it);
  }
  let triangles = 0;
  const perPart = {};
  for (const g of groups.values()) {
    const pivot = pivots[g.part];
    const back = turns[g.part];
    const count = g.list.reduce((n, it) => n + it.P.length / 3, 0);
    const P = new Float32Array(count * 3);
    const I = new Uint32Array(g.list.reduce((n, it) => n + it.I.length, 0));
    let v = 0, t = 0;
    for (const it of g.list) {
      for (let i = 0; i < it.P.length; i += 3) {
        const p = toGame([it.P[i], it.P[i + 1], it.P[i + 2]]);
        const local = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
        P.set(back ? turn(back, local) : local, (v + i / 3) * 3);
      }
      for (let i = 0; i < it.I.length; i++) I[t + i] = it.I[i] + v;
      v += it.P.length / 3;
      t += it.I.length;
    }
    triangles += I.length / 3;
    perPart[g.part] = (perPart[g.part] ?? 0) + I.length / 3;
    const { metal, rough } = surface(g.color, g.rubber);
    const material = doc.createMaterial().setMetallicFactor(metal).setRoughnessFactor(rough);
    if (g.clear) material.setBaseColorFactor([...g.color.slice(0, 3), g.clear]).setAlphaMode('BLEND');
    else material.setBaseColorFactor(g.color);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(I).setBuffer(buffer))
      .setMaterial(material);
    nodes[g.part].addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  }
  await doc.transform(weld({ tolerance: 0.00005 }), prune({ keepLeaves: true }), quantize());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(file, doc);
  console.log(`${path.basename(file)}: ${triangles} triangles, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  for (const part of spec.parts) {
    console.log(`  ${part.name.padEnd(15)} pivot ${pivots[part.name].map(x => x.toFixed(3)).join(', ')}  spin ${gameAxis(part.axis)}${rules.get(part.name).reverse ? ' reverse' : ''}  ${perPart[part.name] ?? 0} triangles`);
  }
  console.log(`  ${'body'.padEnd(15)} ${perPart.body ?? 0} triangles`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
