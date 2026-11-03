// What the AI driver decides 20 times a second, how that becomes gamepad input, and the reflexes
// under it.

import { wrapAngle } from '../robot/mecanum';
import { robotById } from '../robot/robots';
import { SHOOTER } from '../sim/Mechanisms';
import type { PlayerRobot, Simulation } from '../sim/Simulation';
import { idleInput, type RobotInput } from '../sim/types';
import { allianceSign, dist, frameBox, inShootingPosition, robotXZ, rotateToRobot, shotPlan, toRobot, type XZ } from './field';

/** Physics steps (120 a second) between two decisions: 20 decisions a second. */
export const DECISION_STEPS = 6;
export const DECISION_DT = DECISION_STEPS / 120;

export interface BotAction {
  /** Robot-centric drive, -1..1 */
  forward: number;
  strafe: number;
  /** -1..1, positive turns clockwise (like the right stick) */
  turn: number;
  intake: boolean;
  transfer: boolean;
  /** Flywheel wanted on */
  shooter: boolean;
  /** Front arm wanted down (Flower Mode) */
  arm: boolean;
}

export const idleAction = (): BotAction => ({ forward: 0, strafe: 0, turn: 0, intake: false, transfer: false, shooter: false, arm: false });

/** The network's outputs: three sticks, then four buttons. */
export const ACTION_SIZE = 7;

export function encodeAction(a: BotAction, out: Float32Array, at = 0): void {
  out[at] = a.forward;
  out[at + 1] = a.strafe;
  out[at + 2] = a.turn;
  out[at + 3] = a.intake ? 1 : 0;
  out[at + 4] = a.transfer ? 1 : 0;
  out[at + 5] = a.shooter ? 1 : 0;
  out[at + 6] = a.arm ? 1 : 0;
}

/** Gamepad input for an action; the flywheel and the arm are toggled with their buttons. */
export function toRobotInput(a: BotAction, p: PlayerRobot): RobotInput {
  const { forward, strafe, turn } = p.robot.cfg.drive.type === 'tank' ? tankSticks(a) : a;
  return {
    ...idleInput(),
    ly: -forward,
    lx: strafe,
    rx: turn,
    fieldCentric: false,
    intake: a.intake,
    transfer: a.transfer,
    shooterOn: a.shooter && !p.mech.shooterOn,
    shooterOff: !a.shooter && p.mech.shooterOn,
    armDown: a.arm,
    armUp: !a.arm,
  };
}

/**
 * Sticks for a robot that can't strafe (a player's tank drive): it turns toward where the action
 * drives and goes there, backing up to what is right behind it. Standing, or turning hard (to face
 * a ball with its intake), it turns as the action says.
 */
function tankSticks({ forward, strafe, turn }: BotAction): Pick<BotAction, 'forward' | 'strafe' | 'turn'> {
  const speed = Math.hypot(forward, strafe);
  if (speed < 0.1) return { forward, strafe: 0, turn };
  if (Math.abs(turn) > 0.6) return { forward: 0, strafe: 0, turn };
  // Where to go, clockwise from straight ahead (the way the right stick turns), and from straight behind.
  const ahead = Math.atan2(strafe, forward);
  const behind = wrapAngle(ahead - Math.PI);
  const steer = (angle: number) => Math.max(-1, Math.min(1, 2.5 * angle));
  if (Math.abs(behind) < Math.PI / 3) return { forward: -speed * Math.cos(behind), strafe: 0, turn: steer(behind) };
  return { forward: speed * Math.max(0, Math.cos(ahead)), strafe: 0, turn: steer(ahead) };
}

/** Flywheel speed the main turret needs for its shot, as a fraction of full speed */
export function neededFlywheel(p: PlayerRobot): number {
  const shot = p.mech.shot;
  return shot ? Math.min(1, shot.speed / SHOOTER.maxSpeed) : 0;
}

/**
 * Touching the HIVE frame faster than 0.8 m/s is a G417 hit, sliding along it too. Within `near` m
 * of it (robot center, or under it) the robot drives no faster than `speed` and closes in no faster
 * than `approach` (stick; full stick ≈ 2.2–2.6 m/s).
 */
const FRAME_CAUTION = { near: 0.42, speed: 0.28, approach: 0.2 };
/** Pushing against the other robot this long gets it pinned (G421 starts counting at 3 s): back off, s */
const PUSH_LIMIT = 1.2;
/** Standing right up against an opponent this long could pin it too (stopped to shoot, or thinking): move off, s */
const STAND_LIMIT = 1;
/** In AUTO the robot center stays this far on its own side of the center line (G402), m */
const AUTO_FENCE = 0.15;
/** The arm told to go down but resting on something (a FLOWER it is too deep in) this long: back off, s */
const ARM_BLOCKED = 0.6;

/**
 * Reflexes under the driver (the teacher or the network), like a robot's own safety code: it slows
 * down next to the HIVE frame (G417), keeps the intake off with the opponent's NECTAR in its mouth
 * (G408), stays on its own half in AUTO (G402), lets go of the other robot before it counts as a
 * pin (G421) whether it pushes or just stands against it, takes in the POLLEN its push back pulled
 * out of a FLOWER before lifting the arm, backs off a little when the arm can't come down (driven
 * too far into a FLOWER), and when it is told to drive but doesn't move for 0.8 s (caught on a
 * FLOWER, the frame or the other robot) it backs off at an angle for 0.6 s. Without shooting on the
 * move (a house rule, or an AI level below hard) it stops to shoot.
 */
export class Reflexes {
  private stuck = 0;
  private escape = 0;
  private dir: XZ = [0, 0];
  private side = 1;
  private pushing = 0;
  private standing = 0;
  private armBlocked = 0;

  apply(sim: Simulation, p: PlayerRobot, a: BotAction): BotAction {
    let out = a;
    // Every other robot (in a 2 vs 2 three; a partner is no wall to push either).
    const others = [...sim.robots.values()].filter(q => q !== p);
    const pushed = this.escape <= 0 ? others.find(q => this.pushingInto(p, q, a)) : undefined;
    if (pushed) {
      this.pushing += DECISION_DT;
      if (this.pushing > PUSH_LIMIT) {
        this.pushing = 0;
        this.backAway(p, pushed);
      }
    } else this.pushing = Math.max(0, this.pushing - DECISION_DT);
    // Told to lower the arm, but it rests half way on whatever it is wedged under: back straight off.
    const resting = a.arm && p.mech.arm > 0 && p.mech.arm < 1;
    this.armBlocked = resting ? this.armBlocked + DECISION_DT : 0;
    if (this.escape <= 0 && this.armBlocked > ARM_BLOCKED) {
      this.armBlocked = 0;
      this.escape = 0.4;
      this.dir = [-0.35, 0];
    }
    if (this.escape > 0) {
      this.escape -= DECISION_DT;
      out = { ...a, forward: this.dir[0], strafe: this.dir[1], turn: 0 };
    } else {
      const commanded = Math.hypot(a.forward, a.strafe);
      if (commanded > 0.22 && p.robot.speed < 0.06) this.stuck += DECISION_DT;
      else this.stuck = Math.max(0, this.stuck - 2 * DECISION_DT);
      if (this.stuck > 0.8) {
        this.stuck = 0;
        this.escape = 0.6;
        this.side = -this.side;
        // Back away from where it was trying to go, 45° to one side (alternating).
        const [f, s] = [-a.forward / commanded, -a.strafe / commanded];
        const c = Math.SQRT1_2 * 0.6;
        this.dir = [f * c - s * c * this.side, s * c + f * c * this.side];
      }
    }
    out = this.easeNearFrame(sim, p, out);
    if (sim.match.period === 'auto') out = this.keepOwnHalf(p, out);
    // The push back holds its ball until the intake runs (Flower Mode); lifting the arm first
    // would leave the ball on the floor in front of the FLOWER, in the way of the next try.
    if (p.mech.pocket) out = { ...out, intake: true, arm: true };
    // The transfer runs the intake too.
    if ((out.intake || out.transfer) && opponentNectarAhead(sim, p)) out = { ...out, intake: false, transfer: false };
    // Shooting on the move off (the house rule, or an AI level below hard): the turrets aim only
    // with the robot standing still. In the shooting zone with balls on board it stops to shoot
    // (unless it is moving off another robot), and it feeds balls only once every turret with one
    // to shoot is on target (until then only the intake runs).
    if (out.transfer && !p.mech.movingShots) {
      const { mech } = p;
      if (this.escape <= 0 && mech.stored.length && inShootingPosition(p, shotPlan(sim, p, true))) out = { ...out, forward: 0, strafe: 0, turn: 0 };
      if (!mech.turrets.every(t => t.status === 'ready' || !mech.stored.some(b => t.shoots(b)))) out = { ...out, transfer: false, intake: true };
    }
    // Standing against an opponent: if that one is against a wall, it is pinned. (A partner it may
    // stand beside, parked at the end for one.)
    const still = this.escape <= 0 && Math.hypot(out.forward, out.strafe) < 0.1;
    const opponent = still ? others.find(q => q.robot.alliance !== p.robot.alliance && against(p, q)) : undefined;
    this.standing = opponent ? this.standing + DECISION_DT : 0;
    if (opponent && this.standing > STAND_LIMIT) {
      this.standing = 0;
      this.backAway(p, opponent);
    }
    return out;
  }

  /** Lets go of the other robot: backs straight away from it for 0.6 s (from the next decision). */
  private backAway(p: PlayerRobot, other: PlayerRobot): void {
    this.escape = 0.6;
    const [f, r] = toRobot(p, robotXZ(other));
    const n = Math.hypot(f, r) || 1;
    this.dir = [(-f / n) * 0.6, (-r / n) * 0.6];
  }

  /** Up against the other robot and still driving into it. */
  private pushingInto(p: PlayerRobot, other: PlayerRobot, a: BotAction): boolean {
    const [f, r] = toRobot(p, robotXZ(other));
    return against(p, other) && a.forward * f + a.strafe * r > 0.1 * Math.hypot(f, r);
  }

  /** No driving over the center line during AUTO. */
  private keepOwnHalf(p: PlayerRobot, a: BotAction): BotAction {
    const s = allianceSign(p);
    const [x] = robotXZ(p);
    if (x * s < -AUTO_FENCE - 0.25) return a;
    const yaw = p.robot.yaw;
    let vx = a.forward * Math.cos(yaw) + a.strafe * Math.sin(yaw);
    const vz = -a.forward * Math.sin(yaw) + a.strafe * Math.cos(yaw);
    // Toward the other side is +x for red, -x for blue: at the fence, none of that.
    if (vx * s > 0) vx = x * s > -AUTO_FENCE ? -0.2 * s : vx * Math.max(0, (-AUTO_FENCE - x * s) / 0.25);
    const [forward, strafe] = rotateToRobot(yaw, [vx, vz]);
    return { ...a, forward, strafe };
  }

  private easeNearFrame(sim: Simulation, p: PlayerRobot, a: BotAction): BotAction {
    const at = robotXZ(p);
    const box = frameBox(sim, 0);
    const near: XZ = [Math.max(box.minX, Math.min(box.maxX, at[0])), Math.max(box.minZ, Math.min(box.maxZ, at[1]))];
    const gap = dist(at, near);
    if (gap > FRAME_CAUTION.near) return a;
    // Robot-centric sticks as a world velocity, eased, and back.
    const yaw = p.robot.yaw;
    let vx = a.forward * Math.cos(yaw) + a.strafe * Math.sin(yaw);
    let vz = -a.forward * Math.sin(yaw) + a.strafe * Math.cos(yaw);
    if (gap > 1e-6) {
      const [nx, nz] = [(at[0] - near[0]) / gap, (at[1] - near[1]) / gap];
      const toward = -(vx * nx + vz * nz);
      if (toward > FRAME_CAUTION.approach) {
        vx += nx * (toward - FRAME_CAUTION.approach);
        vz += nz * (toward - FRAME_CAUTION.approach);
      }
    }
    const speed = Math.hypot(vx, vz);
    if (speed > FRAME_CAUTION.speed) {
      vx *= FRAME_CAUTION.speed / speed;
      vz *= FRAME_CAUTION.speed / speed;
    }
    const [forward, strafe] = rotateToRobot(yaw, [vx, vz]);
    return { ...a, forward, strafe };
  }
}

/** Up against another robot: closer than their half diagonals add up. */
function against(p: PlayerRobot, other: PlayerRobot): boolean {
  const reach = (Math.hypot(p.robot.cfg.length, p.robot.cfg.width) + Math.hypot(other.robot.cfg.length, other.robot.cfg.width)) / 2;
  return dist(robotXZ(p), robotXZ(other)) < reach;
}

/**
 * The opponent's NECTAR on the floor right in front of an intake: running it would take the ball
 * (G408). For a robot whose NECTAR goes into a lift's box, any NECTAR: the
 * AI doesn't score FLOWERs, so its box stays empty for the POLLEN it shoots.
 */
function opponentNectarAhead(sim: Simulation, p: PlayerRobot): boolean {
  const def = robotById(p.robotId);
  // Only an intake that takes NECTAR can take theirs: the front one, or one at the back. Each as
  // which way it faces (1 forward, -1 back) and how far out its mouth is.
  const mouths: [number, number][] = [];
  if (def.intakes.includes('nectar')) mouths.push([1, def.intakeFront ?? p.robot.cfg.length / 2]);
  if (def.backIntake?.kinds.includes('nectar')) mouths.push([-1, def.backIntake.back]);
  if (!mouths.length) return false;
  return sim.balls.all.some(b => {
    if (b.kind !== 'nectar' || (b.color === p.robot.alliance && !def.lift) || b.state !== 'field') return false;
    const [x, y, z] = sim.balls.position(b);
    // On the floor: NECTAR up in a HIVE cell is out of reach.
    if (y > 0.15) return false;
    const [forward, right] = toRobot(p, [x, z]);
    return Math.abs(right) < 0.26 && mouths.some(([dir, mouth]) => forward * dir > mouth - 0.1 && forward * dir < mouth + 0.3);
  });
}
