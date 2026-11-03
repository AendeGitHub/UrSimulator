// Plays training and test games for tools/train-bot.ts and tools/bot-arena.ts, one at a time, in a
// worker thread.

import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import type { FieldLayout } from '../src/field/layout';
import { runEpisode, type EpisodeConfig } from '../src/ai/episode';
import { Mlp, type MlpData } from '../src/ai/mlp';
import { parseColliders } from '../src/sim/colliders';
import { initPhysics } from '../src/sim/Simulation';

const assets = new URL('../public/assets/', import.meta.url);
const layout: FieldLayout = JSON.parse(fs.readFileSync(new URL('field-layout.json', assets), 'utf8'));
const bin = fs.readFileSync(new URL('field-colliders.bin', assets));
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
await initPhysics();

let cached: { data: MlpData; net: Mlp } | null = null;

parentPort!.on('message', ({ id, cfg, net }: { id: number; cfg: EpisodeConfig; net: MlpData | null }) => {
  if (net && cached?.data !== net) cached = { data: net, net: Mlp.fromData(net) };
  const result = runEpisode(layout, colliders, cfg, net ? cached!.net : null);
  parentPort!.postMessage({ id, result }, [result.features.buffer, result.labels.buffer]);
});
