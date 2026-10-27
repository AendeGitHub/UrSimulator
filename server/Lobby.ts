// All rooms on the server, and routing of client messages to them.

import { CODE_LETTERS, normalizeCode, type ClientMessage, type RoomFormat } from '../src/net/protocol';
import { DEFAULT_ROBOT_ID, robotById } from '../src/robot/robots';
import { cleanRules, type RuleOptions } from '../src/sim/Referee';
import { SLOTS, type GameMode, type RobotInput, type Slot } from '../src/sim/types';
import type { Peer } from './Room';

/** When nothing sets a limit (tests); the server takes its limit from RoomPool. */
const MAX_ROOMS = 40;

/** What the lobby needs from a room: a Room in this thread (tests) or a room in a worker thread (RoomPool). */
export interface LobbyRoom {
  readonly code: string;
  readonly size: number;
  join(id: number, name: string, robot: string, peer: Peer): boolean;
  leave(id: number): void;
  setSlot(id: number, slot: Slot | null): void;
  start(id: number, mode: GameMode, rules: RuleOptions): void;
  stop(id: number): void;
  input(id: number, input: RobotInput): void;
  /** Advances a room in this thread; rooms in a worker thread are advanced there. */
  tick(dt: number): void;
  dispose(): void;
}

export type RoomFactory = (code: string, format: RoomFormat) => LobbyRoom;

export function randomCode(taken: (code: string) => boolean): string {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
    if (!taken(code)) return code;
  }
}

interface Client {
  id: number;
  name: string;
  robot: string;
  peer: Peer;
  room: LobbyRoom | null;
}

export class Lobby {
  private readonly rooms = new Map<string, LobbyRoom>();
  private readonly clients = new Map<number, Client>();
  private nextId = 1;

  constructor(private readonly createRoom: RoomFactory, private readonly maxRooms = MAX_ROOMS) {}

  connect(peer: Peer): number {
    const id = this.nextId++;
    this.clients.set(id, { id, name: 'Игрок', robot: DEFAULT_ROBOT_ID, peer, room: null });
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
        c.robot = robotById(typeof msg.robot === 'string' ? msg.robot : undefined).id;
        break;
      case 'create': {
        if (this.rooms.size >= this.maxRooms) return c.peer.sendText({ t: 'error', code: 'serverFull', message: 'Сервер заполнен, попробуй позже' });
        this.leaveRoom(id);
        const code = randomCode(code => this.rooms.has(code));
        const room = this.createRoom(code, msg.format === '1v1' ? '1v1' : '2v2');
        this.rooms.set(code, room);
        this.enter(c, room);
        break;
      }
      case 'join': {
        const room = this.rooms.get(normalizeCode(String(msg.code ?? '')));
        if (!room) return c.peer.sendText({ t: 'error', code: 'noRoom', message: 'Комната с таким кодом не найдена' });
        if (c.room === room) return;
        this.leaveRoom(id);
        this.enter(c, room);
        break;
      }
      case 'slot':
        if (msg.slot === null || SLOTS.includes(msg.slot)) c.room?.setSlot(id, msg.slot);
        break;
      case 'start':
        if (msg.mode === 'match' || msg.mode === 'practice') c.room?.start(id, msg.mode, cleanRules(msg.rules));
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

  private enter(c: Client, room: LobbyRoom): void {
    if (!room.join(c.id, c.name, c.robot, c.peer)) return c.peer.sendText({ t: 'error', code: 'roomFull', message: 'Комната заполнена (4 игрока)' });
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

  /** A room that broke (its worker thread failed): its players go back to the menu. */
  closeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const c of this.clients.values()) {
      if (c.room !== room) continue;
      c.room = null;
      c.peer.sendText({ t: 'room', room: null });
    }
    room.dispose();
    this.rooms.delete(code);
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
    armUp: flag(raw.armUp),
    armDown: flag(raw.armDown),
  };
}
