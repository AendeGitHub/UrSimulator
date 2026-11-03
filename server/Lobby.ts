// Online rooms (src/net/lobbyProtocol.ts). The server keeps the room list and passes messages
// between players; the room's admin runs the match in their browser. Nothing here touches the
// physics, so a small server copes with many rooms.

import { cleanAiLevel, type AiLevel } from '../src/ai/level';
import { cleanStart, type StartPose } from '../src/field/startPose';
import { cleanScoreDisplay, type ScoreDisplay } from '../src/game/scoreDisplay';
import { cleanName } from '../src/net/records';
import { FORMAT_SLOTS, RELAY, isPassword, type ClientMessage, type LobbyError, type RoomFormat, type RoomInfo, type RoomSummary, type ServerMessage } from '../src/net/lobbyProtocol';
import { cleanBlueprint, withoutMesh, type Blueprint } from '../src/robot/custom';
import { ROBOTS } from '../src/robot/robots';
import { cleanRules, type RuleOptions } from '../src/sim/Referee';
import { SLOTS, slotAlliance, type GameMode, type Slot } from '../src/sim/types';
import type { GameRecord } from './Stats';

export const MAX_CLIENTS = 300;
export const MAX_ROOMS = 60;
const ROOM_ID_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Shorter practice in a room doesn't count as a game, s */
export const MIN_PRACTICE = 20;
const MAX_POINTS = 1500;
/** Quick play: with no open room and nobody else looking for this long, a player gets a room of their own to wait in, s */
export const QUICK_WAIT = 10;
/** A quick-play room with two players or more starts its match by itself this long after, s */
export const QUICK_START = 30;
/** …and gives someone who just came in at least this long to pick a robot, s */
export const QUICK_JOIN_TIME = 15;

/** A signed-in player, as the lobby needs them for the statistics. */
export interface LobbyAccount {
  id: string;
  name: string;
  username: string;
}

/** What the lobby needs from the rest of the server (nothing, in tests). */
export interface LobbyHooks {
  /** The account behind a session token */
  identify?(token: string): Promise<LobbyAccount | null>;
  /** A room's match or practice ended */
  game?(game: GameRecord): void;
}

/** A connected browser, as the lobby sees it. */
export interface LobbySocket {
  send(message: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

interface Member {
  id: number;
  name: string;
  robot: string;
  /** A robot the player made: its blueprint */
  custom?: Blueprint;
  slot: Slot | null;
  start: StartPose | null;
}

interface Room {
  id: string;
  format: RoomFormat;
  adminId: number;
  members: Member[];
  /** AI drivers by driver station: their robot */
  ai: Partial<Record<Slot, string>>;
  /** How well they drive */
  aiLevel: AiLevel;
  rules: RuleOptions;
  mode: GameMode;
  scoreDisplay: ScoreDisplay;
  password: string | null;
  /** Made by quick play (lobbyProtocol.ts RoomSummary.quick) */
  quick: boolean;
  /** When a quick-play room starts its match by itself, ms (null: not enough players) */
  autoStartAt: number | null;
  running: boolean;
  /** When the game being played started, ms */
  startedAt: number;
  /** The admin already sent this match's result */
  reported: boolean;
}

interface Client {
  id: number;
  name: string;
  socket: LobbySocket;
  room: Room | null;
  /** The browser, and the signed-in player (from the hello) */
  device: string | null;
  account: LobbyAccount | null;
}

/** A player waiting for quick play to find them a room. */
interface Search {
  /** Since when, ms */
  since: number;
  robot: PlayerRobot;
  start: StartPose | null;
}

const isRobot = (id: unknown): id is string => typeof id === 'string' && ROBOTS.some(r => r.id === id);

/** A player's robot: a team's, or one they made with its blueprint (checked and cleaned). */
type PlayerRobot = { robot: string; custom?: Blueprint };

function playerRobot(robot: unknown, custom: unknown): PlayerRobot {
  if (isRobot(robot)) return { robot };
  const blueprint = typeof robot === 'string' && /^custom-[a-z0-9]{4,16}$/.test(robot) ? cleanBlueprint(custom) : null;
  // Their own 3D model stays on their computer: everyone else sees the blocks.
  return blueprint ? { robot: robot as string, custom: withoutMesh(blueprint) } : { robot: ROBOTS[0].id };
}

export class Lobby {
  private readonly clients = new Map<number, Client>();
  private readonly rooms = new Map<string, Room>();
  /** Quick play: players looking for a room, by client id */
  private readonly searching = new Map<number, Search>();
  private nextId = 1;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly hooks: LobbyHooks = {},
    private readonly now: () => number = Date.now,
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** A new browser; null when the server is full. */
  connect(socket: LobbySocket): number | null {
    if (this.clients.size >= MAX_CLIENTS) {
      socket.send({ t: 'error', code: 'serverFull' });
      return null;
    }
    const id = this.nextId++;
    this.clients.set(id, { id, name: cleanName(''), socket, room: null, device: null, account: null });
    socket.send({ t: 'welcome', id });
    socket.send({ t: 'rooms', rooms: this.summaries() });
    return id;
  }

  disconnect(id: number): void {
    this.searching.delete(id);
    this.leave(id);
    this.clients.delete(id);
  }

  /** Every second: quick play places the players looking for a game and starts its rooms' matches. */
  tick(): void {
    this.matchmake();
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.running || room.autoStartAt === null || now < room.autoStartAt) continue;
      this.begin(room);
      this.changed(room);
    }
  }

  message(id: number, msg: ClientMessage): void {
    const c = this.clients.get(id);
    if (!c || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        if (typeof msg.name === 'string') c.name = cleanName(msg.name);
        if (typeof msg.device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.device)) c.device = msg.device;
        if (typeof msg.token === 'string' && this.hooks.identify) {
          this.hooks.identify(msg.token).then(account => {
            if (this.clients.get(id) === c) c.account = account;
          }, () => undefined);
        } else if (msg.token === null) {
          c.account = null;
        }
        return;
      case 'create':
        this.searching.delete(id);
        return this.create(c, msg.format, playerRobot(msg.robot, msg.custom), msg.start, msg.rules, msg.scoreDisplay, msg.aiLevel);
      case 'join':
        this.searching.delete(id);
        return this.join(c, msg.room, playerRobot(msg.robot, msg.custom), msg.start, msg.password);
      case 'leave':
        return this.leave(id);
      case 'quick':
        return this.quick(c, playerRobot(msg.robot, msg.custom), msg.start);
      case 'quickCancel':
        if (this.searching.delete(id)) c.socket.send({ t: 'quick', searching: false });
        return;
      case 'slot':
        return this.takeSlot(c, msg.slot);
      case 'robot':
        return this.changeRobot(c, msg.robot, msg.custom, msg.start);
      case 'lock':
        return this.admin(c, room => {
          if (msg.password !== null && !isPassword(msg.password)) return;
          room.password = msg.password;
        });
      case 'ai':
        return this.admin(c, room => {
          if (room.running || !FORMAT_SLOTS[room.format].includes(msg.slot)) return;
          // A player's station stays theirs.
          if (room.members.some(m => m.slot === msg.slot)) return;
          if (msg.robot === null) delete room.ai[msg.slot];
          else if (isRobot(msg.robot)) room.ai[msg.slot] = msg.robot;
        });
      case 'aiLevel':
        return this.admin(c, room => void (!room.running && (room.aiLevel = cleanAiLevel(msg.level))));
      case 'rules':
        return this.admin(c, room => void (room.rules = cleanRules(msg.rules)));
      case 'mode':
        return this.admin(c, room => void (!room.running && (room.mode = msg.mode === 'practice' ? 'practice' : 'match')));
      case 'scoreDisplay':
        return this.admin(c, room => void (room.scoreDisplay = cleanScoreDisplay(msg.display)));
      case 'start':
        return this.start(c);
      case 'stop':
        return this.admin(c, room => this.stopGame(room));
      case 'result':
        return this.result(c, msg.score);
      case 'signal': {
        const to = this.clients.get(msg.to);
        if (to && c.room && to.room === c.room) to.socket.send({ t: 'signal', from: id, data: msg.data });
        return;
      }
    }
  }

  /** Game data between two players in the same room, when they have no direct connection. */
  binary(id: number, data: Uint8Array): void {
    const c = this.clients.get(id);
    if (!c?.room || data.length < RELAY.header) return;
    const to = this.clients.get(data[1] | (data[2] << 8));
    if (!to || to.room !== c.room) return;
    const out = new Uint8Array(data);
    out[1] = id & 0xff;
    out[2] = id >> 8;
    to.socket.sendBinary(out);
  }

  private create(c: Client, format: RoomFormat, robot: PlayerRobot, start: unknown, rules: unknown, scoreDisplay: unknown, aiLevel: unknown): void {
    if (c.room) this.leave(c.id);
    const room = this.newRoom(c, format === '1v1' ? '1v1' : '2v2', cleanRules(rules), cleanScoreDisplay(scoreDisplay), false, cleanAiLevel(aiLevel));
    if (!room) return c.socket.send({ t: 'error', code: 'serverFull' });
    this.enter(c, room, robot, start);
  }

  /** A new room with `c` as its admin (who still has to enter it); null when the server has rooms enough. */
  private newRoom(c: Client, format: RoomFormat, rules: RuleOptions, scoreDisplay: ScoreDisplay, quick: boolean, aiLevel = cleanAiLevel(undefined)): Room | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    const room: Room = {
      id: this.roomId(),
      format,
      adminId: c.id,
      members: [],
      ai: {},
      aiLevel,
      rules,
      mode: 'match',
      scoreDisplay,
      password: null,
      quick,
      autoStartAt: null,
      running: false,
      startedAt: 0,
      reported: false,
    };
    this.rooms.set(room.id, room);
    return room;
  }

  private quick(c: Client, robot: PlayerRobot, start: unknown): void {
    if (c.room) this.leave(c.id);
    this.searching.set(c.id, { since: this.now(), robot, start: cleanStart(start) });
    c.socket.send({ t: 'quick', searching: true });
    this.matchmake();
  }

  /**
   * Quick play: each player looking for a game (who has waited longest first) goes into the open
   * room with the most players. With none, two or more looking play together in a new 2 vs 2 room
   * with the usual rules; one who has looked alone for QUICK_WAIT gets that room to wait in.
   */
  private matchmake(): void {
    const waiting = () => [...this.searching].sort((a, b) => a[1].since - b[1].since);
    for (const [id, search] of waiting()) {
      const c = this.clients.get(id);
      const room = this.openRoom();
      if (!c || !room) continue;
      this.searching.delete(id);
      this.enter(c, room, search.robot, search.start);
    }
    const left = waiting();
    if (!left.length || (left.length < 2 && this.now() - left[0][1].since < QUICK_WAIT * 1000)) return;
    const [hostId, search] = left[0];
    const host = this.clients.get(hostId);
    if (!host) return void this.searching.delete(hostId);
    const room = this.newRoom(host, '2v2', cleanRules(undefined), 'live', true);
    // The server has rooms enough: they keep looking.
    if (!room) return;
    this.searching.delete(hostId);
    this.enter(host, room, search.robot, search.start);
    // The others looking come in after them.
    this.matchmake();
  }

  /** Where quick play puts a player: a room with no password, no match on and a free station; the fullest first. */
  private openRoom(): Room | null {
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.password || room.running || room.members.length >= FORMAT_SLOTS[room.format].length) continue;
      const better = !best || room.members.length > best.members.length || (room.members.length === best.members.length && room.quick && !best.quick);
      if (better) best = room;
    }
    return best;
  }

  private join(c: Client, roomId: string, robot: PlayerRobot, start: unknown, password?: string): void {
    const room = this.rooms.get(roomId);
    const error = (code: LobbyError) => c.socket.send({ t: 'error', code });
    if (!room) return error('noRoom');
    if (room.members.some(m => m.id === c.id)) return;
    if (room.running) return error('running');
    if (room.members.length >= FORMAT_SLOTS[room.format].length) return error('roomFull');
    if (room.password && (typeof password !== 'string' || password.toUpperCase() !== room.password)) return error('badPassword');
    if (c.room) this.leave(c.id);
    this.enter(c, room, robot, start);
  }

  private enter(c: Client, room: Room, robot: PlayerRobot, start: unknown): void {
    const taken = new Set(room.members.map(m => m.slot));
    // An empty station first; otherwise the new player takes over from the AI.
    const free = FORMAT_SLOTS[room.format].filter(s => !taken.has(s));
    const slot = free.find(s => !room.ai[s]) ?? free[0] ?? null;
    if (slot) delete room.ai[slot];
    room.members.push({ id: c.id, name: c.name, ...robot, slot, start: cleanStart(start) });
    c.room = room;
    // Someone new in a quick-play room counting down: time to pick a robot.
    if (room.autoStartAt !== null) room.autoStartAt = Math.max(room.autoStartAt, this.now() + QUICK_JOIN_TIME * 1000);
    this.changed(room);
  }

  leave(id: number): void {
    const c = this.clients.get(id);
    const room = c?.room;
    if (!c || !room) return;
    c.room = null;
    const gone = room.members.find(m => m.id === id);
    room.members = room.members.filter(m => m.id !== id);
    if (!room.members.length) {
      this.stopGame(room, gone);
      this.rooms.delete(room.id);
    } else if (room.adminId === id) {
      // The match ran in the admin's browser: it is over. The next player in becomes the admin.
      room.adminId = room.members[0].id;
      this.stopGame(room, gone);
    }
    c.socket.send({ t: 'room', room: null });
    if (this.rooms.has(room.id)) this.changed(room);
    else this.broadcastList();
  }

  private takeSlot(c: Client, slot: Slot | null): void {
    const room = c.room;
    const me = room?.members.find(m => m.id === c.id);
    if (!room || !me || room.running) return;
    if (slot !== null && (!SLOTS.includes(slot) || !FORMAT_SLOTS[room.format].includes(slot))) return;
    if (slot && room.members.some(m => m.slot === slot && m.id !== c.id)) return c.socket.send({ t: 'error', code: 'slotTaken' });
    // A player taking the AI's station replaces it.
    if (slot) delete room.ai[slot];
    me.slot = slot;
    this.changed(room);
  }

  /** A robot, and the start its player picked for it (the admin's game checks it against G304). */
  private changeRobot(c: Client, robot: unknown, custom: unknown, start: unknown): void {
    const me = c.room?.members.find(m => m.id === c.id);
    const picked = playerRobot(robot, custom);
    if (!c.room || !me || c.room.running || picked.robot !== robot) return;
    me.robot = picked.robot;
    if (picked.custom) me.custom = picked.custom;
    else delete me.custom;
    me.start = cleanStart(start);
    this.changed(c.room);
  }

  private start(c: Client): void {
    this.admin(c, room => {
      const players = room.members.filter(m => m.slot).length;
      const robots = players + Object.keys(room.ai).length;
      // Someone has to drive, and with someone else on the field: another player or the AI.
      if (players < 1 || robots < 2) return c.socket.send({ t: 'error', code: 'notReady' });
      this.begin(room);
    });
  }

  private begin(room: Room): void {
    room.running = true;
    room.startedAt = this.now();
    room.reported = false;
  }

  /** The admin's game finished a match: it counts for everyone in it (once). */
  private result(c: Client, score: unknown): void {
    const room = c.room;
    if (!room || room.adminId !== c.id || !room.running || room.mode !== 'match' || room.reported) return;
    const s = score as { red?: unknown; blue?: unknown } | null;
    const points = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
    if (!s || !points(s.red) || !points(s.blue)) return;
    room.reported = true;
    this.report(room, { red: s.red, blue: s.blue });
  }

  /** Back to choosing; practice that went on long enough counts as a game. `left`: the admin, who just left it. */
  private stopGame(room: Room, left?: Member): void {
    if (room.running && room.mode === 'practice' && this.now() - room.startedAt >= MIN_PRACTICE * 1000) this.report(room, undefined, left);
    room.running = false;
  }

  private report(room: Room, score: { red: number; blue: number } | undefined, left?: Member): void {
    if (!this.hooks.game) return;
    const players = [...room.members, ...(left ? [left] : [])].filter(m => m.slot).map(m => {
      const client = this.clients.get(m.id);
      return { device: client?.device ?? undefined, account: client?.account ?? null, name: m.name, alliance: slotAlliance(m.slot!), robot: m.robot };
    });
    this.hooks.game({
      type: room.mode === 'practice' ? 'practice' : room.format,
      mode: room.mode,
      duration: (this.now() - room.startedAt) / 1000,
      score,
      players,
      ai: [...new Set((Object.keys(room.ai) as Slot[]).map(slotAlliance))],
    });
  }

  /** The room a signed-in player is in (for their friends). */
  roomOf(account: string): RoomSummary | null {
    for (const c of this.clients.values()) if (c.account?.id === account && c.room) return this.summary(c.room);
    return null;
  }

  private admin(c: Client, change: (room: Room) => void): void {
    const room = c.room;
    if (!room) return;
    if (room.adminId !== c.id) return c.socket.send({ t: 'error', code: 'adminOnly' });
    change(room);
    this.changed(room);
  }

  private changed(room: Room): void {
    // A quick-play room counts down while it has two players at driver stations and no match on.
    const players = room.members.filter(m => m.slot).length;
    if (!room.quick || room.running || players < 2) room.autoStartAt = null;
    else room.autoStartAt ??= this.now() + QUICK_START * 1000;
    const info = this.info(room);
    for (const m of room.members) this.clients.get(m.id)?.socket.send({ t: 'room', room: info });
    this.broadcastList();
  }

  /** Everyone choosing a room sees the list change. */
  private broadcastList(): void {
    const rooms = this.summaries();
    for (const c of this.clients.values()) if (!c.room) c.socket.send({ t: 'rooms', rooms });
  }

  private summary(room: Room): RoomSummary {
    const admin = room.members.find(m => m.id === room.adminId);
    return { id: room.id, name: admin?.name ?? '', format: room.format, players: room.members.length, locked: room.password !== null, running: room.running, mode: room.mode, quick: room.quick };
  }

  /** Rooms with a free driver station first, then the full and the playing ones. */
  summaries(): RoomSummary[] {
    const open = (r: RoomSummary) => (r.running || r.players >= FORMAT_SLOTS[r.format].length ? 1 : 0);
    return [...this.rooms.values()].map(r => this.summary(r)).sort((a, b) => open(a) - open(b));
  }

  private info(room: Room): RoomInfo {
    // Everyone inside already knows the password; the admin shares it from the room screen.
    return {
      ...this.summary(room),
      adminId: room.adminId,
      members: room.members.map(m => ({ ...m, start: m.start && { ...m.start } })),
      ai: { ...room.ai },
      aiLevel: room.aiLevel,
      rules: { ...room.rules },
      password: room.password,
      scoreDisplay: room.scoreDisplay,
      autoStartIn: room.autoStartAt === null ? null : Math.max(0, (room.autoStartAt - this.now()) / 1000),
    };
  }

  private roomId(): string {
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i++) id += ROOM_ID_LETTERS[Math.floor(this.random() * ROOM_ID_LETTERS.length)];
      if (!this.rooms.has(id)) return id;
    }
  }
}
