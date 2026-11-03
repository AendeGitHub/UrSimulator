// Online games. The admin's browser runs the match (HostSession), takes the other players' inputs
// and sends everyone snapshots of the field; the others (GuestSession) send their driver input and
// draw those snapshots, blended smoothly (interpolate.ts).
//
// Messages, first byte: 1 snapshot [f32 countdown][state], 2 input, 3 JSON (the final score).

import { cleanAiLevel } from '../ai/level';
import type { FieldLayout } from '../field/layout';
import type { AllianceScore } from '../game/scoring';
import { Session, type Driver, type GameSession, type SessionEvents } from '../game/Session';
import { sharedRobotId } from '../robot/custom';
import type { Alliance } from '../robot/robotConfig';
import type { ColliderPart } from '../sim/colliders';
import { decodeState, encodeState } from '../sim/stateCodec';
import type { WorldState } from '../sim/state';
import { idleInput, type RobotInput, type Slot } from '../sim/types';
import { SnapshotBuffer } from './interpolate';
import type { RoomInfo, RoomPlayer } from './lobbyProtocol';

const MSG = { snapshot: 1, input: 2, json: 3 } as const;
/** Snapshots a second to a player linked directly, and through the server */
const SNAPSHOT_RATE = { direct: 60, relay: 30 };
const INPUT_RATE = 60;
/** One-shot presses travel as counters, so a lost packet can't lose a press or repeat one. */
const ONE_SHOTS = ['shooterOn', 'shooterOff', 'imuReset', 'armUp', 'armDown'] as const;
/**
 * The lift's press, added later: its counter rides in byte 7, which older
 * apps send as 0 and don't read, so the message keeps its 13 bytes.
 */
const LATE_SHOT = 'lift';
/** Bit 1 was slow mode (since removed): it stays unused, so an app of another version reads the rest right. */
const FLAGS = ['fieldCentric', null, 'intake', 'eject', 'transfer', 'boxRollers'] as const;

type Send = (to: number, data: Uint8Array, fast: boolean) => void;
type JsonMessage = { t: 'finished'; score: Record<Alliance, AllianceScore> };

const stick = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));

/** A driver's input as a 13-byte message; call every frame so no press is missed. */
export class InputEncoder {
  private readonly counts = new Uint8Array(ONE_SHOTS.length);
  private lateCount = 0;
  private seq = 0;

  encode(input: RobotInput): Uint8Array {
    ONE_SHOTS.forEach((k, i) => input[k] && (this.counts[i] = (this.counts[i] + 1) & 0xff));
    if (input[LATE_SHOT]) this.lateCount = (this.lateCount + 1) & 0xff;
    this.seq = (this.seq + 1) & 0xffff;
    let flags = 0;
    FLAGS.forEach((k, i) => k && input[k] && (flags |= 1 << i));
    const out = new Uint8Array(8 + ONE_SHOTS.length);
    const view = new DataView(out.buffer);
    out[0] = MSG.input;
    view.setUint16(1, this.seq, true);
    view.setInt8(3, stick(input.lx));
    view.setInt8(4, stick(input.ly));
    view.setInt8(5, stick(input.rx));
    out[6] = flags;
    out[7] = this.lateCount;
    out.set(this.counts, 8);
    return out;
  }
}

/** The admin's side: the newest input of one remote driver, each press applied once. */
export class InputDecoder {
  private seq = -1;
  private counts: Uint8Array | null = null;
  private lateCount: number | null = null;
  private latest = idleInput();
  private presses: Partial<RobotInput> = {};

  receive(data: Uint8Array): void {
    if (data.length < 8 + ONE_SHOTS.length) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const seq = view.getUint16(1, true);
    // Older than the newest (with wrap-around): it came late, skip it.
    if (this.seq >= 0 && ((seq - this.seq) & 0xffff) >= 0x8000) return;
    this.seq = seq;
    const input = idleInput();
    input.lx = view.getInt8(3) / 127;
    input.ly = view.getInt8(4) / 127;
    input.rx = view.getInt8(5) / 127;
    FLAGS.forEach((k, i) => k && (input[k] = (data[6] & (1 << i)) !== 0));
    const counts = data.subarray(8, 8 + ONE_SHOTS.length);
    if (this.counts) ONE_SHOTS.forEach((k, i) => counts[i] !== this.counts![i] && (this.presses[k] = true));
    this.counts = new Uint8Array(counts);
    if (this.lateCount !== null && data[7] !== this.lateCount) this.presses[LATE_SHOT] = true;
    this.lateCount = data[7];
    this.latest = input;
  }

  /** This frame's input; presses only once. */
  take(): RobotInput {
    const input = { ...this.latest, ...this.presses };
    this.presses = {};
    return input;
  }
}

function jsonMessage(msg: JsonMessage): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + text.length);
  out[0] = MSG.json;
  out.set(text, 1);
  return out;
}

function readJson(data: Uint8Array): JsonMessage | null {
  try {
    return JSON.parse(new TextDecoder().decode(data.subarray(1))) as JsonMessage;
  } catch {
    return null;
  }
}

/**
 * The robot a player in a room drives, as every game in the room knows it: a robot they made goes
 * by its blueprint (customStore.addSharedRobot puts it in the game).
 */
export const memberRobot = (m: RoomPlayer): string => (m.custom ? sharedRobotId(m.custom) : m.robot);

/** The robots in a room's match: the players at their driver stations and the AI the admin placed. */
export function roomDrivers(room: RoomInfo): { drivers: (Driver & { id: number })[]; ai: Driver[] } {
  const drivers = room.members.filter(m => m.slot).map(m => ({ id: m.id, slot: m.slot!, robot: memberRobot(m), start: m.start }));
  const taken = new Set(drivers.map(d => d.slot));
  const level = cleanAiLevel(room.aiLevel);
  const ai = (Object.entries(room.ai) as [Slot, string][]).filter(([slot]) => !taken.has(slot)).map(([slot, robot]) => ({ slot, robot, level }));
  return { drivers, ai };
}

export interface LinkRates {
  /** Whether the link to a player is direct (more snapshots a second) */
  direct(id: number): boolean;
}

/** The admin's browser: the whole match runs here, with the room's mode and rules. */
export class HostSession implements GameSession {
  readonly online = true;
  private readonly session: Session;
  /** Remote drivers by player id */
  private readonly remote = new Map<number, { slot: Slot; input: InputDecoder }>();
  private sendTime = 0;
  private tick = 0;

  constructor(layout: FieldLayout, colliders: ColliderPart[], room: RoomInfo, myId: number,
    private readonly send: Send, private readonly rates: LinkRates, events: SessionEvents) {
    const { drivers, ai } = roomDrivers(room);
    for (const d of drivers) if (d.id !== myId) this.remote.set(d.id, { slot: d.slot, input: new InputDecoder() });
    this.session = new Session(layout, colliders, drivers, ai, room.mode, room.rules, {
      toast: text => events.toast(text),
      finished: score => {
        const msg = jsonMessage({ t: 'finished', score });
        for (const id of this.remote.keys()) this.send(id, msg, false);
        events.finished(score);
      },
    });
  }

  get ai(): readonly Driver[] {
    return this.session.ai;
  }

  receive(from: number, data: Uint8Array): void {
    if (data[0] === MSG.input) this.remote.get(from)?.input.receive(data);
  }

  update(dt: number, inputs: Partial<Record<Slot, RobotInput>>): void {
    const all = { ...inputs };
    for (const r of this.remote.values()) all[r.slot] = r.input.take();
    this.session.update(dt, all);
  }

  frame(dt: number, startIn: number): void {
    this.sendTime -= dt;
    if (this.sendTime > 0) return;
    this.sendTime = Math.max(0, this.sendTime + 1 / SNAPSHOT_RATE.direct);
    this.tick++;
    const state = new Uint8Array(encodeState(this.session.state()));
    const msg = new Uint8Array(5 + state.length);
    msg[0] = MSG.snapshot;
    new DataView(msg.buffer).setFloat32(1, startIn, true);
    msg.set(state, 5);
    const every = SNAPSHOT_RATE.direct / SNAPSHOT_RATE.relay;
    for (const id of this.remote.keys()) if (this.rates.direct(id) || this.tick % every === 0) this.send(id, msg, true);
  }

  state(): WorldState {
    return this.session.state();
  }

  dispose(): void {
    this.session.dispose();
  }
}

/** Everyone else: drives their robot from here and watches the admin's match. */
export class GuestSession implements GameSession {
  readonly online = true;
  remoteStartIn: number | null = null;
  private readonly buffer = new SnapshotBuffer();
  private readonly input = new InputEncoder();
  private sendTime = 0;

  constructor(readonly ai: readonly Driver[], private readonly mySlot: Slot | null, private readonly adminId: number, private readonly send: Send, private readonly events: SessionEvents) {}

  receive(from: number, data: Uint8Array): void {
    if (from !== this.adminId) return;
    if (data[0] === MSG.snapshot && data.length > 5) {
      const startIn = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(1, true);
      this.remoteStartIn = startIn;
      try {
        this.buffer.push(decodeState(data.slice(5).buffer), performance.now() / 1000);
      } catch {
        // A snapshot from another game version.
      }
    } else if (data[0] === MSG.json) {
      const msg = readJson(data);
      if (msg?.t === 'finished') this.events.finished(msg.score);
    }
  }

  update(dt: number, inputs: Partial<Record<Slot, RobotInput>>): void {
    const input = this.mySlot && inputs[this.mySlot];
    if (!input) return;
    const msg = this.input.encode(input);
    this.sendTime -= dt;
    if (this.sendTime > 0) return;
    this.sendTime = Math.max(0, this.sendTime + 1 / INPUT_RATE);
    this.send(this.adminId, msg, true);
  }

  state(): WorldState | null {
    return this.buffer.sample(performance.now() / 1000);
  }

  dispose(): void {
    this.buffer.clear();
  }
}
