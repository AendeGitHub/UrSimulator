// Makes a finished game model lighter: fewer triangles, same nodes and moving parts. For when the
// CAD isn't at hand to convert again (tools/convert-robot.mjs, tools/convert-field.mjs).
//
//   node tools/lighten-model.mjs <in.glb> <out.glb> <error> [only=node,node] [--drop-normals]
//
// `error` is how far (as a fraction of each mesh's size) a simplified surface may move:
// 0.005 is invisible, 0.02 starts to round off small details. `only` limits it to named nodes
// (or meshes under them, such as a robot's wheel_fl).
// --drop-normals removes stored normals first: flat-shaded CAD stores every triangle on its own
// vertices, which blocks simplification; the game then rebuilds creased normals on load.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const dropNormals = args.includes('--drop-normals');
const [input, output, errorArg, onlyArg] = args.filter(a => a !== '--drop-normals');
const error = Number(errorArg);
if (!input || !output || !(error > 0)) {
  console.error('Usage: node tools/lighten-model.mjs <in.glb> <out.glb> <error> [only=node,node]');
  process.exit(1);
}
const only = onlyArg?.startsWith('only=') ? new Set(onlyArg.slice(5).split(',')) : null;

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);

const triangles = () => doc.getRoot().listMeshes().reduce((n, mesh) =>
  n + mesh.listPrimitives().reduce((m, p) => m + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
const before = triangles();

if (dropNormals) for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) prim.setAttribute('NORMAL', null);
await doc.transform(weld({ tolerance: 0.00005 }));
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || (only && !only.has(node.getName()) && !only.has(node.getParentNode()?.getName() ?? ''))) continue;
  for (const prim of mesh.listPrimitives()) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: 0, error, lockBorder: false });
}

console.log(`${input}: ${Math.round(before)} → ${Math.round(triangles())} triangles`);
await io.write(output, doc);
