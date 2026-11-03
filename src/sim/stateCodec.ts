// Compact binary form of the world state, for online snapshots (about 1 KB instead of ~10 KB of
// JSON). Referee calls are not in it: they go with the final score.

import { emptyScore } from '../game/scoring';
import { ROBOTS, isCustomRobotId, robotById } from '../robot/robots';
import { PERIODS } from './Match';
import type { ShooterStatus } from './Mechanisms';
import type { RobotState, TurretState, WorldState } from './state';
import { SLOTS } from './types';

const STATUSES: ShooterStatus[] = ['off', 'spinning', 'ready', 'tooFar'];
const SCORE_FIELDS = ['leave', 'autoPark', 'autoTips', 'teleopTips', 'teleopPark', 'warnings', 'yellowCards', 'redCards', 'minorFouls', 'majorFouls'] as const;
const FIELD_FIELDS = ['cellElements', 'flowerBottom', 'ownedFlowerElements', 'gardenElements'] as const;
const VERSION = 8;
/**
 * A snapshot with a player-made robot in it (robot/custom.ts): that robot's byte is CUSTOM and its
 * id follows as text. Otherwise it is the same, so older replays still play; older apps refuse it.
 */
const VERSION_CUSTOM = 9;
/**
 * A snapshot with a robot of three or more turrets in it (a player's): each robot has the count of
 * its other turrets and their numbers where the others have their second turret's. Older apps refuse it.
 */
const VERSION_TURRETS = 10;
/**
 * A snapshot with a robot that has a lift in it: like VERSION_TURRETS, with
 * each robot's lift, the balls in its box (count, then ids), how high they stand (mm) and the ball
 * leaving it (none: 255; else its id, how long it has been on its way in 2 ms steps, then 1 and
 * where it drops into a FLOWER in mm, or 0) after its arm. Older apps refuse it.
 */
const VERSION_LIFT = 11;
const CUSTOM = 255;
/** A robot without a second turret has these numbers in its place in older snapshots */
const NO_TURRET: TurretState = { yaw: 0, pitch: 0.9, flywheel: 0 };
/** An empty push back (ball ids are below 255) */
const NO_BALL = 255;
/** Team robots by the number snapshots and replays give them: their place in ROBOTS, with the 8th reserved (DHB is the 9th) */
const TEAM_IDS: (string | null)[] = [...ROBOTS.slice(0, 7).map(d => d.id), null, ...ROBOTS.slice(7).map(d => d.id)];

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
  text(v: string) { const bytes = new TextEncoder().encode(v.slice(0, 32)); this.u8(bytes.length); for (const b of bytes) this.u8(b); }
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
  text() { const n = this.u8(); const bytes = new Uint8Array(this.view.buffer, this.offset, n); this.offset += n; return new TextDecoder().decode(bytes); }
}

const clampI16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));

function writeTurret(w: Writer, t: TurretState): void {
  w.f32(t.yaw);
  w.f32(t.pitch);
  w.u8(Math.round(Math.min(1, t.flywheel) * 255));
}

const readTurret = (r: Reader): TurretState => ({ yaw: r.f32(), pitch: r.f32(), flywheel: r.u8() / 255 });

export function encodeState(s: WorldState): ArrayBuffer {
  const w = new Writer();
  const version = s.robots.some(r => robotById(r.robot).lift) ? VERSION_LIFT
    : s.robots.some(r => r.extraTurrets.length > 1) ? VERSION_TURRETS : s.robots.some(r => isCustomRobotId(r.robot)) ? VERSION_CUSTOM : VERSION;
  const turretCounts = version === VERSION_TURRETS || version === VERSION_LIFT;
  w.u8(version);
  w.f32(s.time);
  w.u8(PERIODS.indexOf(s.period));
  w.f32(s.periodTime);
  for (const a of ['red', 'blue'] as const) {
    w.f32(s.hiveAngles[a]);
    w.u8(s.tips[a]);
    for (const k of SCORE_FIELDS) w.u8(s.score[a][k]);
    w.u16(s.score[a].foulPoints);
    for (const k of FIELD_FIELDS) w.u8(s.score[a].field[k]);
  }
  w.u8(s.robots.length);
  for (const r of s.robots) {
    w.u8(SLOTS.indexOf(r.slot));
    const team = TEAM_IDS.indexOf(r.robot);
    if (team < 0 && isCustomRobotId(r.robot)) {
      w.u8(CUSTOM);
      w.text(r.robot);
    } else {
      w.u8(Math.max(0, team));
    }
    for (const v of [r.x, r.z, r.yaw, r.heading, r.speed, r.turretYaw, r.pitch, r.flywheel, r.shotSpeed, r.shotDistance]) w.f32(v);
    w.i8(r.intakeDir);
    // The transfer, and the lift's box rollers (only a lift's robot has them running) in bit 1.
    w.u8((r.transfer ? 1 : 0) | (r.boxRollers ? 2 : 0));
    w.u8(STATUSES.indexOf(r.status));
    for (const v of [r.powers.fl, r.powers.fr, r.powers.bl, r.powers.br]) w.i8(Math.round(v * 127));
    w.u8(r.stored.length);
    for (const id of r.stored) w.u8(id);
    w.u8(r.pocket ?? NO_BALL);
    // Centivolts, like the Driver Station's two decimals.
    w.u16(Math.round(r.voltage * 100));
    w.u16(Math.round(r.minVoltage * 100));
    w.u8(Math.round(r.arm * 255));
    if (version === VERSION_LIFT) {
      w.u8(Math.round(r.lift * 255));
      w.u8(r.box.length);
      for (const id of r.box) w.u8(id);
      w.u16(Math.round(Math.max(0, r.boxTop) * 1000));
      w.u8(r.boxExit ? r.boxExit.id : NO_BALL);
      if (r.boxExit) {
        w.u8(Math.min(255, Math.round(r.boxExit.t * 500)));
        w.u8(r.boxExit.to ? 1 : 0);
        if (r.boxExit.to) for (const v of r.boxExit.to) w.i16(clampI16(v * 1000));
      }
    }
    if (turretCounts) {
      w.u8(r.extraTurrets.length);
      for (const t of r.extraTurrets) writeTurret(w, t);
    } else {
      writeTurret(w, r.extraTurrets[0] ?? NO_TURRET);
    }
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
  const version = r.u8();
  if (version !== VERSION && version !== VERSION_CUSTOM && version !== VERSION_TURRETS && version !== VERSION_LIFT) throw new Error('snapshot version mismatch');
  const turretCounts = version === VERSION_TURRETS || version === VERSION_LIFT;
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
    score[a].foulPoints = r.u16();
    for (const k of FIELD_FIELDS) score[a].field[k] = r.u8();
  }
  const robots: RobotState[] = [];
  const count = r.u8();
  for (let i = 0; i < count; i++) {
    const slot = SLOTS[r.u8()];
    const index = r.u8();
    const robot = index === CUSTOM ? r.text() : TEAM_IDS[index] ?? ROBOTS[0].id;
    const [x, z, yaw, heading, speed, turretYaw, pitch, flywheel, shotSpeed, shotDistance] = Array.from({ length: 10 }, () => r.f32());
    const intakeDir = r.i8();
    const running = r.u8();
    const transfer = (running & 1) !== 0;
    const boxRollers = (running & 2) !== 0;
    const status = STATUSES[r.u8()];
    const [fl, fr, bl, br] = Array.from({ length: 4 }, () => r.i8() / 127);
    const stored = Array.from({ length: r.u8() }, () => r.u8());
    const pocketId = r.u8();
    const pocket = pocketId === NO_BALL ? null : pocketId;
    const voltage = r.u16() / 100;
    const minVoltage = r.u16() / 100;
    const arm = r.u8() / 255;
    const lift = version === VERSION_LIFT ? r.u8() / 255 : 0;
    const box = version === VERSION_LIFT ? Array.from({ length: r.u8() }, () => r.u8()) : [];
    let boxTop = 0;
    let boxExit: RobotState['boxExit'] = null;
    if (version === VERSION_LIFT) {
      boxTop = r.u16() / 1000;
      const id = r.u8();
      if (id !== NO_BALL) boxExit = { id, t: r.u8() / 500, to: r.u8() ? [r.i16() / 1000, r.i16() / 1000, r.i16() / 1000] : null };
    }
    let extraTurrets: TurretState[];
    if (turretCounts) {
      extraTurrets = Array.from({ length: r.u8() }, () => readTurret(r));
    } else {
      // Every robot has room for a second turret in these.
      const second = readTurret(r);
      extraTurrets = robotById(robot).extraTurrets ? [second] : [];
    }
    robots.push({ slot, robot, x, z, yaw, heading, speed, turretYaw, pitch, flywheel, intakeDir, transfer, status, shotSpeed, shotDistance, powers: { fl, fr, bl, br }, stored, box, boxTop, boxExit, pocket, voltage, minVoltage, arm, lift, boxRollers, extraTurrets });
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
