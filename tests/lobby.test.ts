import { describe, expect, it } from 'vitest';
import { Lobby, QUICK_JOIN_TIME, QUICK_START, QUICK_WAIT, type LobbySocket } from '../server/Lobby';
import { DEFAULT_RULES } from '../src/sim/Referee';
import type { ClientMessage, RoomInfo, RoomSummary, ServerMessage } from '../src/net/lobbyProtocol';

class FakeSocket implements LobbySocket {
  readonly messages: ServerMessage[] = [];
  readonly binary: Uint8Array[] = [];
  send(m: ServerMessage) {
    this.messages.push(structuredClone(m));
  }
  sendBinary(d: Uint8Array) {
    this.binary.push(d);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.messages].reverse().find(m => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
  get room(): RoomInfo | null {
    return this.last('room')?.room ?? null;
  }
  get rooms(): RoomSummary[] {
    return this.last('rooms')?.rooms ?? [];
  }
}

function player(lobby: Lobby, name: string) {
  const socket = new FakeSocket();
  const id = lobby.connect(socket)!;
  const send = (m: ClientMessage) => lobby.message(id, m);
  send({ t: 'hello', name });
  return { id, socket, send };
}

describe('online rooms', () => {
  it('lists rooms that need players, and a closed one asks for its 4-letter password', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '1v1', robot: 'bumble-v', rules: DEFAULT_RULES });
    expect(admin.socket.room).toMatchObject({ name: 'Admin', format: '1v1', players: 1, locked: false, adminId: admin.id });
    expect(admin.socket.room!.members[0]).toMatchObject({ name: 'Admin', robot: 'bumble-v', slot: 'red1' });
    expect(guest.socket.rooms).toEqual([expect.objectContaining({ name: 'Admin', players: 1, locked: false })]);

    admin.send({ t: 'lock', password: 'ABCD' });
    expect(guest.socket.rooms[0].locked).toBe(true);
    // The list never shows the password.
    expect(JSON.stringify(guest.socket.rooms)).not.toContain('ABCD');

    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    expect(guest.socket.last('error')?.code).toBe('badPassword');
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2', password: 'abcd' });
    expect(guest.socket.room).toMatchObject({ players: 2, password: 'ABCD' });
    expect(guest.socket.room!.members.map(m => m.slot)).toEqual(['red1', 'blue1']);

    // Full now: a third player can't get in.
    const third = player(lobby, 'Third');
    third.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2', password: 'ABCD' });
    expect(third.socket.last('error')?.code).toBe('roomFull');
  });

  it('only the admin opens, closes and starts; a bad password is refused', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    const id = admin.socket.room!.id;
    guest.send({ t: 'join', room: id, robot: 'uran-v2' });
    guest.send({ t: 'lock', password: 'QWER' });
    expect(guest.socket.last('error')?.code).toBe('adminOnly');
    admin.send({ t: 'lock', password: 'ab1' });
    expect(admin.socket.room!.locked).toBe(false);
    admin.send({ t: 'lock', password: 'QWER' });
    admin.send({ t: 'lock', password: null });
    expect(guest.socket.room!.locked).toBe(false);
    guest.send({ t: 'start' });
    expect(guest.socket.room!.running).toBe(false);
    admin.send({ t: 'start' });
    expect(guest.socket.room!.running).toBe(true);
    // A running room can't be joined.
    const late = player(lobby, 'Late');
    late.send({ t: 'join', room: id, robot: 'uran-v2' });
    expect(late.socket.last('error')?.code).toBe('running');
  });

  it('the admin puts the AI on any free station with a robot; a player who joins takes its place', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    admin.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    // Alone, the match needs the AI somewhere on the field.
    admin.send({ t: 'start' });
    expect(admin.socket.last('error')?.code).toBe('notReady');
    admin.send({ t: 'ai', slot: 'red2', robot: 'bumble-v' });
    admin.send({ t: 'ai', slot: 'blue1', robot: 'silver-bullet-blaster' });
    admin.send({ t: 'ai', slot: 'blue2', robot: 'uran-v2' });
    // Not on the admin's own station, and only real robots.
    admin.send({ t: 'ai', slot: 'red1', robot: 'uran-v2' });
    admin.send({ t: 'ai', slot: 'blue2', robot: 'tank' });
    expect(admin.socket.room!.ai).toEqual({ red2: 'bumble-v', blue1: 'silver-bullet-blaster', blue2: 'uran-v2' });
    admin.send({ t: 'ai', slot: 'blue1', robot: 'bumble-v' });
    expect(admin.socket.room!.ai.blue1).toBe('bumble-v');

    // Every station has a robot: a new player takes over from the AI, the room counts players only.
    const guest = player(lobby, 'Guest');
    expect(guest.socket.rooms[0].players).toBe(1);
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    expect(guest.socket.room!.members.find(m => m.id === guest.id)?.slot).toBe('blue1');
    expect(guest.socket.room!.ai).toEqual({ red2: 'bumble-v', blue2: 'uran-v2' });
    // Moving to the AI's station replaces it too; the station left behind is free.
    guest.send({ t: 'slot', slot: 'blue2' });
    expect(guest.socket.room!.ai).toEqual({ red2: 'bumble-v' });
    admin.send({ t: 'start' });
    expect(guest.socket.room!.running).toBe(true);
  });

  it("the room's AI drives at the admin's level: theirs when they make the room, medium without one", () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES, aiLevel: 'hard' });
    expect(admin.socket.room!.aiLevel).toBe('hard');
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    guest.send({ t: 'aiLevel', level: 'easy' });
    expect(guest.socket.last('error')?.code).toBe('adminOnly');
    admin.send({ t: 'aiLevel', level: 'easy' });
    expect(guest.socket.room!.aiLevel).toBe('easy');
    // Anything else is the usual level.
    admin.send({ t: 'aiLevel', level: 'impossible' as never });
    expect(guest.socket.room!.aiLevel).toBe('medium');
    // Not during a match: the AI already drives at the level it started with.
    admin.send({ t: 'ai', slot: 'red2', robot: 'bumble-v' });
    admin.send({ t: 'start' });
    admin.send({ t: 'aiLevel', level: 'hard' });
    expect(guest.socket.room!.aiLevel).toBe('medium');

    const other = player(lobby, 'Other');
    other.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    expect(other.socket.room!.aiLevel).toBe('medium');
  });

  it('the admin picks the rules and the mode for everyone', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: { fouls: false, cards: true, battery: true, movingShots: true } });
    expect(admin.socket.room).toMatchObject({ mode: 'match', rules: { fouls: false, cards: true, battery: true, movingShots: true } });
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    guest.send({ t: 'rules', rules: { fouls: true, cards: true, battery: true, movingShots: true } });
    expect(guest.socket.last('error')?.code).toBe('adminOnly');
    admin.send({ t: 'rules', rules: { fouls: true, cards: false, battery: false, movingShots: false } });
    admin.send({ t: 'mode', mode: 'practice' });
    expect(guest.socket.room).toMatchObject({ mode: 'practice', rules: { fouls: true, cards: false, battery: false, movingShots: false } });
    const third = player(lobby, 'Third');
    expect(third.socket.rooms[0].mode).toBe('practice');
  });

  it('players move to free stations; the admin leaving ends the match and passes the room on', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    guest.send({ t: 'slot', slot: 'red1' });
    expect(guest.socket.last('error')?.code).toBe('slotTaken');
    guest.send({ t: 'slot', slot: 'red2' });
    expect(guest.socket.room!.members.find(m => m.id === guest.id)?.slot).toBe('red2');
    admin.send({ t: 'start' });
    lobby.disconnect(admin.id);
    expect(guest.socket.room).toMatchObject({ adminId: guest.id, running: false, players: 1 });
    lobby.disconnect(guest.id);
    expect(lobby.roomCount).toBe(0);
  });

  it("keeps each player's own start with their robot, and drops anything that is not a pose", () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    const start = { x: -0.3, z: 1.5, yaw: 1.5 };
    admin.send({ t: 'create', format: '1v1', robot: 'uran-v2', start, rules: DEFAULT_RULES });
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'bumble-v', start: { x: 'far', z: 0, yaw: 0 } as never });
    const members = () => admin.socket.room!.members;
    expect(members().map(m => m.start)).toEqual([start, null]);
    guest.send({ t: 'robot', robot: 'uran-v2', start });
    expect(members()[1]).toMatchObject({ robot: 'uran-v2', start });
    // A robot without a start of its own: its usual spot.
    guest.send({ t: 'robot', robot: 'bumble-v' });
    expect(members()[1].start).toBeNull();
  });

  it('passes WebRTC signals and relayed game data only within a room', () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    const stranger = player(lobby, 'Stranger');
    admin.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'uran-v2' });
    admin.send({ t: 'signal', to: guest.id, data: { sdp: 'offer' } });
    expect(guest.socket.last('signal')).toEqual({ t: 'signal', from: admin.id, data: { sdp: 'offer' } });
    admin.send({ t: 'signal', to: stranger.id, data: 'x' });
    expect(stranger.socket.last('signal')).toBeUndefined();

    lobby.binary(guest.id, new Uint8Array([1, admin.id & 0xff, admin.id >> 8, 42, 43]));
    expect([...admin.socket.binary[0]]).toEqual([1, guest.id & 0xff, guest.id >> 8, 42, 43]);
    lobby.binary(stranger.id, new Uint8Array([1, admin.id, 0, 7]));
    expect(admin.socket.binary).toHaveLength(1);
  });

  it("the admin picks what everyone sees of the score; a new room starts with its maker's choice", () => {
    const lobby = new Lobby();
    const admin = player(lobby, 'Admin');
    const guest = player(lobby, 'Guest');
    admin.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES, scoreDisplay: 'end' });
    guest.send({ t: 'join', room: admin.socket.room!.id, robot: 'bumble-v' });
    expect(guest.socket.room!.scoreDisplay).toBe('end');
    admin.send({ t: 'scoreDisplay', display: 'earned' });
    expect(guest.socket.room!.scoreDisplay).toBe('earned');
    guest.send({ t: 'scoreDisplay', display: 'live' });
    expect(guest.socket.last('error')?.code).toBe('adminOnly');
    admin.send({ t: 'scoreDisplay', display: 'secret' as never });
    expect(guest.socket.room!.scoreDisplay).toBe('live');
    // Older games send no choice: the whole score.
    const other = player(lobby, 'Other');
    other.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    expect(other.socket.room!.scoreDisplay).toBe('live');
  });
});

describe('quick play', () => {
  function clock() {
    const c = { ms: 1_000_000, now: () => c.ms, wait: (s: number) => void (c.ms += s * 1000) };
    return c;
  }

  it('puts a player in the open room with the most players, never a closed, full or playing one', () => {
    const lobby = new Lobby();
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(n => player(lobby, n));
    a.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    b.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    c.send({ t: 'join', room: b.socket.room!.id, robot: 'uran-v2' });
    d.send({ t: 'create', format: '2v2', robot: 'uran-v2', rules: DEFAULT_RULES });
    d.send({ t: 'join', room: b.socket.room!.id, robot: 'uran-v2' });
    // B's room has 3 players now; A's has 1. Closing B's sends the next player to A's.
    b.send({ t: 'lock', password: 'ABCD' });
    e.send({ t: 'quick', robot: 'bumble-v' });
    expect(e.socket.room).toMatchObject({ id: a.socket.room!.id, players: 2 });
    expect(e.socket.room!.members[1]).toMatchObject({ name: 'E', robot: 'bumble-v', slot: 'blue1' });

    b.send({ t: 'lock', password: null });
    const f = player(lobby, 'F');
    f.send({ t: 'quick', robot: 'uran-v2' });
    expect(f.socket.room!.id).toBe(b.socket.room!.id);
    expect(f.socket.room!.players).toBe(4);
  });

  it('players looking at the same time play together; one alone gets a room of their own to wait in', () => {
    const time = clock();
    const lobby = new Lobby(Math.random, {}, time.now);
    const a = player(lobby, 'A');
    a.send({ t: 'quick', robot: 'uran-v2' });
    expect(a.socket.last('quick')).toEqual({ t: 'quick', searching: true });
    expect(a.socket.room).toBeNull();
    const b = player(lobby, 'B');
    b.send({ t: 'quick', robot: 'bumble-v' });
    // The one who looked first is the admin of a 2 vs 2 room with the usual rules.
    expect(a.socket.room).toMatchObject({ format: '2v2', quick: true, adminId: a.id, players: 2, rules: DEFAULT_RULES, scoreDisplay: 'live' });
    expect(b.socket.room!.id).toBe(a.socket.room!.id);

    const c = player(lobby, 'C');
    c.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    c.send({ t: 'lock', password: 'ABCD' });
    const d = player(lobby, 'D');
    d.send({ t: 'quick', robot: 'uran-v2' });
    expect(d.socket.room?.id).toBe(a.socket.room!.id);
    const e = player(lobby, 'E');
    e.send({ t: 'quick', robot: 'uran-v2' });
    expect(e.socket.room?.id).toBe(a.socket.room!.id);
    // The room is full now: the next one waits, then hosts.
    const f = player(lobby, 'F');
    f.send({ t: 'quick', robot: 'uran-v2' });
    time.wait(QUICK_WAIT - 1);
    lobby.tick();
    expect(f.socket.room).toBeNull();
    time.wait(1);
    lobby.tick();
    expect(f.socket.room).toMatchObject({ quick: true, adminId: f.id, players: 1, autoStartIn: null });
    expect(lobby.roomCount).toBe(3);
  });

  it('stops looking when the player cancels, makes or joins a room, or leaves', () => {
    const time = clock();
    const lobby = new Lobby(Math.random, {}, time.now);
    const a = player(lobby, 'A');
    a.send({ t: 'quick', robot: 'uran-v2' });
    a.send({ t: 'quickCancel' });
    expect(a.socket.last('quick')).toEqual({ t: 'quick', searching: false });
    const b = player(lobby, 'B');
    b.send({ t: 'quick', robot: 'uran-v2' });
    lobby.disconnect(b.id);
    const c = player(lobby, 'C');
    c.send({ t: 'quick', robot: 'uran-v2' });
    c.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    time.wait(QUICK_WAIT);
    lobby.tick();
    // Only C's own room: nobody was still looking.
    expect(lobby.roomCount).toBe(1);
    expect(a.socket.room).toBeNull();
    expect(c.socket.room).toMatchObject({ quick: false, players: 1 });
  });

  it("a quick-play room starts its match by itself, with time for a newcomer to pick a robot", () => {
    const time = clock();
    const lobby = new Lobby(Math.random, {}, time.now);
    const a = player(lobby, 'A');
    const b = player(lobby, 'B');
    a.send({ t: 'quick', robot: 'uran-v2' });
    b.send({ t: 'quick', robot: 'uran-v2' });
    expect(a.socket.room!.autoStartIn).toBe(QUICK_START);
    time.wait(QUICK_START - 5);
    const c = player(lobby, 'C');
    c.send({ t: 'quick', robot: 'uran-v2' });
    expect(c.socket.room!.autoStartIn).toBe(QUICK_JOIN_TIME);
    time.wait(QUICK_JOIN_TIME - 1);
    lobby.tick();
    expect(a.socket.room!.running).toBe(false);
    time.wait(1);
    lobby.tick();
    expect(a.socket.room).toMatchObject({ running: true, autoStartIn: null });
    expect(c.socket.room!.running).toBe(true);
    // Back to choosing after the match: the next one counts down again.
    a.send({ t: 'stop' });
    expect(a.socket.room).toMatchObject({ running: false, autoStartIn: QUICK_START });
    // One player left: no countdown.
    b.send({ t: 'leave' });
    c.send({ t: 'leave' });
    expect(a.socket.room!.autoStartIn).toBeNull();
    // A room someone made themselves never starts without its admin.
    const d = player(lobby, 'D');
    const e = player(lobby, 'E');
    d.send({ t: 'create', format: '1v1', robot: 'uran-v2', rules: DEFAULT_RULES });
    e.send({ t: 'join', room: d.socket.room!.id, robot: 'uran-v2' });
    expect(d.socket.room!.autoStartIn).toBeNull();
    time.wait(QUICK_START * 2);
    lobby.tick();
    expect(d.socket.room!.running).toBe(false);
  });
});
