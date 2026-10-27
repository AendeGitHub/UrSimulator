// A worker thread that simulates the online rooms RoomPool gives it, on its own CPU core.

import { parentPort, workerData } from 'node:worker_threads';
import { SNAPSHOT_RATE, type ServerMessage } from '../src/net/protocol';
import { parseColliders } from '../src/sim/colliders';
import { initPhysics } from '../src/sim/Simulation';
import { Room, type Peer } from './Room';
import type { FromWorker, Outgoing, RoomWorkerData, ToWorker } from './RoomPool';

// Each wake-up costs CPU, and a free server only gets about 10 ms of it per 100 ms: waking every
// 4 ms used that up early and froze the room for the rest of each 100 ms (snapshots in bursts).
const TICK_MS = 15;

const port = parentPort!;
const data = workerData as RoomWorkerData;
await initPhysics();
const colliders = parseColliders(data.colliders);
const rooms = new Map<string, Room>();

// Messages go out in one batch per tick or command: a snapshot sent to four players is copied once.
let outbox: Outgoing[] = [];

function flush(): void {
  port.postMessage({ t: 'out', out: outbox } satisfies FromWorker);
  outbox = [];
}

function send(code: string, id: number, msg: ServerMessage | ArrayBuffer): void {
  if (!outbox.length) queueMicrotask(flush);
  outbox.push([code, id, msg]);
}

function peer(code: string, id: number): Peer {
  return { sendText: msg => send(code, id, msg), sendBinary: data => send(code, id, data) };
}

/** A room that throws is closed alone, so the other rooms on this worker play on. */
function withRoom(code: string, action: (room: Room) => void): void {
  const room = rooms.get(code);
  if (!room) return;
  try {
    action(room);
  } catch (err) {
    console.error(`Room ${code} failed:`, err);
    rooms.delete(code);
    try {
      room.dispose();
    } catch {
      // Its physics may be what broke.
    }
    port.postMessage({ t: 'closed', code } satisfies FromWorker);
  }
}

port.on('message', (msg: ToWorker) => {
  switch (msg.t) {
    case 'create':
      rooms.set(msg.code, new Room(msg.code, data.layout, colliders, 1 / SNAPSHOT_RATE, msg.format));
      break;
    case 'dispose':
      withRoom(msg.code, room => {
        rooms.delete(msg.code);
        room.dispose();
      });
      break;
    case 'join':
      withRoom(msg.code, room => room.join(msg.id, msg.name, msg.robot, peer(msg.code, msg.id)));
      break;
    case 'leave':
      withRoom(msg.code, room => room.leave(msg.id));
      break;
    case 'slot':
      withRoom(msg.code, room => room.setSlot(msg.id, msg.slot));
      break;
    case 'start':
      withRoom(msg.code, room => room.start(msg.id, msg.mode, msg.rules));
      break;
    case 'stop':
      withRoom(msg.code, room => room.stop(msg.id));
      break;
    case 'input':
      withRoom(msg.code, room => room.input(msg.id, msg.input));
      break;
  }
});

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  for (const code of rooms.keys()) withRoom(code, room => room.tick(dt));
}, TICK_MS);

port.postMessage({ t: 'ready' } satisfies FromWorker);
