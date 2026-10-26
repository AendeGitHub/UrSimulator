import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { parseColliders } from '../src/sim/colliders';
import { PHYSICS_DT, Simulation, initPhysics } from '../src/sim/Simulation';
import { decodeState, encodeState } from '../src/sim/state';
import { idleInput } from '../src/sim/types';
import { cellFrame } from '../src/field/hiveGeometry';
import { total } from '../src/game/scoring';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

function makeSim() {
  const toasts: string[] = [];
  const sim = new Simulation(layout, colliders, { toast: t => toasts.push(t), finished: () => toasts.push('finished') });
  return { sim, toasts };
}

const run = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) sim.step();
};

describe('headless simulation', () => {
  beforeAll(() => initPhysics());

  it('drives a robot forward with the FTC stick convention', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.start('practice');
    const x0 = sim.robots.get('red1')!.robot.position[0];
    sim.setInput('red1', { ...idleInput(), ly: -1 });
    run(sim, 0.4);
    expect(sim.robots.get('red1')!.robot.position[0] - x0).toBeGreaterThan(0.3);
  });

  it('tips the red hive with the 4 pre-loads from in front of the opening (3 NECTAR + 4 POLLEN = 10)', () => {
    const { sim, toasts } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    sim.setInput('red1', { ...idleInput(), transfer: true });
    run(sim, 1.5);
    sim.setInput('red1', idleInput());
    run(sim, 6.5); // a full cell takes up to 5 s to drop
    expect(sim.hives.red.tips).toBe(1);
    expect(toasts.some(t => t.includes('улей перевернулся'))).toBe(true);
  });

  it('supports four robots and round-trips the state through a snapshot', () => {
    const { sim } = makeSim();
    for (const s of ['red1', 'red2', 'blue1', 'blue2'] as const) sim.addRobot(s, s);
    sim.start('match');
    run(sim, 0.2);
    const state = sim.state();
    const decoded = decodeState(encodeState(state));
    expect(decoded.robots.map(r => r.slot)).toEqual(['red1', 'red2', 'blue1', 'blue2']);
    expect(decoded.robots[0].stored).toHaveLength(4);
    expect(decoded.period).toBe('auto');
    expect(decoded.robots[2].x).toBeCloseTo(state.robots[2].x, 4);
    for (let i = 0; i < state.balls.transforms.length; i += 7) {
      expect(decoded.balls.transforms[i]).toBeCloseTo(state.balls.transforms[i], 2);
    }
    expect(encodeState(state).byteLength).toBeLessThan(1500);
  });
});

describe('URAN V1 rules', () => {
  beforeAll(() => initPhysics());

  it('stacked POLLEN in a flower falls when the bottom one is taken', () => {
    const { sim } = makeSim();
    sim.start('practice');
    const [fx, fz] = sim.zones.flowers[0];
    const inFlower = sim.balls.all
      .filter(b => b.state === 'field' && Math.hypot(sim.balls.position(b)[0] - fx, sim.balls.position(b)[2] - fz) < 0.05)
      .sort((a, b) => sim.balls.position(a)[1] - sim.balls.position(b)[1]);
    expect(inFlower.length).toBe(4);
    const secondY = sim.balls.position(inFlower[1])[1];
    sim.balls.hold(inFlower[0]);
    run(sim, 1);
    expect(sim.balls.position(inFlower[1])[1]).toBeLessThan(secondY - 0.04);
  });

  it('cannot pull POLLEN out of a flower with the intake', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, 0], [0, 0, 0]));
    // Flower on the red wall at (-1.73, 0.59): face it from the field side and push in with the intake on.
    const [fx, fz] = sim.zones.flowers.find(([x]) => x < -1.5)!;
    p.robot.setPose({ x: fx + 0.45, z: fz, yaw: Math.PI });
    sim.setInput('red1', { ...idleInput(), intake: true, ly: -0.3, fieldCentric: false });
    run(sim, 1.5);
    expect(p.mech.stored).toHaveLength(0);
  });

  it('drives faster than the old placeholder: 518 RPM on 82 mm mecanum wheels', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.robot.setPose({ x: -1.2, z: -1.2, yaw: 0 });
    sim.setInput('red1', { ...idleInput(), ly: -1, fieldCentric: false });
    run(sim, 0.6);
    expect(p.robot.speed).toBeGreaterThan(2.0);
  });
});

describe('hive tipping delay', () => {
  beforeAll(() => initPhysics());

  /** Drops `n` POLLEN straight into the upward red cell (3 NECTAR already there = weight 6). */
  function fillRedCell(sim: Simulation, n: number) {
    const hive = sim.hives.red;
    const f = cellFrame('red', 'pos', hive.pivot, hive.angle);
    const pollen = sim.balls.all.filter(b => b.kind === 'pollen' && b.state === 'field').slice(0, n);
    pollen.forEach((b, i) => {
      const p: [number, number, number] = [f.center[0] - 0.15 + (i % 4) * 0.08, f.center[1] + 0.05 + Math.floor(i / 4) * 0.08, f.center[2]];
      sim.balls.release(b, p, [0, 0, 0]);
    });
  }

  it('with exactly the tip weight (3 NECTAR + 4 POLLEN = 10) it holds about 5 s', () => {
    const { sim } = makeSim();
    sim.start('practice');
    fillRedCell(sim, 4);
    run(sim, 4);
    expect(sim.hives.red.tips).toBe(0);
    expect(sim.hives.red.tipPending).toBeGreaterThan(0.6);
    run(sim, 2.5);
    expect(sim.hives.red.tips).toBe(1);
  });

  it('heavier than that it tips after about 3 s', () => {
    const { sim } = makeSim();
    sim.start('practice');
    fillRedCell(sim, 6);
    run(sim, 2.4);
    expect(sim.hives.red.tips).toBe(0);
    run(sim, 1.6);
    expect(sim.hives.red.tips).toBe(1);
  });
});

describe('G408: opponent NECTAR', () => {
  beforeAll(() => initPhysics());

  it('warns, then a yellow card, then a red card that zeroes the score', () => {
    const { sim, toasts } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('match');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const blue = sim.balls.all.filter(b => b.kind === 'nectar' && b.color === 'blue' && b.state === 'staged').slice(0, 3);
    const score = sim.match.score.red;
    for (const [i, b] of blue.entries()) {
      p.robot.setPose({ x: -1.0, z: -0.8 + i * 0.5, yaw: 0 });
      sim.balls.release(b, [-1.0 + 0.3, 0.05, -0.8 + i * 0.5], [0, 0, 0]);
      sim.setInput('red1', { ...idleInput(), intake: true });
      run(sim, 0.3);
      expect(p.mech.stored).toContain(b);
    }
    expect(score.warnings).toBe(1);
    expect(score.yellowCards).toBe(1);
    expect(score.redCards).toBe(1);
    score.leave = 1;
    expect(total(score)).toBe(0);
    expect(toasts.some(t => t.includes('G408'))).toBe(true);
  });
});
