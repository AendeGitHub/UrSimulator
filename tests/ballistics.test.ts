import { describe, expect, it } from 'vitest';
import { GRAVITY, launchVelocity, solveShot } from '../src/game/ballistics';

/** Integrates the flight and returns where the ball is after `t` seconds. */
function fly(launch: [number, number, number], v: [number, number, number], t: number): [number, number, number] {
  return [launch[0] + v[0] * t, launch[1] + v[1] * t - (GRAVITY * t * t) / 2, launch[2] + v[2] * t];
}

describe('auto-aim ballistics', () => {
  const descent = (35 * Math.PI) / 180;

  it('hits the target from a standing robot', () => {
    const launch: [number, number, number] = [-1.5, 0.43, 0.8];
    const target: [number, number, number] = [-0.32, 1.45, 0.35];
    const s = solveShot(launch, target, descent);
    const p = fly(launch, launchVelocity(s.yaw, s.pitch, s.speed), s.time);
    p.forEach((c, i) => expect(c).toBeCloseTo(target[i], 5));
  });

  it('arrives descending at the requested angle', () => {
    const launch: [number, number, number] = [0, 0.4, 0];
    const s = solveShot(launch, [2, 1.4, 0], descent);
    const v = launchVelocity(s.yaw, s.pitch, s.speed);
    const vyAtTarget = v[1] - GRAVITY * s.time;
    expect(Math.atan2(-vyAtTarget, Math.hypot(v[0], v[2]))).toBeCloseTo(descent, 5);
  });

  it('compensates for robot motion', () => {
    const launch: [number, number, number] = [-1, 0.43, 0];
    const target: [number, number, number] = [0, 1.4, 0.5];
    const robotVel: [number, number] = [0.8, -0.5];
    const s = solveShot(launch, target, descent, robotVel);
    const v = launchVelocity(s.yaw, s.pitch, s.speed);
    const p = fly(launch, [v[0] + robotVel[0], v[1], v[2] + robotVel[1]], s.time);
    p.forEach((c, i) => expect(c).toBeCloseTo(target[i], 5));
  });

  it('uses the robot yaw convention (0 = +X, CCW positive)', () => {
    expect(solveShot([0, 0, 0], [1, 1, 0], descent).yaw).toBeCloseTo(0);
    expect(solveShot([0, 0, 0], [0, 1, -1], descent).yaw).toBeCloseTo(Math.PI / 2);
  });

  it('needs more speed for longer shots', () => {
    const near = solveShot([0, 0.4, 0], [1, 1.4, 0], descent);
    const far = solveShot([0, 0.4, 0], [3, 1.4, 0], descent);
    expect(far.speed).toBeGreaterThan(near.speed);
  });
});
