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
  /** Rapid fire: seconds from the first to the last of a full load of 4 balls while transferring */
  rapidFire: number;
}

/**
 * A front arm that swings down in front of the intake (Bumble V's): raised, the intake takes balls
 * off the floor; lowered, it can't, but at a FLOWER it pulls POLLEN out of the bottom by itself (G418 B).
 */
export interface ArmSpec {
  /** Seconds to swing all the way up or down */
  travel: number;
  /** How far the model's arm turns up from its CAD pose (lowered), rad */
  upAngle: number;
  /** The lowered arm's box in front of the frame: forward from..to and up from..to, m */
  box: { x: [number, number]; y: [number, number] };
  /**
   * How far forward of the footprint center the arm's front reaches as it swings down, at evenly
   * spaced steps from raised (first) to lowered (last), measured from the model, m
   */
  reach: number[];
}

/** Where held balls sit in the model (robot frame: forward, up, right; m): `first` is the ball next to be shot, each further ball is `step` closer to the intake. */
export interface Storage {
  first: [number, number, number];
  step: [number, number, number];
}

/** A second turret with its own lane (Silver Bullet Blaster): it shoots `kinds`, the main turret the rest. */
export interface SecondTurret {
  shooter: ShooterSpec;
  kinds: BallKind[];
  storage: Storage;
}

/** Drivetrain as the team describes it, for the robot card. */
export interface DriveSpec {
  /** Drive motor speed, RPM */
  rpm: number;
  /** Mecanum wheel diameter, m */
  wheel: number;
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
  drive: DriveSpec;
  config: RobotConfig;
  shooter: ShooterSpec;
  /** Game pieces the intake picks up; it drives over the others */
  intakes: BallKind[];
  /** Forward distance of the intake's mouth from the footprint center, if not at its front edge, m */
  intakeFront?: number;
  arm?: ArmSpec;
  /** Where the main turret's held balls sit */
  storage: Storage;
  second?: SecondTurret;
}

/** Wheel surface speed: motor RPM / 60 · π · wheel diameter. */
export const wheelSpeed = ({ rpm, wheel }: DriveSpec) => (rpm / 60) * Math.PI * wheel;

const URAN_V1_DRIVE: DriveSpec = { rpm: 518, wheel: 0.082 };
const BUMBLE_V_DRIVE: DriveSpec = { rpm: 522, wheel: 0.096 };
const SILVER_BULLET_DRIVE: DriveSpec = { rpm: 435, wheel: 0.104 };

export const URAN_V1: RobotDefinition = {
  id: 'uran-v1',
  name: 'URAN V1',
  team: 'URAN92',
  number: '25300',
  teamLogo: 'assets/teams/uran.svg',
  model: 'assets/robots/uran-v1.glb',
  lowModel: 'assets/robots/uran-v1-low.glb',
  drive: URAN_V1_DRIVE,
  // Sizes measured from the team CAD (Jedi92.stp).
  config: {
    name: 'URAN V1',
    length: 0.44,
    width: 0.316,
    height: 0.305,
    mass: 9,
    wheelRadius: 0.041,
    // 82 mm mecanum wheels on 518 RPM motors.
    drive: { maxWheelSpeed: wheelSpeed(URAN_V1_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.258, wheelBase: 0.215 },
    // Light and fast: traction allows more acceleration than a heavy robot.
    maxAccel: 6.5,
    maxTurnAccel: 34,
  },
  // Flywheel shooter on a turret (axis measured from the CAD turret ring); balls leave on the side
  // that faces the front of the robot in the CAD. From the opening side of a cell the field allows
  // at most ~2.3 m, so the accuracy scale fits that. The turret turns 200° each way, a little past the back.
  // Rapid fire (the team's figure): all 4 balls in 0.4 s.
  shooter: { at: [-0.022, 0.003], height: 0.26, exit: 0.1, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: (200 * Math.PI) / 180, rapidFire: 0.4 },
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
  drive: BUMBLE_V_DRIVE,
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
    drive: { maxWheelSpeed: wheelSpeed(BUMBLE_V_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.214, wheelBase: 0.169 },
    // Heavier than URAN V1, so a little less acceleration from the same traction.
    maxAccel: 5.8,
    maxTurnAccel: 30,
  },
  // Two flywheels on a turret that turns a full turn each way: the ball is squeezed between the
  // low front wheel and the high back one and leaves forward over the front wheel (camera side).
  // Rapid fire (the team's figure): 4 balls in 0.7 s.
  shooter: { at: [-0.084, 0], height: 0.33, exit: 0.06, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: 2 * Math.PI, rapidFire: 0.7 },
  intakes: ['pollen'],
  // The bush-back arm on the front intake axle, driven by a servo.
  // Swinging down, its front end first sweeps forward past the lowered pose, then comes back a little.
  arm: {
    travel: 0.4,
    upAngle: 1.85,
    box: { x: [0.12, 0.23], y: [0.035, 0.18] },
    reach: [0.106, 0.125, 0.148, 0.175, 0.198, 0.216, 0.23, 0.239, 0.241, 0.238, 0.229],
  },
  // The front rollers sit behind the arm, at the front plate of the frame.
  intakeFront: 0.11,
  // Up the transfer ramp, from under the turret forward to the intake rollers.
  storage: { first: [-0.09, 0.13, 0], step: [0.06, 0, 0] },
};

/** One turret of Silver Bullet Blaster: a flywheel under a curved hood of passive rollers. */
const silverBulletShooter = (right: number): ShooterSpec => ({
  at: [-0.102, right], height: 0.44, exit: 0.05, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: 2 * Math.PI,
  // Rapid fire (the team's figure): 4 balls in 1 s.
  rapidFire: 1.0,
});

export const SILVER_BULLET_BLASTER: RobotDefinition = {
  id: 'silver-bullet-blaster',
  name: 'Silver Bullet Blaster',
  team: 'SWB',
  number: '21094',
  teamLogo: 'assets/teams/swb.png',
  logoBackground: '#481a60',
  model: 'assets/robots/silver-bullet-blaster.glb',
  lowModel: 'assets/robots/silver-bullet-blaster-low.glb',
  sign: { at: -0.063, length: 0.3 },
  drive: SILVER_BULLET_DRIVE,
  // Sizes measured from the team CAD (Silver Bullet Blaster.step); the lowered arm sticks out in front.
  config: {
    name: 'Silver Bullet Blaster',
    length: 0.546,
    // The frame up to the front intake wheels: the arm's part of the footprint only collides while it is down.
    frame: { length: 0.455, offset: -0.046 },
    width: 0.367,
    height: 0.451,
    mass: 12.5,
    wheelRadius: 0.052,
    // 104 mm mecanum wheels on 435 RPM motors.
    drive: { maxWheelSpeed: wheelSpeed(SILVER_BULLET_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.296, wheelBase: 0.229 },
    // The heaviest robot: the least acceleration from the same traction.
    maxAccel: 5.3,
    maxTurnAccel: 27,
  },
  // Two turrets side by side, each fed by its own lane up the ramp: the left one shoots POLLEN,
  // the right one NECTAR. Both aim at the HIVE by themselves.
  shooter: silverBulletShooter(-0.101),
  second: { shooter: silverBulletShooter(0.102), kinds: ['nectar'], storage: { first: [-0.075, 0.27, 0.102], step: [0.075, -0.035, 0] } },
  intakes: ['pollen', 'nectar'],
  // Flower Mode: the U-shaped arm on the front intake axle, lifted by a servo winch. Lowered it
  // blocks the floor but pulls POLLEN out of the bottom of a FLOWER, like Bumble V's.
  arm: {
    travel: 0.5,
    upAngle: 2.2,
    // From the bar just above the tiles: robots ride 12 mm low on their frame box, so lower would touch the floor.
    box: { x: [0.182, 0.273], y: [0.025, 0.15] },
    reach: [0.161, 0.19, 0.223, 0.252, 0.274, 0.291, 0.305, 0.31, 0.306, 0.294, 0.273],
  },
  // The front intake wheels stick out past the frame.
  intakeFront: 0.18,
  storage: { first: [-0.075, 0.27, -0.101], step: [0.075, -0.035, 0] },
};

// New robots go at the end: snapshots name a robot by its place in this list.
export const ROBOTS: RobotDefinition[] = [URAN_V1, BUMBLE_V, SILVER_BULLET_BLASTER];
export const DEFAULT_ROBOT_ID = URAN_V1.id;

export function robotById(id: string | undefined): RobotDefinition {
  return ROBOTS.find(r => r.id === id) ?? URAN_V1;
}
