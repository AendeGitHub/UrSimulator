import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { parseColliders } from '../src/sim/colliders';
import { PHYSICS_DT, Simulation, initPhysics } from '../src/sim/Simulation';
import { decodeState, encodeState } from '../src/sim/state';
import { idleInput } from '../src/sim/types';
import { cellFrame } from '../src/field/hiveGeometry';
import { total } from '../src/game/scoring';
import type { Ball } from '../src/sim/BallSim';
import { ROBOTS, URAN_V1, robotById } from '../src/robot/robots';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

/** No robot in the game takes NECTAR yet; the NECTAR rules are tested with this one. */
const NECTAR_ROBOT = 'test-nectar';
ROBOTS.push({ ...URAN_V1, id: NECTAR_ROBOT, intakes: ['pollen', 'nectar'] });

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
    // One shot every 0.5 s (URAN V1's fire rate)
    sim.setInput('red1', { ...idleInput(), transfer: true });
    run(sim, 2.2);
    sim.setInput('red1', idleInput());
    run(sim, 6.5); // 3 s on the dampers, then 1.8 s to turn over
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
    expect(decoded.robots.map(r => r.arm)).toEqual([0, 0, 0, 0]);
    // A snapshot from a server before the arm (no arm bytes at the end) still reads.
    const old = encodeState(state);
    expect(decodeState(old.slice(0, old.byteLength - 4)).robots[0].arm).toBe(0);
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

  it('URAN V1 picks up POLLEN and drives over NECTAR', () => {
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

  it('fires one ball every 0.5 s (URAN V1) or 0.6 s (Bumble V)', () => {
    for (const [robot, shots] of [['uran-v1', 3], ['bumble-v', 2]] as const) {
      const { sim } = makeSim();
      const p = sim.addRobot('red1', 'test', robot);
      sim.start('practice');
      sim.setInput('red1', { ...idleInput(), shooterOn: true });
      run(sim, 1);
      const before = p.mech.stored.length;
      // Shots at 0 and every interval after: 0, 0.5, 1.0 s or 0, 0.6 s within 1.1 s.
      sim.setInput('red1', { ...idleInput(), transfer: true });
      run(sim, 1.1);
      expect(before - p.mech.stored.length, robot).toBe(shots);
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

  it('URAN V1 has no arm: the arm buttons change nothing', () => {
    const { sim } = makeSim();
    const p = sim.addRobot('red1', 'test');
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.5);
    expect(p.mech.arm).toBe(0);
    const pollen = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field' && sim.balls.position(b)[1] < 0.06)!;
    expect(intake(sim, 'red1', pollen, -1.0, 0.2)).toBe(true);
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
    red.robot.setPose({ x: bx - blue.robot.cfg.length / 2 - red.robot.cfg.length / 2 - 0.01, z: bz, yaw: 0 });
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
