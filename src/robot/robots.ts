// Playable robots. Each one is a team's real robot: its CAD model and how it drives and shoots.

import type { RobotConfig } from './robotConfig';

/** Where the shooter is and how well it hits depending on distance to the target. */
export interface ShooterSpec {
  /** Shooter position on the robot: (forward, right) from the footprint center, m */
  at: [number, number];
  /** Height where balls leave the shooter, m */
  height: number;
  /** Distance from the turret axis to where balls leave, m */
  exit: number;
  /** Up to this distance (m) the robot hits almost every shot */
  sweetSpot: number;
  /** At this distance and beyond (m) shots scatter widely */
  maxRange: number;
  /** Turret angle (rad) at which the model's shooter points straight forward */
  modelYaw: number;
}

export interface RobotDefinition {
  id: string;
  /** Robot name shown on its signs */
  name: string;
  team: string;
  teamLogo: string;
  /** glTF model made from the team's CAD (tools/convert-robot.mjs) */
  model: string;
  config: RobotConfig;
  shooter: ShooterSpec;
}

/** Wheel surface speed: motor RPM / 60 · π · wheel diameter. */
const wheelSpeed = (rpm: number, wheelDiameter: number) => (rpm / 60) * Math.PI * wheelDiameter;

export const URAN_V1: RobotDefinition = {
  id: 'uran-v1',
  name: 'URAN V1',
  team: 'URAN92',
  teamLogo: 'assets/teams/uran.svg',
  model: 'assets/robots/uran-v1.glb',
  // Sizes measured from the team CAD (Jedi92.stp).
  config: {
    name: 'URAN V1',
    length: 0.44,
    width: 0.316,
    height: 0.305,
    mass: 9,
    wheelRadius: 0.041,
    // 82 mm mecanum wheels on 518 RPM motors.
    drive: { maxWheelSpeed: wheelSpeed(518, 0.082), strafeEfficiency: 0.85, trackWidth: 0.258, wheelBase: 0.215 },
    // Light and fast: traction allows more acceleration than a heavy robot.
    maxAccel: 6.5,
    maxTurnAccel: 34,
  },
  // Flywheel shooter on a turret (axis measured from the CAD turret ring); balls leave over the
  // hood on the flywheel side, which faces the back of the robot in the CAD. From the opening side
  // of a cell the field allows at most ~2.3 m, so the accuracy scale fits that.
  shooter: { at: [-0.022, 0.003], height: 0.26, exit: 0.1, sweetSpot: 1.0, maxRange: 2.2, modelYaw: Math.PI },
};

export const ROBOTS: RobotDefinition[] = [URAN_V1];
export const DEFAULT_ROBOT_ID = URAN_V1.id;

export function robotById(id: string | undefined): RobotDefinition {
  return ROBOTS.find(r => r.id === id) ?? URAN_V1;
}
