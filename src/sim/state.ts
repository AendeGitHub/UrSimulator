// World state for rendering.

import type { AllianceScore } from '../game/scoring';
import type { WheelPowers } from '../robot/mecanum';
import type { Alliance } from '../robot/robotConfig';
import type { Period } from './Match';
import type { ShooterStatus } from './Mechanisms';
import type { Slot } from './types';

/** A turret besides the main one: where it points and how fast its flywheel turns */
export interface TurretState {
  yaw: number;
  pitch: number;
  flywheel: number;
}

export interface RobotState {
  slot: Slot;
  /** Robot id (robots.ts) */
  robot: string;
  x: number;
  z: number;
  yaw: number;
  heading: number;
  speed: number;
  turretYaw: number;
  pitch: number;
  flywheel: number;
  intakeDir: number;
  /** Transfer wheels feeding the shooter */
  transfer: boolean;
  status: ShooterStatus;
  shotSpeed: number;
  shotDistance: number;
  powers: WheelPowers;
  /** Ball ids in the hopper, next to shoot first */
  stored: number[];
  /** Ball ids in a lift's box, the top one first */
  box: number[];
  /** How high the top ball in the box stands, in the frame of LiftSpec.storage (with the lift down), m */
  boxTop: number;
  /**
   * The ball leaving the box: how long since it left the top of the stack (s; out through the hole
   * after boxHoleTime), and once it is out over a FLOWER, where it drops into the tube (world, m)
   */
  boxExit: { id: number; t: number; to: [number, number, number] | null } | null;
  /** The ball waiting in the push back in front of the intake (Flower Mode), or null */
  pocket: number | null;
  /** Battery under load and the lowest it has been, V */
  voltage: number;
  minVoltage: number;
  /** Front arm: 0 raised .. 1 lowered (0 for robots without one) */
  arm: number;
  /** Lift (a flower scoring box): 0 down .. 1 all the way up (0 for robots without one) */
  lift: number;
  /** The rollers in the lift's box are running */
  boxRollers: boolean;
  /** The other turrets, in order (Silver Bullet Blaster's NECTAR one, those of a player's robot) */
  extraTurrets: TurretState[];
}

export interface WorldState {
  time: number;
  period: Period;
  periodTime: number;
  hiveAngles: Record<Alliance, number>;
  tips: Record<Alliance, number>;
  score: Record<Alliance, AllianceScore>;
  robots: RobotState[];
  balls: {
    /** 0 field, 1 held, 2 staged */
    states: Uint8Array;
    /** x, y, z, qx, qy, qz, qw per ball */
    transforms: Float32Array;
  };
}
