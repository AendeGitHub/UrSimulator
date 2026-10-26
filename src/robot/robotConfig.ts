import type { DriveConfig } from './mecanum';

export type Alliance = 'red' | 'blue';

export interface RobotConfig {
  name: string;
  /** Footprint along robot forward / right and height, m */
  length: number;
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

const INCH = 0.0254;

// Placeholder robot until the team's CAD is imported: 18" mecanum chassis,
// goBILDA 312 RPM motors on 104 mm wheels (312 / 60 * PI * 0.104 ≈ 1.70 m/s).
export const DEFAULT_ROBOT: RobotConfig = {
  name: 'UrSim',
  length: 18 * INCH,
  width: 18 * INCH,
  height: 0.28,
  mass: 13,
  wheelRadius: 0.052,
  drive: {
    maxWheelSpeed: (312 / 60) * Math.PI * 0.104,
    strafeEfficiency: 0.85,
    trackWidth: 0.41,
    wheelBase: 0.3,
  },
  maxAccel: 5.5,
  maxTurnAccel: 28,
};
