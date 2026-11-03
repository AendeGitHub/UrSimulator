// Robot rigid body + mecanum drivetrain controller.

import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../field/layout';
import { chassisSpeeds, forwardVector, mecanumPowers, rightVector, swerveDrive, wrapAngle, type ChassisSpeeds, type WheelPowers } from '../robot/mecanum';
import type { Alliance, RobotConfig } from '../robot/robotConfig';
import type { ArmSpec, LiftSpec } from '../robot/robots';
import { Battery } from './Battery';
import { slotAlliance, type Slot } from './types';

export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

const GROUND_CLEARANCE = 0.012;
/**
 * A raised arm's box still comes up this far into whatever it rests against, m: a resting contact
 * presses in about a millimetre, and the physics settles that much gently.
 */
const RAISED_SLACK = 0.005;

export class RobotSim {
  readonly body: RAPIER.RigidBody;
  /** Kept: body.collider(0) makes a new wrapper object on every call. */
  readonly collider: RAPIER.Collider;
  readonly alliance: Alliance;
  /** Yaw the simulated IMU reports as zero: away from the drivers at init, then wherever "reset heading" was pressed. */
  private imuZero = 0;
  powers: WheelPowers = { fl: 0, fr: 0, bl: 0, br: 0 };
  readonly battery = new Battery();

  /** A folding arm's box, solid only while the arm is down */
  readonly armCollider: RAPIER.Collider | null = null;
  /** Its box out past the frame while raised (ArmSpec.raisedBox), solid only while the arm is up */
  readonly raisedArmCollider: RAPIER.Collider | null = null;
  /** A lift's box (a flower scoring box), riding the lift: shots and balls hit it */
  readonly liftCollider: RAPIER.Collider | null = null;

  constructor(private readonly world: RAPIER.World, readonly slot: Slot, readonly cfg: RobotConfig, pose: Pose, private readonly arm?: ArmSpec, private readonly lift?: LiftSpec) {
    this.alliance = slotAlliance(slot);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .enabledRotations(false, true, false) // FTC robots rarely tip; keeps driving stable
        // No CCD: at full speed a robot moves 2 cm per step, far less than its own size or a wall.
        .setCanSleep(false),
    );
    const bodyHeight = cfg.height - GROUND_CLEARANCE;
    const frame = cfg.frame ?? { length: cfg.length, offset: 0 };
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(frame.length / 2, bodyHeight / 2, cfg.width / 2)
        .setTranslation(frame.offset, GROUND_CLEARANCE + bodyHeight / 2, 0)
        .setMass(cfg.mass)
        // Traction comes from the drive controller below, so the body itself slides freely.
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        // Bumpers soak up hits: nothing bounces off the robot.
        .setRestitution(0)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
    /** An arm's box in front of the frame, as wide as the robot: forward from..to, up from..to. */
    const box = ({ x: [x0, x1], y: [y0, y1] }: ArmSpec['box']) => world.createCollider(
      RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, cfg.width / 2)
        .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, 0)
        .setMass(0)
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
    if (arm) {
      this.armCollider = box(arm.box);
      this.armCollider.setEnabled(false);
      // Arms start raised.
      if (arm.raisedBox) this.raisedArmCollider = box(arm.raisedBox);
    }
    if (lift) {
      const { x: [x0, x1], y: [y0, y1], halfWidth } = lift.box;
      this.liftCollider = world.createCollider(
        RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, halfWidth)
          .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, 0)
          .setMass(0)
          .setFriction(0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setRestitution(0)
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
        this.body,
      );
    }
    this.setPose(pose);
  }

  /** The lift's box goes up with it (0 down .. 1 all the way up). */
  setLift(progress: number): void {
    if (!this.liftCollider || !this.lift) return;
    const { x: [x0, x1], y: [y0, y1] } = this.lift.box;
    this.liftCollider.setTranslationWrtParent({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 + progress * this.lift.height, z: 0 });
  }

  /** The arm's box pushes balls and robots only while the arm is down (or up, the raised one). */
  setArm(progress: number): void {
    const toggle = (c: RAPIER.Collider | null, solid: boolean) => {
      if (c && c.isEnabled() !== solid) c.setEnabled(solid);
    };
    toggle(this.armCollider, progress >= 1);
    toggle(this.raisedArmCollider, progress <= 0);
  }

  /** The arm's box that is solid now, if any. */
  get solidArm(): RAPIER.Collider | null {
    if (this.armCollider?.isEnabled()) return this.armCollider;
    return this.raisedArmCollider?.isEnabled() ? this.raisedArmCollider : null;
  }


  /**
   * Whether the arm, swung down to `progress` (0 raised .. 1 lowered), stays clear of walls, field
   * elements and other robots. Balls don't count: the arm pushes them aside. All the way up, an arm
   * that sticks out in front (ArmSpec.raisedBox) needs room for that box.
   */
  armFits(progress: number): boolean {
    if (!this.arm) return true;
    const { reach, box, raisedBox } = this.arm;
    if (progress <= 0 && raisedBox) return this.clearInFront(raisedBox, RAISED_SLACK);
    const k = Math.max(0, Math.min(1, progress)) * (reach.length - 1);
    const i = Math.min(reach.length - 2, Math.floor(k));
    const front = reach[i] + (reach[i + 1] - reach[i]) * (k - i);
    const frame = this.cfg.frame ?? { length: this.cfg.length, offset: 0 };
    const back = frame.offset + frame.length / 2;
    return front <= back || this.clearInFront({ x: [back, front], y: box.y });
  }

  /**
   * Whether a box as wide as the robot, forward from..to and up from..to, touches anything but
   * balls deeper than `slack` (m).
   */
  private clearInFront({ x: [x0, x1], y: [y0, y1] }: ArmSpec['box'], slack = 0): boolean {
    const along = (x0 + x1) / 2;
    const t = this.body.translation();
    const yaw = this.yaw;
    const shape = new RAPIER.Cuboid((x1 - x0) / 2 - slack, (y1 - y0) / 2 - slack, this.cfg.width / 2 - slack);
    const at = { x: t.x + Math.cos(yaw) * along, y: t.y + (y0 + y1) / 2, z: t.z - Math.sin(yaw) * along };
    const hit = this.world.intersectionWithShape(at, this.body.rotation(), shape, undefined, undefined, undefined, this.body, c => c.shapeType() !== RAPIER.ShapeType.Ball);
    return !hit;
  }

  remove(): void {
    this.world.removeRigidBody(this.body);
  }

  setPose(pose: Pose): void {
    this.body.setTranslation({ x: pose.x, y: 0.002, z: pose.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(pose.yaw / 2), z: 0, w: Math.cos(pose.yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // The IMU starts with "forward" pointing away from the drivers, however the robot was put
    // down at the start (a turned start position), so field-centric driving matches the sticks.
    this.imuZero = this.alliance === 'red' ? 0 : Math.PI;
    this.powers = { fl: 0, fr: 0, bl: 0, br: 0 };
  }

  get yaw(): number {
    const q = this.body.rotation();
    return 2 * Math.atan2(q.y, q.w);
  }

  /** Heading as the robot's IMU would report it (CCW positive, radians). */
  get heading(): number {
    return wrapAngle(this.yaw - this.imuZero);
  }

  resetImu(): void {
    this.imuZero = this.yaw;
  }

  get position(): Vec3 {
    const t = this.body.translation();
    return [t.x, t.y, t.z];
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** Horizontal velocity (x, z), m/s */
  get velocity(): [number, number] {
    const v = this.body.linvel();
    return [v.x, v.z];
  }

  /** How fast the robot turns, rad/s (counterclockwise positive, like its yaw) */
  get turnRate(): number {
    return this.body.angvel().y;
  }

  /** Called every physics step with FTC-style inputs in -1..1 (turn > 0 = clockwise). */
  drive(forward: number, strafe: number, turn: number, dt: number): void {
    // Motors run at a speed proportional to the battery voltage.
    const drive = { ...this.cfg.drive, maxWheelSpeed: this.cfg.drive.maxWheelSpeed * this.battery.speedScale };
    let target: ChassisSpeeds;
    if (drive.type === 'swerve') {
      const swerve = swerveDrive(forward, strafe, turn, drive);
      this.powers = swerve.powers;
      target = swerve.speeds;
    } else {
      // A tank drive's wheels don't move it sideways.
      this.powers = mecanumPowers(forward, drive.type === 'tank' ? 0 : strafe, turn);
      target = chassisSpeeds(this.powers, drive);
    }
    const yaw = this.yaw;
    const [fx, fz] = forwardVector(yaw);
    const [rx, rz] = rightVector(yaw);
    const tx = target.forward * fx + target.right * rx;
    const tz = target.forward * fz + target.right * rz;

    // Move toward the commanded velocity, limited by traction. Contacts (walls, other robots)
    // are resolved by the physics step afterwards, so pushing against something stalls the robot.
    const v = this.body.linvel();
    let dx = tx - v.x;
    let dz = tz - v.z;
    const maxDv = this.cfg.maxAccel * dt;
    const dv = Math.hypot(dx, dz);
    if (dv > maxDv) {
      dx *= maxDv / dv;
      dz *= maxDv / dv;
    }
    this.body.setLinvel({ x: v.x + dx, y: v.y, z: v.z + dz }, true);

    const w = this.body.angvel().y;
    const maxDw = this.cfg.maxTurnAccel * dt;
    const dw = Math.max(-maxDw, Math.min(maxDw, -target.turnCw - w));
    this.body.setAngvel({ x: 0, y: w + dw, z: 0 }, true);
  }
}
