// World state for rendering, and its compact binary form for network snapshots.

import { emptyScore, type AllianceScore } from '../game/scoring';
import type { WheelPowers } from '../robot/mecanum';
import type { Alliance } from '../robot/robotConfig';
import { PERIODS, type Period } from './Match';
import type { ShooterStatus } from './Mechanisms';
import { SLOTS, type Slot } from './types';
import { ROBOTS, robotById } from '../robot/robots';

export interface RobotState {
  slot: Slot;
  /** Robot id (robots.ts) */
  robot: string;
  x: number;
  z: number;
  yaw: number;
  heading: number;
  speed: number;
  turretYaw: number;
  pitch: number;
  flywheel: number;
  intakeDir: number;
  status: ShooterStatus;
  shotSpeed: number;
  shotDistance: number;
  powers: WheelPowers;
  /** Ball ids in the hopper, next to shoot first */
  stored: number[];
}

export interface WorldState {
  time: number;
  period: Period;
  periodTime: number;
  hiveAngles: Record<Alliance, number>;
  tips: Record<Alliance, number>;
  score: Record<Alliance, AllianceScore>;
  robots: RobotState[];
  balls: {
    /** 0 field, 1 held, 2 staged */
    states: Uint8Array;
    /** x, y, z, qx, qy, qz, qw per ball */
    transforms: Float32Array;
  };
}

const STATUSES: ShooterStatus[] = ['off', 'spinning', 'ready', 'tooFar'];
const SCORE_FIELDS = ['leave', 'autoPark', 'autoTips', 'teleopTips', 'teleopPark'] as const;
const FIELD_FIELDS = ['cellElements', 'flowerBottom', 'ownedFlowerElements', 'gardenElements'] as const;
const VERSION = 2;

/** Little binary writer/reader so snapshots stay ~1 KB instead of ~10 KB of JSON. */
class Writer {
  private buf = new ArrayBuffer(4096);
  private view = new DataView(this.buf);
  offset = 0;
  private ensure(n: number) {
    if (this.offset + n <= this.buf.byteLength) return;
    const bigger = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(bigger).set(new Uint8Array(this.buf));
    this.buf = bigger;
    this.view = new DataView(bigger);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.offset, v); this.offset += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.offset, v, true); this.offset += 2; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; }
  done(): ArrayBuffer { return this.buf.slice(0, this.offset); }
}

class Reader {
  private readonly view: DataView;
  offset = 0;
  constructor(buf: ArrayBuffer) { this.view = new DataView(buf); }
  u8() { return this.view.getUint8(this.offset++); }
  i8() { return this.view.getInt8(this.offset++); }
  u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
}

const clampI16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));

export function encodeState(s: WorldState): ArrayBuffer {
  const w = new Writer();
  w.u8(VERSION);
  w.f32(s.time);
  w.u8(PERIODS.indexOf(s.period));
  w.f32(s.periodTime);
  for (const a of ['red', 'blue'] as const) {
    w.f32(s.hiveAngles[a]);
    w.u8(s.tips[a]);
    for (const k of SCORE_FIELDS) w.u8(s.score[a][k]);
    for (const k of FIELD_FIELDS) w.u8(s.score[a].field[k]);
  }
  w.u8(s.robots.length);
  for (const r of s.robots) {
    w.u8(SLOTS.indexOf(r.slot));
    w.u8(Math.max(0, ROBOTS.indexOf(robotById(r.robot))));
    for (const v of [r.x, r.z, r.yaw, r.heading, r.speed, r.turretYaw, r.pitch, r.flywheel, r.shotSpeed, r.shotDistance]) w.f32(v);
    w.i8(r.intakeDir);
    w.u8(STATUSES.indexOf(r.status));
    for (const v of [r.powers.fl, r.powers.fr, r.powers.bl, r.powers.br]) w.i8(Math.round(v * 127));
    w.u8(r.stored.length);
    for (const id of r.stored) w.u8(id);
  }
  const n = s.balls.states.length;
  w.u16(n);
  for (let i = 0; i < n; i++) {
    w.u8(s.balls.states[i]);
    const t = s.balls.transforms;
    // Millimetres and unit-quaternion components fit in 16 bits.
    for (let k = 0; k < 3; k++) w.i16(clampI16(t[i * 7 + k] * 1000));
    for (let k = 3; k < 7; k++) w.i16(clampI16(t[i * 7 + k] * 32767));
  }
  return w.done();
}

export function decodeState(buf: ArrayBuffer): WorldState {
  const r = new Reader(buf);
  if (r.u8() !== VERSION) throw new Error('snapshot version mismatch');
  const time = r.f32();
  const period = PERIODS[r.u8()];
  const periodTime = r.f32();
  const hiveAngles = { red: 0, blue: 0 };
  const tips = { red: 0, blue: 0 };
  const score = { red: emptyScore(), blue: emptyScore() };
  for (const a of ['red', 'blue'] as const) {
    hiveAngles[a] = r.f32();
    tips[a] = r.u8();
    for (const k of SCORE_FIELDS) score[a][k] = r.u8();
    for (const k of FIELD_FIELDS) score[a].field[k] = r.u8();
  }
  const robots: RobotState[] = [];
  const count = r.u8();
  for (let i = 0; i < count; i++) {
    const slot = SLOTS[r.u8()];
    const robot = (ROBOTS[r.u8()] ?? ROBOTS[0]).id;
    const [x, z, yaw, heading, speed, turretYaw, pitch, flywheel, shotSpeed, shotDistance] = Array.from({ length: 10 }, () => r.f32());
    const intakeDir = r.i8();
    const status = STATUSES[r.u8()];
    const [fl, fr, bl, br] = Array.from({ length: 4 }, () => r.i8() / 127);
    const stored = Array.from({ length: r.u8() }, () => r.u8());
    robots.push({ slot, robot, x, z, yaw, heading, speed, turretYaw, pitch, flywheel, intakeDir, status, shotSpeed, shotDistance, powers: { fl, fr, bl, br }, stored });
  }
  const n = r.u16();
  const states = new Uint8Array(n);
  const transforms = new Float32Array(n * 7);
  for (let i = 0; i < n; i++) {
    states[i] = r.u8();
    for (let k = 0; k < 3; k++) transforms[i * 7 + k] = r.i16() / 1000;
    for (let k = 3; k < 7; k++) transforms[i * 7 + k] = r.i16() / 32767;
  }
  return { time, period, periodTime, hiveAngles, tips, score, robots, balls: { states, transforms } };
}
