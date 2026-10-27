// Online rooms spread over worker threads, so a server uses all its CPU cores: each worker
// simulates its rooms (roomWorker.ts), while this thread keeps the WebSockets, lobby and records.

import { Worker } from 'node:worker_threads';
import type { FieldLayout } from '../src/field/layout';
import { MAX_PLAYERS, type RoomFormat, type ServerMessage } from '../src/net/protocol';
import type { RuleOptions } from '../src/sim/Referee';
import type { GameMode, RobotInput, Slot } from '../src/sim/types';
import type { LobbyRoom } from './Lobby';
import type { Peer } from './Room';

/**
 * A live 2 vs 2 match takes about 13% of a fast core (Apple M2) and 20–25% of a cloud one, so a
 * worker's core runs 4–5 of them at full speed; rooms waiting in the lobby or playing 1 vs 1 cost less.
 */
export const ROOMS_PER_WORKER = 6;

export interface RoomWorkerData {
  layout: FieldLayout;
  /** field-colliders.bin */
  colliders: ArrayBuffer;
}

export type ToWorker =
  | { t: 'create'; code: string; format: RoomFormat }
  | { t: 'dispose'; code: string }
  | { t: 'join'; code: string; id: number; name: string; robot: string }
  | { t: 'leave'; code: string; id: number }
  | { t: 'slot'; code: string; id: number; slot: Slot | null }
  | { t: 'start'; code: string; id: number; mode: GameMode; rules: RuleOptions }
  | { t: 'stop'; code: string; id: number }
  | { t: 'input'; code: string; id: number; input: RobotInput };

/** [room code, player id, a text message or a snapshot] */
export type Outgoing = [string, number, ServerMessage | ArrayBuffer];

export type FromWorker =
  | { t: 'ready' }
  // Everything the worker's rooms sent during one tick or one command, in one message.
  | { t: 'out'; out: Outgoing[] }
  // A room threw and the worker closed it; the worker's other rooms play on.
  | { t: 'closed'; code: string };

interface Thread {
  worker: Worker;
  rooms: Map<string, RemoteRoom>;
}

/** A room in a worker thread. Its players' connections stay here; the worker sends them messages through the pool. */
class RemoteRoom implements LobbyRoom {
  private readonly peers = new Map<number, Peer>();

  constructor(readonly code: string, private readonly thread: Thread) {}

  get size(): number {
    return this.peers.size;
  }

  private post(msg: ToWorker): void {
    this.thread.worker.postMessage(msg);
  }

  join(id: number, name: string, robot: string, peer: Peer): boolean {
    if (this.peers.size >= MAX_PLAYERS) return false;
    this.peers.set(id, peer);
    this.post({ t: 'join', code: this.code, id, name, robot });
    return true;
  }

  leave(id: number): void {
    if (this.peers.delete(id)) this.post({ t: 'leave', code: this.code, id });
  }

  setSlot(id: number, slot: Slot | null): void {
    this.post({ t: 'slot', code: this.code, id, slot });
  }

  start(id: number, mode: GameMode, rules: RuleOptions): void {
    this.post({ t: 'start', code: this.code, id, mode, rules });
  }

  stop(id: number): void {
    this.post({ t: 'stop', code: this.code, id });
  }

  input(id: number, input: RobotInput): void {
    this.post({ t: 'input', code: this.code, id, input });
  }

  tick(): void {}

  dispose(): void {
    if (this.thread.rooms.get(this.code) !== this) return;
    this.thread.rooms.delete(this.code);
    this.post({ t: 'dispose', code: this.code });
  }

  /** Players who left meanwhile get nothing. */
  deliver(id: number, msg: ServerMessage | ArrayBuffer): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (msg instanceof ArrayBuffer) peer.sendBinary(msg);
    else peer.sendText(msg);
  }
}

export class RoomPool {
  private readonly threads: Thread[] = [];
  private readonly started: Promise<void>[] = [];
  private closing = false;

  /**
   * @param url the worker script (roomWorker.ts, built to roomWorker.mjs)
   * @param closed called with the code of a room that broke; the lobby sends its players back
   */
  constructor(
    private readonly url: URL,
    count: number,
    private readonly data: RoomWorkerData,
    private readonly closed: (code: string) => void,
  ) {
    for (let i = 0; i < count; i++) {
      const thread: Thread = { worker: null!, rooms: new Map() };
      this.started.push(this.spawn(thread));
      this.threads.push(thread);
    }
  }

  /** Resolves once every worker has loaded the physics and the field. */
  async ready(): Promise<void> {
    await Promise.all(this.started);
  }

  get maxRooms(): number {
    return this.threads.length * ROOMS_PER_WORKER;
  }

  /** Rooms on each worker, for /health. */
  get load(): number[] {
    return this.threads.map(t => t.rooms.size);
  }

  /** A new room on the worker with the fewest rooms. */
  readonly create = (code: string, format: RoomFormat): LobbyRoom => {
    const thread = this.threads.reduce((best, t) => (t.rooms.size < best.rooms.size ? t : best));
    const room = new RemoteRoom(code, thread);
    thread.rooms.set(code, room);
    thread.worker.postMessage({ t: 'create', code, format } satisfies ToWorker);
    return room;
  };

  private spawn(thread: Thread): Promise<void> {
    const worker = new Worker(this.url, { workerData: this.data });
    thread.worker = worker;
    return new Promise((resolve, reject) => {
      let ready = false;
      worker.on('message', (msg: FromWorker) => {
        switch (msg.t) {
          case 'ready':
            ready = true;
            resolve();
            break;
          case 'out':
            for (const [code, id, payload] of msg.out) thread.rooms.get(code)?.deliver(id, payload);
            break;
          case 'closed':
            this.closed(msg.code);
            break;
        }
      });
      worker.on('error', err => console.error('Room worker failed:', err));
      worker.on('exit', code => {
        if (this.closing) return;
        if (!ready) {
          // A worker that cannot even start will not start next time either.
          reject(new Error(`Room worker stopped while starting (exit code ${code})`));
          return;
        }
        console.error(`Room worker stopped (exit code ${code}); closing ${thread.rooms.size} room(s) and starting a new worker`);
        const lost = [...thread.rooms.keys()];
        thread.rooms.clear();
        for (const room of lost) this.closed(room);
        this.spawn(thread).catch(err => {
          console.error(err);
          process.exit(1);
        });
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.threads.map(t => t.worker.terminate()));
  }
}
