// Mecanum drive math, written the same way as typical FTC TeleOp code (see gm0.org).
//
// World frame: X/Z plane, Y up. Yaw 0 faces +X; positive yaw turns counter-clockwise seen from above.
// Robot frame: forward = +X, right = +Z.

export interface DriveConfig {
  /** Wheel surface speed at full power, m/s (motor RPM / 60 * PI * wheel diameter) */
  maxWheelSpeed: number;
  /** Mecanum rollers lose some speed when strafing (0..1) */
  strafeEfficiency: number;
  /** Distance between left and right wheels, m */
  trackWidth: number;
  /** Distance between front and back wheels, m */
  wheelBase: number;
}

export interface WheelPowers {
  fl: number;
  fr: number;
  bl: number;
  br: number;
}

export interface ChassisSpeeds {
  /** m/s along robot forward */
  forward: number;
  /** m/s along robot right */
  right: number;
  /** rad/s, positive = clockwise seen from above (FTC "turn right") */
  turnCw: number;
}

/** FTC-style wheel powers: forward/strafe/turn in -1..1, normalized so no wheel exceeds 1. */
export function mecanumPowers(forward: number, strafe: number, turn: number): WheelPowers {
  const denom = Math.max(Math.abs(forward) + Math.abs(strafe) + Math.abs(turn), 1);
  return {
    fl: (forward + strafe + turn) / denom,
    bl: (forward - strafe + turn) / denom,
    fr: (forward - strafe - turn) / denom,
    br: (forward + strafe - turn) / denom,
  };
}

/** Forward kinematics: wheel powers → chassis speeds. */
export function chassisSpeeds(p: WheelPowers, cfg: DriveConfig): ChassisSpeeds {
  const v = cfg.maxWheelSpeed;
  const k = (cfg.trackWidth + cfg.wheelBase) / 2;
  return {
    forward: ((p.fl + p.fr + p.bl + p.br) / 4) * v,
    right: ((p.fl - p.fr - p.bl + p.br) / 4) * v * cfg.strafeEfficiency,
    turnCw: ((p.fl - p.fr + p.bl - p.br) / 4) * (v / k),
  };
}

export function forwardVector(yaw: number): [number, number] {
  return [Math.cos(yaw), -Math.sin(yaw)];
}

export function rightVector(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

/**
 * Field-centric drive: stick input is relative to the driver ("up" = away from the driver).
 * `heading` is the robot yaw relative to the direction the driver faces, as an IMU would report it.
 * Returns robot-relative forward/strafe commands.
 */
export function fieldCentric(stickForward: number, stickRight: number, heading: number): { forward: number; strafe: number } {
  // Same as the FTC sample: rotate the stick vector by -heading.
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return {
    forward: stickForward * cos - stickRight * sin,
    strafe: stickForward * sin + stickRight * cos,
  };
}

/** Wraps an angle to -PI..PI. */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
