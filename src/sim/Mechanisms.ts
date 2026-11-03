// Intake (or one at each end) → storage (4 balls) → transfer → flywheel shooter on an auto-aiming
// turret (or several, each shooting its kind of ball or any).

import { NECTAR_RADIUS, POLLEN_RADIUS, type Vec3 } from '../field/layout';
import { FLOWER_VOLUME } from '../field/zones';
import { launchVelocity, solveShot, type ShotSolution, type ShotSpin } from '../game/ballistics';
import { wrapAngle } from '../robot/mecanum';
import { BOX_EXIT, boxExitPosition, boxHoleTime, pushBackSpot, turretsOf, type ArmSpec, type LiftSpec, type RobotDefinition, type ShooterSpec } from '../robot/robots';
import { AIR_DAMPING, BALL_MASS, SPIN_DAMPING, type Ball, type BallKind, type BallSim } from './BallSim';
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
  /**
   * The flywheel mass these rates are for, kg. A heavier one (ShooterSpec.flywheelMass) changes
   * speed that many times slower, but each shot also takes that many times less of its speed, so
   * it recovers in the same time.
   */
  flywheelMass: 0.3,
  turretRate: 7,
  aimTolerance: 0.035,
  /** A target this far past the turret's stop is not worth swinging round for yet, rad */
  unwindMargin: 0.2,
  /**
   * Out of its turn either way, the turret leaves the stop it went to for the other one only once
   * that is this much nearer the target, rad: near the robot, the target behind it swings a few
   * degrees each way as the turret's exit goes round.
   */
  stopMargin: 0.5,
};

/**
 * A robot slower than this (m/s, and turning slower than rad/s) stands still for a turret that can't
 * aim on the move (house rule `movingShots` off).
 */
const STILL = { speed: 0.05, turn: 0.1 };

/**
 * Where the intake grabs balls (from its mouth) and how often: one ball every `interval` s, for
 * rollers on a motor turning `rpm` (unless the robot's own interval or rpm is set).
 */
const INTAKE = { reach: 0.09, inside: 0.06, halfWidth: 0.17, maxHeight: 0.16, interval: 0.35, rpm: 1150 };

/** Seconds between balls a robot's front intake takes in: its own, or the usual scaled to its motor's speed. */
export const intakeInterval = (def: RobotDefinition): number =>
  def.intakeInterval ?? (def.intakeRpm ? (INTAKE.interval * INTAKE.rpm) / def.intakeRpm : INTAKE.interval);

/** How many times slower than the usual one a turret's flywheel changes speed (SHOOTER.flywheelMass). */
const heaviness = (spec: ShooterSpec): number => (spec.flywheelMass ?? SHOOTER.flywheelMass) / SHOOTER.flywheelMass;
/**
 * Where an intake takes balls: which way its mouth faces (1 forward, -1 back) and how far from the
 * footprint center it is (m), how wide and which balls, how often (s), and the time to the next one.
 */
interface Mouth {
  dir: 1 | -1;
  at: number;
  halfWidth: number;
  kinds: readonly BallKind[];
  interval: number;
  timer: number;
}
/** Balls inside a flower tube: only a lowered arm reaches the flower's retrieval opening. */
const FLOWER_TUBE = { radius: 0.09, height: 0.62 };
/**
 * The lowered arm works a FLOWER once its front bar is in the retrieval opening: past the bottom
 * ring's outer edge (7.7 cm from the tube's center), and no further than the support at the back
 * (tube center from the arm's front, m).
 */
const FLOWER_REACH = { behind: 0.05, ahead: 0.08, side: 0.15 };
/**
 * The next POLLEN comes out once it has landed: the stack drops by itself after one is pulled out,
 * so the FLOWER empties as fast as its POLLEN fall (about 0.15 s a ball, like the blocks of a VEX
 * loader tube). Still moving up or down faster than this it isn't there yet, m/s.
 */
const LANDED_SPEED = 0.05;
/** The intake's rollers catch a ball in the push back this long after it comes out, s */
const POCKET_GRAB = 0.05;
/**
 * A lift's box (a flower scoring box): its rollers carry the balls standing in it
 * up at `rise` m/s, as far as the curved guide under its lid. With the box down the stopper over the
 * hole in its back wall stays shut (meanwhile the rollers take in what the intake brings, POLLEN
 * too); raised, the servo swings it up and the top ball goes out through the hole (BOX_EXIT). With
 * the box all the way up (`ready` of its lift) and a FLOWER's tube within `capture` of where that
 * ball comes down (m, across the floor) it drops into the tube's top from `dropY` (over the top ring
 * at 0.575 m); anywhere else it falls off behind the robot.
 */
const BOX = { rise: 0.4, ready: 0.95, capture: 0.12, dropY: 0.66 };

const DEG = Math.PI / 180;

/**
 * Defence: a hard hit from another robot knocks the turrets off their aim for `duration` s. Shots
 * scatter `angle` more (standard deviation), so about 3 in 4 still score from the sweet spot.
 */
export const KNOCK = { duration: 2, angle: 4.8 * DEG };

/**
 * Shot scatter (standard deviations) at a given distance: tight inside the sweet spot,
 * growing quadratically to wide scatter at max range, and wider still with the turret knocked.
 */
export function shotSpread(distance: number, acc: Pick<ShooterSpec, 'sweetSpot' | 'maxRange'>, knocked = false): { angle: number; speed: number } {
  const t = Math.max(0, Math.min(1.3, (distance - acc.sweetSpot) / (acc.maxRange - acc.sweetSpot)));
  const k = t * t;
  // Even close in, no robot is perfect: a little scatter on every shot.
  const angle = 0.8 * DEG + k * 4.5 * DEG;
  return { angle: knocked ? Math.hypot(angle, KNOCK.angle) : angle, speed: 0.009 + k * 0.07 };
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
  lift: boolean;
  boxRollers: boolean;
}

export type ShooterStatus = 'off' | 'spinning' | 'ready' | 'tooFar';

/** Gaussian noise (Box–Muller) so shots are not perfectly repeatable. */
function noise(sigma: number): number {
  return sigma * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** A turret with its flywheel. A robot may have several: each shoots its kind of ball, or any. */
export class Turret {
  /** Flywheel speed as a fraction of maximum */
  flywheel = 0;
  /** Turret angle relative to the robot, CCW positive, within spec.turretLimit of where it rests */
  yaw = 0;
  shot: ShotSolution | null = null;
  status: ShooterStatus = 'off';
  feedTimer = 0;
  /** The stop it went to with the target out of its turn either way (1 or -1), until it is back in reach; 0 none */
  stop = 0;

  /** `kinds`: the balls it shoots; undefined for one that shoots everything. */
  constructor(readonly spec: ShooterSpec, readonly kinds?: readonly BallKind[]) {
    this.reset();
  }

  shoots(b: Ball): boolean {
    return !this.kinds || this.kinds.includes(b.kind);
  }

  reset(): void {
    this.flywheel = 0;
    this.yaw = this.spec.facing ?? 0;
    this.shot = null;
    this.status = 'off';
    this.feedTimer = 0;
    this.stop = 0;
  }
}

export class Mechanisms {
  /** Front of the queue goes to the shooter next; the back is nearest the intake. */
  readonly stored: Ball[] = [];
  /**
   * Balls in a lift's box (a flower scoring box), the top one first: they come
   * in at the bottom while the box is down (NECTAR always, POLLEN while its rollers run) and leave
   * at the top on its rollers once it is up.
   */
  readonly box: Ball[] = [];
  shooterOn = false;
  /** The main turret first; Silver Bullet Blaster's second one shoots its NECTAR. */
  readonly turrets: Turret[];
  /** Game pieces the front intake picks up */
  private readonly intakes: readonly BallKind[];
  private readonly armSpec: ArmSpec | undefined;
  private readonly liftSpec: LiftSpec | undefined;
  /** Forward distance of the front intake's mouth from the footprint center, m */
  private readonly intakeFront: number;
  /** The front intake, and the back one of a robot that has one */
  private readonly mouths: Mouth[];
  /** -1 ejecting, 0 idle, 1 intaking — for the roller animation */
  intakeDir = 0;
  /** Front arm: 0 raised .. 1 lowered (robots without one stay at 0) */
  arm = 0;
  /** Lift (a flower scoring box): 0 down .. 1 all the way up (robots without one stay at 0) */
  lift = 0;
  /** The rollers in the lift's box are running */
  boxRollers = false;
  /** Where the lift was last sent */
  private liftUp = false;
  /** How high the top ball in the box stands (the others one ball apart under it), in the frame of LiftSpec.storage, m */
  boxTop = 0;
  /** How far the servo has swung the stopper over the box's hole up: 0 shut .. 1 out of the way */
  boxStopper = 0;
  /**
   * The ball leaving the box: how long since it left the top of the stack (s; out of the hole after
   * boxHoleTime), and once it is out over a FLOWER, where it drops into the tube (world, m). Still
   * held until it is let go.
   */
  boxExit: { ball: Ball; t: number; to: Vec3 | null } | null = null;
  /**
   * Push back: the POLLEN the lowered arm pulled out of a FLOWER. It waits in front of the intake,
   * inside the arm, until the intake (or the transfer) runs; it falls out if the arm goes up.
   */
  pocket: Ball | null = null;
  /** How long the push back has held its ball, s */
  private pocketTime = 0;
  /** Seconds the turrets stay knocked off their aim by a robot hit */
  knocked = 0;
  /** Shooting on the move (a house rule, RuleOptions.movingShots): off, turrets aim only with the robot still */
  movingShots = true;
  /** Extra shot scatter (standard deviation), rad: the AI below its best (ai/skill.ts) */
  aimError = 0;
  private armLowered = false;
  /** Called for every ball an intake picks up, with where it was (for the referee). */
  onPickup?: (ball: Ball, at: Vec3) => void;
  private ejectTimer = 0;

  constructor(
    private readonly robot: RobotSim,
    private readonly balls: BallSim,
    private readonly target: () => Vec3,
    private readonly flowers: [number, number][],
    def: RobotDefinition,
  ) {
    this.turrets = turretsOf(def).map(t => new Turret(t.shooter, t.kinds));
    this.intakes = def.intakes;
    this.armSpec = def.arm;
    this.liftSpec = def.lift;
    this.intakeFront = def.intakeFront ?? def.config.length / 2;
    this.mouths = [{ dir: 1, at: this.intakeFront, halfWidth: def.intakeHalfWidth ?? INTAKE.halfWidth, kinds: def.intakes, interval: intakeInterval(def), timer: 0 }];
    const back = def.backIntake;
    if (back) this.mouths.push({ dir: -1, at: back.back, halfWidth: back.halfWidth, kinds: back.kinds, interval: back.interval, timer: 0 });
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

  /** Balls the robot controls, those in its box too: at most CAPACITY (G407) */
  get held(): number {
    return this.stored.length + this.box.length + (this.boxExit ? 1 : 0);
  }

  reset(preloads: Ball[]): void {
    this.stored.length = 0;
    this.box.length = 0;
    this.boxExit = null;
    this.boxTop = this.liftSpec?.storage[0][1] ?? 0;
    this.boxStopper = 0;
    for (const b of preloads) {
      this.balls.hold(b);
      this.stored.push(b);
    }
    this.shooterOn = false;
    for (const t of this.turrets) t.reset();
    this.arm = 0;
    this.knocked = 0;
    this.armLowered = false;
    this.pocket = null;
    this.lift = 0;
    this.liftUp = false;
    this.boxRollers = false;
  }

  /** Another robot hit this one hard (Simulation.knockTurrets). */
  knock(): void {
    this.knocked = KNOCK.duration;
  }

  /** Drops everything the robot holds where it stands (robot leaving the field). */
  dropAll(): void {
    if (this.pocket) this.dropPocket();
    const [px, , pz] = this.robot.position;
    const over = this.boxExit ? [this.boxExit.ball] : [];
    this.boxExit = null;
    [...this.stored.splice(0), ...this.box.splice(0), ...over].forEach((b, i) => this.balls.release(b, [px + (i % 2) * 0.08, 0.1 + i * 0.1, pz], [0, 0, 0]));
  }

  /** World position just out through the hole of a lift's box, where its balls come out (with the lift where it is). */
  boxOutlet(): Vec3 {
    const lift = this.liftSpec!;
    const [px, , pz] = this.robot.position;
    return boxExitPosition(lift, px, pz, this.robot.yaw, this.lift * lift.height, boxHoleTime(lift), null);
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
    this.knocked = Math.max(0, this.knocked - dt);
    // A ball already on its way out of the box gets out, powered or not.
    if (this.boxExit) this.moveOut(dt);
    if (!enabled) {
      // No powered movement between periods or after the match (G403 / G404).
      this.shooterOn = false;
      this.intakeDir = 0;
      this.boxRollers = false;
      for (const t of this.turrets) {
        this.spinFlywheel(t, 0, dt);
        this.updateStatus(t, false);
      }
      return;
    }
    if (input.shooterOn) this.shooterOn = true;
    if (input.shooterOff) this.shooterOn = false;
    if (this.liftSpec) {
      // One button sends it up, and down again once it is up (or on its way).
      if (input.lift) this.liftUp = !this.liftUp;
      const step = dt / this.liftSpec.travel;
      this.lift = this.liftUp ? Math.min(1, this.lift + step) : Math.max(0, this.lift - step);
      this.boxRollers = input.boxRollers;
      this.runBoxRollers(dt);
    }
    if (this.armSpec) {
      if (input.armDown) this.armLowered = true;
      if (input.armUp) this.armLowered = false;
      const step = dt / this.armSpec.travel;
      let to = this.arm;
      if (!this.armLowered) to = Math.max(0, this.arm - step);
      else if (this.arm < 1) {
        // It swings down only as far as there is room: against a wall, a FLOWER or a robot it rests
        // there and goes on down as the robot backs away; driven further in, it is pushed back up.
        // Once all the way down its box is solid and stops the robot instead.
        const next = Math.min(1, this.arm + step);
        if (this.robot.armFits(next)) to = next;
        else while (to > 0 && !this.robot.armFits(to)) to = Math.max(0, to - step);
      }
      // Up the same way: an arm that sticks out in front while raised (Bobik's) goes all the way up
      // only with room for its box there. Under a FLOWER's middle ring it stops a step short until
      // the robot backs out: made solid inside the ring, the box would throw the robot across the field.
      if (to === 0 && this.arm > 0 && !this.robot.armFits(0)) to = Math.min(this.arm, step);
      this.arm = to;
    }

    // The push back holds its ball only while the arm is all the way down.
    if (this.pocket && this.arm < 1) this.dropPocket();
    // A lowered arm at a FLOWER pushes its bottom POLLEN back out of the retrieval opening into
    // the push back, one at a time, as long as the robot has room to control it (G407).
    const flower = this.flowerAhead();
    if (flower && !this.pocket && this.held < CAPACITY) this.pushFromFlower(flower);
    if (this.pocket) this.pocketTime += dt;

    // The transfer runs the intakes too, so balls picked up while feeding go straight to the shooter.
    this.intakeDir = input.eject ? -1 : input.intake || input.transfer ? 1 : 0;
    if (this.intakeDir === 1) this.runIntake(dt);
    if (this.intakeDir === -1) this.runEject(dt);

    for (const t of this.turrets) {
      this.aim(t, dt);
      if (input.transfer) this.runTransfer(t, dt);
      else t.feedTimer = Math.min(t.feedTimer, 0);
    }
  }

  private runIntake(dt: number): void {
    for (const m of this.mouths) m.timer -= dt;
    if (this.held >= CAPACITY) return;
    // A lowered arm blocks the floor in front: the front intake takes only what the push back
    // holds, as soon as the rollers catch it (it already sits against them).
    const armDown = !!this.armSpec && this.arm > 0;
    if (armDown && this.pocket && this.pocketTime >= POCKET_GRAB) {
      this.stored.push(this.pocket);
      this.pocket = null;
    }
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    for (const m of this.mouths) {
      if (m.timer > 0 || (armDown && m.dir > 0) || this.held >= CAPACITY) continue;
      for (const b of this.balls.all) {
        if (b.state !== 'field' || !m.kinds.includes(b.kind)) continue;
        // A lift's box takes balls in at its bottom, so only while it is down: NECTAR always (the
        // turret shoots POLLEN only), POLLEN while the box's rollers run (a FLOWER's cycle).
        const intoBox = !!this.liftSpec && (b.kind === 'nectar' || (this.boxRollers && this.lift === 0));
        if (intoBox && this.lift > 0) continue;
        const [x, y, z] = this.balls.position(b);
        if (y < FLOWER_TUBE.height && this.flowers.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < FLOWER_TUBE.radius)) continue;
        const dx = x - px;
        const dz = z - pz;
        // Out from the robot's center through the mouth, and across it.
        const out = (dx * fx + dz * fz) * m.dir;
        const across = dx * -fz + dz * fx;
        if (y < INTAKE.maxHeight && out > m.at - INTAKE.inside && out < m.at + INTAKE.reach && Math.abs(across) < m.halfWidth) {
          this.balls.hold(b);
          (intoBox ? this.box : this.stored).push(b);
          m.timer = m.interval;
          this.onPickup?.(b, [x, y, z]);
          break;
        }
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

  /** The bottom POLLEN of the FLOWER at (cx, cz), pushed out of its retrieval opening into the push back. */
  private pushFromFlower([cx, cz]: [number, number]): void {
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
    // Still falling (or thrown up by a robot running into the FLOWER): not down yet.
    if (Math.abs(bottom.body.linvel().y) > LANDED_SPEED) return;
    const at = this.balls.position(bottom);
    this.balls.hold(bottom);
    this.pocket = bottom;
    this.pocketTime = 0;
    this.onPickup?.(bottom, at);
  }

  /** The push back's ball rolls out onto the floor where it was. */
  private dropPocket(): void {
    const b = this.pocket!;
    this.pocket = null;
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const at = this.armSpec ? pushBackSpot(this.intakeFront, this.armSpec) : this.intakeFront;
    const [vx, vz] = this.robot.velocity;
    this.balls.release(b, [px + Math.cos(yaw) * at, b.radius + 0.005 + (this.armSpec?.pocketLift ?? 0), pz - Math.sin(yaw) * at], [vx, 0, vz]);
  }

  /**
   * The box's rollers carry the balls standing in it up, the stack resting on the newest at the
   * bottom, until the top one is against the guide. The servo swings the stopper up while they run
   * with the box raised, and keeps it up until a ball in the hole is out; once it is up, the top
   * ball goes out through the hole, the next rising after it only as it gets out of the way.
   */
  private runBoxRollers(dt: number): void {
    const lift = this.liftSpec!;
    const { storage } = lift;
    const bottom = storage[0][1];
    const apart = storage[1][1] - bottom;
    const top = storage[storage.length - 1][1];
    const inHole = !!this.boxExit && this.boxExit.t < boxHoleTime(lift);
    const opening = (this.boxRollers && this.lift > 0) || inHole;
    this.boxStopper = Math.min(1, Math.max(0, this.boxStopper + (opening ? dt : -dt) / BOX_EXIT.stopper));
    // A ball taken in at the bottom lifts the stack resting on it.
    this.boxTop = this.box.length ? Math.max(this.boxTop, bottom + (this.box.length - 1) * apart) : bottom;
    if (!this.boxRollers || !this.box.length) return;
    this.boxTop = Math.min(this.stackRoom(), this.boxTop + BOX.rise * dt);
    if (this.boxStopper >= 1 && !this.boxExit && this.boxTop >= top) {
      this.boxExit = { ball: this.box.shift()!, t: 0, to: null };
      // The next one is the top now, a ball lower.
      this.boxTop -= apart;
    }
  }

  /** How high the top of the stack in the box can go: up to the guide, and under the ball going out through the hole. */
  private stackRoom(): number {
    const lift = this.liftSpec!;
    const { storage, out } = lift;
    const [fx, top] = storage[storage.length - 1];
    const apart = storage[1][1] - storage[0][1];
    if (!this.boxExit) return top;
    const k = Math.min(1, this.boxExit.t / boxHoleTime(lift));
    const back = k * Math.abs(out[0] - fx);
    return back >= apart ? top : Math.min(top, top + (out[1] - top) * k - Math.sqrt(apart * apart - back * back));
  }

  /**
   * Where a ball just out through the hole drops into a FLOWER: with the box all the way up, into
   * the tube of one within reach of where the ball comes down behind the hole.
   */
  private flowerUnder(): Vec3 | null {
    if (this.lift < BOX.ready) return null;
    const [ox, , oz] = this.boxOutlet();
    const yaw = this.robot.yaw;
    const drift = BOX_EXIT.speed * BOX_EXIT.fall;
    const [lx, lz] = [ox - Math.cos(yaw) * drift, oz + Math.sin(yaw) * drift];
    const flower = this.flowers.find(([cx, cz]) => Math.hypot(lx - cx, lz - cz) < BOX.capture);
    return flower ? [flower[0], BOX.dropY, flower[1]] : null;
  }

  /**
   * The ball leaving the box goes out through the hole, then is let go: over a FLOWER once it has
   * fallen into the tube's top, onto the stack (placed by the robot: G410 judges a NECTAR); anywhere
   * else as it comes out, rolling off back and down to the tiles.
   */
  private moveOut(dt: number): void {
    const exit = this.boxExit!;
    const hole = boxHoleTime(this.liftSpec!);
    const inHole = exit.t < hole;
    exit.t += dt;
    if (exit.t < hole) return;
    if (inHole) exit.to = this.flowerUnder();
    if (exit.to && exit.t < hole + BOX_EXIT.fall) return;
    this.boxExit = null;
    const yaw = this.robot.yaw;
    const [vx, vz] = this.robot.velocity;
    if (exit.to) {
      // As fast as it has come down (boxExitPosition).
      this.balls.release(exit.ball, exit.to, [0, (2 * (exit.to[1] - this.boxOutlet()[1])) / BOX_EXIT.fall, 0]);
    } else {
      this.balls.release(exit.ball, this.boxOutlet(), [vx - Math.cos(yaw) * BOX_EXIT.speed, 0, vz + Math.sin(yaw) * BOX_EXIT.speed]);
    }
    exit.ball.launch = { by: this.robot.slot, kind: 'eject', age: 0 };
  }

  private runEject(dt: number): void {
    this.ejectTimer -= dt;
    if (this.ejectTimer > 0 || (!this.stored.length && !this.pocket)) return;
    // Reversed, the intake pushes the push back's ball away first.
    const b = this.pocket ?? this.stored.pop()!;
    this.pocket = null;
    const [px, , pz] = this.robot.position;
    const yaw = this.robot.yaw;
    const [fx, fz] = [Math.cos(yaw), -Math.sin(yaw)];
    // Out of the intake's mouth, or past the arm while it is (partly) down.
    const out = (this.arm > 0 ? this.robot.cfg.length / 2 : this.intakeFront) + b.radius + 0.03;
    const [vx, vz] = this.robot.velocity;
    this.balls.release(b, [px + fx * out, b.radius + 0.01, pz + fz * out], [vx + fx * EJECT.speed, 0, vz + fz * EJECT.speed]);
    b.launch = { by: this.robot.slot, kind: 'eject', age: 0 };
    this.ejectTimer = EJECT.interval;
  }

  /** How the turret's next ball will spin (ShooterSpec.spin), so the aim allows for its curve. */
  private shotSpin(turret: Turret): ShotSpin | undefined {
    if (!turret.spec.spin) return undefined;
    const kind = this.stored.find(b => turret.shoots(b))?.kind ?? turret.kinds?.[0] ?? this.intakes[0];
    const radius = kind === 'nectar' ? NECTAR_RADIUS : POLLEN_RADIUS;
    return { spin: turret.spec.spin, radius, mass: BALL_MASS[kind], damping: AIR_DAMPING, spinDamping: SPIN_DAMPING };
  }

  private aim(turret: Turret, dt: number): void {
    const launch = this.launchPoint(turret);
    // Without shooting on the move the turret aims only while the robot stands still, and the shot
    // doesn't allow for the robot's motion: fired on the move, it misses.
    const still = this.movingShots || (this.robot.speed < STILL.speed && Math.abs(this.robot.turnRate) < STILL.turn);
    const shot = solveShot(launch, this.target(), SHOOTER.descent, this.movingShots ? this.robot.velocity : [0, 0], this.shotSpin(turret));
    turret.shot = shot;
    // The turret cannot spin round and round (its wires would wind up): it turns at most
    // turretLimit either way from where it rests. It takes the short way to the target while that
    // stays within the limit, otherwise it unwinds the long way round.
    const limit = turret.spec.turretLimit;
    const rest = turret.spec.facing ?? 0;
    const target = wrapAngle(shot.yaw - this.robot.yaw);
    let desired = turret.yaw + wrapAngle(target - turret.yaw);
    const past = Math.abs(desired - rest) - limit;
    if (past > 0) {
      const side = Math.sign(desired - rest);
      const around = desired - side * 2 * Math.PI;
      // Just past the stop: wait there instead of swinging all the way round for a few degrees.
      if (past < SHOOTER.unwindMargin) desired = rest + side * limit;
      else if (Math.abs(around - rest) <= limit) desired = around;
      else {
        // Out of its turn either way (it turns less than half a turn each way): it waits at the
        // stop nearer the target, staying at (or on its way to) the one it picked unless the other
        // is clearly nearer. With the target right behind, both are about as near, and the target
        // shifts a little as the turret turns (its exit swings round): without keeping to its pick,
        // the turret would turn back and forth on the spot.
        const toHigh = Math.abs(wrapAngle(target - (rest + limit)));
        const toLow = Math.abs(wrapAngle(target - (rest - limit)));
        let stop = turret.stop;
        if (!stop) stop = turret.yaw > rest ? (toHigh <= toLow + SHOOTER.unwindMargin ? 1 : -1) : toHigh + SHOOTER.unwindMargin < toLow ? 1 : -1;
        else if (stop > 0 ? toLow + SHOOTER.stopMargin < toHigh : toHigh + SHOOTER.stopMargin < toLow) stop = -stop;
        turret.stop = stop;
        desired = rest + stop * limit;
      }
    }
    if (past <= 0) turret.stop = 0;
    const maxStep = still ? SHOOTER.turretRate * dt : 0;
    const step = Math.max(-maxStep, Math.min(maxStep, desired - turret.yaw));
    turret.yaw = Math.max(rest - limit, Math.min(rest + limit, turret.yaw + step));
    const err = wrapAngle(target - turret.yaw);

    // Auto speed: the flywheel targets exactly the speed this distance needs.
    const needed = shot.speed / SHOOTER.maxSpeed;
    this.spinFlywheel(turret, this.shooterOn ? Math.min(needed, 1) : 0, dt);
    this.updateStatus(turret, still && Math.abs(err) < SHOOTER.aimTolerance);
  }

  private spinFlywheel(turret: Turret, target: number, dt: number): void {
    const rate = ((target > turret.flywheel ? SHOOTER.spinUpRate : SHOOTER.spinDownRate) * dt) / heaviness(turret.spec);
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
    const spread = shotSpread(turret.shot.distance, turret.spec, this.knocked > 0);
    const angle = Math.hypot(spread.angle, this.aimError);
    const yaw = this.robot.yaw + turret.yaw + noise(angle);
    const pitch = turret.shot.pitch + noise(angle);
    // A stopped flywheel just lets the ball drop out of the shooter.
    const speed = Math.max(0.6, turret.flywheel * SHOOTER.maxSpeed * (1 + noise(spread.speed)));
    const v = launchVelocity(yaw, pitch, speed);
    const [rvx, rvz] = this.robot.velocity;
    // The shooter's spin (frontspin: about the axis across its flight, its top turning forward).
    const w = (turret.spec.spin * speed) / b.radius;
    this.balls.release(b, this.launchPoint(turret), [v[0] + rvx, v[1], v[2] + rvz], [-Math.sin(yaw) * w, 0, -Math.cos(yaw) * w]);
    b.launch = { by: this.robot.slot, kind: 'shot', age: 0 };
    turret.flywheel *= 1 - (1 - SHOOTER.shotDrop) / heaviness(turret.spec);
    // Rapid fire: the 4 balls of a full load leave evenly spaced over `rapidFire` seconds (the
    // leftover fraction of a step carries over so the spacing doesn't drift).
    turret.feedTimer = Math.max(turret.feedTimer, -dt) + turret.spec.rapidFire / (CAPACITY - 1);
  }
}
