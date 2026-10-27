// Playable robots. Each one is a team's real robot: its CAD model and how it drives and shoots.

import type { BallKind } from '../sim/BallSim';
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
  /** How far the turret turns each way from straight ahead before its cables stop it, rad */
  turretLimit: number;
  /** Seconds between shots while transferring (how fast it fires) */
  fireInterval: number;
}

/**
 * A front arm that swings down in front of the intake (Bumble V's): raised, the intake takes balls
 * off the floor; lowered, it can't, but it pulls POLLEN out of the bottom of a FLOWER (G418 B).
 */
export interface ArmSpec {
  /** Seconds to swing all the way up or down */
  travel: number;
  /** How far the model's arm turns up from its CAD pose (lowered), rad */
  upAngle: number;
  /** The lowered arm's box in front of the frame: forward from..to and up from..to, m */
  box: { x: [number, number]; y: [number, number] };
}

export interface RobotDefinition {
  id: string;
  /** Robot name shown on its signs */
  name: string;
  team: string;
  /** FTC team number, on the robot's signs */
  number: string;
  teamLogo: string;
  /** Fill around a logo that isn't square-on-white, to match its own background */
  logoBackground?: string;
  /** glTF model made from the team's CAD (tools/convert-robot.mjs), detailed */
  model: string;
  /** The same model simplified further (tools/lighten-model.mjs), for Low graphics */
  lowModel: string;
  /** Where the side signs go if not centred on the footprint: forward offset and length, m */
  sign?: { at: number; length: number };
  config: RobotConfig;
  shooter: ShooterSpec;
  /** Game pieces the intake picks up; it drives over the others */
  intakes: BallKind[];
  /** Forward distance of the intake's mouth from the footprint center, if not at its front edge, m */
  intakeFront?: number;
  arm?: ArmSpec;
  /**
   * Where held balls sit in the model (robot frame: forward, up, right; m): `first` is the ball
   * next to be shot, each further ball is `step` closer to the intake.
   */
  storage: { first: [number, number, number]; step: [number, number, number] };
}

/** Wheel surface speed: motor RPM / 60 · π · wheel diameter. */
const wheelSpeed = (rpm: number, wheelDiameter: number) => (rpm / 60) * Math.PI * wheelDiameter;

export const URAN_V1: RobotDefinition = {
  id: 'uran-v1',
  name: 'URAN V1',
  team: 'URAN92',
  number: '25300',
  teamLogo: 'assets/teams/uran.svg',
  model: 'assets/robots/uran-v1.glb',
  lowModel: 'assets/robots/uran-v1-low.glb',
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
  // Flywheel shooter on a turret (axis measured from the CAD turret ring); balls leave on the side
  // that faces the front of the robot in the CAD. From the opening side of a cell the field allows
  // at most ~2.3 m, so the accuracy scale fits that.
  shooter: { at: [-0.022, 0.003], height: 0.26, exit: 0.1, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: Math.PI, fireInterval: 0.5 },
  // URAN V1 plays POLLEN only: NECTAR stays on the field.
  intakes: ['pollen'],
  // A row under the transfer rollers, from the turret forward to the intake.
  storage: { first: [-0.075, 0.1, 0], step: [0.072, 0, 0] },
};

export const BUMBLE_V: RobotDefinition = {
  id: 'bumble-v',
  name: 'Bumble V',
  team: 'SWB',
  number: '21094',
  teamLogo: 'assets/teams/swb.png',
  logoBackground: '#481a60',
  model: 'assets/robots/bumble-v.glb',
  lowModel: 'assets/robots/bumble-v-low.glb',
  // On the side plates of the drive base (the arm sticks out in front of them).
  sign: { at: -0.055, length: 0.26 },
  // Sizes measured from the team CAD (Bumble V.step); the lowered arm sticks out in front.
  config: {
    name: 'Bumble V',
    length: 0.459,
    // The frame alone: the arm's part of the footprint only collides while it is down.
    frame: { length: 0.351, offset: -0.054 },
    width: 0.28,
    height: 0.404,
    mass: 11,
    wheelRadius: 0.048,
    // 96 mm mecanum wheels on 522 RPM motors.
    drive: { maxWheelSpeed: wheelSpeed(522, 0.096), strafeEfficiency: 0.85, trackWidth: 0.214, wheelBase: 0.169 },
    // Heavier than URAN V1, so a little less acceleration from the same traction.
    maxAccel: 5.8,
    maxTurnAccel: 30,
  },
  // Two flywheels on a turret that turns a full turn each way: the ball is squeezed between the
  // low front wheel and the high back one and leaves forward over the front wheel (camera side).
  shooter: { at: [-0.084, 0], height: 0.33, exit: 0.06, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: 2 * Math.PI, fireInterval: 0.6 },
  intakes: ['pollen'],
  // The bush-back arm on the front intake axle, driven by a servo.
  arm: { travel: 0.4, upAngle: 1.85, box: { x: [0.12, 0.23], y: [0.035, 0.18] } },
  // The front rollers sit behind the arm, at the front plate of the frame.
  intakeFront: 0.11,
  // Up the transfer ramp, from under the turret forward to the intake rollers.
  storage: { first: [-0.09, 0.13, 0], step: [0.06, 0, 0] },
};

export const ROBOTS: RobotDefinition[] = [URAN_V1, BUMBLE_V];
export const DEFAULT_ROBOT_ID = URAN_V1.id;

export function robotById(id: string | undefined): RobotDefinition {
  return ROBOTS.find(r => r.id === id) ?? URAN_V1;
}
