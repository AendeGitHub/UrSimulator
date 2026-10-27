import type { DriveConfig } from './mecanum';

export type Alliance = 'red' | 'blue';

export interface RobotConfig {
  name: string;
  /** Footprint along robot forward / right and height, m */
  length: number;
  /** The solid frame when part of the footprint is a folding arm: its length and how far its center sits forward, m */
  frame?: { length: number; offset: number };
  width: number;
  height: number;
  mass: number;
  wheelRadius: number;
  drive: DriveConfig;
  /** Traction limit, m/s² */
  maxAccel: number;
  /** rad/s² */
  maxTurnAccel: number;
}
