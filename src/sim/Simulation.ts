// The whole game without graphics: field physics, balls, hives, robots, match and scoring.
// Runs in the browser, for solo play and for two drivers on a split screen.

import RAPIER from '@dimforge/rapier3d-compat';
import type { FieldLayout } from '../field/layout';
import { buildZones, footprint, type Zones } from '../field/zones';
import { defaultStart, forAlliance, resolveStarts, slotStation, startField, type StartField, type StartPose } from '../field/startPose';
import { fieldCentric } from '../robot/mecanum';
import type { Alliance } from '../robot/robotConfig';
import { DEFAULT_ROBOT_ID, robotById } from '../robot/robots';
import { BALL_RESTITUTION, BallSim } from './BallSim';
import type { ColliderPart } from './colliders';
import { HiveSim } from './HiveSim';
import { Match, type MatchEvents } from './Match';
import { Mechanisms } from './Mechanisms';
import { RobotSim, type Pose } from './RobotSim';
import type { WorldState } from './state';
import type { Vec3 } from '../field/layout';
import type { Ball } from './BallSim';
import { DEFAULT_RULES, type RuleOptions } from './Referee';
import { SLOTS, idleInput, mergeInput, slotAlliance, type GameMode, type RobotInput, type Slot } from './types';

export const PHYSICS_DT = 1 / 120;
const WALL_HEIGHT = 0.32;
const WALL_THICKNESS = 0.06;

/** A hit on the HIVE frame faster than this is reported to the referee (G417), m/s */
const HIVE_HIT_SPEED = 0.8;
/**
 * A PIN (G421): the pinned robot's driver pushes the sticks this far but it moves slower than
 * `stuck`, held within `against` of a wall or field element.
 */
const PIN = { trying: 0.3, stuck: 0.15, against: 0.03, foulEvery: 3, apart: 0.61, endAfterApart: 3 };
/**
 * A ball leaving a robot keeps only `keep` of its speed. Shots start inside their robot, so a ball
 * shot less than `shotClear` s ago is left alone.
 */
const ROBOT_HIT = { keep: 0.35, shotClear: 0.3 };
/** Robots that run into each other faster than this (closing speed) knock both turrets off aim, m/s */
const KNOCK_SPEED = 0.7;
/**
 * A robot running into a FLOWER faster than `speed` (m/s) jolts its stack: the balls in the tube
 * jump up by `lift` times the robot's speed (at most `max`, m/s) and fall back, the way the blocks
 * of a VEX loader tube hop when a robot rams it. A ball in the tube is closer than `tube` m to its center.
 */
const FLOWER_JOLT = { speed: 0.4, lift: 1.1, max: 1.5, tube: 0.09, height: 0.62 };

/** During AUTO each alliance owns its half of the field: red is -X (columns A–C), blue +X. */
const onOpponentSide = (alliance: Alliance, x: number) => (alliance === 'red' ? x > 0 : x < 0);

export interface PlayerRobot {
  /** Which robot (robots.ts) this player drives */
  robotId: string;
  robot: RobotSim;
  mech: Mechanisms;
  input: RobotInput;
  name: string;
}

let rapierReady: Promise<void> | null = null;
/** Loads the physics engine (WASM) once. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export class Simulation {
  readonly world: RAPIER.World;
  readonly zones: Zones;
  readonly balls: BallSim;
  readonly hives: Record<Alliance, HiveSim>;
  readonly match: Match;
  readonly robots = new Map<Slot, PlayerRobot>();
  /** The red side's limits for a start (G304) */
  readonly startField: StartField;
  private starts = new Map<Slot, Pose>();
  /** Simulated seconds since creation */
  time = 0;
  private rules: RuleOptions = { ...DEFAULT_RULES };
  /** The HIVE frame (G417) and the outlines of field elements a robot can be pinned against (G421) */
  private hiveFrame: RAPIER.Collider | null = null;
  /** The HIVE frame's footprint, so contact is only asked of Rapier for robots near it */
  private hiveFrameBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  private readonly obstacles: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private readonly frameContact = new Map<Slot, boolean>();
  /** Each FLOWER's collider and footprint, with its tube center (x, z) */
  private readonly flowerParts: { collider: RAPIER.Collider; box: { minX: number; maxX: number; minZ: number; maxZ: number }; center: [number, number] }[] = [];
  /** Robot and FLOWER ("red1|2") touching at the last step, and each robot's speed going into this one */
  private readonly flowerContact = new Set<string>();
  private readonly flowerSpeed = new Map<Slot, number>();
  /** Robot pairs ("red1|blue1") touching at the last step */
  private readonly robotContact = new Set<string>();
  private readonly lastSpeed = new Map<Slot, number>();
  /** PIN counts keyed "pinner|pinned" */
  private readonly pins = new Map<string, { time: number; fouls: number; apart: number }>();
  /** 1 for each ball (by id) that touched a robot at the last step */
  private readonly onRobot: Uint8Array;
  /** 1 for each ball (by id) a robot presses against the wall or a field element */
  private readonly pressed: Uint8Array;

  /** The HIVE frame's footprint on the floor (the AI drives around it) */
  get frameBox(): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    return this.hiveFrameBox;
  }

  /** Call initPhysics() first. */
  constructor(readonly layout: FieldLayout, colliders: ColliderPart[], events: MatchEvents) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.zones = buildZones(layout);
    this.startField = startField(layout, this.zones);
    this.buildField(colliders);
    this.balls = new BallSim(this.world, layout);
    this.onRobot = new Uint8Array(this.balls.all.length);
    this.pressed = new Uint8Array(this.balls.all.length);
    const hive = (a: Alliance) => {
      const shape = colliders.find(c => c.kind === `hive_${a}`);
      if (!shape) throw new Error(`field-colliders.bin has no hive_${a}`);
      return new HiveSim(this.world, a, layout.hives[a].pivot, shape);
    };
    this.hives = { red: hive('red'), blue: hive('blue') };
    this.match = new Match(this.balls, this.hives, () => [...this.robots.values()].map(p => p.robot), this.zones, events);
    this.reset();
  }

  private buildField(colliders: ColliderPart[]): void {
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const part of colliders) {
      if (part.kind !== 'static') continue;
      const collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(part.vertices, part.indices).setFriction(0.5).setRestitution(0.3), ground);
      if (part.name === 'frame') this.hiveFrame = collider;
      const v = part.vertices;
      const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (let i = 0; i < v.length; i += 3) {
        box.minX = Math.min(box.minX, v[i]);
        box.maxX = Math.max(box.maxX, v[i]);
        box.minZ = Math.min(box.minZ, v[i + 2]);
        box.maxZ = Math.max(box.maxZ, v[i + 2]);
      }
      this.obstacles.push(box);
      if (part.name === 'frame') this.hiveFrameBox = box;
      if (part.name.startsWith('flower')) {
        const mid: [number, number] = [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2];
        const center = [...this.zones.flowers].sort((a, b) => Math.hypot(a[0] - mid[0], a[1] - mid[1]) - Math.hypot(b[0] - mid[0], b[1] - mid[1]))[0];
        this.flowerParts.push({ collider, box, center });
      }
    }
    // Floor (soft foam tiles) and perimeter walls (polycarbonate) as simple boxes.
    const half = this.zones.wall;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.05, 8).setTranslation(0, -0.05, 0).setFriction(0.9).setRestitution(BALL_RESTITUTION), ground);
    const wallLen = half + WALL_THICKNESS * 2;
    for (const [x, z, sx, sz] of [
      [half + WALL_THICKNESS / 2, 0, WALL_THICKNESS / 2, wallLen],
      [-half - WALL_THICKNESS / 2, 0, WALL_THICKNESS / 2, wallLen],
      [0, half + WALL_THICKNESS / 2, wallLen, WALL_THICKNESS / 2],
      [0, -half - WALL_THICKNESS / 2, wallLen, WALL_THICKNESS / 2],
    ]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(sx, WALL_HEIGHT / 2, sz).setTranslation(x, WALL_HEIGHT / 2, z).setFriction(0.2).setRestitution(0.4),
        ground,
      );
    }
  }

  /** Where a robot starts: picked by its driver (setStarts), or touching its alliance wall at its driver station, facing the field. */
  startPose(slot: Slot, robotLength: number): Pose {
    return this.starts.get(slot) ?? forAlliance(defaultStart(slotStation(slot), robotLength, this.zones.wall), slotAlliance(slot));
  }

  /**
   * Drivers' own starts (red side, manual G304) for the robots on the field; a robot without one,
   * or with one that G304 doesn't allow there, starts in a free default spot.
   */
  setStarts(picked: Partial<Record<Slot, StartPose | null>>): void {
    this.starts = resolveStarts([...this.robots].map(([slot, p]) => ({ slot, cfg: p.robot.cfg, start: picked[slot] })), this.startField);
    for (const [slot, p] of this.robots) p.robot.setPose(this.startPose(slot, p.robot.cfg.length));
  }

  addRobot(slot: Slot, name: string, robotId: string = DEFAULT_ROBOT_ID): PlayerRobot {
    this.removeRobot(slot);
    const def = robotById(robotId);
    const robot = new RobotSim(this.world, slot, def.config, this.startPose(slot, def.config.length), def.arm, def.lift);
    const mech = new Mechanisms(robot, this.balls, () => this.hives[robot.alliance].target(), this.zones.flowers, def);
    mech.reset(this.balls.preloads(slot));
    mech.onPickup = (b, at) => this.judgePickup(robot, b, at);
    robot.battery.enabled = this.rules.battery;
    mech.movingShots = this.rules.movingShots;
    const player = { robotId: def.id, robot, mech, input: idleInput(), name };
    this.robots.set(slot, player);
    return player;
  }

  removeRobot(slot: Slot): void {
    const p = this.robots.get(slot);
    if (!p) return;
    p.mech.dropAll();
    p.robot.remove();
    this.robots.delete(slot);
  }

  /** Field, balls, hives and robots back to the match start. */
  reset(): void {
    this.balls.reset();
    this.hives.red.reset();
    this.hives.blue.reset();
    this.robotContact.clear();
    for (const [slot, p] of this.robots) {
      p.robot.setPose(this.startPose(slot, p.robot.cfg.length));
      p.robot.battery.reset();
      p.mech.reset(this.balls.preloads(slot));
      p.input = idleInput();
    }
  }

  /** House rules: the referee's fouls and cards, the battery, shooting on the move. */
  setRules(rules: RuleOptions): void {
    this.rules = { ...rules };
    this.match.referee.options = { ...rules };
    for (const p of this.robots.values()) {
      p.robot.battery.enabled = rules.battery;
      p.mech.movingShots = rules.movingShots;
    }
  }

  /** The house rules in play (the AI drives by them too). */
  get ruleOptions(): Readonly<RuleOptions> {
    return this.rules;
  }

  start(mode: GameMode): void {
    this.reset();
    this.match.start(mode === 'match' ? 'auto' : 'practice');
  }

  setInput(slot: Slot, input: RobotInput): void {
    const p = this.robots.get(slot);
    if (p) p.input = mergeInput(p.input, input);
  }

  /** One fixed physics step. */
  step(): void {
    const dt = PHYSICS_DT;
    const enabled = this.match.robotEnabled;
    for (const p of this.robots.values()) {
      const { robot, mech, input } = p;
      if (enabled) {
        if (input.imuReset) robot.resetImu();
        let forward = -input.ly;
        let strafe = input.lx;
        if (input.fieldCentric) ({ forward, strafe } = fieldCentric(forward, strafe, robot.heading));
        robot.drive(forward, strafe, input.rx, dt);
      } else {
        robot.drive(0, 0, 0, dt);
      }
      mech.step(dt, input, enabled);
      robot.setArm(mech.arm);
      robot.setLift(mech.lift);
      const { fl, fr, bl, br } = robot.powers;
      robot.battery.step(dt, mech.flywheel, (Math.abs(fl) + Math.abs(fr) + Math.abs(bl) + Math.abs(br)) / 4);
      input.shooterOn = input.shooterOff = input.imuReset = input.armUp = input.armDown = input.lift = false;
    }
    this.hives.red.step(dt, this.balls);
    this.hives.blue.step(dt, this.balls);
    this.balls.step(dt);
    this.match.step(dt);
    // How fast the robots were going into the step is how hard they hit each other in it.
    const before = this.robots.size > 1 ? new Map([...this.robots].map(([slot, p]) => [slot, p.robot.velocity])) : null;
    this.world.step();
    this.balls.sync();
    if (before) this.knockTurrets(before);
    this.shakeFlowers();
    this.softenRobotHits();
    this.judgeContacts(dt);
    this.time += dt;
  }

  /** A robot (or its lowered arm) that just ran into a FLOWER hard enough jolts the balls in its tube. */
  private shakeFlowers(): void {
    for (const { robot } of this.robots.values()) {
      const speed = this.flowerSpeed.get(robot.slot) ?? 0;
      this.flowerSpeed.set(robot.slot, robot.speed);
      this.flowerParts.forEach((f, i) => {
        const key = `${robot.slot}|${i}`;
        const arm = robot.solidArm;
        const touching = this.near(robot, f.box) && (this.touching(robot.collider, f.collider) || (!!arm && this.touching(arm, f.collider)));
        if (touching && !this.flowerContact.has(key) && speed > FLOWER_JOLT.speed) this.jolt(f.center, speed);
        if (touching) this.flowerContact.add(key);
        else this.flowerContact.delete(key);
      });
    }
  }

  /** The balls in the FLOWER tube at (cx, cz) jump up together. */
  private jolt([cx, cz]: [number, number], speed: number): void {
    const up = Math.min(FLOWER_JOLT.max, speed * FLOWER_JOLT.lift);
    for (const b of this.balls.all) {
      if (b.state !== 'field') continue;
      const [x, y, z] = this.balls.position(b);
      if (y > FLOWER_JOLT.height || Math.hypot(x - cx, z - cz) > FLOWER_JOLT.tube) continue;
      const v = b.body.linvel();
      b.body.setLinvel({ x: v.x, y: v.y + up, z: v.z }, true);
    }
  }

  private hasOpponent(alliance: Alliance): boolean {
    return [...this.robots.values()].some(p => p.robot.alliance !== alliance);
  }

  /** G408 (opponent NECTAR) and G402 (opponent's elements during AUTO) when the intake takes a ball. */
  private judgePickup(robot: RobotSim, b: Ball, at: Vec3): void {
    const match = this.match;
    if (!match.judging) return;
    if (b.kind === 'nectar' && b.color !== robot.alliance) match.referee.opponentNectar(robot.slot);
    if (match.period === 'auto' && onOpponentSide(robot.alliance, at[0]) && this.hasOpponent(robot.alliance)) match.referee.autoInterference(robot.slot);
  }

  private touching(a: RAPIER.Collider, b: RAPIER.Collider): boolean {
    let contact = false;
    this.world.contactPair(a, b, manifold => {
      if (manifold.numContacts() > 0) contact = true;
    });
    return contact;
  }

  /** Direction a contact pushes from `a` onto `b` (world space), or null if they don't touch. */
  private contactNormal(a: RAPIER.Collider, b: RAPIER.Collider): RAPIER.Vector | null {
    let normal: RAPIER.Vector | null = null;
    this.world.contactPair(a, b, (manifold, flipped) => {
      if (manifold.numContacts() === 0) return;
      const n = manifold.normal();
      normal = flipped ? { x: -n.x, y: -n.y, z: -n.z } : n;
    });
    return normal;
  }

  /**
   * A robot pressing a ball against the wall, a FLOWER or the HIVE: the light ball would give way to
   * the heavy robot and squeeze through the wall. Squeezed like that a real ball stops the robot, so
   * the ball becomes something robots can't push (a higher dominance group) until no robot touches it.
   * Pressed down onto the tiles (by an arm over it) it isn't pinned: it rolls on as it is pushed.
   */
  private pressedAgainstField(b: Ball, push: RAPIER.Vector): boolean {
    let pressed = false;
    this.world.contactPairsWith(b.collider, other => {
      const body = other.parent();
      if (pressed || !body || !(body.isFixed() || body.isKinematic())) return;
      const n = this.contactNormal(b.collider, other);
      if (n && Math.abs(n.y) < 0.7 && n.x * push.x + n.y * push.y + n.z * push.z > 0.5) pressed = true;
    });
    return pressed;
  }

  /**
   * Bumpers and hollow plastic soak up a hit: a ball pushed or struck by a robot rolls off slowly
   * instead of shooting across the field. It loses the speed as it leaves the robot, so the robot
   * can still push it along.
   */
  private softenRobotHits(): void {
    const robots = [...this.robots.values()].map(({ robot }) => {
      const [x, , z] = robot.position;
      return { robot, x, z, reach: Math.hypot(robot.cfg.length, robot.cfg.width) / 2 };
    });
    for (const b of this.balls.all) {
      let touching = false;
      if (b.state === 'field' && !b.body.isSleeping() && !(b.launch?.kind === 'shot' && b.launch.age < ROBOT_HIT.shotClear)) {
        const [x, , z] = this.balls.position(b);
        for (const { robot, x: rx, z: rz, reach } of robots) {
          if (Math.hypot(x - rx, z - rz) > reach + b.radius + 0.02) continue;
          const arm = robot.solidArm;
          const push = this.contactNormal(robot.collider, b.collider) ?? (arm ? this.contactNormal(arm, b.collider) : null);
          if (!push) continue;
          touching = true;
          if (!this.pressed[b.id] && this.pressedAgainstField(b, push)) {
            this.pressed[b.id] = 1;
            b.body.setDominanceGroup(1);
          }
          if (this.pressed[b.id]) {
            // Pushed back out of the wall it just rests there: it must not shove the robot away.
            const v = b.body.linvel();
            const back = v.x * push.x + v.y * push.y + v.z * push.z;
            if (back < 0) b.body.setLinvel({ x: v.x - back * push.x, y: v.y - back * push.y, z: v.z - back * push.z }, true);
          }
        }
      }
      if (this.pressed[b.id] && !touching) {
        this.pressed[b.id] = 0;
        b.body.setDominanceGroup(0);
      }
      if (this.onRobot[b.id] && !touching && b.state === 'field') {
        const v = b.body.linvel();
        const w = b.body.angvel();
        const k = ROBOT_HIT.keep;
        b.body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
        // Its spin too, or the floor would turn the spin back into speed.
        b.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
      }
      this.onRobot[b.id] = touching ? 1 : 0;
    }
  }

  /** Robots near each other, or near the HIVE frame (a cheap test before asking Rapier). */
  private near(r: RobotSim, other: RobotSim | { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
    const [x, , z] = r.position;
    const reach = Math.hypot(r.cfg.length, r.cfg.width) / 2 + 0.05;
    if (other instanceof RobotSim) {
      const [ox, , oz] = other.position;
      return Math.hypot(x - ox, z - oz) < reach + Math.hypot(other.cfg.length, other.cfg.width) / 2;
    }
    return x > other.minX - reach && x < other.maxX + reach && z > other.minZ - reach && z < other.maxZ + reach;
  }

  /** Defence: two robots that run into each other hard knock each other's turrets off their aim. */
  private knockTurrets(before: Map<Slot, [number, number]>): void {
    const players = [...this.robots.values()];
    players.forEach((a, i) => {
      for (const b of players.slice(i + 1)) {
        const key = `${a.robot.slot}|${b.robot.slot}`;
        const contact = this.near(a.robot, b.robot) && this.touching(a.robot.collider, b.robot.collider);
        if (contact && !this.robotContact.has(key)) {
          const [ax, , az] = a.robot.position;
          const [bx, , bz] = b.robot.position;
          const [avx, avz] = before.get(a.robot.slot)!;
          const [bvx, bvz] = before.get(b.robot.slot)!;
          // Speed along the line between them: a glancing scrape doesn't count.
          const closing = ((avx - bvx) * (bx - ax) + (avz - bvz) * (bz - az)) / Math.max(1e-6, Math.hypot(bx - ax, bz - az));
          if (closing > KNOCK_SPEED) {
            a.mech.knock();
            b.mech.knock();
          }
        }
        if (contact) this.robotContact.add(key);
        else this.robotContact.delete(key);
      }
    });
  }

  /** Rules about contact: G417 (HIVE frame), G402 (opponent robot during AUTO), G421 (PINS). */
  private judgeContacts(dt: number): void {
    const match = this.match;
    const players = [...this.robots.values()];
    if (!match.judging) {
      this.pins.clear();
      return;
    }
    for (const p of players) {
      const slot = p.robot.slot;
      const hit = !!this.hiveFrame && !!this.hiveFrameBox && this.near(p.robot, this.hiveFrameBox) && this.touching(p.robot.collider, this.hiveFrame);
      // The speed it had before this step is how hard it hit.
      const speed = this.lastSpeed.get(slot) ?? 0;
      if (hit && !this.frameContact.get(slot) && speed > HIVE_HIT_SPEED) match.referee.hiveFrameHit(slot, speed, this.time);
      this.frameContact.set(slot, hit);
      this.lastSpeed.set(slot, p.robot.speed);
    }
    for (const a of players) {
      for (const b of players) {
        if (a.robot.alliance !== 'red' || b.robot.alliance !== 'blue') continue;
        const contact = this.near(a.robot, b.robot) && this.touching(a.robot.collider, b.robot.collider);
        if (contact && match.period === 'auto') {
          // Whoever is on the other alliance's half is disrupting their AUTO.
          const x = (a.robot.position[0] + b.robot.position[0]) / 2;
          for (const p of [a, b]) if (onOpponentSide(p.robot.alliance, x)) match.referee.autoInterference(p.robot.slot);
        }
        this.judgePin(a, b, contact, dt);
        this.judgePin(b, a, contact, dt);
      }
    }
  }

  /** A robot right up against the perimeter wall, the HIVE frame or a FLOWER. */
  private againstFieldElement(robot: RobotSim): boolean {
    const [x, , z] = robot.position;
    const wall = this.zones.wall - PIN.against;
    const e = PIN.against;
    return footprint(x, z, robot.yaw, robot.cfg.length, robot.cfg.width).some(([cx, cz]) =>
      Math.abs(cx) > wall || Math.abs(cz) > wall
      || this.obstacles.some(o => cx > o.minX - e && cx < o.maxX + e && cz > o.minZ - e && cz < o.maxZ + e));
  }

  /**
   * G421: `pinner` holds `pinned` against a field element while its driver tries to get away.
   * The count pauses when they separate and ends once they stay 2 ft apart for 3 s.
   */
  private judgePin(pinner: PlayerRobot, pinned: PlayerRobot, contact: boolean, dt: number): void {
    const key = `${pinner.robot.slot}|${pinned.robot.slot}`;
    const { lx, ly, rx } = pinned.input;
    const held = contact
      && Math.hypot(lx, ly, rx) > PIN.trying
      && pinned.robot.speed < PIN.stuck
      && this.againstFieldElement(pinned.robot);
    const count = this.pins.get(key);
    if (held) {
      const c = count ?? { time: 0, fouls: 0, apart: 0 };
      c.time += dt;
      c.apart = 0;
      if (c.time > PIN.foulEvery * (c.fouls + 1)) {
        c.fouls++;
        this.match.referee.pin(pinner.robot.slot);
      }
      this.pins.set(key, c);
      return;
    }
    if (!count) return;
    const [ax, , az] = pinner.robot.position;
    const [bx, , bz] = pinned.robot.position;
    const gap = Math.hypot(ax - bx, az - bz) - (pinner.robot.cfg.length + pinned.robot.cfg.length) / 2;
    if (gap > PIN.apart) {
      count.apart += dt;
      if (count.apart > PIN.endAfterApart) this.pins.delete(key);
    }
  }

  /** Everything a renderer or a network snapshot needs. */
  state(): WorldState {
    const transforms = this.balls.transforms.slice();
    const states = new Uint8Array(this.balls.all.length);
    this.balls.all.forEach((b, i) => {
      states[i] = b.state === 'field' ? 0 : b.state === 'held' ? 1 : 2;
    });
    return {
      time: this.time,
      period: this.match.period,
      periodTime: this.match.time,
      hiveAngles: { red: this.hives.red.angle, blue: this.hives.blue.angle },
      tips: { red: this.hives.red.tips, blue: this.hives.blue.tips },
      score: { red: structuredClone(this.match.score.red), blue: structuredClone(this.match.score.blue) },
      robots: SLOTS.filter(s => this.robots.has(s)).map(slot => {
        const { robot, mech, robotId, input } = this.robots.get(slot)!;
        const [x, , z] = robot.position;
        return {
          slot,
          robot: robotId,
          x,
          z,
          yaw: robot.yaw,
          heading: robot.heading,
          speed: robot.speed,
          turretYaw: mech.turretYaw,
          pitch: mech.shot?.pitch ?? 0.9,
          flywheel: mech.turret.flywheel,
          extraTurrets: mech.turrets.slice(1).map(t => ({ yaw: t.yaw, pitch: t.shot?.pitch ?? 0.9, flywheel: t.flywheel })),
          intakeDir: mech.intakeDir,
          transfer: input.transfer && this.match.robotEnabled,
          status: mech.status,
          shotSpeed: mech.shot?.speed ?? 0,
          shotDistance: mech.shot?.distance ?? 0,
          powers: { ...robot.powers },
          stored: mech.stored.map(b => b.id),
          pocket: mech.pocket?.id ?? null,
          voltage: robot.battery.voltage,
          minVoltage: robot.battery.minVoltage,
          arm: mech.arm,
          lift: mech.lift,
          boxRollers: mech.boxRollers,
          box: mech.box.map(b => b.id),
          boxTop: mech.boxTop,
          boxExit: mech.boxExit && { id: mech.boxExit.ball.id, t: mech.boxExit.t, to: mech.boxExit.to && [...mech.boxExit.to] },
        };
      }),
      balls: { states, transforms },
    };
  }
}
