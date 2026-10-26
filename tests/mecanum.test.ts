import { describe, expect, it } from 'vitest';
import { chassisSpeeds, fieldCentric, forwardVector, mecanumPowers, rightVector, wrapAngle } from '../src/robot/mecanum';

const cfg = { maxWheelSpeed: 2, strafeEfficiency: 0.8, trackWidth: 0.4, wheelBase: 0.3 };

describe('mecanum drive', () => {
  it('drives straight forward with all wheels equal', () => {
    const p = mecanumPowers(1, 0, 0);
    expect(p).toEqual({ fl: 1, fr: 1, bl: 1, br: 1 });
    const s = chassisSpeeds(p, cfg);
    expect(s.forward).toBeCloseTo(2);
    expect(s.right).toBeCloseTo(0);
    expect(s.turnCw).toBeCloseTo(0);
  });

  it('strafes right with the FTC wheel pattern and loses some speed', () => {
    const p = mecanumPowers(0, 1, 0);
    expect(p).toEqual({ fl: 1, fr: -1, bl: -1, br: 1 });
    const s = chassisSpeeds(p, cfg);
    expect(s.forward).toBeCloseTo(0);
    expect(s.right).toBeCloseTo(1.6);
  });

  it('turns clockwise for positive turn input', () => {
    const s = chassisSpeeds(mecanumPowers(0, 0, 1), cfg);
    expect(s.turnCw).toBeCloseTo(2 / 0.35);
    expect(s.forward).toBeCloseTo(0);
  });

  it('normalizes so no wheel power exceeds 1', () => {
    const p = mecanumPowers(1, 1, 1);
    for (const v of Object.values(p)) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('uses yaw 0 = +X forward and +Z right', () => {
    expect(forwardVector(0)).toEqual([1, -0]);
    expect(rightVector(0)).toEqual([0, 1]);
    const [fx, fz] = forwardVector(Math.PI / 2); // turned left (CCW)
    expect(fx).toBeCloseTo(0);
    expect(fz).toBeCloseTo(-1);
  });
});

describe('field-centric', () => {
  it('passes input through when the robot faces away from the driver', () => {
    const r = fieldCentric(1, 0.5, 0);
    expect(r.forward).toBeCloseTo(1);
    expect(r.strafe).toBeCloseTo(0.5);
  });

  it('strafes right when the robot faces the driver-left and the stick is pushed up', () => {
    const r = fieldCentric(1, 0, Math.PI / 2);
    expect(r.forward).toBeCloseTo(0);
    expect(r.strafe).toBeCloseTo(1);
  });

  it('drives backward when the robot faces the driver', () => {
    const r = fieldCentric(1, 0, Math.PI);
    expect(r.forward).toBeCloseTo(-1);
  });

  it('wraps angles', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
  });
});
