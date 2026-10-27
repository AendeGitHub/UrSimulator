// Turns a robot CAD export into a game model with moving parts.
//
// Step 1 (STEP → GLB, native OpenCASCADE; needs `pip install cascadio==0.1.1 numpy`):
//   python3 -c "import cascadio; cascadio.step_to_glb('Robots/Uran 92 V2/Jedi92.step', 'robot-raw.glb', tol_linear=0.8, tol_angular=0.45, include_materials=True)"
// Step 2 (this script, with the robot's part list):
//   node tools/convert-robot.mjs robot-raw.glb public/assets/robots/uran-v2.glb tools/robots/uran-v2.json
//
// The spec says which CAD axis points up ("up": +y or +z, Fusion exports either) and forward.
// The output faces +X (game "forward"), stands on y = 0 and is centered on its footprint.
// Moving parts (turret, flywheel, wheels, rollers) become separate nodes whose origin is their
// pivot; `extras.spin` names the game axis they turn around (and `extras.reverse` marks one that
// turns the other way, like the second wheel of a two-flywheel shooter). Everything else is one
// "body" node.
// Meshes carry no normals: CAD normals split every face into its own island, which blocks
// simplification, so the game computes creased normals when it loads the model.
// `drop` names CAD assemblies left out entirely (old parts kept in the file); a rule's `ancestor`
// may be a list when one moving part is spread over several CAD nodes.
// STEP exports lose transparency: `translucent` lists CAD colors (clear polycarbonate panels)
// that become see-through again, each with its opacity.

import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, quantize, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [input, output, specPath] = process.argv.slice(2);
if (!input || !output || !specPath) {
  console.error('Usage: node tools/convert-robot.mjs <raw.glb> <out.glb> <robot-spec.json>');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

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

const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function ancestors(node) {
  const names = [];
  for (let n = node; n; n = n.getParentNode()) names.push(n.getName());
  return names;
}

/** First part whose rule matches this CAD node, or "body". */
function classify(node, center) {
  const names = ancestors(node);
  // "fixed": parts that never turn even inside a moving part's zone, e.g. a drive belt that
  // wraps around a wheel's pulley.
  const lower = names.map(n => n.toLowerCase());
  if ((spec.fixed ?? []).some(f => lower.some(n => n.includes(f.toLowerCase())))) return 'body';
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

/** Plastics, aluminium and rubber read better with simple material guesses from their CAD color. */
function surface([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 0.12) return { metal: 0.1, rough: 0.55 };
  if (max - min < 0.06 && max > 0.3) return { metal: 0.75, rough: 0.32 };
  return { metal: 0.05, rough: 0.5 };
}

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const src = await io.read(input);

  // Collect triangles per (part, color) in CAD coordinates.
  const groups = new Map();
  let dropped = 0;
  let total = 0;
  for (const node of src.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const b = getBounds(node);
    const size = Math.max(...b.max.map((v, i) => v - b.min[i]));
    const tris = mesh.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0);
    total += tris;
    // Screws, nuts and pins add triangles but nothing visible at game distance.
    if (size < spec.dropSmallerThan || (spec.drop ?? []).some(d => ancestors(node).includes(d))) {
      dropped += tris;
      continue;
    }
    const center = b.min.map((v, i) => (v + b.max[i]) / 2);
    const part = classify(node, center);
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const color = mat ? mat.getBaseColorFactor() : [0.6, 0.6, 0.6, 1];
      const key = `${part}|${color.map(v => v.toFixed(3)).join(',')}`;
      if (!groups.has(key)) groups.set(key, { part, color, pos: [], idx: [] });
      const g = groups.get(key);
      const pos = prim.getAttribute('POSITION');
      const base = g.pos.length / 3;
      const el = [];
      for (let i = 0; i < pos.getCount(); i++) g.pos.push(...apply(m, pos.getElement(i, el)));
      const ind = prim.getIndices();
      if (ind) for (let i = 0; i < ind.getCount(); i++) g.idx.push(base + ind.getScalar(i));
    }
  }

  // Footprint center to the origin, wheels on the floor (computed in game orientation).
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups.values()) {
    for (let i = 0; i < g.pos.length; i += 3) {
      const p = rot([g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  const toGame = p => rot(p).map((v, k) => v + offset[k]);

  const doc = new Document();
  const buffer = doc.createBuffer();
  const root = doc.createNode('robot');
  doc.createScene('robot').addChild(root);
  const pivots = { body: [0, 0, 0] };
  const nodes = { body: doc.createNode('body') };
  root.addChild(nodes.body);
  for (const part of spec.parts) {
    pivots[part.name] = toGame(part.pivot);
    nodes[part.name] = doc.createNode(part.name).setExtras({ spin: gameAxis(part.axis), ...(part.reverse ? { reverse: true } : {}) });
  }
  for (const part of spec.parts) {
    const parent = part.parent ?? 'body';
    // Node origin = pivot, expressed relative to the parent's pivot.
    nodes[part.name].setTranslation(pivots[part.name].map((v, k) => v - pivots[parent][k]));
    (parent === 'body' ? root : nodes[parent]).addChild(nodes[part.name]);
  }

  for (const g of groups.values()) {
    const pivot = pivots[g.part];
    const P = new Float32Array(g.pos.length);
    for (let i = 0; i < g.pos.length; i += 3) {
      const p = toGame([g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
      P[i] = p[0] - pivot[0];
      P[i + 1] = p[1] - pivot[1];
      P[i + 2] = p[2] - pivot[2];
    }
    const { metal, rough } = surface(g.color);
    const clear = (spec.translucent ?? []).find(t => t.color.every((v, k) => Math.abs(v - g.color[k]) < 0.01));
    const material = doc.createMaterial().setMetallicFactor(metal).setRoughnessFactor(rough);
    if (clear) material.setBaseColorFactor([...g.color.slice(0, 3), clear.opacity]).setAlphaMode('BLEND');
    else material.setBaseColorFactor(g.color);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buffer))
      .setMaterial(material);
    nodes[g.part].addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  }

  await MeshoptSimplifier.ready;
  const ratio = Math.min(1, spec.triangles / (total - dropped));
  await doc.transform(weld({ tolerance: 0.00005 }), simplify({ simplifier: MeshoptSimplifier, ratio, error: spec.error ?? 0.004, lockBorder: false }), prune({ keepLeaves: true }), quantize());
  const after = doc.getRoot().listMeshes().reduce((t, m) => t + m.listPrimitives().reduce((u, p) => u + p.getIndices().getCount() / 3, 0), 0);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  await io.write(output, doc);
  console.log(`${total} triangles (${dropped} in tiny parts dropped) → ${after}, ${(fs.statSync(output).size / 1e6).toFixed(1)} MB`);
  console.log(`size (forward × height × side): ${max.map((v, k) => (v - min[k]).toFixed(3)).join(' × ')} m`);
  for (const part of spec.parts) {
    const n = [...groups.values()].filter(g => g.part === part.name).reduce((t, g) => t + g.idx.length / 3, 0);
    console.log(`  ${part.name.padEnd(15)} pivot ${pivots[part.name].map(v => v.toFixed(3)).join(', ')}  spin ${gameAxis(part.axis)}  ${n} source triangles`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
