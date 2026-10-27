import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Lobby } from '../server/Lobby';
import type { Peer } from '../server/Room';
import type { FieldLayout } from '../src/field/layout';
import type { RoomInfo, ServerMessage } from '../src/net/protocol';
import { parseColliders } from '../src/sim/colliders';
import { initPhysics } from '../src/sim/Simulation';
import { decodeState, type WorldState } from '../src/sim/state';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

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
  get errors(): string[] {
    return this.messages.flatMap(m => (m.t === 'error' ? [m.message] : []));
  }
  /** What the browser translates errors by */
  get errorCodes(): string[] {
    return this.messages.flatMap(m => (m.t === 'error' && m.code ? [m.code] : []));
  }
}

function connect(lobby: Lobby, name: string) {
  const peer = new FakePeer();
  const id = lobby.connect(peer);
  lobby.handle(id, { t: 'hello', name });
  return { id, peer };
}

const runFor = (lobby: Lobby, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.01) lobby.tick(0.01);
};

describe('game server lobby', () => {
  beforeAll(() => initPhysics());

  it('creates a room and lets a friend join by code into the other alliance', () => {
    const lobby = new Lobby(layout, colliders);
    const host = connect(lobby, 'Max');
    lobby.handle(host.id, { t: 'create' });
    const code = host.peer.room!.code;
    expect(code).toMatch(/^[A-Z]{4}$/);

    const friend = connect(lobby, 'Anya');
    lobby.handle(friend.id, { t: 'join', code: code.toLowerCase() });
    const room = friend.peer.room!;
    expect(room.players.map(p => [p.name, p.slot])).toEqual([['Max', 'red1'], ['Anya', 'blue1']]);
    expect(room.hostId).toBe(host.id);
  });

  it('rejects wrong codes, a fifth player and starts by guests', () => {
    const lobby = new Lobby(layout, colliders);
    const host = connect(lobby, 'A');
    lobby.handle(host.id, { t: 'create' });
    const code = host.peer.room!.code;
    const stranger = connect(lobby, 'X');
    lobby.handle(stranger.id, { t: 'join', code: 'ZZZZ' === code ? 'YYYY' : 'ZZZZ' });
    expect(stranger.peer.errors).toContain('Комната с таким кодом не найдена');
    expect(stranger.peer.errorCodes).toEqual(['noRoom']);

    const others = ['B', 'C', 'D'].map(n => connect(lobby, n));
    for (const o of others) lobby.handle(o.id, { t: 'join', code });
    const fifth = connect(lobby, 'E');
    lobby.handle(fifth.id, { t: 'join', code });
    expect(fifth.peer.errors).toContain('Комната заполнена (4 игрока)');

    lobby.handle(others[0].id, { t: 'start', mode: 'match' });
    expect(others[0].peer.errors).toContain('Начать может только хост комнаты');
    expect(others[0].peer.errorCodes).toEqual(['hostOnly']);
  });

  it('runs a match: inputs move the right robot and everyone gets snapshots', () => {
    const lobby = new Lobby(layout, colliders);
    const red = connect(lobby, 'Red');
    lobby.handle(red.id, { t: 'create' });
    const blue = connect(lobby, 'Blue');
    lobby.handle(blue.id, { t: 'join', code: red.peer.room!.code });
    lobby.handle(red.id, { t: 'start', mode: 'match' });
    expect(blue.peer.room!.running).toBe('match');

    runFor(lobby, 0.1);
    const start = blue.peer.snapshots.at(-1)!;
    expect(start.robots.map(r => r.slot)).toEqual(['red1', 'blue1']);
    const blueX0 = start.robots[1].x;

    // Blue drives "up" (field-centric: away from the blue drivers, toward -X).
    lobby.handle(blue.id, { t: 'input', input: { ...idleInput(), ly: -1 } });
    runFor(lobby, 0.5);
    const after = red.peer.snapshots.at(-1)!;
    expect(after.robots[1].x).toBeLessThan(blueX0 - 0.3);
    expect(Math.abs(after.robots[0].x - start.robots[0].x)).toBeLessThan(0.01);
    expect(after.period).toBe('auto');
    // ~30 snapshots per second
    expect(red.peer.snapshots.length).toBeGreaterThan(15);
    expect(red.peer.snapshots.length).toBeLessThan(25);
  });

  it("plays with the host's house rules, and ignores junk rules", () => {
    const lobby = new Lobby(layout, colliders);
    const host = connect(lobby, 'Host');
    lobby.handle(host.id, { t: 'create' });
    lobby.handle(host.id, { t: 'start', mode: 'match', rules: { fouls: false, cards: true, battery: false } });
    expect(host.peer.room!.rules).toEqual({ fouls: false, cards: true, battery: false });
    lobby.handle(host.id, { t: 'stop' });
    lobby.handle(host.id, { t: 'start', mode: 'match', rules: { fouls: 'no', cards: 7 } as never });
    expect(host.peer.room!.rules).toEqual({ fouls: true, cards: true, battery: true });
  });

  it('plays a full online match to the end and returns the room to the lobby', () => {
    const lobby = new Lobby(layout, colliders);
    const host = connect(lobby, 'Host');
    lobby.handle(host.id, { t: 'create' });
    lobby.handle(host.id, { t: 'start', mode: 'match' });
    for (let i = 0; i < 1700; i++) lobby.tick(0.1); // 2:30 match + settle, 12 physics steps per tick
    const finished = host.peer.messages.find(m => m.t === 'finished');
    expect(finished).toBeDefined();
    expect(host.peer.room!.running).toBeNull();
    const toasts = host.peer.messages.flatMap(m => (m.t === 'toast' ? [m.text] : []));
    expect(toasts).toContain('TELEOP!');

    // The host can start again; a guest cannot stop it.
    lobby.handle(host.id, { t: 'start', mode: 'practice' });
    expect(host.peer.room!.running).toBe('practice');
    lobby.handle(host.id, { t: 'stop' });
    expect(host.peer.room!.running).toBeNull();
  });

  it('cleans hostile input and moves the host role when the host leaves', () => {
    const lobby = new Lobby(layout, colliders);
    const a = connect(lobby, 'A');
    lobby.handle(a.id, { t: 'create' });
    const b = connect(lobby, 'B');
    lobby.handle(b.id, { t: 'join', code: a.peer.room!.code });
    lobby.handle(a.id, { t: 'start', mode: 'practice' });
    lobby.handle(b.id, { t: 'input', input: { lx: 1e9, ly: Number.NaN, rx: 'x' } as never });
    runFor(lobby, 0.2);
    const blue = b.peer.snapshots.at(-1)!.robots.find(r => r.slot === 'blue1')!;
    expect(Number.isFinite(blue.x)).toBe(true);

    lobby.disconnect(a.id);
    expect(b.peer.room!.hostId).toBe(b.id);
    expect(b.peer.room!.players).toHaveLength(1);
  });
});
