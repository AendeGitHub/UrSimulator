import { describe, expect, it } from 'vitest';
import { GRAVITY, launchVelocity, magnusAccel, solveShot, type ShotSolution, type ShotSpin } from '../src/game/ballistics';

/** Integrates the flight and returns where the ball is after `t` seconds. */
function fly(launch: [number, number, number], v: [number, number, number], t: number): [number, number, number] {
  return [launch[0] + v[0] * t, launch[1] + v[1] * t - (GRAVITY * t * t) / 2, launch[2] + v[2] * t];
}

const pollen = (spin: number): ShotSpin => ({ spin, radius: 0.0711 / 2, mass: 0.045, damping: 0.02, spinDamping: 0.9 });

/**
 * Flies a shot the way the physics does (BallSim's Magnus impulse along ω × v, then gravity and
 * damping, 120 steps a second), spinning about the axis across its launch direction like the
 * shooter makes it, and returns how close it passes to `target`, m.
 */
function flySpinning(launch: [number, number, number], s: ShotSolution, spin: ShotSpin, target: [number, number, number]): number {
  const v = launchVelocity(s.yaw, s.pitch, s.speed);
  const w0 = (spin.spin * s.speed) / spin.radius;
  let w = [-Math.sin(s.yaw) * w0, 0, -Math.cos(s.yaw) * w0];
  let p = [...launch];
  const dt = 1 / 120;
  let closest = Infinity;
  for (let t = 0; t < 2; t += dt) {
    const speed = Math.hypot(...v);
    const c = [w[1] * v[2] - w[2] * v[1], w[2] * v[0] - w[0] * v[2], w[0] * v[1] - w[1] * v[0]];
    const across = Math.hypot(...c);
    if (across > 1e-9) {
      const k = (magnusAccel(speed, across / speed, spin.radius, spin.mass) * dt) / across;
      for (let i = 0; i < 3; i++) v[i] += c[i] * k;
    }
    v[1] -= GRAVITY * dt;
    for (let i = 0; i < 3; i++) v[i] /= 1 + dt * spin.damping;
    w = w.map(x => x / (1 + dt * spin.spinDamping));
    const prev = p;
    p = p.map((x, i) => x + v[i] * dt);
    // Closest approach along this step's segment.
    const d = p.map((x, i) => x - prev[i]);
    const f = Math.max(0, Math.min(1, d.reduce((sum, x, i) => sum + x * (target[i] - prev[i]), 0) / d.reduce((sum, x) => sum + x * x, 0)));
    closest = Math.min(closest, Math.hypot(...prev.map((x, i) => x + d[i] * f - target[i])));
  }
  return closest;
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

  it('a frontspin ball curves down: the aim sends it faster at the same angle, and it still hits', () => {
    const launch: [number, number, number] = [-1.5, 0.33, 0.8];
    const target: [number, number, number] = [-0.32, 1.45, 0.35];
    const plain = solveShot(launch, target, descent);
    const spun = solveShot(launch, target, descent, [0, 0], pollen(1));
    expect(spun.speed).toBeGreaterThan(plain.speed * 1.01);
    expect(spun.pitch).toBeCloseTo(plain.pitch, 6);
    expect(spun.yaw).toBeCloseTo(plain.yaw, 6);
    expect(flySpinning(launch, spun, pollen(1), target)).toBeLessThan(0.01);
    // Sent at the plain speed, the same frontspin ball would pass a few centimeters low.
    expect(flySpinning(launch, plain, pollen(1), target)).toBeGreaterThan(0.025);
  });

  it('allows for any spin, near and far; no spin changes nothing', () => {
    const launch: [number, number, number] = [0, 0.33, 0];
    for (const target of [[0.8, 1.4, 0.3], [2, 1.4, 0.3], [2.6, 1.45, -0.4]] as [number, number, number][]) {
      const plain = solveShot(launch, target, descent);
      for (const spin of [1, 0.25, -0.5]) {
        const s = solveShot(launch, target, descent, [0, 0], pollen(spin));
        expect(Math.abs(s.speed - plain.speed), `${target} ${spin}`).toBeGreaterThan(0.005);
        expect(flySpinning(launch, s, pollen(spin), target), `${target} ${spin}`).toBeLessThan(0.01);
      }
      expect(solveShot(launch, target, descent, [0, 0], pollen(0))).toEqual(plain);
    }
  });

  it('spin lifts more the faster it turns, and levels off', () => {
    const lift = (spin: number) => magnusAccel(5, (spin * 5) / 0.0356, 0.0356, 0.045);
    expect(lift(0)).toBe(0);
    expect(lift(0.25)).toBeGreaterThan(0);
    expect(lift(1)).toBeGreaterThan(lift(0.25));
    // A POLLEN turning as if it rolled through the air at 5 m/s: about a twentieth of g.
    expect(lift(1) / GRAVITY).toBeGreaterThan(0.035);
    expect(lift(1) / GRAVITY).toBeLessThan(0.06);
    expect(lift(100) / lift(1)).toBeLessThan(1.6);
  });
});
