// All rooms on the server, and routing of client messages to them.

import type { FieldLayout } from '../src/field/layout';
import { SNAPSHOT_RATE, normalizeCode, type ClientMessage } from '../src/net/protocol';
import type { ColliderPart } from '../src/sim/colliders';
import { SLOTS } from '../src/sim/types';
import { Room, randomCode, type Peer } from './Room';

/** Keeps one small server responsive (one full room uses about 4% of a CPU core). */
const MAX_ROOMS = 40;

interface Client {
  id: number;
  name: string;
  peer: Peer;
  room: Room | null;
}

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<number, Client>();
  private nextId = 1;

  constructor(private readonly layout: FieldLayout, private readonly colliders: ColliderPart[]) {}

  connect(peer: Peer): number {
    const id = this.nextId++;
    this.clients.set(id, { id, name: 'Игрок', peer, room: null });
    peer.sendText({ t: 'welcome', id });
    return id;
  }

  disconnect(id: number): void {
    this.leaveRoom(id);
    this.clients.delete(id);
  }

  handle(id: number, msg: ClientMessage): void {
    const c = this.clients.get(id);
    if (!c) return;
    switch (msg.t) {
      case 'hello':
        c.name = String(msg.name ?? '');
        break;
      case 'create': {
        if (this.rooms.size >= MAX_ROOMS) return c.peer.sendText({ t: 'error', message: 'Сервер заполнен, попробуй позже' });
        this.leaveRoom(id);
        const code = randomCode(code => this.rooms.has(code));
        const room = new Room(code, this.layout, this.colliders, 1 / SNAPSHOT_RATE);
        this.rooms.set(code, room);
        this.enter(c, room);
        break;
      }
      case 'join': {
        const room = this.rooms.get(normalizeCode(String(msg.code ?? '')));
        if (!room) return c.peer.sendText({ t: 'error', message: 'Комната с таким кодом не найдена' });
        if (c.room === room) return;
        this.leaveRoom(id);
        this.enter(c, room);
        break;
      }
      case 'slot':
        if (msg.slot === null || SLOTS.includes(msg.slot)) c.room?.setSlot(id, msg.slot);
        break;
      case 'start':
        if (msg.mode === 'match' || msg.mode === 'practice') c.room?.start(id, msg.mode);
        break;
      case 'stop':
        c.room?.stop(id);
        break;
      case 'input':
        if (msg.input && typeof msg.input === 'object') c.room?.input(id, sanitizeInput(msg.input));
        break;
      case 'leave':
        this.leaveRoom(id);
        c.peer.sendText({ t: 'room', room: null });
        break;
    }
  }

  private enter(c: Client, room: Room): void {
    if (!room.join(c.id, c.name, c.peer)) return c.peer.sendText({ t: 'error', message: 'Комната заполнена (4 игрока)' });
    c.room = room;
  }

  private leaveRoom(id: number): void {
    const c = this.clients.get(id);
    if (!c?.room) return;
    const room = c.room;
    room.leave(id);
    c.room = null;
    if (!room.size) {
      room.dispose();
      this.rooms.delete(room.code);
    }
  }

  tick(dt: number): void {
    for (const room of this.rooms.values()) room.tick(dt);
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}

/** Never trust numbers from the network: clamp sticks, coerce flags. */
function sanitizeInput(input: object) {
  const raw = input as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  const flag = (v: unknown) => v === true;
  return {
    lx: num(raw.lx),
    ly: num(raw.ly),
    rx: num(raw.rx),
    fieldCentric: flag(raw.fieldCentric),
    slow: flag(raw.slow),
    intake: flag(raw.intake),
    eject: flag(raw.eject),
    transfer: flag(raw.transfer),
    shooterOn: flag(raw.shooterOn),
    shooterOff: flag(raw.shooterOff),
    imuReset: flag(raw.imuReset),
  };
}
