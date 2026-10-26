// Turns a robot CAD export into a light game model.
//
// Step 1 (STEP → GLB, native OpenCASCADE; needs `pip install cascadio==0.1.1 numpy`):
//   python3 -c "import cascadio; cascadio.step_to_glb('Robot/Uran 92 V1/Jedi92.stp', 'robot-raw.glb', tol_linear=0.4, tol_angular=0.6, include_materials=True)"
// Step 2 (this script):
//   node tools/convert-robot.mjs robot-raw.glb public/assets/robots/uran-v1.glb --forward=+z
//
// The output faces +X (game "forward"), stands on y = 0, is centered on its footprint,
// has one mesh per color and is simplified for real-time rendering. It has no normals:
// CAD normals split every face into its own island, which blocks simplification, so the
// game computes creased normals when it loads the model.

import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, quantize, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [input, output, ...flags] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node tools/convert-robot.mjs <raw.glb> <out.glb> [--forward=+z|-z|+x|-x] [--triangles=150000]');
  process.exit(1);
}
const option = (name, fallback) => flags.find(f => f.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const forward = option('forward', '+z');
const targetTriangles = Number(option('triangles', 150000));

/** Yaw that turns the CAD's forward axis onto +X. */
const YAW = { '+z': Math.PI / 2, '-z': -Math.PI / 2, '+x': 0, '-x': Math.PI }[forward];
if (YAW === undefined) throw new Error(`--forward must be +z, -z, +x or -x`);

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, [x, y, z], w = 1) => [
  m[0] * x + m[4] * y + m[8] * z + m[12] * w,
  m[1] * x + m[5] * y + m[9] * z + m[13] * w,
  m[2] * x + m[6] * y + m[10] * z + m[14] * w,
];

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const src = await io.read(input);
  const yawM = [Math.cos(YAW), 0, -Math.sin(YAW), 0, 0, 1, 0, 0, Math.sin(YAW), 0, Math.cos(YAW), 0, 0, 0, 0, 1];

  // Gather every triangle in world space, grouped by color.
  const groups = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of src.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = mul(yawM, node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const color = mat ? mat.getBaseColorFactor() : [0.6, 0.6, 0.6, 1];
      const metal = mat ? mat.getMetallicFactor() : 0;
      const rough = mat ? mat.getRoughnessFactor() : 0.6;
      const key = [...color, metal, rough].map(v => v.toFixed(3)).join(',');
      if (!groups.has(key)) groups.set(key, { color, metal, rough, pos: [], idx: [] });
      const g = groups.get(key);
      const pos = prim.getAttribute('POSITION');
      const base = g.pos.length / 3;
      const el = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const p = apply(m, pos.getElement(i, el));
        g.pos.push(...p);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
      const ind = prim.getIndices();
      if (ind) for (let i = 0; i < ind.getCount(); i++) g.idx.push(base + ind.getScalar(i));
      else for (let i = 0; i < pos.getCount(); i++) g.idx.push(base + i);
    }
  }
  // Footprint center to the origin, wheels on the floor.
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('robot');
  const root = doc.createNode('robot');
  scene.addChild(root);
  let triangles = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) g.pos[i + k] += offset[k];
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buffer))
      .setMaterial(doc.createMaterial().setBaseColorFactor(g.color).setMetallicFactor(g.metal).setRoughnessFactor(g.rough));
    root.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
    triangles += g.idx.length / 3;
  }

  await MeshoptSimplifier.ready;
  const ratio = Math.min(1, targetTriangles / triangles);
  await doc.transform(weld({ tolerance: 0.0001 }), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: false }), prune(), quantize());
  const after = doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((t, p) => t + p.getIndices().getCount() / 3, 0), 0);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  await io.write(output, doc);
  const size = max.map((v, k) => v - min[k]);
  console.log(`${triangles} → ${after} triangles, ${groups.size} colors, ${(fs.statSync(output).size / 1e6).toFixed(1)} MB`);
  console.log(`size (forward × height × side): ${size[0].toFixed(3)} × ${size[1].toFixed(3)} × ${size[2].toFixed(3)} m`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
