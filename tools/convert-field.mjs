// Converts the official BIOBUZZ field STEP (Field/field-cad-step.step) into game assets:
//   public/assets/field.glb         — lightweight visual model, grouped into named nodes
//   public/assets/field-layout.json — positions of scoring elements, flowers, hives and tape
//
// Run with: npm run convert:field
//
// Coordinates (same as the CAD export): meters, Y up, origin at field center on the tile surface.
// Red alliance is at -X, blue at +X, the audience side is +Z.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup, quantize } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_FILE = path.join(ROOT, 'Field', 'field-cad-step.step');
const OUT_DIR = path.join(ROOT, 'public', 'assets');

// Hive pivot height above the tiles, from the Competition Manual (9.6.1: 43.95 in).
const HIVE_PIVOT_Y = 1.1163;

/** Tape whose center is farther than this from the field center is outside the walls. */
const OUTSIDE_FIELD = 1.81;

const FASTENER = /screw|nut\b|rivet|washer|quick release pin|bolt|cable tie|rivnut|plug|fastener|detent/i;

function classify(meshName, pathNames) {
  const p = pathNames.join(' / ');
  if (/Pollen/i.test(meshName)) return 'pollen';
  if (/Red Nectar/i.test(meshName)) return 'nectar_red';
  if (/Blue Nectar/i.test(meshName)) return 'nectar_blue';
  if (/Soft Tiles/i.test(p)) return 'skip'; // the game draws its own tile floor
  if (FASTENER.test(meshName)) return 'skip';
  if (/Gaffer Tape/i.test(meshName)) return 'tape';
  if (/Red Hive/i.test(p)) return 'hive_red';
  if (/Blue Hive/i.test(p)) return 'hive_blue';
  const flower = p.match(/Flower Assembly <(\d+)>/);
  if (flower) return `flower_${flower[1]}`;
  if (/Glass/i.test(meshName)) return 'glass';
  if (/Frame <\d+>/.test(p)) return 'frame';
  if (/Perimeter/i.test(p)) return 'perimeter';
  return 'misc';
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function bboxOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max };
}

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const center = b => b.min.map((v, k) => round((v + b.max[k]) / 2));

async function main() {
  console.log('Reading STEP (takes ~1–2 minutes)...');
  const occt = await occtimportjs();
  const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(STEP_FILE)), {
    linearUnit: 'meter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.0015,
    angularDeflection: 0.5,
  });
  if (!res.success) throw new Error('STEP import failed');
  console.log(`Imported ${res.meshes.length} meshes`);

  // Map every mesh to its assembly path.
  const meshPath = new Map();
  (function walk(node, names) {
    const here = [...names, node.name];
    for (const i of node.meshes) meshPath.set(i, here);
    for (const c of node.children) walk(c, here);
  })(res.root, []);

  const layout = { pollen: [], nectar: { red: [], blue: [] }, flowers: [], hives: {}, tape: [], wallInnerHalf: 0 };
  const groups = new Map(); // group -> Map(colorKey -> { color, parts: [] })
  const groupBoxes = new Map();
  let glassInner = Infinity;

  res.meshes.forEach((m, i) => {
    const kind = classify(m.name, meshPath.get(i) ?? []);
    const pos = m.attributes.position.array;
    const box = bboxOf(pos);
    if (kind === 'skip') return;
    if (kind === 'pollen') return void layout.pollen.push(center(box));
    if (kind === 'nectar_red') return void layout.nectar.red.push(center(box));
    if (kind === 'nectar_blue') return void layout.nectar.blue.push(center(box));
    if (kind === 'tape') {
      // Alliance-area tape lies outside the field; the game does not draw it.
      const [cx, , cz] = center(box);
      if (Math.abs(cx) > OUTSIDE_FIELD || Math.abs(cz) > OUTSIDE_FIELD) return;
      const color = /Red/i.test(m.name) ? 'red' : 'blue';
      layout.tape.push({ color, min: box.min.map(v => round(v)), max: box.max.map(v => round(v)) });
    }
    if (kind === 'glass') {
      // Thin axis of the panel gives the inner face of the perimeter wall.
      const thinX = box.max[0] - box.min[0] < box.max[2] - box.min[2];
      const inner = thinX ? Math.min(Math.abs(box.min[0]), Math.abs(box.max[0])) : Math.min(Math.abs(box.min[2]), Math.abs(box.max[2]));
      glassInner = Math.min(glassInner, inner);
    }

    const color = m.color ?? [0.6, 0.6, 0.6];
    const colorKey = color.map(c => c.toFixed(3)).join(',');
    if (!groups.has(kind)) groups.set(kind, new Map());
    const byColor = groups.get(kind);
    if (!byColor.has(colorKey)) byColor.set(colorKey, { color, parts: [] });
    byColor.get(colorKey).parts.push({ pos, nrm: m.attributes.normal?.array, idx: m.index.array });

    const gb = groupBoxes.get(kind) ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let k = 0; k < 3; k++) {
      gb.min[k] = Math.min(gb.min[k], box.min[k]);
      gb.max[k] = Math.max(gb.max[k], box.max[k]);
    }
    groupBoxes.set(kind, gb);
  });

  layout.wallInnerHalf = round(glassInner);
  for (const [kind, box] of groupBoxes) {
    if (kind.startsWith('flower_')) {
      layout.flowers.push({ name: kind, center: [center(box)[0], center(box)[2]], topY: round(box.max[1]), min: box.min.map(v => round(v)), max: box.max.map(v => round(v)) });
    }
    if (kind.startsWith('hive_')) {
      layout.hives[kind.slice(5)] = { pivot: [center(box)[0], HIVE_PIVOT_Y, 0], min: box.min.map(v => round(v)), max: box.max.map(v => round(v)) };
    }
  }
  layout.flowers.sort((a, b) => a.name.localeCompare(b.name));

  // Build the glTF document: one node per group, one primitive per color.
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('field');
  const materials = new Map();

  function materialFor(kind, color) {
    const key = `${kind === 'glass' ? 'glass' : kind === 'tape' ? 'tape' : 'solid'}|${color.join(',')}`;
    if (materials.has(key)) return materials.get(key);
    const lin = color.map(srgbToLinear);
    const grey = Math.abs(color[0] - color[1]) < 0.02 && Math.abs(color[1] - color[2]) < 0.02;
    const mat = doc.createMaterial(key).setBaseColorFactor([...lin, 1]).setDoubleSided(true);
    if (kind === 'glass') {
      mat.setBaseColorFactor([0.85, 0.9, 0.95, 0.18]).setAlphaMode('BLEND').setRoughnessFactor(0.08).setMetallicFactor(0);
    } else if (kind === 'tape') {
      mat.setRoughnessFactor(0.9).setMetallicFactor(0);
    } else if (grey && color[0] > 0.4) {
      mat.setRoughnessFactor(0.4).setMetallicFactor(0.7); // aluminum extrusions and sheet metal
    } else {
      mat.setRoughnessFactor(0.65).setMetallicFactor(0);
    }
    materials.set(key, mat);
    return mat;
  }

  for (const [kind, byColor] of groups) {
    const pivot = kind.startsWith('hive_') ? layout.hives[kind.slice(5)].pivot : [0, 0, 0];
    const lift = kind === 'tape' ? 0.0015 : 0; // keep tape above the floor to avoid z-fighting
    const mesh = doc.createMesh(kind);
    for (const { color, parts } of byColor.values()) {
      let vCount = 0, iCount = 0;
      for (const p of parts) { vCount += p.pos.length / 3; iCount += p.idx.length; }
      const P = new Float32Array(vCount * 3), N = new Float32Array(vCount * 3), I = new Uint32Array(iCount);
      let vo = 0, io = 0;
      for (const p of parts) {
        for (let j = 0; j < p.pos.length; j += 3) {
          P[vo * 3 + j] = p.pos[j] - pivot[0];
          P[vo * 3 + j + 1] = p.pos[j + 1] - pivot[1] + lift;
          P[vo * 3 + j + 2] = p.pos[j + 2] - pivot[2];
          if (p.nrm) { N[vo * 3 + j] = p.nrm[j]; N[vo * 3 + j + 1] = p.nrm[j + 1]; N[vo * 3 + j + 2] = p.nrm[j + 2]; }
        }
        for (let j = 0; j < p.idx.length; j++) I[io + j] = p.idx[j] + vo;
        vo += p.pos.length / 3;
        io += p.idx.length;
      }
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(N).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(I).setBuffer(buffer))
        .setMaterial(materialFor(kind, color));
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(kind).setMesh(mesh).setTranslation(pivot);
    if (kind === 'frame' || kind.startsWith('flower_')) node.setExtras({ collider: 'trimesh' });
    if (kind.startsWith('hive_')) node.setExtras({ collider: 'trimesh', pivot: 'x-axis' });
    scene.addChild(node);
  }

  await MeshoptSimplifier.ready;
  const countTris = () => doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((t, p) => t + p.getIndices().getCount() / 3, 0), 0);
  console.log(`Triangles before simplify: ${countTris()}`);
  await doc.transform(dedup(), weld({ tolerance: 0.0001 }), simplify({ simplifier: MeshoptSimplifier, ratio: 0, error: 0.0025, lockBorder: false }), prune(), quantize());
  console.log(`Triangles after simplify: ${countTris()}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(path.join(OUT_DIR, 'field.glb'), doc);
  fs.writeFileSync(path.join(OUT_DIR, 'field-layout.json'), JSON.stringify(layout, null, 2));
  const size = fs.statSync(path.join(OUT_DIR, 'field.glb')).size;
  console.log(`Wrote field.glb (${(size / 1e6).toFixed(1)} MB), field-layout.json: ${layout.pollen.length} pollen, ${layout.nectar.red.length}+${layout.nectar.blue.length} nectar, ${layout.flowers.length} flowers, wall inner half ${layout.wallInnerHalf} m`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
