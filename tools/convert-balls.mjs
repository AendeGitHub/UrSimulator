// POLLEN and NECTAR from the official game element CAD → public/assets/balls.glb.
//
//   node tools/convert-balls.mjs
//
// Each element is a perforated hollow plastic ball moulded in two halves; both halves are kept
// (outside, inside and the hole walls) so the holes look like holes. Both NECTAR files share one
// shape, so the output has two meshes: "pollen" and "nectar". Colours come from the game
// (yellow, red, blue), not from the CAD.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  pollen: 'Field/am-5851_yellow Pollen.STEP',
  nectar: 'Field/am-5852_red Red Alliance Nectar.STEP',
};
const OUTPUT = path.join(ROOT, 'public/assets/balls.glb');
/** Enough for round holes at game distance; the outlines draw their rims anyway. */
const TRIANGLES = 1500;

/** The whole ball from a STEP file, centred on the origin. */
function ball(occt, file) {
  const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(path.join(ROOT, file))), {
    linearUnit: 'meter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.002,
    angularDeflection: 0.3,
  });
  // Some CAD files are not modelled around the origin: centre on the bounding box.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of res.meshes) {
    const p = m.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
    }
  }
  const center = min.map((v, k) => (v + max[k]) / 2);
  const pos = [];
  const nor = [];
  const idx = [];
  for (const m of res.meshes) {
    const base = pos.length / 3;
    m.attributes.position.array.forEach((v, i) => pos.push(v - center[i % 3]));
    nor.push(...m.attributes.normal.array);
    for (const i of m.index.array) idx.push(base + i);
  }
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx: Uint32Array.from(idx), diameter: Math.max(...max.map((v, k) => v - min[k])) };
}

async function main() {
  const occt = await require('occt-import-js')();
  await MeshoptSimplifier.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('balls');
  for (const [name, file] of Object.entries(SOURCES)) {
    const { pos, nor, idx, diameter } = ball(occt, file);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
    console.log(`${name}: ${file} — ${(diameter * 1000).toFixed(1)} mm, ${idx.length / 3} triangles`);
  }
  await doc.transform(weld({ tolerance: 0.00002 }));
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: TRIANGLES / (prim.getIndices().getCount() / 3), error: 0.01 });
      console.log(`  ${mesh.getName()} → ${prim.getIndices().getCount() / 3} triangles`);
    }
  }
  await new NodeIO().write(OUTPUT, doc);
  console.log(`${path.relative(ROOT, OUTPUT)} ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
