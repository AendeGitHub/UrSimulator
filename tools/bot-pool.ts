// Worker threads that play AI games (tools/bot-worker.ts) for training and comparing drivers.

import { Worker } from 'node:worker_threads';
import type { EpisodeConfig, EpisodeResult } from '../src/ai/episode';
import type { MlpData } from '../src/ai/mlp';

export class Pool {
  private readonly idle: Worker[] = [];
  private readonly queue: { cfg: EpisodeConfig; net: MlpData | null; done: (r: EpisodeResult) => void }[] = [];
  private readonly pending = new Map<number, (r: EpisodeResult) => void>();
  private nextId = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./bot-worker.mjs', import.meta.url));
      worker.on('message', ({ id, result }: { id: number; result: EpisodeResult }) => {
        this.pending.get(id)!(result);
        this.pending.delete(id);
        this.idle.push(worker);
        this.pump();
      });
      worker.on('error', err => {
        console.error(err);
        process.exit(1);
      });
      this.idle.push(worker);
    }
  }

  run(cfg: EpisodeConfig, net: MlpData | null): Promise<EpisodeResult> {
    return new Promise(done => {
      this.queue.push({ cfg, net, done });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, job.done);
      worker.postMessage({ id, cfg: job.cfg, net: job.net });
    }
  }

  close(): Promise<number[]> {
    return Promise.all(this.idle.map(w => w.terminate()));
  }
}
