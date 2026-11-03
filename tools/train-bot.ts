// Trains the AI driver's network (src/ai/policy.json):  npm run train:bot
//
// Imitation learning with DAgger. Round 0: the teacher (src/ai/teacher.ts) plays games and every
// decision is recorded with what it saw (src/ai/features.ts) and what it did. The network learns to
// map one to the other. Later rounds: the network drives (with fewer and fewer teacher decisions
// mixed in), the teacher still says what it would have done at every step, and those new examples
// — exactly the situations the network gets itself into — are added to the data before it trains
// again. Games run in parallel worker threads; the network trains here with Adam.
//
//   ROUNDS=6 EPISODES=56 EPOCHS=10 HIDDEN=128 WORKERS=7 npm run train:bot

import fs from 'node:fs';
import os from 'node:os';
import { ACTION_SIZE } from '../src/ai/action';
import type { EpisodeConfig, EpisodeResult } from '../src/ai/episode';
import { FEATURE_SIZE } from '../src/ai/features';
import { Mlp, type Layer, type MlpData } from '../src/ai/mlp';
import { ROBOTS } from '../src/robot/robots';
import { Pool } from './bot-pool';

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const ROUNDS = env('ROUNDS', 6);
const EPISODES = env('EPISODES', 56);
const EPOCHS = env('EPOCHS', 10);
const HIDDEN = env('HIDDEN', 128);
const WORKERS = env('WORKERS', Math.max(1, os.availableParallelism() - 1));
const EVAL_GAMES = env('EVAL', 21);
/** Teacher decisions mixed in per round: all of them first, then fewer and fewer */
const BETAS = [1, 0.5, 0.3, 0.2, 0.1, 0.1];
const OUT = new URL('../src/ai/policy.json', import.meta.url);

// ---- games ------------------------------------------------------------------

const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

/** A random game: full match or practice, either alliance, any robots, a teacher or idle opponent. */
function randomGame(beta: number): EpisodeConfig {
  const red = Math.random() < 0.5;
  const match = Math.random() < 0.65;
  return {
    mode: match ? 'match' : 'practice',
    seconds: match ? 170 : 90,
    bot: { slot: red ? 'red1' : 'blue1', robot: pick(ROBOTS).id },
    opponent: { slot: red ? 'blue1' : 'red1', robot: pick(ROBOTS).id, driver: Math.random() < 0.7 ? 'teacher' : 'idle' },
    beta,
    record: true,
  };
}

/** The same test games every round: full matches against the teacher and against an idle robot. */
const TEST_GAMES: EpisodeConfig[] = Array.from({ length: EVAL_GAMES }, (_, i) => ({
  mode: 'match',
  seconds: 170,
  bot: { slot: i % 2 ? 'red1' : 'blue1', robot: ROBOTS[i % ROBOTS.length].id },
  opponent: { slot: i % 2 ? 'blue1' : 'red1', robot: ROBOTS[(i + 1) % ROBOTS.length].id, driver: i % 4 < 2 ? 'teacher' : 'idle' },
  beta: 0,
  record: false,
}));

type TestResult = { score: number; opponent: number; tips: number; fouls: number; wins: number };

async function test(pool: Pool, net: MlpData | null): Promise<TestResult> {
  const results = await Promise.all(TEST_GAMES.map(cfg => pool.run({ ...cfg, beta: net ? 0 : 1 }, net)));
  const mean = (f: (r: EpisodeResult) => number) => results.reduce((s, r) => s + f(r), 0) / results.length;
  return {
    score: mean(r => r.score),
    opponent: mean(r => r.opponentScore),
    tips: mean(r => r.tips),
    fouls: mean(r => r.fouls),
    wins: results.filter(r => r.score > r.opponentScore).length / results.length,
  };
}

// ---- data -------------------------------------------------------------------

class Dataset {
  private readonly parts: EpisodeResult[] = [];
  count = 0;

  add(r: EpisodeResult): void {
    if (!r.samples) return;
    this.parts.push(r);
    this.count += r.samples;
  }

  arrays(): { x: Float32Array; y: Float32Array } {
    const x = new Float32Array(this.count * FEATURE_SIZE);
    const y = new Float32Array(this.count * ACTION_SIZE);
    let n = 0;
    for (const r of this.parts) {
      x.set(r.features, n * FEATURE_SIZE);
      y.set(r.labels, n * ACTION_SIZE);
      n += r.samples;
    }
    return { x, y };
  }
}

// ---- training ----------------------------------------------------------------

/** Loss weights: the three sticks (squared error), then intake, transfer, shooter, arm (cross-entropy). */
const WEIGHTS = [1, 1, 1, 0.5, 1.5, 0.5, 1];
const STICKS = 3;

function newNetwork(x: Float32Array, n: number): Mlp {
  const mean = new Float32Array(FEATURE_SIZE);
  const std = new Float32Array(FEATURE_SIZE);
  for (let i = 0; i < n; i++) for (let f = 0; f < FEATURE_SIZE; f++) mean[f] += x[i * FEATURE_SIZE + f] / n;
  for (let i = 0; i < n; i++) for (let f = 0; f < FEATURE_SIZE; f++) std[f] += (x[i * FEATURE_SIZE + f] - mean[f]) ** 2 / n;
  for (let f = 0; f < FEATURE_SIZE; f++) std[f] = Math.max(0.05, Math.sqrt(std[f]));
  const sizes = [FEATURE_SIZE, HIDDEN, HIDDEN, ACTION_SIZE];
  const layers: Layer[] = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const [inputs, outputs] = [sizes[l], sizes[l + 1]];
    const w = new Float32Array(inputs * outputs);
    // He initialization (Box–Muller normal)
    const scale = Math.sqrt(2 / inputs) * (l + 2 === sizes.length ? 0.3 : 1);
    for (let i = 0; i < w.length; i++) w[i] = scale * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    layers.push({ inputs, outputs, w, b: new Float32Array(outputs) });
  }
  return new Mlp(layers, mean, std);
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/** Minibatch Adam on the network in place; logs the validation loss and accuracy every epoch. */
function train(net: Mlp, x: Float32Array, y: Float32Array, n: number, epochs: number): void {
  const L = net.layers;
  const B = 256;
  const valid = Math.floor(n * 0.05);
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const trainIdx = order.subarray(valid);
  const validIdx = order.subarray(0, valid);
  // Activations per layer for one batch, and their gradients
  const acts = [new Float32Array(B * FEATURE_SIZE), ...L.map(l => new Float32Array(B * l.outputs))];
  const grads = L.map(l => new Float32Array(B * l.outputs));
  const gW = L.map(l => new Float32Array(l.w.length));
  const gB = L.map(l => new Float32Array(l.b.length));
  const adam = L.map(l => ({ mw: new Float32Array(l.w.length), vw: new Float32Array(l.w.length), mb: new Float32Array(l.b.length), vb: new Float32Array(l.b.length) }));
  let t = 0;

  const forward = (idx: Uint32Array, from: number, count: number) => {
    const a0 = acts[0];
    for (let s = 0; s < count; s++) {
      const row = idx[from + s] * FEATURE_SIZE;
      for (let f = 0; f < FEATURE_SIZE; f++) a0[s * FEATURE_SIZE + f] = (x[row + f] - net.mean[f]) / net.std[f];
    }
    L.forEach((layer, k) => {
      const input = acts[k];
      const out = acts[k + 1];
      const last = k === L.length - 1;
      const { w, b, inputs, outputs } = layer;
      for (let s = 0; s < count; s++) {
        const xi = s * inputs;
        for (let o = 0; o < outputs; o++) {
          let sum = b[o];
          const row = o * inputs;
          for (let i = 0; i < inputs; i++) sum += w[row + i] * input[xi + i];
          out[s * outputs + o] = last || sum > 0 ? sum : 0;
        }
      }
    });
  };

  /** Loss of the batch; with `grad` fills the output gradient. */
  const lossOf = (idx: Uint32Array, from: number, count: number, grad: Float32Array | null) => {
    const out = acts[L.length];
    let loss = 0;
    for (let s = 0; s < count; s++) {
      const row = idx[from + s] * ACTION_SIZE;
      for (let k = 0; k < ACTION_SIZE; k++) {
        const o = out[s * ACTION_SIZE + k];
        const target = y[row + k];
        let g: number;
        if (k < STICKS) {
          const p = Math.tanh(o);
          loss += WEIGHTS[k] * (p - target) ** 2;
          g = WEIGHTS[k] * 2 * (p - target) * (1 - p * p);
        } else {
          const p = sigmoid(o);
          loss -= WEIGHTS[k] * (target * Math.log(p + 1e-7) + (1 - target) * Math.log(1 - p + 1e-7));
          g = WEIGHTS[k] * (p - target);
        }
        if (grad) grad[s * ACTION_SIZE + k] = g / count;
      }
    }
    return loss / count;
  };

  const backward = (count: number) => {
    for (let k = L.length - 1; k >= 0; k--) {
      const { w, inputs, outputs } = L[k];
      const g = grads[k];
      const input = acts[k];
      gW[k].fill(0);
      gB[k].fill(0);
      for (let s = 0; s < count; s++) {
        for (let o = 0; o < outputs; o++) {
          const go = g[s * outputs + o];
          if (go === 0) continue;
          gB[k][o] += go;
          const row = o * inputs;
          const xi = s * inputs;
          for (let i = 0; i < inputs; i++) gW[k][row + i] += go * input[xi + i];
        }
      }
      if (k === 0) break;
      // Gradient into the layer below, through its ReLU.
      const below = grads[k - 1];
      for (let s = 0; s < count; s++) {
        for (let i = 0; i < inputs; i++) {
          if (input[s * inputs + i] <= 0) {
            below[s * inputs + i] = 0;
            continue;
          }
          let sum = 0;
          for (let o = 0; o < outputs; o++) sum += w[o * inputs + i] * g[s * outputs + o];
          below[s * inputs + i] = sum;
        }
      }
    }
  };

  const step = (lr: number) => {
    t++;
    const [b1, b2, eps] = [0.9, 0.999, 1e-8];
    const c1 = 1 - b1 ** t;
    const c2 = 1 - b2 ** t;
    L.forEach((layer, k) => {
      const a = adam[k];
      for (const [param, grad, m, v] of [[layer.w, gW[k], a.mw, a.vw], [layer.b, gB[k], a.mb, a.vb]] as const) {
        for (let i = 0; i < param.length; i++) {
          m[i] = b1 * m[i] + (1 - b1) * grad[i];
          v[i] = b2 * v[i] + (1 - b2) * grad[i] * grad[i];
          param[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
        }
      }
    });
  };

  const evaluate = () => {
    let loss = 0;
    let sticks = 0;
    const right = new Array(ACTION_SIZE - STICKS).fill(0);
    for (let from = 0; from < validIdx.length; from += B) {
      const count = Math.min(B, validIdx.length - from);
      forward(validIdx, from, count);
      loss += lossOf(validIdx, from, count, null) * count;
      const out = acts[L.length];
      for (let s = 0; s < count; s++) {
        const row = validIdx[from + s] * ACTION_SIZE;
        for (let k = 0; k < STICKS; k++) sticks += Math.abs(Math.tanh(out[s * ACTION_SIZE + k]) - y[row + k]) / STICKS;
        for (let k = STICKS; k < ACTION_SIZE; k++) if (out[s * ACTION_SIZE + k] > 0 === y[row + k] > 0.5) right[k - STICKS]++;
      }
    }
    return { loss: loss / validIdx.length, sticks: sticks / validIdx.length, buttons: right.map(r => r / validIdx.length) };
  };

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = trainIdx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]];
    }
    // Cosine learning rate from 2e-3 down to 1e-4 over the round
    const lr = 1e-4 + 0.5 * (2e-3 - 1e-4) * (1 + Math.cos((Math.PI * epoch) / epochs));
    let sum = 0;
    let batches = 0;
    const started = performance.now();
    for (let from = 0; from + B <= trainIdx.length; from += B) {
      forward(trainIdx, from, B);
      sum += lossOf(trainIdx, from, B, grads[L.length - 1]);
      backward(B);
      step(lr);
      batches++;
    }
    const v = evaluate();
    console.log(`  epoch ${epoch + 1}/${epochs}: train ${(sum / batches).toFixed(4)} · valid ${v.loss.toFixed(4)} · sticks off by ${v.sticks.toFixed(3)} · intake/transfer/shooter/arm right ${v.buttons.map(b => (b * 100).toFixed(1)).join(' / ')}% · ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
}

// ---- main ---------------------------------------------------------------------

const pool = new Pool(WORKERS);
const data = new Dataset();
const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(0)} s`;
const show = (r: TestResult) =>
  `${r.score.toFixed(1)} points (opponent ${r.opponent.toFixed(1)}), ${r.tips.toFixed(1)} tips, ${r.fouls.toFixed(2)} fouls, won ${(r.wins * 100).toFixed(0)}%`;

console.log(`Training the AI driver: ${ROUNDS} rounds × ${EPISODES} games, ${WORKERS} workers, ${FEATURE_SIZE} → ${HIDDEN} → ${HIDDEN} → ${ACTION_SIZE}`);
const teacher = await test(pool, null);
console.log(`Teacher in the test games: ${show(teacher)} · ${elapsed()}`);

let net: Mlp | null = null;
let best: { score: number; data: MlpData; round: number; examples: number; result: TestResult } | null = null;
for (let round = 0; round < ROUNDS; round++) {
  const beta = BETAS[Math.min(round, BETAS.length - 1)];
  const games = await Promise.all(Array.from({ length: EPISODES }, () => pool.run(randomGame(net ? beta : 1), net?.toData() ?? null)));
  for (const g of games) data.add(g);
  console.log(`Round ${round + 1}: ${games.length} games (teacher share ${net ? beta : 1}), ${data.count} examples · ${elapsed()}`);
  const { x, y } = data.arrays();
  net ??= newNetwork(x, data.count);
  train(net, x, y, data.count, EPOCHS);
  const result = await test(pool, net.toData());
  console.log(`Network in the test games: ${show(result)} · ${elapsed()}`);
  if (!best || result.score - 20 * result.fouls > best.score) best = { score: result.score - 20 * result.fouls, data: net.toData(), round: round + 1, examples: data.count, result };
}

await pool.close();
const policy = {
  about: 'AI driver for UrSim, trained by tools/train-bot.ts (imitation learning with DAgger from src/ai/teacher.ts)',
  trained: new Date().toISOString().slice(0, 10),
  round: best!.round,
  examples: best!.examples,
  test: { teacher, network: best!.result },
  net: best!.data,
};
fs.writeFileSync(OUT, `${JSON.stringify(policy, null, 1)}\n`);
console.log(`Saved round ${best!.round} to src/ai/policy.json · ${elapsed()}`);
