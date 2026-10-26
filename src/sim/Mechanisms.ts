// Intake → storage (4 balls) → transfer → flywheel shooter on an auto-aiming turret.

import type { Vec3 } from '../field/layout';
import { launchVelocity, solveShot, type ShotSolution } from '../game/ballistics';
import { wrapAngle } from '../robot/mecanum';
import type { ShooterSpec } from '../robot/robots';
import type { Ball, BallSim } from './BallSim';
import type { RobotSim } from './RobotSim';

/** G407: a robot may not control more than 4 scoring elements. */
export const CAPACITY = 4;

export const SHOOTER = {
  /** Ball exit speed at full flywheel speed, m/s */
  maxSpeed: 8.5,
  /** Lob arrives descending at this angle — matches the 30° upward-facing cell opening */
  descent: (35 * Math.PI) / 180,
  /** Flywheel acceleration as fraction of max speed per second (velocity PID holds the target exactly) */
  spinUpRate: 1.8,
  spinDownRate: 0.7,
  /** Each shot slows the flywheel; it then recovers */
  shotDrop: 0.9,
  feedInterval: 0.28,
  turretRate: 7,
  aimTolerance: 0.035,
};

const INTAKE = { reach: 0.09, inside: 0.06, halfWidth: 0.17, maxHeight: 0.16, interval: 0.12 };
/** Balls inside a flower tube: this intake cannot reach into the flower's retrieval opening. */
const FLOWER_TUBE = { radius: 0.09, height: 0.62 };

const DEG = Math.PI / 180;

/**
 * Shot scatter (standard deviations) at a given distance: tight inside the sweet spot,
 * growing quadratically to wide scatter at max range.
 */
export function shotSpread(distance: number, acc: Pick<ShooterSpec, 'sweetSpot' | 'maxRange'>): { angle: number; speed: number } {
  const t = Math.max(0, Math.min(1.3, (distance - acc.sweetSpot) / (acc.maxRange - acc.sweetSpot)));
  const k = t * t;
  return { angle: 0.4 * DEG + k * 4.5 * DEG, speed: 0.006 + k * 0.07 };
}

export type ShotRange = 'near' | 'mid' | 'far';

export function shotRange(distance: number, acc: Pick<ShooterSpec, 'sweetSpot' | 'maxRange'>): ShotRange {
  if (distance <= acc.sweetSpot) return 'near';
  return distance <= (acc.sweetSpot + acc.maxRange) / 2 ? 'mid' : 'far';
}
const EJECT = { speed: 1.6, interval: 0.25 };

export interface MechanismInput {
  intake: boolean;
  eject: boolean;
  shooterOn: boolean;
  shooterOff: boolean;
  transfer: boolean;
}

export type ShooterStatus = 'off' | 'spinning' | 'ready' | 'tooFar';

/** Gaussian noise (Box–Muller) so shots are not perfectly repeatable. */
function noise(sigma: number): number {
  return sigma * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class Mechanisms {
  /** Front of the queue goes to the shooter next; the back is nearest the intake. */
  readonly stored: Ball[] = [];
  shooterOn = false;
  /** Flywheel speed as a fraction of maximum */
  flywheel = 0;
  /** Turret angle relative to the robot, CCW positive */
  turretYaw = 0;
  /** -1 ejecting, 0 idle, 1 intaking — for the roller animation */
  intakeDir = 0;
  shot: ShotSolution | null = null;
  status: ShooterStatus = 'off';
  /** Called when the robot breaks a rule (e.g. picks up the opponent's NECTAR). */
  onViolation?: (rule: 'G408') => void;
  private intakeTimer = 0;
  private ejectTimer = 0;
  private feedTimer = 0;

  constructor(
    private readonly robot: RobotSim,
    private readonly balls: BallSim,
    private readonly target: () => Vec3,
    private readonly flowers: [number, number][],
    private readonly spec: ShooterSpec,
  ) {}

  reset(preloads: Ball[]): void {
    this.stored.length = 0;
    for (const b of preloads) {
      this.balls.hold(b);
      this.stored.push(b);
    }
    this.shooterOn = false;
    this.flywheel = 0;
    this.turretYaw = 0;
    this.shot = null;
    this.status = 'off';
  }

  /** Drops everything the robot holds where it stands (robot leaving the field). */
  dropAll(): void {
    const [px, , pz] = this.robot.position;
    this.stored.splice(0).forEach((b, i) => this.balls.release(b, [px + (i % 2) * 0.08, 0.1 + i * 0.08, pz], [0, 0, 0]));
  }

  /** World position where balls leave the shooter. */
  launchPoint(): Vec3 {
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const [rx, rz] = [Math.sin(yaw), Math.cos(yaw)];
    const [tf, tr] = this.spec.at;
    const aim = yaw + this.turretYaw;
    return [
      px + fx * tf + rx * tr + Math.cos(aim) * this.spec.exit,
      this.spec.height,
      pz + fz * tf + rz * tr - Math.sin(aim) * this.spec.exit,
    ];
  }

  step(dt: number, input: MechanismInput, enabled: boolean): void {
    if (!enabled) {
      // No powered movement between periods or after the match (G403 / G404).
      this.shooterOn = false;
      this.intakeDir = 0;
      this.spinFlywheel(0, dt);
      this.updateStatus(false);
      return;
    }
    if (input.shooterOn) this.shooterOn = true;
    if (input.shooterOff) this.shooterOn = false;

    this.intakeDir = input.eject ? -1 : input.intake ? 1 : 0;
    if (this.intakeDir === 1) this.runIntake(dt);
    if (this.intakeDir === -1) this.runEject(dt);

    this.aim(dt);
    if (input.transfer) this.runTransfer(dt);
    else this.feedTimer = Math.min(this.feedTimer, 0);
  }

  private runIntake(dt: number): void {
    this.intakeTimer -= dt;
    if (this.intakeTimer > 0 || this.stored.length >= CAPACITY) return;
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const front = this.robot.cfg.length / 2;
    for (const b of this.balls.all) {
      if (b.state !== 'field') continue;
      const [x, y, z] = this.balls.position(b);
      if (y < FLOWER_TUBE.height && this.flowers.some(([fx, fz]) => Math.hypot(x - fx, z - fz) < FLOWER_TUBE.radius)) continue;
      const dx = x - px;
      const dz = z - pz;
      const forward = dx * fx + dz * fz;
      const right = dx * -fz + dz * fx;
      if (y < INTAKE.maxHeight && forward > front - INTAKE.inside && forward < front + INTAKE.reach && Math.abs(right) < INTAKE.halfWidth) {
        this.balls.hold(b);
        this.stored.push(b);
        this.intakeTimer = INTAKE.interval;
        // G408: a robot may not control the opponent's NECTAR.
        if (b.kind === 'nectar' && b.color !== this.robot.alliance) this.onViolation?.('G408');
        return;
      }
    }
  }

  private runEject(dt: number): void {
    this.ejectTimer -= dt;
    if (this.ejectTimer > 0 || !this.stored.length) return;
    const b = this.stored.pop()!;
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const out = this.robot.cfg.length / 2 + b.radius + 0.03;
    const [vx, vz] = this.robot.velocity;
    this.balls.release(b, [px + fx * out, b.radius + 0.01, pz + fz * out], [vx + fx * EJECT.speed, 0, vz + fz * EJECT.speed]);
    this.ejectTimer = EJECT.interval;
  }

  private aim(dt: number): void {
    const launch = this.launchPoint();
    this.shot = solveShot(launch, this.target(), SHOOTER.descent, this.robot.velocity);
    const desired = wrapAngle(this.shot.yaw - this.robot.yaw);
    const err = wrapAngle(desired - this.turretYaw);
    const maxStep = SHOOTER.turretRate * dt;
    this.turretYaw = wrapAngle(this.turretYaw + Math.max(-maxStep, Math.min(maxStep, err)));

    // Auto speed: the flywheel targets exactly the speed this distance needs.
    const needed = this.shot.speed / SHOOTER.maxSpeed;
    this.spinFlywheel(this.shooterOn ? Math.min(needed, 1) : 0, dt);
    this.updateStatus(Math.abs(err) < SHOOTER.aimTolerance);
  }

  private spinFlywheel(target: number, dt: number): void {
    const rate = (target > this.flywheel ? SHOOTER.spinUpRate : SHOOTER.spinDownRate) * dt;
    this.flywheel += Math.max(-rate, Math.min(rate, target - this.flywheel));
  }

  private updateStatus(aimed: boolean): void {
    if (!this.shooterOn) this.status = 'off';
    else if (this.shot && this.shot.speed > SHOOTER.maxSpeed) this.status = 'tooFar';
    else if (aimed && this.shot && Math.abs(this.flywheel - this.shot.speed / SHOOTER.maxSpeed) < 0.02) this.status = 'ready';
    else this.status = 'spinning';
  }

  private runTransfer(dt: number): void {
    this.feedTimer -= dt;
    if (this.feedTimer > 0 || !this.stored.length || !this.shot) return;
    const b = this.stored.shift()!;
    const spread = shotSpread(this.shot.distance, this.spec);
    const yaw = this.robot.yaw + this.turretYaw + noise(spread.angle);
    const pitch = this.shot.pitch + noise(spread.angle);
    // A stopped flywheel just lets the ball drop out of the shooter.
    const speed = Math.max(0.6, this.flywheel * SHOOTER.maxSpeed * (1 + noise(spread.speed)));
    const v = launchVelocity(yaw, pitch, speed);
    const [rvx, rvz] = this.robot.velocity;
    this.balls.release(b, this.launchPoint(), [v[0] + rvx, v[1], v[2] + rvz]);
    this.flywheel *= SHOOTER.shotDrop;
    this.feedTimer = SHOOTER.feedInterval;
  }
}
