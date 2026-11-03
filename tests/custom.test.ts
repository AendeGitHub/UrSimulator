import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Lobby, type LobbySocket } from '../server/Lobby';
import { runEpisode } from '../src/ai/episode';
import { Mlp, type MlpData } from '../src/ai/mlp';
import policy from '../src/ai/policy.json';
import { parseReport } from '../server/api';
import { recordRun } from '../server/Stats';
import { POLLEN_RADIUS, type FieldLayout } from '../src/field/layout';
import type { ClientMessage, RoomInfo, ServerMessage } from '../src/net/lobbyProtocol';
import { roomDrivers } from '../src/net/OnlineSession';
import {
  ARM, DEFAULT_BLUEPRINT, DEFAULT_INTAKE, DEFAULT_TURRET, LIMITS, MAX_SPEED, MAX_TURRETS, TURRET_LIMITS, arrangeTurrets, cleanBlueprint, customDefinition, readShareCode,
  shareCode, sharedRobotId, withTurret, withoutMesh, withoutTurret, type Blueprint, type Drivetrain, type TurretPart,
} from '../src/robot/custom';
import { wrapAngle } from '../src/robot/mecanum';
import { CUSTOM_ROBOT, addCustomRobot, isCustomRobotId, pushBackSpot, robotById, turretsOf } from '../src/robot/robots';
import { parseColliders } from '../src/sim/colliders';
import { DEFAULT_RULES } from '../src/sim/Referee';
import { PHYSICS_DT, Simulation, initPhysics } from '../src/sim/Simulation';
import { decodeState, encodeState } from '../src/sim/stateCodec';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
const FTC_BOX = 0.4572;

const blueprint = (patch: Partial<Blueprint> = {}) => cleanBlueprint({ ...DEFAULT_BLUEPRINT, ...patch })!;
/** A robot with `n` turrets, added one by one in the Workshop. */
function withTurrets(n: number, patch: Partial<Blueprint> = {}): Blueprint {
  let bp = blueprint(patch);
  while (bp.turrets.length < n) bp = blueprint({ ...bp, turrets: withTurret(bp, 0) });
  return bp;
}
const both = { kind: 'both' as const };
/** POLLEN on the left, NECTAR on the right, like Silver Bullet Blaster */
const twoLanes: TurretPart[] = [{ ...DEFAULT_TURRET, z: -0.1, shoots: 'pollen' }, { ...DEFAULT_TURRET, z: 0.1, shoots: 'nectar' }];
const makeSim = () => new Simulation(layout, colliders, { toast: () => {}, finished: () => {} });
const run = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) sim.step();
};

describe('blueprints of player-made robots', () => {
  it('keeps every number in its range, text without markup, and cleaning a clean one changes nothing', () => {
    const turrets = Array.from({ length: 7 }, () => ({ ...DEFAULT_TURRET, height: 9, range: -5, facing: 1000 }));
    const bp = cleanBlueprint({ ...DEFAULT_BLUEPRINT, length: 2, rpm: 99999, mass: -3, name: ' <b>Rocket</b>\n2 ', number: 'No. 12a34', color: 'red', intake: { ...DEFAULT_INTAKE, ...both, rate: 99 }, backIntake: { kind: 'x' }, turrets })!;
    expect(bp.length).toBe(LIMITS.length.max);
    expect(bp.rpm).toBe(LIMITS.rpm.max);
    expect(bp.mass).toBe(LIMITS.mass.min);
    expect(bp.name).not.toMatch(/[<>\n]/);
    expect(bp.number).toBe('1234');
    expect(bp.color).toBe(DEFAULT_BLUEPRINT.color);
    expect(bp.intake).toMatchObject({ kind: 'both', rate: 6 });
    // A back intake made of nonsense is the usual intake.
    expect(bp.backIntake).toEqual({ ...DEFAULT_INTAKE });
    expect(bp.turrets).toHaveLength(MAX_TURRETS);
    expect(bp.turrets[0]).toMatchObject({ height: TURRET_LIMITS.height.max, range: 0, facing: 180 });
    expect(cleanBlueprint(bp)).toEqual(bp);
    for (const value of [null, 'robot', 42, [1, 2]]) expect(cleanBlueprint(value)).toBeNull();
    // Missing fields get the defaults.
    expect(cleanBlueprint({})).toEqual(cleanBlueprint(DEFAULT_BLUEPRINT));
    expect(blueprint({ turrets: [] }).turrets).toEqual([DEFAULT_TURRET]);
  });

  it('reads robots saved before they could have more turrets and a back intake', () => {
    // The older default robot is the default robot.
    const older = { ...DEFAULT_BLUEPRINT, intake: 'pollen', intakeWidth: 0.3, intakeReach: 0.04, intakeRate: 3, turrets: 1, turretAt: -0.06, shooterHeight: 0.33, turretRange: 180, rapidFire: 0.6, spin: 0 };
    expect(cleanBlueprint(older)).toEqual(blueprint());
    // Two turrets side by side, POLLEN left and NECTAR right.
    const bp = cleanBlueprint({ ...older, intake: 'both', intakeWidth: 0.25, intakeReach: 0.05, intakeRate: 4, arm: true, turrets: 2, turretAt: 0.02, shooterHeight: 0.3, turretRange: 90, rapidFire: 0.5, spin: 1 })!;
    expect(bp.intake).toEqual({ kind: 'both', width: 0.25, reach: 0.05, rate: 4 });
    expect(bp.backIntake).toBeNull();
    expect(bp.arm).toBe(true);
    const turret = { x: 0.02, height: 0.3, facing: 0, range: 90, rapidFire: 0.5, spin: 1 };
    expect(bp.turrets).toEqual([{ ...turret, z: -0.1, shoots: 'pollen' }, { ...turret, z: 0.1, shoots: 'nectar' }]);
    // Two turrets were only for an intake that takes both.
    expect(cleanBlueprint({ ...older, turrets: 2 })!.turrets).toHaveLength(1);
  });

  it('a turret shoots balls the robot has, and every ball the robot has goes to a turret', () => {
    // POLLEN only: a NECTAR turret would have nothing to shoot.
    expect(blueprint({ turrets: [{ ...DEFAULT_TURRET, shoots: 'nectar' }] }).turrets[0].shoots).toBe('both');
    // Both kinds: a lane for each, or the main turret shoots what no other does.
    const shoots = (intake: Partial<Blueprint>, turrets: TurretPart['shoots'][]) =>
      blueprint({ ...intake, turrets: turrets.map(kind => ({ ...DEFAULT_TURRET, shoots: kind })) }).turrets.map(t => t.shoots);
    expect(shoots({ intake: { ...DEFAULT_INTAKE, ...both } }, ['pollen', 'nectar'])).toEqual(['pollen', 'nectar']);
    expect(shoots({ intake: { ...DEFAULT_INTAKE, ...both } }, ['nectar', 'nectar'])).toEqual(['both', 'nectar']);
    // NECTAR from the back intake counts too.
    expect(shoots({ backIntake: { ...DEFAULT_INTAKE, kind: 'nectar' } }, ['pollen', 'nectar'])).toEqual(['pollen', 'nectar']);
    // A NECTAR-only robot still shoots its POLLEN pre-loads.
    expect(shoots({ intake: { ...DEFAULT_INTAKE, kind: 'nectar' } }, ['nectar'])).toEqual(['both']);
    // The Flower Mode arm pushes POLLEN into the front intake.
    expect(blueprint({ intake: { ...DEFAULT_INTAKE, kind: 'nectar' }, arm: true }).arm).toBe(false);
    expect(blueprint({ intake: { ...DEFAULT_INTAKE, ...both }, arm: true }).arm).toBe(true);
  });

  it("fits FTC's 18-inch starting box, its wheels fit the frame and it drives no faster than MAX_SPEED", () => {
    const extremes: Partial<Blueprint>[] = [
      {},
      { length: 1, width: 1, rpm: 1200, wheel: 0.14, arm: true, turrets: [{ ...DEFAULT_TURRET, height: 1 }] },
      {
        length: 0.25, width: 0.25, wheel: 0.14, frameHeight: 0.15,
        intake: { ...DEFAULT_INTAKE, reach: 0.1 }, backIntake: { ...DEFAULT_INTAKE, reach: 0.1 },
        turrets: Array.from({ length: MAX_TURRETS }, (_, i) => ({ ...DEFAULT_TURRET, x: i % 2 ? 0.2 : -0.2, z: -0.2 + 0.1 * i, height: 0.15 })),
      },
    ];
    for (const patch of extremes) {
      const bp = blueprint(patch);
      const def = customDefinition('custom-test', bp);
      const label = JSON.stringify(patch);
      const frame = def.config.frame ?? { length: def.config.length, offset: 0 };
      expect(frame.length, label).toBeLessThanOrEqual(FTC_BOX);
      expect(def.config.width, label).toBeLessThanOrEqual(FTC_BOX);
      expect(def.config.height, label).toBeLessThanOrEqual(FTC_BOX);
      expect(def.config.drive.maxWheelSpeed, label).toBeLessThanOrEqual(MAX_SPEED);
      // Front and back wheels don't overlap, and every turret stands over the frame.
      expect(def.config.drive.wheelBase, label).toBeGreaterThan(2 * def.config.wheelRadius);
      for (const { shooter } of turretsOf(def)) {
        expect(Math.abs(shooter.at[0] - frame.offset), label).toBeLessThan(frame.length / 2);
        expect(Math.abs(shooter.at[1]), label).toBeLessThan(def.config.width / 2);
        expect(shooter.height, label).toBeGreaterThan(bp.frameHeight + 0.02);
      }
    }
  });

  it("takes balls at the robot's front; with the arm, in front of the frame, with room for a POLLEN before the arm's bar", () => {
    const plain = customDefinition('custom-plain', blueprint());
    expect(plain.intakeFront).toBeCloseTo(plain.config.length / 2);
    expect(plain.arm).toBeUndefined();
    const arm = customDefinition('custom-arm', blueprint({ arm: true }));
    expect(arm.config.length).toBeCloseTo(DEFAULT_BLUEPRINT.length + ARM.length);
    expect(arm.config.frame).toEqual({ length: DEFAULT_BLUEPRINT.length, offset: -ARM.length / 2 });
    expect(arm.intakeFront).toBeCloseTo(arm.config.length / 2 - ARM.length);
    expect(arm.arm!.box.x[1]).toBeCloseTo(arm.config.length / 2);
    // Lowered, its front reaches the end of its box; on the way down it swings out a little further.
    expect(arm.arm!.reach.at(-1)).toBeCloseTo(arm.arm!.box.x[1]);
    expect(Math.max(...arm.arm!.reach)).toBeGreaterThan(arm.arm!.box.x[1]);
    const spot = pushBackSpot(arm.intakeFront!, arm.arm!);
    expect(spot - POLLEN_RADIUS).toBeGreaterThan(arm.intakeFront!);
    expect(spot + POLLEN_RADIUS).toBeLessThan(arm.arm!.box.x[1]);
    // A second intake takes balls at the robot's back.
    const twoWay = customDefinition('custom-twoway', blueprint({ arm: true, backIntake: { ...DEFAULT_INTAKE, kind: 'nectar', width: 0.2 } }));
    expect(twoWay.backIntake).toEqual({ back: DEFAULT_BLUEPRINT.length / 2 + ARM.length / 2, halfWidth: 0.1, kinds: ['nectar'], interval: 1 / DEFAULT_INTAKE.rate });
    expect(twoWay.intakeFront).toBeCloseTo(arm.intakeFront!);
  });

  it('holds 4 balls from under each turret to the intake, each turret in a lane of its own', () => {
    const def = customDefinition('custom-two', blueprint({ intake: { ...DEFAULT_INTAKE, ...both }, turrets: twoLanes }));
    expect(def.intakes).toEqual(['pollen', 'nectar']);
    expect(def.shooterKinds).toEqual(['pollen']);
    expect(def.extraTurrets?.map(t => t.kinds)).toEqual([['nectar']]);
    for (const { shooter, storage } of turretsOf(customDefinition('custom-five', withTurrets(5)))) {
      expect(storage).toHaveLength(4);
      expect(storage[0][0]).toBeCloseTo(shooter.at[0]);
      expect(storage[0][2]).toBeCloseTo(shooter.at[1]);
      expect(storage[3][0]).toBeLessThan(def.intakeFront!);
      expect(storage[3][1]).toBeLessThan(storage[0][1]);
    }
    // POLLEN on the left, NECTAR on the right.
    expect(def.shooter.at[1]).toBeLessThan(0);
    expect(def.extraTurrets![0].shooter.at[1]).toBeGreaterThan(0);
  });

  it('lays out up to five turrets neatly as they are added, and a new one where there is room', () => {
    let bp = blueprint();
    for (let n = 2; n <= MAX_TURRETS; n++) {
      bp = blueprint({ ...bp, turrets: withTurret(bp, 0) });
      expect(bp.turrets).toHaveLength(n);
      // Their turntables (11 cm square) don't overlap.
      bp.turrets.forEach((a, i) => {
        for (const b of bp.turrets.slice(i + 1)) expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)), `${n}`).toBeGreaterThan(0.1099);
      });
      expect(arrangeTurrets(bp)).toEqual(bp.turrets);
    }
    expect(withTurret(bp, 0)).toHaveLength(MAX_TURRETS);
    // Taking one away, the others close up.
    const four = blueprint({ ...bp, turrets: withoutTurret(bp, 4) });
    expect(four.turrets).toHaveLength(4);
    expect(arrangeTurrets(four)).toEqual(four.turrets);
    expect(withoutTurret(blueprint(), 0)).toHaveLength(1);
    // Moved by the player, they stay where they are.
    const apart = blueprint({ turrets: [{ ...DEFAULT_TURRET, x: 0.1, z: 0.1 }, { ...DEFAULT_TURRET, x: -0.1, z: -0.1, shoots: 'pollen' }] });
    const three = withTurret(apart, 1);
    expect(three.slice(0, 2)).toEqual(apart.turrets);
    expect(three[2].shoots).toBe('pollen');
    expect(Math.min(...apart.turrets.map(t => Math.hypot(t.x - three[2].x, t.z - three[2].z)))).toBeGreaterThan(0.2);
  });

  it('travels as a share code, without its 3D model, and goes by the same id in every game of an online room', () => {
    const bp = blueprint({ name: 'Ракета', mesh: { id: 'abcd1234', file: 'robot.glb', format: 'glb', scale: 0.001, up: 'z', turn: 1, signs: true } });
    expect(bp.mesh?.format).toBe('glb');
    const code = shareCode(bp);
    expect(code.startsWith('URSIM-ROBOT:')).toBe(true);
    expect(readShareCode(`My robot: ${code} — try it`)).toEqual(withoutMesh(bp));
    expect(readShareCode('URSIM-ROBOT:not a code')).toBeNull();
    expect(readShareCode('hello')).toBeNull();
    expect(sharedRobotId(bp)).toBe(sharedRobotId(withoutMesh(bp)));
    expect(sharedRobotId(bp)).not.toBe(sharedRobotId(blueprint({ ...bp, rpm: bp.rpm + 5 })));
    expect(isCustomRobotId(sharedRobotId(bp))).toBe(true);
  });

  it("a player-made robot this game doesn't have shows as the default blocks, other unknown ids as URAN V2", () => {
    expect(robotById('x-zzzzzzz').id).toBe(CUSTOM_ROBOT);
    expect(robotById('custom-unknown1').custom).toBeTruthy();
    expect(robotById('nobody').id).toBe('uran-v2');
  });
});

describe('a player-made robot on the field', () => {
  beforeAll(() => initPhysics());

  it('drives, takes POLLEN and tips the HIVE with its pre-loads like a team robot', () => {
    const def = customDefinition('custom-sim1', blueprint());
    addCustomRobot(def);
    const sim = makeSim();
    const p = sim.addRobot('red1', 'test', def.id);
    sim.start('practice');
    expect(p.mech.stored).toHaveLength(4);

    // Shoots its 4 pre-loads into the red HIVE's cell from in front of it.
    const target = sim.hives.red.target();
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: Math.atan2(-(target[2] - 1.35), target[0] + 0.45) });
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    sim.setInput('red1', { ...idleInput(), transfer: true });
    run(sim, 2.2);
    sim.setInput('red1', idleInput());
    run(sim, 6.5);
    expect(sim.hives.red.tips).toBe(1);

    // Picks up a POLLEN in front of its intake.
    p.robot.setPose({ x: -1, z: 0.2, yaw: 0 });
    run(sim, 0.2);
    const pollen = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field')!;
    sim.balls.release(pollen, [-1 + def.intakeFront! + 0.04, pollen.radius, 0.2], [0, 0, 0]);
    sim.setInput('red1', { ...idleInput(), intake: true });
    run(sim, 0.3);
    expect(p.mech.stored).toContain(pollen);

    // From its start at the alliance wall it drives into the field at its top speed.
    const fresh = makeSim();
    const q = fresh.addRobot('red1', 'test', def.id);
    fresh.start('practice');
    fresh.setInput('red1', { ...idleInput(), ly: -1 });
    let top = 0;
    for (let i = 0; i < 0.5 / PHYSICS_DT; i++) {
      fresh.step();
      top = Math.max(top, q.robot.speed);
    }
    expect(top).toBeGreaterThan(def.config.drive.maxWheelSpeed * 0.9);
  });

  it('takes balls with its back intake too, and fires one ball from each of its turrets at once', () => {
    const def = customDefinition('custom-sim3', withTurrets(4, { backIntake: { ...DEFAULT_INTAKE } }));
    addCustomRobot(def);
    const sim = makeSim();
    const p = sim.addRobot('red1', 'test', def.id);
    sim.start('practice');
    expect(p.mech.turrets).toHaveLength(4);

    // With the flywheels up, every turret takes a pre-load at the same moment.
    const target = sim.hives.red.target();
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: Math.atan2(-(target[2] - 1.35), target[0] + 0.45) });
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1);
    const preloads = [...p.mech.stored];
    expect(preloads).toHaveLength(4);
    sim.setInput('red1', { ...idleInput(), transfer: true });
    sim.step();
    expect(p.mech.stored).toHaveLength(0);
    expect(preloads.every(b => b.launch?.kind === 'shot')).toBe(true);
    expect(new Set(preloads.map(b => sim.balls.position(b)).map(([x, , z]) => `${x.toFixed(2)} ${z.toFixed(2)}`)).size).toBe(4);
    // The snapshot has every turret.
    expect(sim.state().robots[0].extraTurrets).toHaveLength(3);

    // Backing over a POLLEN, the back intake takes it.
    sim.setInput('red1', idleInput());
    p.robot.setPose({ x: -1, z: 0.2, yaw: 0 });
    run(sim, 0.2);
    const pollen = sim.balls.all.find(b => b.kind === 'pollen' && b.state === 'field')!;
    sim.balls.release(pollen, [-1 - def.backIntake!.back - 0.04, pollen.radius, 0.2], [0, 0, 0]);
    sim.setInput('red1', { ...idleInput(), intake: true });
    run(sim, 0.3);
    expect(p.mech.stored).toContain(pollen);
  });

  it('drives on mecanum wheels, swerve modules (full speed sideways too) or a tank drive (not sideways)', () => {
    const sideways = (drivetrain: Drivetrain) => {
      const def = customDefinition(`custom-${drivetrain}`, blueprint({ drivetrain }));
      addCustomRobot(def);
      const sim = makeSim();
      sim.setRules({ ...DEFAULT_RULES, battery: false });
      const p = sim.addRobot('red1', 'test', def.id);
      sim.start('practice');
      p.robot.setPose({ x: -1, z: -0.9, yaw: 0 });
      sim.setInput('red1', { ...idleInput(), fieldCentric: false, lx: 1 });
      run(sim, 0.5);
      return p.robot.speed / def.config.drive.maxWheelSpeed;
    };
    expect(sideways('mecanum')).toBeCloseTo(0.85, 2);
    expect(sideways('swerve')).toBeCloseTo(1, 2);
    expect(sideways('tank')).toBeLessThan(0.02);
    // The tank's wheels grip better; swerve modules turn it a little slower.
    const def = (drivetrain: Drivetrain) => customDefinition('custom-drive', blueprint({ drivetrain })).config;
    expect(def('tank').maxAccel).toBeGreaterThan(def('mecanum').maxAccel);
    expect(def('swerve').maxTurnAccel).toBeLessThan(def('mecanum').maxTurnAccel);
  });

  it('a turret rests where it faces and turns no further than its range from there', () => {
    const def = customDefinition('custom-sim4', blueprint({ turrets: [{ ...DEFAULT_TURRET, facing: 180, range: 45 }] }));
    addCustomRobot(def);
    const sim = makeSim();
    const p = sim.addRobot('red1', 'test', def.id);
    sim.start('practice');
    const turret = p.mech.turret;
    expect(turret.yaw).toBeCloseTo(Math.PI);
    const target = sim.hives.red.target();
    const toward = Math.atan2(-(target[2] - 1.35), target[0] + 0.45);
    // With the HIVE behind the robot it turns onto it.
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: toward + Math.PI + 0.3 });
    sim.setInput('red1', { ...idleInput(), shooterOn: true });
    run(sim, 1.5);
    expect(turret.status).toBe('ready');
    expect(Math.abs(wrapAngle(turret.yaw - Math.PI))).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
    // Facing the HIVE, it can't: it waits at its stop.
    p.robot.setPose({ x: -0.45, z: 1.35, yaw: toward });
    run(sim, 1.5);
    expect(turret.status).not.toBe('ready');
    expect(Math.abs(wrapAngle(turret.yaw - Math.PI))).toBeCloseTo(Math.PI / 4);
  });

  it("its Flower Mode arm pulls POLLEN out of a FLOWER's retrieval opening into the push back", () => {
    const def = customDefinition('custom-sim2', blueprint({ arm: true }));
    addCustomRobot(def);
    const sim = makeSim();
    const p = sim.addRobot('red1', 'test', def.id);
    sim.start('practice');
    p.mech.stored.splice(0).forEach(b => sim.balls.release(b, [0, 0.05, -1.5], [0, 0, 0]));
    const [fx, fz] = sim.zones.flowers.find(([, z]) => z < -1)!;
    p.robot.setPose({ x: fx, z: fz + 0.6, yaw: Math.PI / 2 });
    sim.setInput('red1', { ...idleInput(), armDown: true });
    run(sim, 0.7);
    sim.setInput('red1', { ...idleInput(), fieldCentric: false, ly: -0.25 });
    run(sim, 1.5);
    sim.setInput('red1', idleInput());
    run(sim, 0.3);
    expect(p.mech.arm).toBe(1);
    expect(p.mech.pocket?.kind).toBe('pollen');
    sim.setInput('red1', { ...idleInput(), intake: true });
    run(sim, 1.5);
    expect(p.mech.stored.length).toBeGreaterThanOrEqual(2);
  });

  it('the AI drives one too and scores, as with a team robot it was not trained with', () => {
    const robots = [
      blueprint(),
      blueprint({ intake: { ...DEFAULT_INTAKE, ...both }, turrets: twoLanes, arm: true, rpm: 312, mass: 14 }),
      withTurrets(MAX_TURRETS, { intake: { ...DEFAULT_INTAKE, ...both }, backIntake: { ...DEFAULT_INTAKE, ...both }, drivetrain: 'swerve' }),
      blueprint({ drivetrain: 'tank' }),
    ];
    for (const [i, bp] of robots.entries()) {
      const def = customDefinition(`custom-ai${i}`, bp);
      addCustomRobot(def);
      const net = Mlp.fromData(policy.net as MlpData);
      const opponent = { slot: 'red1', robot: 'uran-v2', driver: 'idle' } as const;
      const r = runEpisode(layout, colliders, { mode: 'practice', seconds: 60, bot: { slot: 'blue1', robot: def.id }, opponent, beta: 0, record: false }, net);
      expect(r.score, def.id).toBeGreaterThanOrEqual(20);
      expect(r.fouls, def.id).toBe(0);
    }
  }, 120_000);

  it('online: snapshots carry its id, and snapshots without one stay as older games read them', () => {
    const def = customDefinition('x-abcdefg', blueprint());
    addCustomRobot(def);
    const sim = makeSim();
    sim.addRobot('red1', 'a', def.id);
    sim.addRobot('blue1', 'b', 'bobik');
    sim.start('practice');
    run(sim, 0.1);
    const buf = encodeState(sim.state());
    expect(decodeState(buf).robots.map(r => r.robot)).toEqual(['x-abcdefg', 'bobik']);

    const teams = makeSim();
    teams.addRobot('red1', 'a', 'bumble-v');
    teams.addRobot('blue1', 'b', 'silver-bullet-blaster');
    teams.start('practice');
    const old = encodeState(teams.state());
    expect(new Uint8Array(old)[0]).toBe(8);
    expect(decodeState(old).robots.map(r => [r.robot, r.extraTurrets.length])).toEqual([['bumble-v', 0], ['silver-bullet-blaster', 1]]);
  });

  it('online: a robot of three or more turrets goes in a newer snapshot, with every turret', () => {
    const def = customDefinition('x-three00', withTurrets(3, { turrets: [{ ...DEFAULT_TURRET, facing: 90 }] }));
    addCustomRobot(def);
    const sim = makeSim();
    sim.addRobot('red1', 'a', def.id);
    sim.addRobot('blue1', 'b', 'silver-bullet-blaster');
    sim.start('practice');
    run(sim, 0.1);
    const state = sim.state();
    const buf = encodeState(state);
    expect(new Uint8Array(buf)[0]).toBe(10);
    const back = decodeState(buf);
    expect(back.robots.map(r => r.extraTurrets.length)).toEqual([2, 1]);
    back.robots[0].extraTurrets.forEach((t, i) => expect(t.yaw).toBeCloseTo(state.robots[0].extraTurrets[i].yaw, 5));
    expect(back.robots[0].turretYaw).toBeCloseTo(state.robots[0].turretYaw, 5);
  });
});

class FakeSocket implements LobbySocket {
  readonly messages: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.messages.push(structuredClone(m));
  }
  sendBinary() {}
  get room(): RoomInfo | null {
    return ([...this.messages].reverse().find(m => m.t === 'room') as Extract<ServerMessage, { t: 'room' }> | undefined)?.room ?? null;
  }
}

describe('player-made robots online and in the statistics', () => {
  it("a room takes a player's own robot with its blueprint (without the 3D model); a robot without one falls back to URAN V2", () => {
    const lobby = new Lobby();
    const players = ['Admin', 'Guest', 'Third'].map(name => {
      const socket = new FakeSocket();
      const id = lobby.connect(socket)!;
      const send = (m: ClientMessage) => lobby.message(id, m);
      send({ t: 'hello', name });
      return { id, socket, send };
    });
    const [admin, guest, third] = players;
    const bp = blueprint({ name: 'Rocket', mesh: { id: 'abcd1234', file: 'r.stl', format: 'stl', scale: 0.001, up: 'z', turn: 0, signs: true } });
    admin.send({ t: 'create', format: '2v2', robot: 'custom-abcd12', custom: bp, rules: DEFAULT_RULES });
    const room = admin.socket.room!;
    guest.send({ t: 'join', room: room.id, robot: 'custom-zzzz99' });
    third.send({ t: 'join', room: room.id, robot: 'bobik', custom: bp });
    const members = admin.socket.room!.members;
    expect(members[0]).toMatchObject({ robot: 'custom-abcd12', custom: withoutMesh(bp) });
    expect(members[1].robot).toBe('uran-v2');
    expect(members[2]).toMatchObject({ robot: 'bobik' });
    expect(members[2].custom).toBeUndefined();
    // Every game in the room drives it by its blueprint's id.
    expect(roomDrivers(admin.socket.room!).drivers[0].robot).toBe(sharedRobotId(bp));

    // Back to a team's robot: the blueprint goes.
    admin.send({ t: 'robot', robot: 'bumble-v' });
    expect(admin.socket.room!.members[0]).toEqual(expect.objectContaining({ robot: 'bumble-v' }));
    expect(admin.socket.room!.members[0].custom).toBeUndefined();
  });

  it('a game with a player-made robot counts, but never goes into the high score tables', () => {
    const report = parseReport({ type: 'solo', mode: 'match', duration: 150, score: { red: 120, blue: 0 }, players: [{ alliance: 'red', robot: 'custom-abcd12' }], ai: [], device: 'device-12345678' });
    expect(report).not.toBeNull();
    expect(recordRun({ ...report!, players: report!.players })).toBeNull();
    const team = parseReport({ type: 'solo', mode: 'match', duration: 150, score: { red: 120, blue: 0 }, players: [{ alliance: 'red', robot: 'uran-v2' }], ai: [], device: 'device-12345678' });
    expect(recordRun({ ...team!, players: team!.players })).toBe('solo');
    expect(parseReport({ type: 'solo', mode: 'match', duration: 150, score: { red: 1, blue: 0 }, players: [{ alliance: 'red', robot: 'robot-of-mine' }], ai: [], device: 'device-12345678' })).toBeNull();
  });
});
