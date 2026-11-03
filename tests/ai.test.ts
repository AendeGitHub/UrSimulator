import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DECISION_DT, idleAction } from '../src/ai/action';
import { decodeOutputs } from '../src/ai/Bot';
import { runEpisode } from '../src/ai/episode';
import { FEATURE_SIZE, observe } from '../src/ai/features';
import { ballCost, dist, parkSpot, partnerOf, pickableBalls, robotXZ, shotPlan, type XZ } from '../src/ai/field';
import { Mlp, fromBase64, toBase64, type MlpData } from '../src/ai/mlp';
import policy from '../src/ai/policy.json';
import { Handicap, SKILLS } from '../src/ai/skill';
import type { FieldLayout } from '../src/field/layout';
import { parseColliders } from '../src/sim/colliders';
import { Simulation, initPhysics } from '../src/sim/Simulation';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

describe('AI driver network', () => {
  it('stores weights as base64 float32 and computes a ReLU layer then a raw output', () => {
    const values = Float32Array.from([0.5, -1.25, 3]);
    expect([...fromBase64(toBase64(values))]).toEqual([...values]);
    // 2 inputs → 2 hidden (ReLU) → 1 output, no normalization
    const net = new Mlp(
      [
        { inputs: 2, outputs: 2, w: Float32Array.from([1, 2, -1, 1]), b: Float32Array.from([0, -10]) },
        { inputs: 2, outputs: 1, w: Float32Array.from([3, 5]), b: Float32Array.from([1]) },
      ],
      Float32Array.from([0, 0]),
      Float32Array.from([1, 1]),
    );
    // hidden: [1·1 + 2·2, max(0, -1 + 2 - 10)] = [5, 0] → 3·5 + 5·0 + 1
    expect(net.forward([1, 2])[0]).toBe(16);
    expect(Mlp.fromData(net.toData()).forward([1, 2])[0]).toBe(16);
  });

  it('turns outputs into sticks (tanh) and buttons (logit > 0)', () => {
    const a = decodeOutputs([10, -10, 0, 1, -1, 0.1, -0.1]);
    expect(a.forward).toBeCloseTo(1);
    expect(a.strafe).toBeCloseTo(-1);
    expect(a.turn).toBe(0);
    expect([a.intake, a.transfer, a.shooter, a.arm]).toEqual([true, false, true, false]);
  });
});

describe('AI driver in the simulation', () => {
  beforeAll(() => initPhysics());

  it('sees the field the same way from either alliance', () => {
    const sim = new Simulation(layout, colliders, { toast: () => {}, finished: () => {} });
    const red = sim.addRobot('red1', 'red');
    const blue = sim.addRobot('blue1', 'blue');
    sim.start('practice');
    const a = new Float32Array(FEATURE_SIZE);
    const b = new Float32Array(FEATURE_SIZE);
    observe(sim, red, a);
    observe(sim, blue, b);
    expect(a.every(Number.isFinite)).toBe(true);
    // The starting field is the same turned 180°, so both robots see the same numbers.
    for (let i = 0; i < FEATURE_SIZE; i++) expect(b[i], `feature ${i}`).toBeCloseTo(a[i], 2);
    sim.world.free();
  });

  it('the teacher scores on its own: picks up, pulls POLLEN out of FLOWERs, shoots and tips its HIVE', () => {
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'red1', robot: 'uran-v2' }, opponent: null, beta: 1, record: true }, null);
    expect(r.samples).toBeGreaterThan(1000);
    expect(r.tips).toBeGreaterThanOrEqual(1);
    expect(r.phases.flower).toBeGreaterThan(0);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it('the trained network drives the robot and scores too', () => {
    const net = Mlp.fromData(policy.net as MlpData);
    // In the game it always plays against someone: here a robot that stands still.
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: 'bumble-v' }, opponent, beta: 0, record: false }, net);
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it('drives Bobik too, a robot it was not trained with, and scores', () => {
    const net = Mlp.fromData(policy.net as MlpData);
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: 'bobik' }, opponent, beta: 0, record: false }, net);
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it("drives Mechatronics too, its heavy flywheel slow to spin up and its shots flying with backspin, and scores", () => {
    const net = Mlp.fromData(policy.net as MlpData);
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: 'mechatronics' }, opponent, beta: 0, record: false }, net);
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it("drives DHB too, faster than any robot it was trained with, and scores", () => {
    const net = Mlp.fromData(policy.net as MlpData);
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: 'dhb' }, opponent, beta: 0, record: false }, net);
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it('without shooting on the move it stops to shoot, and still scores', () => {
    const net = Mlp.fromData(policy.net as MlpData);
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: 'bumble-v' }, opponent, beta: 0, record: false, rules: { movingShots: false } }, net);
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.fouls).toBe(0);
  }, 30_000);

  it('drives at its level: late off the line, slower, stops to think once its load is shot, and scatters its shots', () => {
    const sim = new Simulation(layout, colliders, { toast: () => {}, finished: () => {} });
    const p = sim.addRobot('red1', 'red');
    sim.addRobot('blue1', 'blue');
    sim.start('practice');
    const skill = SKILLS.easy;
    // Thinking takes the middle of its range.
    const handicap = new Handicap(skill, () => 0.5);
    const wanted = { ...idleAction(), forward: 1, strafe: -1, turn: 1, shooter: true, transfer: true };
    const decide = (n: number) => {
      let a = wanted;
      for (let i = 0; i < n; i++) a = handicap.apply(sim, p, wanted);
      return a;
    };
    p.mech.stored.splice(0, Infinity, ...sim.balls.all.slice(0, 2));
    // Off the line late: standing, but the flywheel already spinning up.
    expect(decide(1)).toMatchObject({ forward: 0, strafe: 0, turn: 0, shooter: true, transfer: true });
    const moving = decide(Math.ceil(skill.start / DECISION_DT));
    expect(moving.forward).toBeCloseTo(skill.speed);
    expect(moving.strafe).toBeCloseTo(-skill.speed);
    expect(moving.turn).toBeCloseTo(skill.turn);
    // Its turrets can't aim on the move, and its shots scatter wider.
    expect(p.mech.movingShots).toBe(false);
    expect(p.mech.aimError).toBe(skill.aim);
    // The last ball shot: it stands to think, then goes on.
    p.mech.stored.length = 0;
    const think = (skill.think[0] + skill.think[1]) / 2;
    expect(decide(Math.floor(think / DECISION_DT)).forward).toBe(0);
    expect(decide(2).forward).toBeCloseTo(skill.speed);

    // Hard drives as the network decides, by the room's rules.
    const hard = new Handicap(SKILLS.hard);
    expect(hard.apply(sim, p, wanted)).toEqual(wanted);
    expect(p.mech.movingShots).toBe(true);
    expect(p.mech.aimError).toBe(0);
    sim.world.free();
  });

  it('an easy AI still scores, without fouls, and a hard one more', () => {
    const net = Mlp.fromData(policy.net as MlpData);
    const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
    // Two robots each: a single minute can be lucky or unlucky.
    const play = (level: 'easy' | 'hard') => ['bumble-v', 'uran-v2'].map(robot =>
      runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot }, opponent, beta: 0, record: false, level }, net));
    const points = (games: { score: number }[]) => games.reduce((sum, g) => sum + g.score, 0);
    const easy = play('easy');
    const hard = play('hard');
    expect(points(easy)).toBeGreaterThan(0);
    expect(easy.every(g => g.fouls === 0)).toBe(true);
    expect(points(hard)).toBeGreaterThan(points(easy));
  }, 60_000);

  it('in a 2 vs 2 partners split the field: balls nearer the partner are theirs, and they shoot and park apart', () => {
    const sim = new Simulation(layout, colliders, { toast: () => {}, finished: () => {} });
    const a = sim.addRobot('red1', 'red');
    const b = sim.addRobot('red2', 'red');
    sim.addRobot('blue1', 'blue');
    sim.start('practice');
    a.robot.setPose({ x: -1.2, z: 0.8, yaw: 0 });
    b.robot.setPose({ x: -1.2, z: -0.8, yaw: 0 });
    expect(partnerOf(sim, a)).toBe(b);
    const at = (ball: (typeof sim.balls.all)[number]): XZ => {
      const [x, , z] = sim.balls.position(ball);
      return [x, z];
    };
    const theirs = pickableBalls(sim, a).find(ball => dist(at(ball), robotXZ(b)) + 0.3 < dist(at(ball), robotXZ(a)))!;
    expect(ballCost(sim, a, theirs, null, b)).toBeCloseTo(ballCost(sim, a, theirs, null) + 1);
    const mine = pickableBalls(sim, a).find(ball => dist(at(ball), robotXZ(a)) + 0.3 < dist(at(ball), robotXZ(b)))!;
    expect(ballCost(sim, a, mine, null, b)).toBeCloseTo(ballCost(sim, a, mine, null));

    // The partner already at its shooting spot keeps it; the one coming in shoots from beside it.
    const spot = shotPlan(sim, b, true).spot;
    b.robot.setPose({ x: spot[0], z: spot[1], yaw: 0 });
    const { aim } = shotPlan(sim, b, true);
    a.robot.setPose({ x: aim[0] + (spot[0] - aim[0]) * 1.6, z: aim[1] + (spot[1] - aim[1]) * 1.6, yaw: 0 });
    expect(dist(shotPlan(sim, a, true).spot, spot)).toBeLessThan(0.1);
    expect(dist(shotPlan(sim, a, true, b).spot, spot)).toBeGreaterThan(0.5);
    expect(dist(shotPlan(sim, b, true, a).spot, spot)).toBeLessThan(0.1);
    // At the end each parks at an end of the loading zone.
    expect(dist(parkSpot(sim, a, b), parkSpot(sim, b, a))).toBeGreaterThan(0.5);
    sim.world.free();
  });

  it('decides in well under a millisecond', () => {
    const sim = new Simulation(layout, colliders, { toast: () => {}, finished: () => {} });
    const p = sim.addRobot('red1', 'red');
    sim.addRobot('blue1', 'blue');
    sim.start('practice');
    const net = Mlp.fromData(policy.net as MlpData);
    const x = new Float32Array(FEATURE_SIZE);
    const started = performance.now();
    for (let i = 0; i < 500; i++) {
      observe(sim, p, x);
      decodeOutputs(net.forward(x));
    }
    expect((performance.now() - started) / 500).toBeLessThan(1);
    sim.world.free();
  });
});
