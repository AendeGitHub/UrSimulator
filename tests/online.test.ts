import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { clampStart } from '../src/field/startPose';
import type { AllianceScore } from '../src/game/scoring';
import type { RoomInfo } from '../src/net/lobbyProtocol';
import { GuestSession, HostSession, InputDecoder, InputEncoder, roomDrivers } from '../src/net/OnlineSession';
import type { Alliance } from '../src/robot/robotConfig';
import { robotById } from '../src/robot/robots';
import { DEFAULT_RULES } from '../src/sim/Referee';
import { parseColliders } from '../src/sim/colliders';
import { initPhysics } from '../src/sim/Simulation';
import { decodeState, encodeState } from '../src/sim/stateCodec';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

const room: RoomInfo = {
  id: 'abcdef', name: 'Admin', format: '2v2', players: 2, locked: false, running: true, mode: 'match', quick: false, adminId: 1, password: null,
  scoreDisplay: 'live', autoStartIn: null,
  ai: { red2: 'silver-bullet-blaster', blue2: 'bumble-v' }, rules: DEFAULT_RULES,
  members: [
    { id: 1, name: 'Admin', robot: 'uran-v2', slot: 'red1', start: null },
    { id: 2, name: 'Guest', robot: 'bumble-v', slot: 'blue1', start: null },
  ],
};

describe('online input', () => {
  it('sends sticks and buttons, and every press exactly once even when packets are lost', () => {
    const enc = new InputEncoder();
    const dec = new InputDecoder();
    dec.receive(enc.encode({ ...idleInput(), ly: -1, intake: true }));
    expect(dec.take()).toMatchObject({ ly: -1, intake: true, shooterOn: false });
    // A press in a packet that is lost still arrives with the next one.
    enc.encode({ ...idleInput(), shooterOn: true });
    dec.receive(enc.encode(idleInput()));
    expect(dec.take().shooterOn).toBe(true);
    expect(dec.take().shooterOn).toBe(false);
    // A late packet is skipped.
    const old = enc.encode({ ...idleInput(), lx: 1 });
    dec.receive(enc.encode({ ...idleInput(), lx: -1 }));
    dec.receive(old);
    expect(dec.take().lx).toBeCloseTo(-1);
  });

  it("sends the lift's press and its box rollers in the same 13 bytes, and an older app's message still reads", () => {
    const enc = new InputEncoder();
    const dec = new InputDecoder();
    const first = enc.encode(idleInput());
    expect(first).toHaveLength(13);
    dec.receive(first);
    dec.take();
    // The press of a lost packet comes with the next one, once.
    enc.encode({ ...idleInput(), lift: true });
    dec.receive(enc.encode({ ...idleInput(), boxRollers: true }));
    expect(dec.take()).toMatchObject({ lift: true, boxRollers: true });
    expect(dec.take().lift).toBe(false);
    // An older app sends byte 7 as 0 and has no bit 5: no lift press, no box rollers.
    const older = enc.encode({ ...idleInput(), intake: true });
    older[6] &= 0b11111;
    older[7] = 0;
    const fresh = new InputDecoder();
    fresh.receive(older);
    fresh.receive(older);
    expect(fresh.take()).toMatchObject({ intake: true, lift: false, boxRollers: false });
  });
});

describe('online match', () => {
  beforeAll(() => initPhysics());

  it("puts the AI where the admin placed it, with its robot, at the room's level", () => {
    const { drivers, ai } = roomDrivers({ ...room, aiLevel: 'hard' });
    expect(drivers.map(d => d.slot)).toEqual(['red1', 'blue1']);
    expect(ai).toEqual([{ slot: 'red2', robot: 'silver-bullet-blaster', level: 'hard' }, { slot: 'blue2', robot: 'bumble-v', level: 'hard' }]);
    // A room from an older server has no level: the usual one.
    expect(roomDrivers(room).ai.map(d => d.level)).toEqual(['medium', 'medium']);
  });

  it("starts each player's robot where they put it", () => {
    // Against the audience wall, as the guest's Bumble V touches it
    const start = clampStart({ x: -0.3, z: 2, yaw: Math.PI / 2 }, robotById('bumble-v').config, layout.wallInnerHalf);
    const placed = { ...room, members: room.members.map(m => (m.slot === 'blue1' ? { ...m, start } : m)) };
    expect(roomDrivers(placed).drivers.find(d => d.slot === 'blue1')?.start).toEqual(start);
    const host = new HostSession(layout, colliders, placed, 1, () => {}, { direct: () => true }, { toast() {}, finished() {} });
    const blue = host.state().robots.find(r => r.slot === 'blue1')!;
    // The guest picked it as for the red side; blue is the same turned about the field center.
    expect(blue.x).toBeCloseTo(-start.x, 3);
    expect(blue.z).toBeCloseTo(-start.z, 3);
    host.dispose();
  });

  it("packs the admin's world into a snapshot and back", () => {
    const host = new HostSession(layout, colliders, room, 1, () => {}, { direct: () => true }, { toast() {}, finished() {} });
    host.update(0.5, {});
    const state = host.state();
    const back = decodeState(encodeState(state));
    expect(back.robots.map(r => [r.slot, r.robot])).toEqual(state.robots.map(r => [r.slot, r.robot]));
    expect(back.robots[0].x).toBeCloseTo(state.robots[0].x, 4);
    expect(back.balls.states).toEqual(state.balls.states);
    expect(back.period).toBe(state.period);
    host.dispose();
  });

  it("drives the guest's robot from the guest's input and shows the admin's match to the guest", () => {
    const toGuest: Uint8Array[] = [];
    const finished: Record<Alliance, AllianceScore>[] = [];
    let guest!: GuestSession;
    const host = new HostSession(layout, colliders, room, 1, (to, data) => to === 2 && toGuest.push(data), { direct: () => true }, { toast() {}, finished() {} });
    guest = new GuestSession(roomDrivers(room).ai, 'blue1', 1, (to, data) => to === 1 && host.receive(2, data), { toast() {}, finished: s => finished.push(s) });

    const blueStart = host.state().robots.find(r => r.slot === 'blue1')!.x;
    for (let i = 0; i < 90; i++) {
      // The guest pushes forward (toward the red end for blue), the admin stands still.
      guest.update(1 / 60, { blue1: { ...idleInput(), ly: -1 } });
      host.update(1 / 60, { red1: idleInput() });
      host.frame(1 / 60, 0);
    }
    for (const msg of toGuest) guest.receive(1, msg);
    const blueNow = host.state().robots.find(r => r.slot === 'blue1')!.x;
    expect(blueNow).toBeLessThan(blueStart - 0.3);
    expect(guest.remoteStartIn).toBe(0);
    // The guest's own picture of the match (newest snapshot) has the robot there too.
    const seen = guest.state()!;
    expect(seen.robots).toHaveLength(4);

    // The end of the match reaches the guest with the final score.
    const sim = (host as unknown as { session: { simulation: { match: { next(p: string): void } } } }).session.simulation;
    sim.match.next('post');
    toGuest.length = 0;
    // FIELD settling time after the buzzer
    for (let i = 0; i < 240; i++) host.update(1 / 60, {});
    for (const msg of toGuest) guest.receive(1, msg);
    expect(finished).toHaveLength(1);
    expect(finished[0].red).toHaveProperty('calls');
    host.dispose();
  });
});
