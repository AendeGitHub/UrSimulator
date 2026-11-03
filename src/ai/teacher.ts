// The teacher: a hand-written driver that plays BIOBUZZ well enough to learn from. The network
// (policy.ts) is trained to copy it (tools/train-bot.ts) and drives the AI robot in the game; the
// teacher itself only plays during training.
//
// It collects the balls its intake takes that are quickest to reach, or pulls POLLEN out of a
// FLOWER with its arm (Flower Mode), shoots a full load from the nearest good spot in front of the
// upward cell of its HIVE once the flywheel is up to speed (already while rolling in), stays on its
// own half in AUTO (G402) and parks in its loading zone at the end of the match.

import { wrapAngle } from '../robot/mecanum';
import type { Ball } from '../sim/BallSim';
import { CAPACITY } from '../sim/Mechanisms';
import type { PlayerRobot, Simulation } from '../sim/Simulation';
import { neededFlywheel, type BotAction } from './action';
import {
  ballCost, dist, flowerCost, flowerPlans, inShootingPosition, nextWaypoint, opponentOf, parkSpot, pickableBalls, robotXZ,
  rotateToRobot, shotPlan, toRobot, waitSpot, yawToward, type FlowerPlan, type XZ,
} from './field';

/** A target costing more than this to reach is not worth it with balls already on board */
const WORTH_IT = 1.6;
/** Seconds of TELEOP left when it shoots what it has, and when it goes to park */
const LAST_SHOTS = 18;
const PARK = 6;
/** A ball it couldn't get for this long is left alone for a while, s */
const GIVE_UP = 5;
const SKIP_FOR = 6;
/** Seconds at a FLOWER with the arm down without getting a ball before giving up on it */
const FLOWER_PATIENCE = 2.5;

/** Strategy switches, so variants can be compared in matches (tools/bot-arena.ts) */
export interface TeacherOptions {
  /** Pull POLLEN out of FLOWERs with the arm (Flower Mode) when that beats the floor */
  flowers: boolean;
  /** Shoot from the nearest good spot instead of straight in front of the opening */
  shootNearest: boolean;
  /** Start firing as soon as it is in the shooting zone, still rolling to the spot */
  fireMoving: boolean;
}

export const DEFAULT_TEACHER: TeacherOptions = { flowers: true, shootNearest: true, fireMoving: true };

/** What the teacher is busy with (for statistics and debugging) */
export type TeacherPhase = 'collect' | 'flower' | 'toSpot' | 'fire' | 'wait' | 'park';
export const TEACHER_PHASES: TeacherPhase[] = ['collect', 'flower', 'toSpot', 'fire', 'wait', 'park'];

/** Sticks that drive the robot toward `goal` (around the HIVE frame), facing `face`. */
export function driveTo(sim: Simulation, p: PlayerRobot, goal: XZ, opts: { minSpeed: number; slowFrom: number; face: number | null; ownSide: boolean }): Pick<BotAction, 'forward' | 'strafe' | 'turn'> {
  const at = robotXZ(p);
  const { point, length } = nextWaypoint(sim, p, goal, opts.ownSide);
  const d = dist(at, point);
  let vx = 0;
  let vz = 0;
  if (length > 0.04 && d > 1e-6) {
    const speed = Math.max(opts.minSpeed, Math.min(1, length / opts.slowFrom));
    vx = ((point[0] - at[0]) / d) * speed;
    vz = ((point[1] - at[1]) / d) * speed;
  }
  // Keep clear of FLOWERs and the other robot.
  const push = (from: XZ, reach: number, strength: number) => {
    const e = dist(at, from);
    if (e > reach || e < 1e-6) return;
    const k = ((reach - e) / reach) * strength;
    vx += ((at[0] - from[0]) / e) * k;
    vz += ((at[1] - from[1]) / e) * k;
  };
  for (const f of sim.zones.flowers) if (dist(f, goal) > 0.3) push(f, 0.36, 1.2);
  const opponent = opponentOf(sim, p);
  if (opponent && dist(robotXZ(opponent), goal) > 0.35) push(robotXZ(opponent), 0.7, 0.9);

  let [forward, strafe] = rotateToRobot(p.robot.yaw, [vx, vz]);
  const m = Math.hypot(forward, strafe);
  if (m > 1) {
    forward /= m;
    strafe /= m;
  }
  let turn = 0;
  if (opts.face !== null) {
    turn = turnToward(p, opts.face);
    // Close to the goal, turn first so the intake (or the robot's front) meets it head on.
    if (length < 0.45 && Math.abs(wrapAngle(opts.face - p.robot.yaw)) > 0.6) {
      forward *= 0.25;
      strafe *= 0.25;
    }
  }
  return { forward, strafe, turn };
}

/** Right stick that turns the robot to `yaw` (positive turns clockwise, yaw grows counterclockwise). */
const turnToward = (p: PlayerRobot, yaw: number) => Math.max(-1, Math.min(1, -2.2 * wrapAngle(yaw - p.robot.yaw)));

export class Teacher {
  phase: TeacherPhase = 'wait';
  private mode: 'collect' | 'shoot' = 'collect';
  private target: Ball | null = null;
  private targetTime = 0;
  /** Ball id → simulation time until which it is left alone */
  private readonly skipped = new Map<number, number>();
  /** The FLOWER being emptied, and for how long without a ball */
  private flower: XZ | null = null;
  private flowerTime = 0;
  private flowerStored = 0;
  /** FLOWER (by x, z) → simulation time until which it is left alone */
  private readonly skippedFlowers = new Map<string, number>();
  readonly options: TeacherOptions;

  constructor(options: Partial<TeacherOptions> = {}) {
    this.options = { ...DEFAULT_TEACHER, ...options };
  }

  act(sim: Simulation, p: PlayerRobot, dt: number): BotAction {
    const match = sim.match;
    const auto = match.period === 'auto';
    const left = match.teleopLeft;
    const stored = p.mech.stored.length;
    const at = robotXZ(p);
    const idle: BotAction = { forward: 0, strafe: 0, turn: 0, intake: false, transfer: false, shooter: false, arm: false };

    if (left < PARK) {
      this.phase = 'park';
      this.flower = null;
      return { ...idle, ...driveTo(sim, p, parkSpot(sim, p), { minSpeed: 0, slowFrom: 0.4, face: null, ownSide: false }) };
    }

    const opponent = opponentOf(sim, p);
    let best: Ball | null = null;
    let bestCost = Infinity;
    for (const b of pickableBalls(sim, p)) {
      if ((this.skipped.get(b.id) ?? 0) > sim.time) continue;
      // Sticking with the current target unless another is clearly closer.
      const cost = ballCost(sim, p, b, opponent) - (b === this.target ? 0.3 : 0);
      if (cost < bestCost) {
        best = b;
        bestCost = cost;
      }
    }
    let flower: FlowerPlan | null = null;
    let flowerBest = Infinity;
    if (this.options.flowers && stored < CAPACITY) {
      for (const f of flowerPlans(sim, p)) {
        if ((this.skippedFlowers.get(f.center.join()) ?? 0) > sim.time) continue;
        const cost = flowerCost(sim, p, f, opponent) - (this.flower && dist(f.center, this.flower) < 0.01 ? 0.5 : 0);
        if (cost < flowerBest) {
          flower = f;
          flowerBest = cost;
        }
      }
    }

    if (stored >= CAPACITY || (stored > 0 && (Math.min(bestCost, flowerBest) > WORTH_IT || left < LAST_SHOTS))) this.mode = 'shoot';
    if (stored === 0) this.mode = 'collect';
    // Already at a FLOWER, arm down, with room left: finish emptying it first.
    const atFlower = !!flower && p.mech.arm >= 1 && dist(at, flower.center) < dist(flower.approach, flower.center) && stored < CAPACITY && left >= LAST_SHOTS;

    if (this.mode === 'shoot' && !atFlower) {
      this.target = null;
      this.flower = null;
      const plan = shotPlan(sim, p, this.options.shootNearest);
      const ready = inShootingPosition(p, plan);
      // The flywheel is at the speed this shot needs.
      const spun = p.mech.shooterOn && Math.abs(p.mech.turret.flywheel - neededFlywheel(p)) < 0.08;
      if (ready && (dist(at, plan.spot) < 0.3 || p.robot.speed < 0.15)) {
        this.phase = 'fire';
        return { ...idle, shooter: true, transfer: spun };
      }
      this.phase = 'toSpot';
      const far = dist(at, plan.spot) > 0.5;
      const drive = driveTo(sim, p, plan.spot, { minSpeed: 0, slowFrom: 0.5, face: far ? yawToward(at, nextWaypoint(sim, p, plan.spot, auto).point) : null, ownSide: auto });
      // Already in the zone: fire while rolling the rest of the way (the shot allows for the motion).
      return { ...idle, ...drive, shooter: true, transfer: this.options.fireMoving && ready && spun };
    }

    if (flower && (atFlower || flowerBest < bestCost)) {
      this.target = null;
      return this.emptyFlower(sim, p, flower, dt, idle, auto);
    }
    this.flower = null;

    if (!best) {
      this.phase = 'wait';
      this.target = null;
      // Nothing to pick up: wait on its own half, between the HIVE and the wall.
      return { ...idle, ...driveTo(sim, p, waitSpot(p), { minSpeed: 0, slowFrom: 0.5, face: null, ownSide: auto }) };
    }

    this.phase = 'collect';
    if (best !== this.target) {
      this.target = best;
      this.targetTime = 0;
    }
    this.targetTime += dt;
    if (this.targetTime > GIVE_UP) {
      this.skipped.set(best.id, sim.time + SKIP_FOR);
      this.target = null;
    }
    const [bx, , bz] = sim.balls.position(best);
    const ball: XZ = [bx, bz];
    const wp = nextWaypoint(sim, p, ball, auto).point;
    // Drive through the ball with the intake running: it doesn't stop at it. The arm stays up so
    // the intake reaches the floor.
    const drive = driveTo(sim, p, ball, { minSpeed: 0.35, slowFrom: 0.6, face: yawToward(at, wp), ownSide: auto });
    return { ...idle, ...drive, intake: p.mech.arm === 0 && dist(at, ball) < 0.9 };
  }

  /**
   * Flower Mode, decided from where the robot is: away from the FLOWER, drive to the point in front
   * of it (arm up); there, facing it, lower the arm; arm down, creep up until the arm touches it.
   * The reflexes run the intake for each POLLEN the arm pushes out.
   */
  private emptyFlower(sim: Simulation, p: PlayerRobot, f: FlowerPlan, dt: number, idle: BotAction, auto: boolean): BotAction {
    this.phase = 'flower';
    const at = robotXZ(p);
    const stored = p.mech.stored.length;
    if (!this.flower || dist(this.flower, f.center) > 0.01) {
      this.flower = f.center;
      this.flowerTime = 0;
      this.flowerStored = stored;
    }
    const face = yawToward(at, f.center);
    const facing = Math.abs(wrapAngle(face - p.robot.yaw));
    // Where the robot is along the FLOWER's axis (out from the wall) and across it.
    const standOff = dist(f.approach, f.center);
    const out: XZ = [(f.approach[0] - f.center[0]) / standOff, (f.approach[1] - f.center[1]) / standOff];
    const along = (at[0] - f.center[0]) * out[0] + (at[1] - f.center[1]) * out[1];
    const across = (at[0] - f.center[0]) * -out[1] + (at[1] - f.center[1]) * out[0];
    const [forward, right] = toRobot(p, f.center);
    const lineUp = Math.max(-0.3, Math.min(0.3, right * 2));

    if (p.mech.arm >= 1 && along < standOff + 0.15 && Math.abs(across) < 0.15) {
      // Arm down in front of it: nose in gently; the lowered arm stops the robot at the FLOWER.
      if (stored > this.flowerStored) {
        this.flowerStored = stored;
        this.flowerTime = 0;
      }
      this.flowerTime += dt;
      if (this.flowerTime > FLOWER_PATIENCE) {
        this.skippedFlowers.set(f.center.join(), sim.time + SKIP_FOR);
        this.flower = null;
      }
      return { ...idle, forward: forward > 0 ? 0.2 : 0, strafe: lineUp, turn: turnToward(p, face), arm: true };
    }
    if (Math.abs(across) < 0.1 && along > standOff - 0.2 && along < standOff + 0.15 && facing < 0.2) {
      // In front of it and facing it: stop and lower the arm.
      return { ...idle, strafe: lineUp, turn: turnToward(p, face), arm: true };
    }
    const d = dist(at, f.approach);
    const wp = nextWaypoint(sim, p, f.approach, auto).point;
    return { ...idle, ...driveTo(sim, p, f.approach, { minSpeed: 0, slowFrom: 0.5, face: d > 0.4 ? yawToward(at, wp) : face, ownSide: auto }) };
  }
}
