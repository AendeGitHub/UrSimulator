// Intake → storage (4 balls) → transfer → flywheel shooter on an auto-aiming turret (or two, one
// for each kind of ball).

import type { Vec3 } from '../field/layout';
import { FLOWER_VOLUME } from '../field/zones';
import { launchVelocity, solveShot, type ShotSolution } from '../game/ballistics';
import { wrapAngle } from '../robot/mecanum';
import type { ArmSpec, ShooterSpec } from '../robot/robots';
import type { Ball, BallKind, BallSim } from './BallSim';
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
  turretRate: 7,
  aimTolerance: 0.035,
  /** A target this far past the turret's stop is not worth swinging round for yet, rad */
  unwindMargin: 0.2,
};

/** Where the intake grabs balls (from its mouth) and how often: one ball every `interval` s. */
const INTAKE = { reach: 0.09, inside: 0.06, halfWidth: 0.17, maxHeight: 0.16, interval: 0.35 };
/** Balls inside a flower tube: only a lowered arm reaches the flower's retrieval opening. */
const FLOWER_TUBE = { radius: 0.09, height: 0.62 };
/** With the arm down, a FLOWER this close in front of the robot (center from its front face, m) */
const FLOWER_REACH = { behind: 0.05, ahead: 0.2, side: 0.15 };

const DEG = Math.PI / 180;

/**
 * Shot scatter (standard deviations) at a given distance: tight inside the sweet spot,
 * growing quadratically to wide scatter at max range.
 */
export function shotSpread(distance: number, acc: Pick<ShooterSpec, 'sweetSpot' | 'maxRange'>): { angle: number; speed: number } {
  const t = Math.max(0, Math.min(1.3, (distance - acc.sweetSpot) / (acc.maxRange - acc.sweetSpot)));
  const k = t * t;
  // Even close in, no robot is perfect: a little scatter on every shot.
  return { angle: 0.8 * DEG + k * 4.5 * DEG, speed: 0.009 + k * 0.07 };
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
  armUp: boolean;
  armDown: boolean;
}

export type ShooterStatus = 'off' | 'spinning' | 'ready' | 'tooFar';

/** Gaussian noise (Box–Muller) so shots are not perfectly repeatable. */
function noise(sigma: number): number {
  return sigma * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** A turret with its flywheel. A robot with two shoots each kind of ball from its own. */
export class Turret {
  /** Flywheel speed as a fraction of maximum */
  flywheel = 0;
  /** Turret angle relative to the robot, CCW positive, within ±spec.turretLimit */
  yaw = 0;
  shot: ShotSolution | null = null;
  status: ShooterStatus = 'off';
  feedTimer = 0;

  /** `kinds`: the balls it shoots; undefined for a robot's only turret, which shoots everything. */
  constructor(readonly spec: ShooterSpec, readonly kinds?: readonly BallKind[]) {}

  shoots(b: Ball): boolean {
    return !this.kinds || this.kinds.includes(b.kind);
  }

  reset(): void {
    this.flywheel = 0;
    this.yaw = 0;
    this.shot = null;
    this.status = 'off';
    this.feedTimer = 0;
  }
}

export class Mechanisms {
  /** Front of the queue goes to the shooter next; the back is nearest the intake. */
  readonly stored: Ball[] = [];
  shooterOn = false;
  /** The main turret first; Silver Bullet Blaster's second one shoots its NECTAR. */
  readonly turrets: Turret[];
  /** -1 ejecting, 0 idle, 1 intaking — for the roller animation */
  intakeDir = 0;
  /** Front arm: 0 raised .. 1 lowered (robots without one stay at 0) */
  arm = 0;
  private armLowered = false;
  /** Called for every ball the intake picks up, with where it was (for the referee). */
  onPickup?: (ball: Ball, at: Vec3) => void;
  private intakeTimer = 0;
  private ejectTimer = 0;

  constructor(
    private readonly robot: RobotSim,
    private readonly balls: BallSim,
    private readonly target: () => Vec3,
    private readonly flowers: [number, number][],
    spec: ShooterSpec,
    private readonly intakes: readonly BallKind[],
    private readonly armSpec: ArmSpec | undefined,
    /** Forward distance of the intake's mouth from the footprint center, m */
    private readonly intakeFront: number,
    /** A second turret and the balls it takes from the main one */
    second?: { spec: ShooterSpec; kinds: readonly BallKind[] },
  ) {
    this.turrets = second
      ? [new Turret(spec, intakes.filter(k => !second.kinds.includes(k))), new Turret(second.spec, second.kinds)]
      : [new Turret(spec)];
  }

  /** The main turret, as the HUD, the battery and the referee see the robot's shooter */
  get turret(): Turret {
    return this.turrets[0];
  }

  get turretYaw(): number {
    return this.turret.yaw;
  }

  get shot(): ShotSolution | null {
    return this.turret.shot;
  }

  get status(): ShooterStatus {
    return this.turret.status;
  }

  /** Flywheel load on the battery: every flywheel that is spinning */
  get flywheel(): number {
    return this.turrets.reduce((sum, t) => sum + t.flywheel, 0);
  }

  reset(preloads: Ball[]): void {
    this.stored.length = 0;
    for (const b of preloads) {
      this.balls.hold(b);
      this.stored.push(b);
    }
    this.shooterOn = false;
    for (const t of this.turrets) t.reset();
    this.arm = 0;
    this.armLowered = false;
  }

  /** Drops everything the robot holds where it stands (robot leaving the field). */
  dropAll(): void {
    const [px, , pz] = this.robot.position;
    this.stored.splice(0).forEach((b, i) => this.balls.release(b, [px + (i % 2) * 0.08, 0.1 + i * 0.08, pz], [0, 0, 0]));
  }

  /** World position where balls leave a turret's shooter. */
  launchPoint(turret = this.turret): Vec3 {
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const [rx, rz] = [Math.sin(yaw), Math.cos(yaw)];
    const [tf, tr] = turret.spec.at;
    const aim = yaw + turret.yaw;
    return [
      px + fx * tf + rx * tr + Math.cos(aim) * turret.spec.exit,
      turret.spec.height,
      pz + fz * tf + rz * tr - Math.sin(aim) * turret.spec.exit,
    ];
  }

  step(dt: number, input: MechanismInput, enabled: boolean): void {
    if (!enabled) {
      // No powered movement between periods or after the match (G403 / G404).
      this.shooterOn = false;
      this.intakeDir = 0;
      for (const t of this.turrets) {
        this.spinFlywheel(t, 0, dt);
        this.updateStatus(t, false);
      }
      return;
    }
    if (input.shooterOn) this.shooterOn = true;
    if (input.shooterOff) this.shooterOn = false;
    if (this.armSpec) {
      if (input.armDown) this.armLowered = true;
      if (input.armUp) this.armLowered = false;
      const step = dt / this.armSpec.travel;
      if (!this.armLowered) this.arm = Math.max(0, this.arm - step);
      else if (this.arm < 1) {
        // It swings down only as far as there is room: against a wall, a FLOWER or a robot it rests
        // there and goes on down as the robot backs away; driven further in, it is pushed back up.
        // Once all the way down its box is solid and stops the robot instead.
        const next = Math.min(1, this.arm + step);
        if (this.robot.armFits(next)) this.arm = next;
        else while (this.arm > 0 && !this.robot.armFits(this.arm)) this.arm = Math.max(0, this.arm - step);
      }
    }

    // The transfer runs the intake too, so balls picked up while feeding go straight to the shooter.
    // A lowered arm at a FLOWER runs it by itself: the POLLEN it pulls out goes straight in.
    const flower = this.flowerAhead();
    const fromFlower = !!flower && this.intakes.includes('pollen') && this.stored.length < CAPACITY;
    this.intakeDir = input.eject ? -1 : input.intake || input.transfer || fromFlower ? 1 : 0;
    if (this.intakeDir === 1) this.runIntake(dt, flower);
    if (this.intakeDir === -1) this.runEject(dt);

    for (const t of this.turrets) {
      this.aim(t, dt);
      if (input.transfer) this.runTransfer(t, dt);
      else t.feedTimer = Math.min(t.feedTimer, 0);
    }
  }

  private runIntake(dt: number, flower: [number, number] | undefined): void {
    this.intakeTimer -= dt;
    if (this.intakeTimer > 0 || this.stored.length >= CAPACITY) return;
    // A lowered arm blocks the floor but reaches into a FLOWER; one on its way blocks both.
    if (this.armSpec && this.arm > 0) {
      if (flower) this.takeFromFlower(flower);
      return;
    }
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const front = this.intakeFront;
    for (const b of this.balls.all) {
      if (b.state !== 'field' || !this.intakes.includes(b.kind)) continue;
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
        this.onPickup?.(b, [x, y, z]);
        return;
      }
    }
  }

  /** The FLOWER (tube center x, z) right in front of the fully lowered arm, if there is one. */
  private flowerAhead(): [number, number] | undefined {
    if (!this.armSpec || this.arm < 1) return undefined;
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    const front = this.robot.cfg.length / 2;
    return this.flowers.find(([cx, cz]) => {
      const forward = (cx - px) * fx + (cz - pz) * fz - front;
      const side = (cx - px) * -fz + (cz - pz) * fx;
      return forward >= -FLOWER_REACH.behind && forward <= FLOWER_REACH.ahead && Math.abs(side) <= FLOWER_REACH.side;
    });
  }

  /** The bottom POLLEN of the FLOWER at (cx, cz), pulled out of its retrieval opening. */
  private takeFromFlower([cx, cz]: [number, number]): void {
    if (!this.intakes.includes('pollen')) return;
    let bottom: Ball | null = null;
    let bottomY = Infinity;
    for (const b of this.balls.all) {
      if (b.state !== 'field') continue;
      const [x, y, z] = this.balls.position(b);
      if (y < FLOWER_TUBE.height && y < bottomY && Math.hypot(x - cx, z - cz) < FLOWER_TUBE.radius) {
        bottom = b;
        bottomY = y;
      }
    }
    // Only POLLEN, and only from below the middle ring (G418): NECTAR at the bottom blocks it.
    if (!bottom || bottom.kind !== 'pollen' || bottomY > FLOWER_VOLUME.yMin) return;
    const at = this.balls.position(bottom);
    this.balls.hold(bottom);
    this.stored.push(bottom);
    this.intakeTimer = INTAKE.interval;
    this.onPickup?.(bottom, at);
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
    b.launch = { by: this.robot.slot, kind: 'eject', age: 0 };
    this.ejectTimer = EJECT.interval;
  }

  private aim(turret: Turret, dt: number): void {
    const launch = this.launchPoint(turret);
    const shot = solveShot(launch, this.target(), SHOOTER.descent, this.robot.velocity);
    turret.shot = shot;
    // The turret cannot spin round and round (its wires would wind up): it turns at most
    // turretLimit either way. It takes the short way to the target while that stays within the
    // limit, otherwise it unwinds the long way round.
    const limit = turret.spec.turretLimit;
    const target = wrapAngle(shot.yaw - this.robot.yaw);
    let desired = turret.yaw + wrapAngle(target - turret.yaw);
    const past = Math.abs(desired) - limit;
    // Just past the stop: wait there instead of swinging all the way round for a few degrees.
    if (past > 0) desired = past < SHOOTER.unwindMargin ? Math.sign(desired) * limit : desired - Math.sign(desired) * 2 * Math.PI;
    const maxStep = SHOOTER.turretRate * dt;
    const step = Math.max(-maxStep, Math.min(maxStep, desired - turret.yaw));
    turret.yaw = Math.max(-limit, Math.min(limit, turret.yaw + step));
    const err = wrapAngle(target - turret.yaw);

    // Auto speed: the flywheel targets exactly the speed this distance needs.
    const needed = shot.speed / SHOOTER.maxSpeed;
    this.spinFlywheel(turret, this.shooterOn ? Math.min(needed, 1) : 0, dt);
    this.updateStatus(turret, Math.abs(err) < SHOOTER.aimTolerance);
  }

  private spinFlywheel(turret: Turret, target: number, dt: number): void {
    const rate = (target > turret.flywheel ? SHOOTER.spinUpRate : SHOOTER.spinDownRate) * dt;
    turret.flywheel += Math.max(-rate, Math.min(rate, target - turret.flywheel));
  }

  private updateStatus(turret: Turret, aimed: boolean): void {
    const { shot } = turret;
    if (!this.shooterOn) turret.status = 'off';
    else if (shot && shot.speed > SHOOTER.maxSpeed) turret.status = 'tooFar';
    else if (aimed && shot && Math.abs(turret.flywheel - shot.speed / SHOOTER.maxSpeed) < 0.02) turret.status = 'ready';
    else turret.status = 'spinning';
  }

  /** Feeds the turret the next ball of its kind, `rapidFire` paced. */
  private runTransfer(turret: Turret, dt: number): void {
    turret.feedTimer -= dt;
    const i = this.stored.findIndex(b => turret.shoots(b));
    if (turret.feedTimer > 0 || i < 0 || !turret.shot) return;
    const [b] = this.stored.splice(i, 1);
    const spread = shotSpread(turret.shot.distance, turret.spec);
    const yaw = this.robot.yaw + turret.yaw + noise(spread.angle);
    const pitch = turret.shot.pitch + noise(spread.angle);
    // A stopped flywheel just lets the ball drop out of the shooter.
    const speed = Math.max(0.6, turret.flywheel * SHOOTER.maxSpeed * (1 + noise(spread.speed)));
    const v = launchVelocity(yaw, pitch, speed);
    const [rvx, rvz] = this.robot.velocity;
    this.balls.release(b, this.launchPoint(turret), [v[0] + rvx, v[1], v[2] + rvz]);
    b.launch = { by: this.robot.slot, kind: 'shot', age: 0 };
    turret.flywheel *= SHOOTER.shotDrop;
    // Rapid fire: the 4 balls of a full load leave evenly spaced over `rapidFire` seconds (the
    // leftover fraction of a step carries over so the spacing doesn't drift).
    turret.feedTimer = Math.max(turret.feedTimer, -dt) + turret.spec.rapidFire / (CAPACITY - 1);
  }
}
