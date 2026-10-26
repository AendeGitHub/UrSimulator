// Builds public/assets/field-colliders.bin — physics triangles for the hive frame, flowers and hives —
// from field.glb, so the browser and the game server use exactly the same collision shapes.
//
// Run with: npm run build:colliders  (also run by npm run convert:field)
//
// File layout: "URC1", u32 header length, JSON header (space-padded to 4 bytes), then per part a
// Float32Array of vertices and a Uint32Array of triangle indices at the offsets in the header.
// Hive parts are stored relative to their pivot axle; everything else in field coordinates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');

/** Simplification error relative to each part's size: physics needs less detail than rendering. */
const ERROR = { static: 0.004, hive: 0.002 };

function transform(m, [x, y, z]) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Merges vertices that share a position (render meshes split them by normal). */
function weld(positions, indices) {
  const map = new Map();
  const out = [];
  const remap = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const key = `${Math.round(positions[i * 3] * 1e4)},${Math.round(positions[i * 3 + 1] * 1e4)},${Math.round(positions[i * 3 + 2] * 1e4)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = out.length / 3;
      map.set(key, idx);
      out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = idx;
  }
  return { vertices: new Float32Array(out), indices: Uint32Array.from(indices, i => remap[i]) };
}

/** Keeps only the vertices the simplified triangles still use. */
function dropUnused(vertices, indices) {
  const remap = new Map();
  const out = [];
  const newIndices = Uint32Array.from(indices, i => {
    let j = remap.get(i);
    if (j === undefined) {
      j = out.length / 3;
      remap.set(i, j);
      out.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
    }
    return j;
  });
  return { vertices: new Float32Array(out), indices: newIndices };
}

async function main() {
  const layout = JSON.parse(fs.readFileSync(path.join(ASSETS, 'field-layout.json'), 'utf8'));
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path.join(ASSETS, 'field.glb'));
  await MeshoptSimplifier.ready;

  const parts = [];
  for (const node of doc.getRoot().listNodes()) {
    if (node.getExtras().collider !== 'trimesh' || !node.getMesh()) continue;
    const name = node.getName();
    const kind = name.startsWith('hive_') ? name : 'static';
    const pivot = kind === 'static' ? [0, 0, 0] : layout.hives[name.slice(5)].pivot;
    const m = node.getWorldMatrix();
    const pos = [];
    const idx = [];
    for (const prim of node.getMesh().listPrimitives()) {
      const attr = prim.getAttribute('POSITION');
      const base = pos.length / 3;
      const el = [];
      for (let i = 0; i < attr.getCount(); i++) {
        const [x, y, z] = transform(m, attr.getElement(i, el));
        pos.push(x - pivot[0], y - pivot[1], z - pivot[2]);
      }
      const ind = prim.getIndices();
      for (let i = 0; i < ind.getCount(); i++) idx.push(base + ind.getScalar(i));
    }
    const welded = weld(pos, idx);
    const error = kind === 'static' ? ERROR.static : ERROR.hive;
    const [simplified] = MeshoptSimplifier.simplify(welded.indices, welded.vertices, 3, 0, error, ['LockBorder']);
    const compact = dropUnused(welded.vertices, simplified);
    parts.push({ name, kind, ...compact });
    console.log(`${name.padEnd(10)} ${idx.length / 3} → ${simplified.length / 3} triangles`);
  }

  // Header with byte offsets relative to the start of the data block.
  let offset = 0;
  const header = {
    parts: parts.map(p => {
      const entry = { name: p.name, kind: p.kind, vertexOffset: offset, vertexCount: p.vertices.length };
      offset += p.vertices.byteLength;
      Object.assign(entry, { indexOffset: offset, indexCount: p.indices.length });
      offset += p.indices.byteLength;
      return entry;
    }),
  };
  let json = JSON.stringify(header);
  while ((8 + Buffer.byteLength(json)) % 4) json += ' ';
  const headerBytes = Buffer.from(json, 'utf8');
  const out = Buffer.alloc(8 + headerBytes.length + offset);
  out.write('URC1', 0, 'ascii');
  out.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(out, 8);
  let pos = 8 + headerBytes.length;
  for (const p of parts) {
    Buffer.from(p.vertices.buffer, p.vertices.byteOffset, p.vertices.byteLength).copy(out, pos);
    pos += p.vertices.byteLength;
    Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength).copy(out, pos);
    pos += p.indices.byteLength;
  }
  fs.writeFileSync(path.join(ASSETS, 'field-colliders.bin'), out);
  console.log(`Wrote field-colliders.bin (${(out.length / 1e6).toFixed(2)} MB)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
