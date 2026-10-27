// Measures a robot model's folding arm for ArmSpec.reach (src/robot/robots.ts): how far forward of
// the footprint center the arm's front reaches as it swings from raised to lowered.
//
//   node tools/arm-reach.mjs public/assets/robots/bumble-v.glb 1.85
//
// The model's arm node is lowered and turns about its pivot by (1 - progress) · upAngle when
// raised, the way RobotView animates it.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';

const [file, upAngle, nodeName = 'arm', steps = '10'] = process.argv.slice(2);
if (!file || !upAngle) {
  console.error('Usage: node tools/arm-reach.mjs <robot.glb> <upAngle rad> [node name] [steps]');
  process.exit(1);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
await doc.transform(dequantize());
const node = doc.getRoot().listNodes().find(n => n.getName() === nodeName);
if (!node) throw new Error(`no node "${nodeName}" in ${file}`);
const pivot = node.getWorldTranslation();
const axis = node.getExtras().spin;
if (axis !== 'z') throw new Error(`the arm should turn about the side axis (z), not ${axis}`);

// Arm vertices relative to the pivot, in the robot frame (forward x, up y).
const points = [];
const el = [];
for (const child of node.listChildren()) {
  const m = child.getMatrix();
  for (const prim of child.getMesh()?.listPrimitives() ?? []) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      const [x, y, z] = pos.getElement(i, el);
      points.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]]);
    }
  }
}

const reach = [];
for (let k = 0; k <= Number(steps); k++) {
  const angle = (1 - k / Number(steps)) * Number(upAngle);
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  let front = -Infinity;
  let low = Infinity;
  let high = -Infinity;
  for (const [x, y] of points) {
    front = Math.max(front, x * c - y * s + pivot[0]);
    low = Math.min(low, x * s + y * c + pivot[1]);
    high = Math.max(high, x * s + y * c + pivot[1]);
  }
  reach.push(Number(front.toFixed(3)));
  console.log(`progress ${(k / Number(steps)).toFixed(2)}: front ${front.toFixed(3)} m, height ${low.toFixed(3)}..${high.toFixed(3)} m`);
}
console.log(`pivot ${pivot.map(v => v.toFixed(3)).join(', ')}`);
console.log(`reach: [${reach.join(', ')}]`);
