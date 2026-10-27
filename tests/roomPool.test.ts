import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Lobby } from '../server/Lobby';
import type { Peer } from '../server/Room';
import { RoomPool } from '../server/RoomPool';
import type { FieldLayout } from '../src/field/layout';
import type { RoomInfo, ServerMessage } from '../src/net/protocol';
import { decodeState, type WorldState } from '../src/sim/state';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;

class FakePeer implements Peer {
  readonly messages: ServerMessage[] = [];
  readonly snapshots: WorldState[] = [];
  sendText(msg: ServerMessage) {
    this.messages.push(msg);
  }
  sendBinary(data: ArrayBuffer) {
    this.snapshots.push(decodeState(data));
  }
  get room(): RoomInfo | null {
    const last = [...this.messages].reverse().find(m => m.t === 'room');
    return last && last.t === 'room' ? last.room : null;
  }
}

/** The rooms run in other threads, so the tests wait for their answers in real time. */
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

describe('rooms in worker threads', () => {
  let dir: string;
  let pool: RoomPool;
  let lobby: Lobby;

  const connect = (name: string) => {
    const peer = new FakePeer();
    const id = lobby.connect(peer);
    lobby.handle(id, { t: 'hello', name });
    return { id, peer };
  };

  beforeAll(async () => {
    // The same bundle that npm run build:server makes
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-workers-'));
    await build({
      entryPoints: ['server/roomWorker.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outfile: path.join(dir, 'roomWorker.mjs'),
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      logLevel: 'silent',
    });
    pool = new RoomPool(pathToFileURL(path.join(dir, 'roomWorker.mjs')), 2, { layout, colliders }, code => lobby.closeRoom(code));
    await pool.ready();
    lobby = new Lobby(pool.create, pool.maxRooms);
  }, 30_000);

  afterAll(async () => {
    await pool?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts new rooms on the least busy worker and plays a match there', async () => {
    const red = connect('Red');
    lobby.handle(red.id, { t: 'create' });
    const other = connect('Other');
    lobby.handle(other.id, { t: 'create', format: '1v1' });
    expect(pool.load).toEqual([1, 1]);
    expect(pool.maxRooms).toBe(12);

    await waitFor(() => expect(red.peer.room?.code).toMatch(/^[A-Z]{4}$/));
    const blue = connect('Blue');
    lobby.handle(blue.id, { t: 'join', code: red.peer.room!.code });
    await waitFor(() => expect(red.peer.room?.players.map(p => [p.name, p.slot])).toEqual([['Red', 'red1'], ['Blue', 'blue1']]));
    expect(other.peer.room!.players.map(p => p.name)).toEqual(['Other']);

    lobby.handle(red.id, { t: 'start', mode: 'match' });
    await waitFor(() => expect(blue.peer.snapshots.at(-1)?.robots.map(r => r.slot)).toEqual(['red1', 'blue1']));
    const blueX0 = blue.peer.snapshots.at(-1)!.robots[1].x;
    // Blue drives "up" (field-centric: away from the blue drivers, toward -X).
    lobby.handle(blue.id, { t: 'input', input: { ...idleInput(), ly: -1 } });
    await waitFor(() => expect(red.peer.snapshots.at(-1)!.robots[1].x).toBeLessThan(blueX0 - 0.3));
    // The other room was not started, so it sends no snapshots.
    expect(other.peer.snapshots).toHaveLength(0);

    for (const p of [red, blue, other]) lobby.handle(p.id, { t: 'leave' });
    expect(pool.load).toEqual([0, 0]);
    expect(lobby.roomCount).toBe(0);
  });

  it('sends the players of a stopped worker back to the menu and starts a new worker', async () => {
    const host = connect('Host');
    lobby.handle(host.id, { t: 'create' });
    await waitFor(() => expect(host.peer.room).not.toBeNull());
    const busy = pool.load.indexOf(1);
    const { threads } = pool as unknown as { threads: { worker: Worker }[] };

    await threads[busy].worker.terminate();
    await waitFor(() => expect(host.peer.room).toBeNull());
    expect(lobby.roomCount).toBe(0);
    expect(pool.load).toEqual([0, 0]);

    // The replacement worker takes new rooms.
    lobby.handle(host.id, { t: 'create' });
    await waitFor(() => expect(host.peer.room?.players.map(p => p.name)).toEqual(['Host']));
    lobby.handle(host.id, { t: 'leave' });
  });
});
