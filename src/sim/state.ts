// World state for rendering.

import type { AllianceScore } from '../game/scoring';
import type { WheelPowers } from '../robot/mecanum';
import type { Alliance } from '../robot/robotConfig';
import type { Period } from './Match';
import type { ShooterStatus } from './Mechanisms';
import type { Slot } from './types';

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
  /** Battery under load and the lowest it has been, V */
  voltage: number;
  minVoltage: number;
  /** Front arm: 0 raised .. 1 lowered (0 for robots without one) */
  arm: number;
  /** The second turret (Silver Bullet Blaster's NECTAR one); 0 for robots without */
  turretYaw2: number;
  pitch2: number;
  flywheel2: number;
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
