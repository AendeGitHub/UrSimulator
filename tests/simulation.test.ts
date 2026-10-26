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

  /** Takes the 3 staged NECTAR out of the red cell so it starts empty. */
  function emptyRedCell(sim: Simulation) {
    sim.hives.red.ballsInUpCell(sim.balls).forEach((b, i) => sim.balls.release(b, [-1.2 + i * 0.15, b.radius, -1.4], [0, 0, 0]));
  }

  /** Drops balls of one kind into the upward red cell in a loose grid. */
  function dropIntoRedCell(sim: Simulation, kind: 'pollen' | 'nectar', n: number) {
    const hive = sim.hives.red;
    const f = cellFrame('red', 'pos', hive.pivot, hive.angle);
    const balls = sim.balls.all.filter(b => b.kind === kind && b.state !== 'held' && (kind === 'pollen' || b.color === 'red') && !hive.ballsInUpCell(sim.balls).includes(b)).slice(0, n);
    expect(balls).toHaveLength(n);
    // Slots inside the cell volume: 4 across, 2 deep (along the opening), 2 high (below the roof).
    balls.forEach((b, i) => {
      const [x, u, w] = [-0.18 + (i % 4) * 0.12, Math.floor(i / 4) % 2 ? 0.07 : -0.07, Math.floor(i / 8) ? 0.02 : -0.09];
      const p: [number, number, number] = [0, 1, 2].map(k => f.center[k] + (k === 0 ? x : 0) + f.u[k] * u + f.w[k] * w) as [number, number, number];
      sim.balls.release(b, p, [0, 0, 0]);
    });
  }

  it('starts with 3 NECTAR in the cell (weight 6): 4 POLLEN make 10 and it tips 3 s later', () => {
    const { sim } = makeSim();
    sim.start('practice');
    fillRedCell(sim, 4);
    run(sim, 2.4);
    expect(sim.hives.red.tips).toBe(0);
    expect(sim.hives.red.tipPending).toBeGreaterThan(0.5);
    run(sim, 1.6);
    expect(sim.hives.red.tips).toBe(1);
  });

  it('an empty cell tips with 10 POLLEN but not with 9', () => {
    for (const [n, tips] of [[9, 0], [10, 1]] as const) {
      const { sim } = makeSim();
      sim.start('practice');
      emptyRedCell(sim);
      dropIntoRedCell(sim, 'pollen', n);
      run(sim, 2);
      // All of them landed in the cell and count; NECTAR would count double.
      expect(sim.hives.red.ballsInUpCell(sim.balls)).toHaveLength(n);
      run(sim, 2);
      expect(sim.hives.red.tips).toBe(tips);
    }
  });

  it('5 NECTAR weigh as much as 10 POLLEN and tip it', () => {
    const { sim } = makeSim();
    sim.start('practice');
    // 3 NECTAR are already in the cell; 2 more make 5.
    dropIntoRedCell(sim, 'nectar', 2);
    run(sim, 5);
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

describe('plastic balls', () => {
  beforeAll(() => initPhysics());

  it('barely bounce on the foam tiles and roll to a stop', () => {
    for (const kind of ['pollen', 'nectar'] as const) {
      const { sim } = makeSim();
      sim.start('practice');
      const b = sim.balls.all.find(x => x.kind === kind && x.state === 'field')!;
      sim.balls.release(b, [0.9, 1.0, -1.0], [0, 0, 0]);
      let landed = false;
      let bounce = 0;
      for (let i = 0; i < 240; i++) {
        sim.step();
        const y = sim.balls.position(b)[1] - b.radius;
        if (y < 0.005) landed = true;
        if (landed) bounce = Math.max(bounce, y);
      }
      expect(bounce).toBeLessThan(0.08);
      // Pushed at 1 m/s along the floor it stops within about a metre.
      sim.balls.release(b, [-1.0, b.radius, -1.2], [1, 0, 0]);
      run(sim, 6);
      expect(sim.balls.position(b)[0] + 1.0).toBeLessThan(1.4);
      expect(b.body.linvel().x).toBeLessThan(0.05);
    }
  });
});

describe('balls that leave the field (manual 10.8.2)', () => {
  beforeAll(() => initPhysics());

  it('POLLEN comes back inside the nearest wall after 5 s', () => {
    const { sim } = makeSim();
    sim.start('practice');
    const b = sim.balls.all.find(x => x.kind === 'pollen' && x.state === 'field')!;
    const wall = sim.zones.wall;
    sim.balls.release(b, [0.4, b.radius, wall + 0.6], [0, 0, 0]);
    run(sim, 4.5);
    expect(sim.balls.position(b)[2]).toBeGreaterThan(wall);
    run(sim, 1);
    const [x, , z] = sim.balls.position(b);
    expect(b.state).toBe('field');
    expect(Math.abs(z)).toBeLessThan(wall);
    expect(z).toBeGreaterThan(wall - 0.3);
    expect(Math.abs(x - 0.4)).toBeLessThan(0.7);
  });

  it('NECTAR goes back to its human player, who may enter it again right away (G427)', () => {
    const { sim } = makeSim();
    sim.addRobot('blue1', 'test');
    sim.start('match');
    const b = sim.balls.all.find(x => x.kind === 'nectar' && x.color === 'red' && x.state === 'field')!;
    sim.balls.release(b, [-sim.zones.wall - 0.5, b.radius, 0.3], [0, 0, 0]);
    run(sim, 5.2);
    expect(b.state).toBe('staged');
    expect(b.returned).toBe(true);
    // No hive has tipped, so fresh NECTAR may not be entered yet — but the returned one may.
    run(sim, 2);
    expect(b.state).toBe('field');
    const fresh = sim.balls.all.filter(x => x.kind === 'nectar' && x.color === 'red' && x.homeState === 'staged');
    expect(fresh.every(x => x.state === 'staged')).toBe(true);
  });
});

describe('turret wiring and battery', () => {
  beforeAll(() => initPhysics());

  it('turns at most half a turn either way and unwinds instead of spinning through the back', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    let max = 0;
    let swings = 0;
    let last = p.mech.turretYaw;
    // Spin the robot on the spot for several turns; the turret has to keep tracking the hive.
    for (let i = 0; i < Math.round(8 / PHYSICS_DT); i++) {
      sim.setInput('red1', { ...idleInput(), rx: 0.5 });
      sim.step();
      max = Math.max(max, Math.abs(p.mech.turretYaw));
      if (Math.abs(p.mech.turretYaw - last) > 0.03) swings++;
      last = p.mech.turretYaw;
    }
    expect(max).toBeLessThanOrEqual(Math.PI + 1e-6);
    expect(max).toBeGreaterThan(2.5);
    // Unwinding shows up as steps at full turret speed against the robot's turn.
    expect(swings).toBeGreaterThan(0);
  });

  it('starts at 14 V; a flywheel left running drains it and the robot gets slower', () => {
    const top = (drain: boolean) => {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test');
      sim.start('practice');
      expect(p.robot.battery.voltage).toBeCloseTo(14, 5);
      if (drain) sim.setInput('red1', { ...idleInput(), shooterOn: true });
      run(sim, 90);
      sim.setInput('red1', { ...idleInput(), shooterOff: true });
      run(sim, 3);
      p.robot.setPose({ x: -1.4, z: 0, yaw: 0 });
      sim.setInput('red1', { ...idleInput(), ly: -1 });
      let best = 0;
      for (let i = 0; i < Math.round(0.9 / PHYSICS_DT); i++) {
        sim.step();
        best = Math.max(best, p.robot.speed);
      }
      return { best, volts: p.robot.battery.minVoltage };
    };
    const fresh = top(false);
    const tired = top(true);
    expect(fresh.volts).toBeGreaterThan(13);
    expect(tired.volts).toBeLessThan(13);
    expect(tired.best).toBeLessThan(fresh.best * 0.95);
  });
});

describe('transfer', () => {
  beforeAll(() => initPhysics());

  it('also runs the intake: a ball picked up while feeding goes straight out of the shooter', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.robot.setPose({ x: -0.9, z: -1.2, yaw: 0 });
    p.mech.reset([]);
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1.5);
    // A ball right at the front rollers once the flywheel is up to speed.
    const b = sim.balls.all.find(x => x.kind === 'pollen' && x.state === 'field')!;
    const [x, , z] = p.robot.position;
    sim.balls.release(b, [x + p.robot.cfg.length / 2 + 0.04, b.radius, z], [0, 0, 0]);
    // Picked up and fed in the same step: the ball goes straight out of the shooter.
    let flew = false;
    for (let i = 0; i < Math.round(2 / PHYSICS_DT); i++) {
      sim.setInput('red1', { ...idleInput(), transfer: true });
      sim.step();
      if (sim.balls.position(b)[1] > 0.3) flew = true;
    }
    expect(flew).toBe(true);
    expect(p.mech.stored).toHaveLength(0);
    expect(p.mech.intakeDir).toBe(1);
  });
});
