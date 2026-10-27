import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { parseColliders } from '../src/sim/colliders';
import { PHYSICS_DT, Simulation, initPhysics } from '../src/sim/Simulation';
import { idleInput } from '../src/sim/types';
import { cellFrame } from '../src/field/hiveGeometry';
import { total } from '../src/game/scoring';
import type { Ball } from '../src/sim/BallSim';
import { ROBOTS, URAN_V2, robotById } from '../src/robot/robots';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

/** No robot in the game takes NECTAR yet; the NECTAR rules are tested with this one. */
const NECTAR_ROBOT = 'test-nectar';
ROBOTS.push({ ...URAN_V2, id: NECTAR_ROBOT, intakes: ['pollen', 'nectar'] });

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

  it('tips the red hive with the 4 pre-loads from in front of the opening (3 NECTAR + 4 POLLEN ≥ 8 POLLEN)', () => {
    const { sim, toasts } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    // All 4 balls in 0.4 s (URAN V2's rapid fire)
    sim.setInput('red1', { ...idleInput(), transfer: true });
    run(sim, 2.2);
    sim.setInput('red1', idleInput());
    run(sim, 6.5); // 3 s on the dampers, then 1.8 s to turn over
    expect(sim.hives.red.tips).toBe(1);
    expect(toasts.some(t => t.includes('улей перевернулся'))).toBe(true);
  });

  it('supports four robots', () => {
    const { sim } = makeSim();
    for (const s of ['red1', 'red2', 'blue1', 'blue2'] as const) sim.addRobot(s, s);
    sim.start('match');
    run(sim, 0.2);
    const state = sim.state();
    expect(state.robots.map(r => r.slot)).toEqual(['red1', 'red2', 'blue1', 'blue2']);
    expect(state.robots[0].stored).toHaveLength(4);
    expect(state.period).toBe('auto');
    expect(state.robots.map(r => r.arm)).toEqual([0, 0, 0, 0]);
  });
});

describe('URAN V2 rules', () => {
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

  it('starts with 3 NECTAR in the cell (24 of 40): 4 POLLEN tip it 3 s later', () => {
    const { sim } = makeSim();
    sim.start('practice');
    fillRedCell(sim, 4);
    run(sim, 2.4);
    expect(sim.hives.red.tips).toBe(0);
    expect(sim.hives.red.tipPending).toBeGreaterThan(0.5);
    // The rest of the 3 s, then 1.8 s to turn over
    run(sim, 2.6);
    expect(sim.hives.red.tips).toBe(1);
  });

  it('an empty cell tips with 8 POLLEN but not with 7', () => {
    for (const [n, tips] of [[7, 0], [8, 1]] as const) {
      const { sim } = makeSim();
      sim.start('practice');
      emptyRedCell(sim);
      dropIntoRedCell(sim, 'pollen', n);
      run(sim, 2);
      // All of them landed in the cell and count; NECTAR would count double.
      expect(sim.hives.red.ballsInUpCell(sim.balls)).toHaveLength(n);
      run(sim, 3);
      expect(sim.hives.red.tips).toBe(tips);
    }
  });

  it('5 NECTAR tip it like 8 POLLEN, 4 do not', () => {
    for (const [n, tips] of [[1, 0], [2, 1]] as const) {
      const { sim } = makeSim();
      sim.start('practice');
      // 3 NECTAR are already in the cell; 1 more makes 4, 2 more make 5.
      dropIntoRedCell(sim, 'nectar', n);
      run(sim, 6);
      expect(sim.hives.red.tips).toBe(tips);
    }
  });
});

describe('referee (manual 11.4)', () => {
  beforeAll(() => initPhysics());

  /** Puts `b` right in front of the robot's intake and runs the intake. */
  function intake(sim: Simulation, slot: 'red1' | 'blue1', b: Ball, x: number, z: number) {
    const p = sim.robots.get(slot)!;
    p.robot.setPose({ x, z, yaw: slot === 'red1' ? 0 : Math.PI });
    const mouth = robotById(p.robotId).intakeFront ?? p.robot.cfg.length / 2;
    sim.balls.release(b, [x + (slot === 'red1' ? 1 : -1) * (mouth + 0.04), b.radius, z], [0, 0, 0]);
    sim.setInput(slot, { ...idleInput(), intake: true });
    run(sim, 0.3);
    sim.setInput(slot, idleInput());
    return p.mech.stored.includes(b);
  }

  it('URAN V2 picks up POLLEN and drives over NECTAR', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const nectar = sim.balls.all.find(b => b.kind === 'nectar' && b.color === 'red' && b.state === 'staged')!;
    expect(intake(sim, 'red1', nectar, -1.0, -0.8)).toBe(false);
    const pollen = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field')!;
    expect(intake(sim, 'red1', pollen, -1.0, 0.2)).toBe(true);
  });

  it("Bumble V's arm: raised it takes balls off the floor, lowered only the bottom POLLEN of a FLOWER", () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', 'bumble-v');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const press = (key: 'armUp' | 'armDown') => {
      sim.setInput('red1', { ...idleInput(), [key]: true });
      run(sim, 0.5);
    };
    expect(p.mech.arm).toBe(0);
    const floor = sim.balls.all.filter(b => b.kind === 'pollen' && b.state === 'field' && sim.balls.position(b)[1] < 0.06);
    expect(intake(sim, 'red1', floor[0], -1.0, 0.2)).toBe(true);

    press('armDown');
    expect(p.mech.arm).toBe(1);
    expect(intake(sim, 'red1', floor[1], -1.0, 0.2)).toBe(false);

    // Nose up to the FLOWER near the red wall, facing it (-Z).
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    const inFlower = () => sim.balls.all.filter(b => b.state === 'field' && Math.hypot(sim.balls.position(b)[0] - fx, sim.balls.position(b)[2] - fz) < 0.09);
    const bottom = inFlower().sort((a, b) => sim.balls.position(a)[1] - sim.balls.position(b)[1])[0];
    const atFlower = (arm: 'armUp' | 'armDown') => {
      press(arm);
      p.robot.setPose({ x: fx, z: fz + p.robot.cfg.length / 2 + 0.1, yaw: Math.PI / 2 });
      sim.setInput('red1', { ...idleInput(), intake: true });
      run(sim, 0.3);
      sim.setInput('red1', idleInput());
    };
    atFlower('armUp');
    expect(p.mech.stored).toHaveLength(1);
    atFlower('armDown');
    // The bottom POLLEN first; the ones above drop down and follow while the intake runs.
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
    expect(p.mech.stored).toContain(bottom);
    expect(p.mech.stored.every(b => b.kind === 'pollen')).toBe(true);
  });

  it("Bumble V's lowered arm pulls POLLEN out of a FLOWER without the intake button", () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', 'bumble-v');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    const park = () => {
      p.robot.setPose({ x: fx, z: fz + p.robot.cfg.length / 2 + 0.1, yaw: Math.PI / 2 });
      run(sim, 0.8);
    };
    // Raised, the arm leaves the FLOWER alone and the rollers stay still.
    park();
    expect(p.mech.stored).toHaveLength(0);
    expect(p.mech.intakeDir).toBe(0);
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.5);
    park();
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
    expect(p.mech.stored.every(b => b.kind === 'pollen')).toBe(true);
    expect(p.mech.intakeDir).toBe(1);
  });

  it('rapid fire: URAN V2 empties its 4 balls in 0.4 s, Bumble V in 0.7 s (first to last ball)', () => {
    for (const [robot, seconds] of [['uran-v2', 0.4], ['bumble-v', 0.7]] as const) {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test', robot);
      sim.start('practice');
      sim.setInput('red1', { ...idleInput(), shooterOn: true });
      run(sim, 1);
      sim.setInput('red1', { ...idleInput(), transfer: true });
      const shots: number[] = [];
      for (let i = 0; i < 120 && p.mech.stored.length; i++) {
        const before = p.mech.stored.length;
        sim.step();
        if (p.mech.stored.length < before) shots.push(sim.time);
      }
      expect(shots, robot).toHaveLength(4);
      expect(shots[3] - shots[0], robot).toBeCloseTo(seconds, 1);
      expect(Math.abs(shots[3] - shots[0] - seconds), robot).toBeLessThan(PHYSICS_DT * 1.5);
    }
  });

  it("Bumble V's arm box only pushes balls while the arm is down", () => {
    const moved = (down: boolean) => {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test', 'bumble-v');
      sim.start('practice');
      p.robot.setPose({ x: -1.0, z: 0.2, yaw: 0 });
      if (down) sim.setInput('red1', { ...idleInput(), armDown: true });
      run(sim, 0.6);
      // A POLLEN a little beyond the lowered arm's tip, then creep ~8 cm toward it.
      const b = sim.balls.all.find(x => x.kind === 'pollen' && x.state === 'field' && sim.balls.position(x)[1] < 0.06)!;
      const at: [number, number, number] = [-1.0 + 0.3, b.radius, 0.2];
      sim.balls.release(b, at, [0, 0, 0]);
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.2 });
      run(sim, 0.2);
      sim.setInput('red1', idleInput());
      run(sim, 0.2);
      return Math.hypot(sim.balls.position(b)[0] - at[0], sim.balls.position(b)[2] - at[2]);
    };
    // Raised, the frame stops short of the ball; lowered, the arm pushes it.
    expect(moved(false)).toBeLessThan(0.01);
    expect(moved(true)).toBeGreaterThan(0.02);
  });

  it("Bumble V's arm rests on a FLOWER or the wall instead of throwing the robot back, and goes down as it backs away", () => {
    for (const target of ['flower', 'wall'] as const) {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test', 'bumble-v');
      sim.start('practice');
      p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
      // Drive slowly nose first into the FLOWER near the red wall, or into the audience wall.
      if (target === 'flower') {
        const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
        p.robot.setPose({ x: fx, z: fz + 0.6, yaw: Math.PI / 2 });
      } else p.robot.setPose({ x: 0.6, z: sim.zones.wall - 0.6, yaw: -Math.PI / 2 });
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.4 });
      run(sim, 2);
      sim.setInput('red1', idleInput());
      run(sim, 0.3);
      const [x0, , z0] = p.robot.position;
      sim.setInput('red1', { ...idleInput(), armDown: true });
      let moved = 0;
      for (let i = 0; i < 120; i++) {
        sim.step();
        moved = Math.max(moved, Math.hypot(p.robot.position[0] - x0, p.robot.position[2] - z0));
      }
      // It stays put; the arm swings down only until it touches.
      expect(moved, target).toBeLessThan(0.005);
      expect(p.mech.arm, target).toBeGreaterThan(0);
      expect(p.mech.arm, target).toBeLessThan(0.3);
      expect(p.robot.armCollider!.isEnabled(), target).toBe(false);
      // Backing away a little lets it all the way down, and the robot drives off freely.
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: 0.3 });
      run(sim, 0.4);
      sim.setInput('red1', idleInput());
      run(sim, 0.4);
      expect(p.mech.arm, target).toBe(1);
      expect(p.robot.armCollider!.isEnabled(), target).toBe(true);
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: 1 });
      run(sim, 0.5);
      expect(Math.hypot(p.robot.position[0] - x0, p.robot.position[2] - z0), target).toBeGreaterThan(0.6);
    }
  });

  it("Bumble V's arm at rest on a FLOWER drops once there is room and empties it", () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', 'bumble-v');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    p.robot.setPose({ x: fx, z: fz + 0.6, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.4 });
    run(sim, 2);
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.5);
    // Creep back until the arm is down, then wait.
    for (let i = 0; i < 240 && p.mech.arm < 1; i++) {
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: 0.15 });
      sim.step();
    }
    sim.setInput('red1', idleInput());
    run(sim, 1.5);
    expect(p.mech.arm).toBe(1);
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
  });

  it("URAN V2's Flower Mode: lowered, the arm blocks the floor and pulls POLLEN out of a FLOWER", () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const floor = sim.balls.all.filter(b => b.kind === 'pollen' && b.state === 'field' && sim.balls.position(b)[1] < 0.06);
    expect(intake(sim, 'red1', floor[0], -1.0, 0.2)).toBe(true);
    p.robot.setPose({ x: -1.0, z: 0.2, yaw: 0 });
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.5);
    expect(p.mech.arm).toBe(1);
    expect(intake(sim, 'red1', floor[1], -1.0, 0.2)).toBe(false);
    // Nose up to the FLOWER near the red wall with the arm down: the arm stops the robot just short.
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    p.robot.setPose({ x: fx, z: fz + 0.6, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.3 });
    run(sim, 1.5);
    sim.setInput('red1', idleInput());
    run(sim, 1.5);
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
    expect(p.mech.stored.every(b => b.kind === 'pollen')).toBe(true);
  });

  it('G408: a warning, then one yellow card per match for more opponent NECTAR', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', NECTAR_ROBOT);
    sim.start('match');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const blue = sim.balls.all.filter(b => b.kind === 'nectar' && b.color === 'blue' && b.state === 'staged').slice(0, 3);
    blue.forEach((b, i) => expect(intake(sim, 'red1', b, -1.0, -0.8 + i * 0.5)).toBe(true));
    const red = sim.match.score.red;
    expect(red.warnings).toBe(1);
    expect(red.yellowCards).toBe(1);
    expect(red.redCards).toBe(0);
    expect(red.calls.filter(c => c.startsWith('G408'))).toHaveLength(2);
  });

  it('G410: NECTAR launched into a FLOWER before the last minute is a MAJOR FOUL', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.start('match');
    sim.match.next('teleop');
    const [fx, fz] = sim.zones.flowers[0];
    const b = sim.balls.all.find(x => x.kind === 'nectar' && x.color === 'red' && x.state === 'staged')!;
    sim.balls.release(b, [fx, 0.75, fz], [0, 0, 0]);
    b.launch = { by: 'red1', kind: 'shot', age: 0 };
    run(sim, 1.5);
    expect(sim.match.score.red.majorFouls).toBe(1);
    expect(sim.match.score.blue.foulPoints).toBe(20);
    expect(total(sim.match.score.blue)).toBeGreaterThanOrEqual(20);
  });

  it('G405: a ball ejected out of the field is a MAJOR FOUL, a missed shot is not', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.start('match');
    const [a, b] = sim.balls.all.filter(x => x.kind === 'pollen' && x.state === 'field');
    sim.balls.release(a, [sim.zones.wall + 0.4, 0.1, 0.5], [0, 0, 0]);
    a.launch = { by: 'red1', kind: 'eject', age: 0 };
    sim.balls.release(b, [sim.zones.wall + 0.4, 0.1, -0.5], [0, 0, 0]);
    b.launch = { by: 'red1', kind: 'shot', age: 0 };
    run(sim, 0.2);
    expect(sim.match.score.red.majorFouls).toBe(1);
    expect(sim.match.score.red.calls[0]).toContain('G405');
  });

  it('G402: in AUTO, taking elements on the opponent side is one MAJOR FOUL per match', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.addRobot('blue1', 'opponent');
    sim.start('match');
    sim.robots.get('red1')!.mech.stored.splice(0).forEach(b => sim.balls.release(b, [-1.4, 0.05, -1.5], [0, 0, 0]));
    const pollen = sim.balls.all.filter(x => x.kind === 'pollen' && x.state === 'field').slice(0, 2);
    pollen.forEach((b, i) => expect(intake(sim, 'red1', b, 0.6, -1.2 + i * 0.5)).toBe(true));
    expect(sim.match.score.red.majorFouls).toBe(1);
    expect(sim.match.score.red.calls[0]).toContain('G402');
  });

  it('G417: ramming the HIVE frame is a MAJOR FOUL and a yellow card; a second yellow is a red card', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.start('match');
    const ref = sim.match.referee;
    ref.hiveFrameHit('red1', 1.0, 10);
    expect(sim.match.score.red.warnings).toBe(1);
    expect(sim.match.score.red.majorFouls).toBe(0);
    ref.hiveFrameHit('red1', 1.0, 14);
    expect(sim.match.score.red.majorFouls).toBe(1);
    expect(sim.match.score.red.yellowCards).toBe(1);
    // Another yellow (here from G408) turns into a red card: 0 points.
    ref.opponentNectar('red1');
    ref.opponentNectar('red1');
    expect(sim.match.score.red.redCards).toBe(1);
    sim.match.score.red.leave = 1;
    expect(total(sim.match.score.red)).toBe(0);
  });

  it('G417: driving into the HIVE frame at full speed is called by itself', () => {
    let called = false;
    for (const z of [0.45, 0.3, -0.3, -0.45, 0]) {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test');
      sim.start('match');
      p.robot.setPose({ x: -1.5, z, yaw: 0 });
      sim.setInput('red1', { ...idleInput(), ly: -1 });
      run(sim, 1.6);
      if (sim.match.score.red.calls.some(c => c.startsWith('G417'))) called = true;
    }
    expect(called).toBe(true);
  });

  it('G421: pinning an opponent against the wall for more than 3 s is a MAJOR FOUL, then one per 3 s', () => {
    const { sim } = makeSim();
    const red = sim.addRobot('red1', 'pinner');
    const blue = sim.addRobot('blue1', 'pinned');
    sim.start('match');
    sim.match.next('teleop');
    // Blue backed up against its wall; red drives into it and holds it there.
    const bx = sim.zones.wall - blue.robot.cfg.length / 2 - 0.001;
    const bz = blue.robot.position[2];
    blue.robot.setPose({ x: bx, z: bz, yaw: Math.PI });
    // Front faces 1 cm apart (the frame's front: a raised arm sticks out of nothing).
    const front = ({ cfg }: typeof red.robot) => (cfg.frame ? cfg.frame.offset + cfg.frame.length / 2 : cfg.length / 2);
    red.robot.setPose({ x: bx - front(blue.robot) - front(red.robot) - 0.01, z: bz, yaw: 0 });
    const push = () => {
      sim.setInput('red1', { ...idleInput(), ly: -1 });
      sim.setInput('blue1', { ...idleInput(), ly: -1 });
    };
    for (let i = 0; i < Math.round(3.4 / PHYSICS_DT); i++) {
      push();
      sim.step();
    }
    expect(sim.match.score.red.majorFouls).toBe(1);
    for (let i = 0; i < Math.round(3 / PHYSICS_DT); i++) {
      push();
      sim.step();
    }
    expect(sim.match.score.red.majorFouls).toBe(2);
    expect(sim.match.score.blue.majorFouls).toBe(0);
    expect(sim.match.score.blue.foulPoints).toBe(40);
  });

  it('house rules: with fouls off no points change hands, with cards off no cards', () => {
    const { sim } = makeSim();
    sim.addRobot('red1', 'test');
    sim.setRules({ fouls: false, cards: false, battery: true });
    sim.start('match');
    const ref = sim.match.referee;
    ref.earlyFlowerNectar('red1');
    ref.hiveFrameHit('red1', 2, 1);
    ref.opponentNectar('red1');
    ref.opponentNectar('red1');
    const red = sim.match.score.red;
    expect([red.majorFouls, red.warnings, red.yellowCards, red.redCards, sim.match.score.blue.foulPoints]).toEqual([0, 0, 0, 0, 0]);
    expect(red.calls).toHaveLength(0);
  });

  it('calls nothing in practice', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', NECTAR_ROBOT);
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const blue = sim.balls.all.find(b => b.kind === 'nectar' && b.color === 'blue' && b.state === 'staged')!;
    expect(intake(sim, 'red1', blue, -1.0, -0.8)).toBe(true);
    expect(sim.match.score.red.warnings).toBe(0);
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

describe('balls hit by a robot', () => {
  beforeAll(() => initPhysics());

  it('roll off it instead of flying across the field', () => {
    for (const robot of ['uran-v2', 'bumble-v']) {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test', robot);
      sim.start('practice');
      p.robot.setPose({ x: -1.4, z: -1.2, yaw: 0 });
      const b = sim.balls.all.find(x => x.kind === 'pollen' && x.state === 'field' && sim.balls.position(x)[1] < 0.06)!;
      const at: [number, number, number] = [-0.9, b.radius, -1.2];
      sim.balls.release(b, at, [0, 0, 0]);
      // Full speed (over 2 m/s) into it, then stop.
      sim.setInput('red1', { ...idleInput(), ly: -1, fieldCentric: false });
      run(sim, 0.45);
      sim.setInput('red1', idleInput());
      run(sim, 5);
      const [x, , z] = sim.balls.position(b);
      const [rx, , rz] = p.robot.position;
      expect(Math.hypot(x - at[0], z - at[2]), robot).toBeGreaterThan(0.3);
      // It ends up just ahead of the robot, not at the far wall.
      expect(Math.hypot(x - rx, z - rz), robot).toBeLessThan(0.7);
    }
  });
});

describe('Silver Bullet Blaster', () => {
  beforeAll(() => initPhysics());
  const SBB = 'silver-bullet-blaster';

  it('takes POLLEN and NECTAR off the floor with the arm up', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', SBB);
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const mouth = robotById(SBB).intakeFront!;
    for (const kind of ['pollen', 'nectar'] as const) {
      const b = sim.balls.all.find(x => x.kind === kind && x.color !== 'blue' && x.state !== 'held' && !p.mech.stored.includes(x))!;
      p.robot.setPose({ x: -1.0, z: 0.2, yaw: 0 });
      sim.balls.release(b, [-1.0 + mouth + 0.04, b.radius, 0.2], [0, 0, 0]);
      sim.setInput('red1', { ...idleInput(), intake: true });
      run(sim, 0.4);
      expect(p.mech.stored, kind).toContain(b);
    }
  });

  it('shoots POLLEN from its left turret and NECTAR from its right one, both at once', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', SBB);
    sim.start('practice');
    p.robot.setPose({ x: -0.6, z: 1.2, yaw: 0 });
    // Swap two pre-loaded POLLEN for red NECTAR.
    const nectar = sim.balls.all.filter(b => b.kind === 'nectar' && b.color === 'red').slice(0, 2);
    p.mech.stored.splice(2, 2).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    for (const b of nectar) {
      sim.balls.hold(b);
      p.mech.stored.push(b);
    }
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    expect(p.mech.turrets).toHaveLength(2);
    sim.setInput('red1', { ...idleInput(), transfer: true });
    const side = new Map<number, number>();
    for (let i = 0; i < 60 && p.mech.stored.length; i++) {
      const before = new Set(p.mech.stored);
      sim.step();
      for (const b of before) {
        if (p.mech.stored.includes(b)) continue;
        // Right of the robot (+Z at yaw 0) where the ball left.
        side.set(b.id, sim.balls.position(b)[2] - p.robot.position[2]);
      }
    }
    expect(p.mech.stored).toHaveLength(0);
    const pollen = [...side.keys()].filter(id => !nectar.some(b => b.id === id));
    expect(pollen).toHaveLength(2);
    // The turrets stand 20 cm apart.
    for (const b of nectar) for (const id of pollen) expect(side.get(b.id)! - side.get(id)!).toBeGreaterThan(0.15);
    for (const b of nectar) expect(side.get(b.id)!).toBeGreaterThan(0.02);
  });

  it('rapid fire: 4 POLLEN in 1 s', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', SBB);
    sim.start('practice');
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    sim.setInput('red1', { ...idleInput(), transfer: true });
    const shots: number[] = [];
    for (let i = 0; i < 240 && p.mech.stored.length; i++) {
      const before = p.mech.stored.length;
      sim.step();
      if (p.mech.stored.length < before) shots.push(sim.time);
    }
    expect(shots).toHaveLength(4);
    expect(Math.abs(shots[3] - shots[0] - 1)).toBeLessThan(PHYSICS_DT * 1.5);
  });

  it('Flower Mode: lowered, the arm blocks the floor and pulls POLLEN out of a FLOWER', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', SBB);
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    p.robot.setPose({ x: -1.0, z: 0.2, yaw: 0 });
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.7);
    expect(p.mech.arm).toBe(1);
    const floor = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field' && sim.balls.position(b)[1] < 0.06)!;
    sim.balls.release(floor, [-1.0 + 0.32, floor.radius, 0.2], [0, 0, 0]);
    sim.setInput('red1', { ...idleInput(), intake: true });
    run(sim, 0.4);
    expect(p.mech.stored).not.toContain(floor);
    // Nose up to the FLOWER near the red wall, arm already down.
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    p.robot.setPose({ x: fx, z: fz + 0.6, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.3 });
    run(sim, 1.5);
    sim.setInput('red1', idleInput());
    run(sim, 1.5);
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
    expect(p.mech.stored.every(b => b.kind === 'pollen')).toBe(true);
  });
});

describe('balls pressed against the wall', () => {
  beforeAll(() => initPhysics());

  it('stop a robot backing or strafing into them at full speed instead of squeezing out of the field', () => {
    for (const robot of ['uran-v2', 'bumble-v']) {
      for (const [ly, lx, yaw] of [[1, 0, Math.PI / 2], [0, 1, 0]] as const) {
        const { sim } = makeSim();
        const p = sim.addRobot('red1', 'test', robot);
        sim.start('practice');
        const wall = sim.zones.wall;
        // The back (or the right side) faces the audience wall, a POLLEN and a NECTAR against it.
        p.robot.setPose({ x: 0.3, z: wall - 1, yaw });
        const pollen = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field' && sim.balls.position(b)[1] < 0.06)!;
        const nectar = sim.balls.all.find(b => b.kind === 'nectar' && b.state === 'field')!;
        sim.balls.release(pollen, [0.24, pollen.radius, wall - pollen.radius - 0.005], [0, 0, 0]);
        sim.balls.release(nectar, [0.37, nectar.radius, wall - nectar.radius - 0.005], [0, 0, 0]);
        sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly, lx });
        let deepest = 0;
        for (let i = 0; i < 240; i++) {
          sim.step();
          for (const b of [pollen, nectar]) deepest = Math.max(deepest, sim.balls.position(b)[2] + b.radius - wall);
        }
        const label = `${robot} ${lx ? 'side' : 'back'}`;
        expect(deepest, label).toBeLessThan(0.025);
        // Driven away, the balls are ordinary again: the robot can push them along.
        sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -ly, lx: -lx });
        run(sim, 0.5);
        expect(pollen.body.dominanceGroup(), label).toBe(0);
        expect(nectar.body.dominanceGroup(), label).toBe(0);
      }
    }
  });

  it('can still be pushed along the wall', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const wall = sim.zones.wall;
    p.robot.setPose({ x: -0.6, z: wall - 0.16, yaw: 0 });
    const b = sim.balls.all.find(x => x.kind === 'nectar' && x.state === 'field')!;
    sim.balls.release(b, [-0.2, b.radius, wall - b.radius - 0.002], [0, 0, 0]);
    sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.6 });
    run(sim, 1);
    expect(sim.balls.position(b)[0]).toBeGreaterThan(0.4);
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

  it("URAN V2's turret turns at most 200° either way and unwinds instead of spinning round", () => {
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
    // Past the back (180°), up to its stop at 200°.
    expect(max).toBeLessThanOrEqual((200 * Math.PI) / 180 + 1e-6);
    expect(max).toBeGreaterThan(Math.PI + 0.1);
    // Unwinding shows up as steps at full turret speed against the robot's turn.
    expect(swings).toBeGreaterThan(0);
  });

  it("Bumble V's turret turns a full turn each way, past the back, before it unwinds", () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test', 'bumble-v');
    sim.start('practice');
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    let max = 0;
    for (let i = 0; i < Math.round(12 / PHYSICS_DT); i++) {
      sim.setInput('red1', { ...idleInput(), rx: 0.5 });
      sim.step();
      max = Math.max(max, Math.abs(p.mech.turretYaw));
    }
    expect(max).toBeGreaterThan(Math.PI + 0.5);
    expect(max).toBeLessThanOrEqual(2 * Math.PI + 1e-6);
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

describe('battery off (house rule)', () => {
  beforeAll(() => initPhysics());

  it('stays at 14 V with the flywheel running, so the robot keeps full speed', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.setRules({ fouls: true, cards: true, battery: false });
    sim.start('practice');
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 60);
    expect(p.robot.battery.voltage).toBe(14);
    expect(p.robot.battery.minVoltage).toBe(14);
    expect(p.robot.battery.speedScale).toBe(1);
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
    sim.balls.release(b, [x + robotById(p.robotId).intakeFront! + 0.04, b.radius, z], [0, 0, 0]);
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
