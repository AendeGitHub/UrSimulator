// The whole game without graphics: field physics, balls, hives, robots, match and scoring.
// Runs in the browser for solo play and on the server for online matches.

import RAPIER from '@dimforge/rapier3d-compat';
import type { FieldLayout } from '../field/layout';
import { buildZones, footprint, type Zones } from '../field/zones';
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
import { SLOTS, idleInput, mergeInput, type GameMode, type RobotInput, type Slot } from './types';

export const PHYSICS_DT = 1 / 120;
const SLOW_MODE_SCALE = 0.35;
const WALL_HEIGHT = 0.32;
const WALL_THICKNESS = 0.06;

/** A hit on the HIVE frame faster than this is reported to the referee (G417), m/s */
const HIVE_HIT_SPEED = 0.8;
/**
 * A PIN (G421): the pinned robot's driver pushes the sticks this far but it moves slower than
 * `stuck`, held within `against` of a wall or field element.
 */
const PIN = { trying: 0.3, stuck: 0.15, against: 0.03, foulEvery: 3, apart: 0.61, endAfterApart: 3 };

/** During AUTO each alliance owns its half of the field: red is -X (columns A–C), blue +X. */
const onOpponentSide = (alliance: Alliance, x: number) => (alliance === 'red' ? x > 0 : x < 0);

/** Robots start touching their alliance wall, facing away from their drivers. */
const START_Z: Record<Slot, number> = { red1: -0.25, red2: 1.15, blue1: 0.25, blue2: -1.15 };

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
  /** Simulated seconds since creation */
  time = 0;
  private rules: RuleOptions = { ...DEFAULT_RULES };
  /** The HIVE frame (G417) and the outlines of field elements a robot can be pinned against (G421) */
  private hiveFrame: RAPIER.Collider | null = null;
  /** The HIVE frame's footprint, so contact is only asked of Rapier for robots near it */
  private hiveFrameBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  private readonly obstacles: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private readonly frameContact = new Map<Slot, boolean>();
  private readonly lastSpeed = new Map<Slot, number>();
  /** PIN counts keyed "pinner|pinned" */
  private readonly pins = new Map<string, { time: number; fouls: number; apart: number }>();

  /** Call initPhysics() first. */
  constructor(readonly layout: FieldLayout, colliders: ColliderPart[], events: MatchEvents) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.zones = buildZones(layout);
    this.buildField(colliders);
    this.balls = new BallSim(this.world, layout);
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

  startPose(slot: Slot, robotLength: number): Pose {
    const x = this.zones.wall - robotLength / 2 - 0.004;
    return slot.startsWith('red') ? { x: -x, z: START_Z[slot], yaw: 0 } : { x, z: START_Z[slot], yaw: Math.PI };
  }

  addRobot(slot: Slot, name: string, robotId: string = DEFAULT_ROBOT_ID): PlayerRobot {
    this.removeRobot(slot);
    const def = robotById(robotId);
    const robot = new RobotSim(this.world, slot, def.config, this.startPose(slot, def.config.length));
    const mech = new Mechanisms(robot, this.balls, () => this.hives[robot.alliance].target(), this.zones.flowers, def.shooter, def.intakes);
    mech.reset(this.balls.preloads(slot));
    mech.onPickup = (b, at) => this.judgePickup(robot, b, at);
    robot.battery.enabled = this.rules.battery;
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
    for (const [slot, p] of this.robots) {
      p.robot.setPose(this.startPose(slot, p.robot.cfg.length));
      p.robot.battery.reset();
      p.mech.reset(this.balls.preloads(slot));
      p.input = idleInput();
    }
  }

  /** House rules for the referee (fouls and cards on or off). */
  setRules(rules: RuleOptions): void {
    this.rules = { ...rules };
    this.match.referee.options = { ...rules };
    for (const p of this.robots.values()) p.robot.battery.enabled = rules.battery;
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
        const scale = input.slow ? SLOW_MODE_SCALE : 1;
        let forward = -input.ly;
        let strafe = input.lx;
        if (input.fieldCentric) ({ forward, strafe } = fieldCentric(forward, strafe, robot.heading));
        robot.drive(forward * scale, strafe * scale, input.rx * scale, dt);
      } else {
        robot.drive(0, 0, 0, dt);
      }
      mech.step(dt, input, enabled);
      const { fl, fr, bl, br } = robot.powers;
      robot.battery.step(dt, mech.flywheel, (Math.abs(fl) + Math.abs(fr) + Math.abs(bl) + Math.abs(br)) / 4);
      input.shooterOn = input.shooterOff = input.imuReset = false;
    }
    this.hives.red.step(dt, this.balls);
    this.hives.blue.step(dt, this.balls);
    this.balls.step(dt);
    this.match.step(dt);
    this.world.step();
    this.balls.sync();
    this.judgeContacts(dt);
    this.time += dt;
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
          flywheel: mech.flywheel,
          intakeDir: mech.intakeDir,
          transfer: input.transfer && this.match.robotEnabled,
          status: mech.status,
          shotSpeed: mech.shot?.speed ?? 0,
          shotDistance: mech.shot?.distance ?? 0,
          powers: { ...robot.powers },
          stored: mech.stored.map(b => b.id),
          voltage: robot.battery.voltage,
          minVoltage: robot.battery.minVoltage,
        };
      }),
      balls: { states, transforms },
    };
  }
}
