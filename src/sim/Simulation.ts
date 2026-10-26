// The whole game without graphics: field physics, balls, hives, robots, match and scoring.
// Runs in the browser for solo play and on the server for online matches.

import RAPIER from '@dimforge/rapier3d-compat';
import type { FieldLayout } from '../field/layout';
import { buildZones, type Zones } from '../field/zones';
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
import { SLOTS, idleInput, mergeInput, type GameMode, type RobotInput, type Slot } from './types';

export const PHYSICS_DT = 1 / 120;
const SLOW_MODE_SCALE = 0.35;
const WALL_HEIGHT = 0.32;
const WALL_THICKNESS = 0.06;

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
      if (part.kind === 'static') this.world.createCollider(RAPIER.ColliderDesc.trimesh(part.vertices, part.indices).setFriction(0.5).setRestitution(0.3), ground);
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
    const mech = new Mechanisms(robot, this.balls, () => this.hives[robot.alliance].target(), this.zones.flowers, def.shooter);
    mech.reset(this.balls.preloads(slot));
    mech.onViolation = rule => this.match.recordViolation(robot, rule);
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
      p.mech.reset(this.balls.preloads(slot));
      p.input = idleInput();
    }
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
      input.shooterOn = input.shooterOff = input.imuReset = false;
    }
    this.hives.red.step(dt, this.balls);
    this.hives.blue.step(dt, this.balls);
    this.balls.step();
    this.match.step(dt);
    this.world.step();
    this.time += dt;
  }

  /** Everything a renderer or a network snapshot needs. */
  state(): WorldState {
    const n = this.balls.all.length;
    const transforms = new Float32Array(n * 7);
    const states = new Uint8Array(n);
    this.balls.all.forEach((b, i) => {
      const t = b.body.translation();
      const r = b.body.rotation();
      transforms.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
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
        };
      }),
      balls: { states, transforms },
    };
  }
}
