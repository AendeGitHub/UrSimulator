import { describe, expect, it } from 'vitest';
import { emptyScore } from '../src/game/scoring';
import { INTERPOLATION_DELAY, SnapshotBuffer, lerpState } from '../src/net/interpolate';
import type { WorldState } from '../src/sim/state';

function world(time: number, x: number, yaw: number, ballX: number, ballState = 0): WorldState {
  return {
    time,
    period: 'practice',
    periodTime: time,
    hiveAngles: { red: 0, blue: 0 },
    tips: { red: 0, blue: 0 },
    score: { red: emptyScore(), blue: emptyScore() },
    robots: [{
      slot: 'red1', robot: 'uran-v1', x, z: 0, yaw, heading: yaw, speed: 0, turretYaw: 0, pitch: 1, flywheel: 0, intakeDir: 0, transfer: false,
      status: 'off', shotSpeed: 0, shotDistance: 0, powers: { fl: 0, fr: 0, bl: 0, br: 0 }, stored: [], voltage: 14, minVoltage: 14,
    }],
    balls: { states: new Uint8Array([ballState]), transforms: new Float32Array([ballX, 0.04, 0, 0, 0, 0, 1]) },
  };
}

describe('snapshot interpolation', () => {
  it('blends robot and ball positions halfway', () => {
    const s = lerpState(world(0, 0, 0, 0), world(1, 2, 0, 1), 0.5);
    expect(s.robots[0].x).toBeCloseTo(1);
    expect(s.balls.transforms[0]).toBeCloseTo(0.5);
  });

  it('turns the short way across ±180°', () => {
    const s = lerpState(world(0, 0, Math.PI - 0.1, 0), world(1, 0, -Math.PI + 0.1, 0), 0.5);
    expect(Math.abs(Math.cos(s.robots[0].yaw) + 1)).toBeLessThan(1e-6);
  });

  it('does not blend a ball that was just shot out of a robot', () => {
    const s = lerpState(world(0, 0, 0, 0, 1), world(1, 0, 0, 3, 0), 0.5);
    expect(s.balls.transforms[0]).toBeCloseTo(3);
  });

  it('renders slightly in the past, between the two newest snapshots', () => {
    const buf = new SnapshotBuffer();
    buf.push(world(10, 0, 0, 0), 100);
    buf.push(world(10 + 1 / 30, 1, 0, 0), 100 + 1 / 30);
    const s = buf.sample(100 + 1 / 30 + INTERPOLATION_DELAY - 1 / 60)!;
    expect(s.robots[0].x).toBeGreaterThan(0);
    expect(s.robots[0].x).toBeLessThan(1);
  });

  it('renders further back when snapshots come in bursts, and closer on a steady stream', () => {
    const lag = (gapsOf: (i: number) => number) => {
      const buf = new SnapshotBuffer();
      let local = 100;
      for (let i = 0; i < 300; i++) {
        local += gapsOf(i);
        buf.push(world(i / 30, i, 0, 0), local);
      }
      // How many snapshots (= x) behind the newest one it draws
      return 299 - buf.sample(local)!.robots[0].x;
    };
    const steady = lag(() => 1 / 30);
    const bursts = lag(i => (i % 3 === 0 ? 0.1 : 0));
    expect(steady).toBeLessThan(3);
    expect(bursts).toBeGreaterThan(steady + 2);
  });
});
