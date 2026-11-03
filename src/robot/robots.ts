// Playable robots. Each one is a team's real robot: its CAD model and how it drives and shoots.

import type { BallKind } from '../sim/BallSim';
import type { Blueprint } from './custom';
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
  /** How far the turret turns each way from where it rests before its cables stop it, rad */
  turretLimit: number;
  /** Where the turret rests, the middle of its turn: rad to the left of straight ahead (0 if not given) */
  facing?: number;
  /** Rapid fire: seconds from the first to the last of a full load of 4 balls while transferring */
  rapidFire: number;
  /**
   * How the ball spins as it leaves, as a fraction of rolling (its surface turning as fast as it
   * flies): 1 frontspin, the top turning forward, from one flywheel rolling it along a hood; 0 none,
   * squeezed between two wheels turning alike; negative for backspin. It curves in the air (Magnus).
   */
  spin: number;
  /** The flywheel's mass, kg (the team's figure), if not the usual one (Mechanisms' SHOOTER.flywheelMass) */
  flywheelMass?: number;
}

/**
 * A front arm that swings down in front of the intake (Bumble V's): raised, the intake takes balls
 * off the floor; lowered, it can't, but with its front bar in a FLOWER's retrieval opening it pushes the
 * bottom POLLEN back into the arm (G418 B), where it waits until the intake runs (the push back).
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
  /**
   * An arm that sticks out past the frame while raised (Bobik's): its box there, forward from..to
   * and up from..to (over the balls the intake takes), m; solid only while it is all the way up
   */
  raisedBox?: { x: [number, number]; y: [number, number] };
  /** How high the push back's ball sits above the tiles, if not on them (on the lowered arm's plate), m */
  pocketLift?: number;
}

/**
 * A lift on slides with a box on it (a flower scoring box): while it is down the
 * robot's NECTAR goes into the box, and its POLLEN too while the box's rollers (a button of their
 * own) run; raised, the rollers carry the balls up and out through a hole at the top of its back
 * wall, into a FLOWER the box is over. How far each part of the model goes is in the model
 * (`extras.slide`).
 */
export interface LiftSpec {
  /** Seconds to go all the way up or down */
  travel: number;
  /** How far the box goes up, m (the model's `slide` of the part that carries it) */
  height: number;
  /**
   * Where a ball leaving the box is once it is out through the hole, clear of the back wall, with
   * the lift down: forward of the footprint center (negative: behind it) and above the tiles, m.
   * It goes there straight from the top of `storage`.
   */
  out: [number, number];
  /** Where balls sit in the box with the lift down, from the bottom up (robot frame: forward, up, right; m) */
  storage: Storage;
  /** The box, solid for balls and robots wherever the lift has it: forward from..to and up from..to with the lift down, and half its width, m */
  box: { x: [number, number]; y: [number, number]; halfWidth: number };
}

export interface RobotSign {
  at: number;
  length: number;
  y: number;
  height: number;
  side: number;
}

/**
 * Push back: where a POLLEN pulled out of a FLOWER waits between the intake's mouth and the
 * lowered arm's front bar (forward of the footprint center, m).
 */
export const pushBackSpot = (intakeFront: number, arm: ArmSpec): number => (intakeFront + arm.box.x[1]) / 2;

/**
 * How a ball leaves a lift's box: the curved guide at its top turns the top ball back, out through
 * the hole at `speed` m/s; out of it, over a FLOWER, it falls into the tube's top for `fall` s. The
 * servo swings the stopper over the hole up, or down again, in `stopper` s.
 */
export const BOX_EXIT = { speed: 0.5, fall: 0.16, stopper: 0.12 };

/** Seconds a ball takes from the top of a lift's box out through the hole (to `out`) */
export const boxHoleTime = (lift: LiftSpec): number => Math.abs(lift.out[0] - lift.storage[lift.storage.length - 1][0]) / BOX_EXIT.speed;

/**
 * Where the ball leaving a lift's box is (world, m) `t` s after it left the top of the stack, with
 * the robot at x, z turned `yaw` and its box `up` m up: going straight back out through the hole,
 * riding the robot; then, given where it drops into a FLOWER (`to`), falling there.
 */
export function boxExitPosition(lift: LiftSpec, x: number, z: number, yaw: number, up: number, t: number, to: readonly number[] | null): [number, number, number] {
  const [fx, top, rz] = lift.storage[lift.storage.length - 1];
  const [ox, oy] = lift.out;
  const hole = boxHoleTime(lift);
  const k = Math.min(1, t / hole);
  const f = fx + (ox - fx) * k;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const at: [number, number, number] = [x + f * cos + rz * sin, top + (oy - top) * k + up, z - f * sin + rz * cos];
  if (!to || k < 1) return at;
  // Across steadily and down ever faster, like a ball falling.
  const s = Math.min(1, (t - hole) / BOX_EXIT.fall);
  return [at[0] + (to[0] - at[0]) * s, at[1] + (to[1] - at[1]) * s * s, at[2] + (to[2] - at[2]) * s];
}

/**
 * Where held balls sit in the model (robot frame: forward, up, right; m), one place for each ball
 * the robot can hold, along the path balls take through the CAD from the shooter back to the
 * intake's mouth: the first is the ball next to be shot.
 */
export type Storage = [number, number, number][];

/** A turret and the lane that feeds it: the balls it shoots (if not given, all) and where they wait. */
export interface TurretDef {
  shooter: ShooterSpec;
  kinds?: BallKind[];
  storage: Storage;
}

/** An intake at the back of the robot (a player's robot): it takes balls the robot backs over. */
export interface BackIntake {
  /** How far behind the footprint center its mouth is, m */
  back: number;
  /** How far to each side of the center line it takes balls, m */
  halfWidth: number;
  kinds: BallKind[];
  /** Seconds between balls it takes in */
  interval: number;
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
  /** FTC team number, on the robot's signs (a company's robot: the company's name) */
  number: string;
  teamLogo: string;
  /** Fill around a logo that isn't square-on-white, to match its own background ('transparent' for a round one) */
  logoBackground?: string;
  /**
   * The company that designed the robot, when it isn't a team's: its name, its logo for a light
   * background and its page, which the robot select screen shows as "Robot by" with the logo and
   * opens on a press.
   */
  by?: { name: string; logo: string; url: string };
  /** glTF model made from the team's CAD (tools/convert-robot.mjs), detailed */
  model: string;
  /** The same model simplified further (tools/lighten-model.mjs), for Low graphics */
  lowModel: string;
  /**
   * The robot signs (FTC R402), mounted flat on the outer side plates of the drive base, measured
   * from the model: `at` forward of the footprint center and `y` above the tiles (centers), their
   * size, and how far the plate's outer face is from the robot's center line, m
   */
  sign: RobotSign;
  drive: DriveSpec;
  config: RobotConfig;
  shooter: ShooterSpec;
  /** The balls the main turret shoots, if not all of them */
  shooterKinds?: BallKind[];
  /** Game pieces the (front) intake picks up; it drives over the others */
  intakes: BallKind[];
  /** Forward distance of the intake's mouth from the footprint center, if not at its front edge, m */
  intakeFront?: number;
  /** Seconds between balls the intake takes in, if not the usual 0.35 */
  intakeInterval?: number;
  /** The intake rollers' motor speed, RPM (the team's figure): without `intakeInterval`, it sets how often balls come in */
  intakeRpm?: number;
  /** How far to each side of the center line the intake's mouth takes balls, if not the usual 17 cm, m */
  intakeHalfWidth?: number;
  arm?: ArmSpec;
  lift?: LiftSpec;
  /** Where the main turret's held balls sit */
  storage: Storage;
  /** More turrets, each with its lane: Silver Bullet Blaster's NECTAR one, up to four on a player's robot */
  extraTurrets?: TurretDef[];
  backIntake?: BackIntake;
  /** A robot a player made in the Workshop: what it was made from (robot/custom.ts) */
  custom?: Blueprint;
  /**
   * The robot whose CAD this one was built from (Bobik: WXYZ's Ri3D). Both share a card on the
   * robot select screen, which switches between the two teams' models.
   */
  basedOn?: string;
}

/** A robot's turrets, the main one first. */
export const turretsOf = (def: RobotDefinition): TurretDef[] =>
  [{ shooter: def.shooter, kinds: def.shooterKinds, storage: def.storage }, ...(def.extraTurrets ?? [])];

/** Wheel surface speed: motor RPM / 60 · π · wheel diameter. */
export const wheelSpeed = ({ rpm, wheel }: DriveSpec) => (rpm / 60) * Math.PI * wheel;

const URAN_DRIVE: DriveSpec = { rpm: 518, wheel: 0.082 };
const BUMBLE_V_DRIVE: DriveSpec = { rpm: 522, wheel: 0.096 };
const SILVER_BULLET_DRIVE: DriveSpec = { rpm: 435, wheel: 0.104 };
const SIRIUS_SHADOW_DRIVE: DriveSpec = { rpm: 518, wheel: 0.104 };
const RI3D_DRIVE: DriveSpec = { rpm: 435, wheel: 0.104 };
const MECHATRONICS_DRIVE: DriveSpec = { rpm: 500, wheel: 0.104 };
const DHB_DRIVE: DriveSpec = { rpm: 611, wheel: 0.104 };

export const URAN_V2: RobotDefinition = {
  id: 'uran-v2',
  name: 'URAN V2',
  team: 'URAN92',
  number: '25300',
  teamLogo: 'assets/teams/uran.svg',
  model: 'assets/robots/uran-v2.glb',
  lowModel: 'assets/robots/uran-v2-low.glb',
  // The drive base's outer plates run 26 cm back to 10 cm forward, 1–9 cm above the tiles.
  sign: { at: -0.08, length: 0.32, y: 0.05, height: 0.07, side: 0.15 },
  drive: URAN_DRIVE,
  // Sizes measured from the team CAD (Jedi92.step); the lowered arm sticks out in front.
  config: {
    name: 'URAN V2',
    length: 0.533,
    // The frame up to the front intake wheels: the arm's part of the footprint only collides while it is down.
    frame: { length: 0.44, offset: -0.0465 },
    width: 0.316,
    height: 0.305,
    mass: 9,
    wheelRadius: 0.041,
    // The team's 82 mm mecanum wheels on 518 RPM motors.
    drive: { maxWheelSpeed: wheelSpeed(URAN_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.226, wheelBase: 0.215 },
    // Light and fast: traction allows more acceleration than a heavy robot.
    maxAccel: 6.5,
    maxTurnAccel: 34,
  },
  // Flywheel shooter on a turret (axis measured from the CAD turret ring); balls leave on the side
  // that faces the front of the robot in the CAD. From the opening side of a cell the field allows
  // at most ~2.3 m, so the accuracy scale fits that. The turret turns 200° each way, a little past the back.
  // Rapid fire: all 4 balls in 0.2 s, twice the team's figure of 0.4 s. Its shots fly with frontspin.
  shooter: { at: [-0.0685, 0], height: 0.26, exit: 0.1, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: (200 * Math.PI) / 180, rapidFire: 0.2, spin: 1 },
  // URAN plays POLLEN only: NECTAR stays on the field.
  intakes: ['pollen'],
  // Flower Mode: the U-shaped push-back arm on bearings in front of the intake. Raised it stands
  // up over the intake; lowered it blocks the floor but pushes POLLEN out of the bottom of a FLOWER.
  arm: {
    travel: 0.4,
    upAngle: 1.9,
    box: { x: [0.1735, 0.267], y: [0.025, 0.09] },
    reach: [0.138, 0.158, 0.179, 0.207, 0.231, 0.251, 0.266, 0.275, 0.278, 0.276, 0.267],
  },
  // The intake wheels at the front of the frame, behind the arm; twice as quick as the others.
  intakeFront: 0.1735,
  intakeInterval: 0.175,
  // Under the transfer rollers, from under the turret down the ramp to the intake wheels.
  storage: [[-0.065, 0.119, 0], [0.003, 0.083, 0], [0.078, 0.054, 0], [0.15, 0.048, 0]],
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
  // The drive base's outer plates run 22 cm back to 6 cm forward, 2–9 cm above the tiles.
  sign: { at: -0.08, length: 0.26, y: 0.055, height: 0.065, side: 0.14 },
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
    // Heavier than URAN V2, so a little less acceleration from the same traction.
    maxAccel: 5.8,
    maxTurnAccel: 30,
  },
  // Two flywheels on a turret that turns half a turn each way, 360° in all (the team's figure): the
  // ball is squeezed between the low front wheel and the high back one and leaves forward over the
  // front wheel (camera side).
  // Rapid fire (the team's figure): 4 balls in 0.7 s. Squeezed between the two, a ball flies without spin.
  shooter: { at: [-0.084, 0], height: 0.33, exit: 0.06, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: Math.PI, rapidFire: 0.7, spin: 0 },
  intakes: ['pollen'],
  // The bush-back arm on the front intake axle, driven by a servo.
  // Swinging down, its front end first sweeps forward past the lowered pose, then comes back a little.
  arm: {
    travel: 0.4,
    upAngle: 1.85,
    // In front of the frame the lowered arm lies 4–9 cm above the tiles in the CAD, as low as
    // URAN V2's, so its front bar slides under a FLOWER's middle ring into the retrieval opening.
    box: { x: [0.12, 0.23], y: [0.035, 0.09] },
    reach: [0.106, 0.125, 0.148, 0.175, 0.198, 0.216, 0.23, 0.239, 0.241, 0.238, 0.229],
  },
  // The front rollers sit behind the arm, at the front plate of the frame.
  intakeFront: 0.11,
  // Under the turret's opening, down the channel behind the back roller, over the plate under it
  // and on the tiles at the front rollers.
  storage: [[-0.087, 0.195, 0], [-0.067, 0.108, 0], [0.018, 0.077, 0], [0.095, 0.045, 0]],
};

/**
 * One turret of Silver Bullet Blaster: a flywheel under a curved hood of passive rollers. It turns
 * half a turn each way, 360° in all (the team's figure).
 */
const silverBulletShooter = (right: number): ShooterSpec => ({
  at: [-0.102, right], height: 0.44, exit: 0.05, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: Math.PI,
  // Rapid fire (the team's figure): 4 balls in 1 s.
  rapidFire: 1.0,
  // The hood's rollers turn with the ball, so it leaves with only a little frontspin (the team's word).
  spin: 0.25,
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
  // Low on the side panels, in front of the drive base: they run 27 cm back to 7 cm forward
  // below 10 cm (the corner above is cut off), 3 cm above the tiles.
  sign: { at: -0.1, length: 0.3, y: 0.065, height: 0.065, side: 0.18 },
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
  // the right one NECTAR. Both aim at the HIVE by themselves. Each lane runs from the middle of the
  // front intake back up the ramp to its turret.
  shooter: silverBulletShooter(-0.101),
  shooterKinds: ['pollen'],
  extraTurrets: [{
    shooter: silverBulletShooter(0.102),
    kinds: ['nectar'],
    storage: [[-0.109, 0.28, 0.102], [-0.052, 0.173, 0.068], [0.057, 0.133, 0.042], [0.153, 0.052, 0.047]],
  }],
  intakes: ['pollen', 'nectar'],
  // Flower Mode: the U-shaped arm on the front intake axle, lifted by a servo winch. Lowered it
  // blocks the floor but pushes POLLEN out of the bottom of a FLOWER, like Bumble V's.
  arm: {
    travel: 0.5,
    upAngle: 2.2,
    // From the bar just above the tiles (robots ride 12 mm low on their frame box, so lower would
    // touch the floor) up to 9 cm, as low as URAN V2's: it slides under a FLOWER's middle ring.
    box: { x: [0.182, 0.273], y: [0.025, 0.09] },
    reach: [0.161, 0.19, 0.223, 0.252, 0.274, 0.291, 0.305, 0.31, 0.306, 0.294, 0.273],
  },
  // The front intake wheels stick out past the frame.
  intakeFront: 0.18,
  storage: [[-0.109, 0.28, -0.103], [-0.055, 0.163, -0.092], [0.043, 0.098, -0.045], [0.16, 0.052, -0.036]],
};

/**
 * One turret of Sirius Shadow: a flywheel between two thin Rhino wheels behind the turret's axis,
 * throwing balls out of the back of the turret in the CAD (so the model turns half a turn to face
 * forward, plus the few degrees `cadYaw` the turret stands turned in the CAD, measured from its
 * flywheel's axle). Its servos turn it through gears half a turn each way: all 360° (the team's figure).
 */
const siriusShadowShooter = (forward: number, cadYaw: number): ShooterSpec => ({
  at: [forward, 0.002], height: 0.31, exit: 0.07, sweetSpot: 1.0, maxRange: 2.2, modelYaw: Math.PI + cadYaw, turretLimit: Math.PI,
  // Rapid fire (the team's figure): 4 balls in 0.4 s, with frontspin.
  rapidFire: 0.4,
  spin: 1,
});

export const SIRIUS_SHADOW: RobotDefinition = {
  id: 'sirius-shadow',
  name: 'Sirius Shadow',
  team: 'Mooneye',
  number: '32635',
  teamLogo: 'assets/teams/mooneye.png',
  logoBackground: 'transparent',
  model: 'assets/robots/sirius-shadow.glb',
  lowModel: 'assets/robots/sirius-shadow-low.glb',
  // Over the team's number plates in the CAD, on the outer side plates of the drive base: 11 cm
  // back to 6 cm forward, 3–10 cm above the tiles, 16 cm out from the center line.
  sign: { at: -0.026, length: 0.18, y: 0.064, height: 0.084, side: 0.16 },
  drive: SIRIUS_SHADOW_DRIVE,
  // Sizes measured from the team CAD (67.step): a 38 × 30 cm frame, with the intake wheels 3 cm out in front.
  config: {
    name: 'Sirius Shadow',
    length: 0.413,
    width: 0.3,
    height: 0.294,
    mass: 9,
    wheelRadius: 0.052,
    // 104 mm mecanum wheels on 518 RPM motors: 2.82 m/s in theory, 2.4–2.5 m/s on the field (the
    // team's figures). Under load the motors turn about 8% below their free speed, besides the
    // battery's sag, so its top speed comes out at 2.48 m/s (2.40 with the flywheels running).
    drive: { maxWheelSpeed: wheelSpeed(SIRIUS_SHADOW_DRIVE) * 0.92, strafeEfficiency: 0.85, trackWidth: 0.252, wheelBase: 0.224 },
    // As light as URAN V2, on a longer wheelbase.
    maxAccel: 6.5,
    maxTurnAccel: 32,
  },
  // Two turrets one behind the other on the center line: the back one shoots POLLEN, the front one
  // NECTAR. The intake sorts them by size: NECTAR is too big to drop between two rails behind the
  // intake wheels and rides up them into the front turret; POLLEN drops between them onto the
  // center ramp, which carries it back and up into the back turret.
  // The back turret stands 5.8° round in the CAD, the front one 9.0°.
  shooter: siriusShadowShooter(-0.085, (5.8 * Math.PI) / 180),
  shooterKinds: ['pollen'],
  extraTurrets: [{
    shooter: siriusShadowShooter(0.103, (9.0 * Math.PI) / 180),
    kinds: ['nectar'],
    // Up the rails from the intake's mouth, where two NECTAR fit side by side.
    storage: [[0.118, 0.217, 0.007], [0.108, 0.128, -0.027], [0.165, 0.048, 0.03], [0.21, 0.048, -0.05]],
  }],
  intakes: ['pollen', 'nectar'],
  // Moosetake wheels across the front with a gecko wheel standing at each corner that turns balls
  // in: it takes balls across the whole front, but not from beside the robot.
  intakeHalfWidth: 0.15,
  // Under the back turret, down the steep end of the ramp and along it to the intake's mouth.
  storage: [[-0.075, 0.21, 0.003], [-0.065, 0.12, 0.003], [0.05, 0.072, 0.003], [0.17, 0.04, 0.003]],
};

/**
 * WXYZ's Ri3D robot (Robot in 3 Days, 2026–27), the CAD that RoboRangers built Bobik from: the
 * same figures (WXYZ's) and, but for the back, the same model. WXYZ's has four linear slides there.
 */
export const WXYZ_RI3D: RobotDefinition = {
  id: 'wxyz-ri3d',
  name: 'Ri3D',
  team: 'WXYZ',
  number: '19705',
  teamLogo: 'assets/teams/wxyz.png',
  logoBackground: '#000000',
  model: 'assets/robots/wxyz-ri3d.glb',
  lowModel: 'assets/robots/wxyz-ri3d-low.glb',
  // On the outer side plates of the box frame, over the wheels: 25 cm back to 10 cm forward, 1–9 cm
  // above the tiles.
  sign: { at: -0.076, length: 0.3, y: 0.047, height: 0.065, side: 0.164 },
  drive: RI3D_DRIVE,
  // Sizes measured from the team CAD (19705 2026-27 Ri3D.step): a 36 × 33 cm box frame with the
  // intake 6 cm out in front, the lowered arm 9 cm past that, and the slides 44 cm high at the back.
  config: {
    name: 'Ri3D',
    length: 0.506,
    // Up to the front of the intake: the arm's part of the footprint only collides while it is down.
    frame: { length: 0.417, offset: -0.0445 },
    width: 0.332,
    height: 0.443,
    mass: 9,
    wheelRadius: 0.052,
    // 104 mm mecanum wheels at 435 RPM (the team's figures).
    drive: { maxWheelSpeed: wheelSpeed(RI3D_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.26, wheelBase: 0.239 },
    // As light as Sirius Shadow, on a frame of much its size.
    maxAccel: 6.5,
    maxTurnAccel: 32,
  },
  // One turret that turns 135° each way, 270° in all (the team's figures). A flywheel low at the
  // front and a roller high at the back squeeze the ball between them as it comes up through the
  // turret's ring and throw it forward, so it flies without spin. Rapid fire (the team's figure):
  // 4 balls in 0.3 s.
  shooter: { at: [-0.059, 0], height: 0.33, exit: 0.02, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: (135 * Math.PI) / 180, rapidFire: 0.3, spin: 0 },
  // The channel up to the turret is 7.4 cm wide: POLLEN only.
  intakes: ['pollen'],
  // Flower Mode (push back): two side plates on the frame's front corners with a plate across their
  // ends. Raised it stands out in front of the intake with the plate high enough for balls to roll
  // under; lowered, 50° down, the plate lies 2–4 cm over the tiles, over a FLOWER's bottom ring, and
  // the POLLEN it pulls out waits on it.
  arm: {
    travel: 0.4,
    upAngle: 0.873,
    box: { x: [0.165, 0.254], y: [0.025, 0.064] },
    reach: [0.224, 0.232, 0.238, 0.244, 0.248, 0.252, 0.254, 0.256, 0.256, 0.256, 0.254],
    // From just over a NECTAR (9.2 cm): a ball rolls under it to the frame, which pushes it.
    raisedBox: { x: [0.165, 0.224], y: [0.095, 0.15] },
    pocketLift: 0.025,
  },
  // Rubber wheels across the whole front on the first of four roller shafts, all on one motor at
  // 2000 RPM (the team's figure).
  intakeFront: 0.16,
  intakeHalfWidth: 0.15,
  intakeRpm: 2000,
  // Under the rollers: in the turret's ring, up the curved channel, over the ramp and at the front shaft.
  storage: [[-0.068, 0.26, 0], [-0.032, 0.158, 0], [0.037, 0.075, 0], [0.14, 0.043, 0]],
};

/**
 * Bobik: RoboRangers' build of WXYZ's Ri3D, with WXYZ's figures. Its back is closed with plates where
 * WXYZ's has slides, so it is lower and 2 mm longer (RoboRangers-Robotv2.step).
 */
export const BOBIK: RobotDefinition = {
  ...WXYZ_RI3D,
  id: 'bobik',
  name: 'Bobik',
  team: 'RoboRangers',
  number: '25590',
  teamLogo: 'assets/teams/roborangers.png',
  logoBackground: '#111111',
  model: 'assets/robots/bobik.glb',
  lowModel: 'assets/robots/bobik-low.glb',
  config: { ...WXYZ_RI3D.config, name: 'Bobik', length: 0.508, frame: { length: 0.419, offset: -0.0445 }, height: 0.367 },
  basedOn: WXYZ_RI3D.id,
};

export const MECHATRONICS: RobotDefinition = {
  id: 'mechatronics',
  name: 'Mechatronics',
  team: 'Mechatronics',
  number: '13368',
  teamLogo: 'assets/teams/mechatronics.png',
  logoBackground: '#2d4174',
  model: 'assets/robots/mechatronics.glb',
  lowModel: 'assets/robots/mechatronics-low.glb',
  // In the holders of the team's number plates (left out of the model) above the wheels: 16 cm back
  // to 1 cm forward, 11–18 cm above the tiles.
  sign: { at: -0.074, length: 0.168, y: 0.145, height: 0.064, side: 0.108 },
  drive: MECHATRONICS_DRIVE,
  // Sizes measured from the team CAD (ROBOT 13368.step): a 39 × 29 cm frame with the intake's
  // flexible stars 4 cm out in front.
  config: {
    name: 'Mechatronics',
    length: 0.429,
    width: 0.293,
    height: 0.354,
    // An estimate: the team gave no weight.
    mass: 11,
    wheelRadius: 0.052,
    // 104 mm mecanum wheels at ~500 RPM (the team's figure), on a wide, short wheelbase.
    drive: { maxWheelSpeed: wheelSpeed(MECHATRONICS_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.242, wheelBase: 0.156 },
    // As heavy as Bumble V.
    maxAccel: 5.8,
    maxTurnAccel: 30,
  },
  // One turret on a ring bearing, turned by two servos 135° each way, 270° in all (the team's
  // figure). A 72 mm wheel at its front, one motor on each side and weighted to 800 g (the team's
  // figure), throws the ball up along the hood behind it and forward over its top: under the hood
  // the ball rolls, so it flies with backspin. Rapid fire 4 balls in 0.5 s is an estimate.
  shooter: { at: [-0.026, 0], height: 0.32, exit: 0.03, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: (135 * Math.PI) / 180, rapidFire: 0.5, spin: -1, flywheelMass: 0.8 },
  // The hood leaves room for a POLLEN only.
  intakes: ['pollen'],
  // Three flexible stars on the front shaft with a vectored wheel at each end that turns balls in.
  intakeHalfWidth: 0.14,
  // Against the flywheel, under the turret's ring, on the curved ramp and at the stars.
  storage: [[-0.015, 0.25, 0], [-0.022, 0.158, 0], [0.033, 0.077, 0], [0.15, 0.044, 0]],
};

export const DHB: RobotDefinition = {
  id: 'dhb',
  name: 'DHB',
  team: 'MLP',
  number: '19163',
  teamLogo: 'assets/teams/mlp.png',
  logoBackground: '#000000',
  model: 'assets/robots/dhb.glb',
  lowModel: 'assets/robots/dhb-low.glb',
  // On the outer side plates over the wheels: 24 cm back to 6 cm forward, 1–11 cm above the tiles.
  sign: { at: -0.092, length: 0.28, y: 0.06, height: 0.08, side: 0.163 },
  drive: DHB_DRIVE,
  // Sizes measured from the team CAD (iu.step): a 32 × 30 cm frame with the intake 8 cm out in
  // front, 34 cm wide across the guides at its corners, and the lowered arm 11 cm past the intake.
  config: {
    name: 'DHB',
    length: 0.489,
    // Up to the front of the intake: the arm's part of the footprint only collides while it is down.
    frame: { length: 0.3835, offset: -0.0528 },
    width: 0.34,
    height: 0.307,
    mass: 11.5,
    wheelRadius: 0.052,
    // 104 mm mecanum wheels at 611 RPM (the team's figure), each turned by its motor through an
    // 11:110 helical gear: the fastest robot, 3.3 m/s.
    drive: { maxWheelSpeed: wheelSpeed(DHB_DRIVE), strafeEfficiency: 0.85, trackWidth: 0.276, wheelBase: 0.196 },
    // A little heavier than Bumble V.
    maxAccel: 5.6,
    maxTurnAccel: 29,
  },
  // One turret on a 79-tooth ring gear, turned by two servos through the gear behind it 135° each
  // way, 270° in all (the team's figures). A 3" flex wheel low at its front and three 1.625" ones
  // high at its back, each on its own motor, squeeze the ball as it comes up through the ring and
  // throw it up and forward between them, so it flies without spin. Rapid fire (the team's figure):
  // 4 balls in 0.5 s.
  shooter: { at: [-0.118, 0], height: 0.27, exit: 0.01, sweetSpot: 1.0, maxRange: 2.2, modelYaw: 0, turretLimit: (135 * Math.PI) / 180, rapidFire: 0.5, spin: 0 },
  // The channel up to the turret is 7.6 cm wide: POLLEN only.
  intakes: ['pollen'],
  // Flower Mode: the U-shaped push-back arm on the front intake shaft, lifted by two servos. Raised
  // it leans back over the intake; lowered, its cross plate lies 1–3 cm over the tiles, low enough
  // to go under a FLOWER's middle ring, and the POLLEN it pulls out waits on it.
  arm: {
    travel: 0.4,
    upAngle: 2.2,
    box: { x: [0.139, 0.2445], y: [0.025, 0.09] },
    reach: [0.129, 0.151, 0.17, 0.188, 0.216, 0.239, 0.255, 0.264, 0.265, 0.259, 0.245],
    pocketLift: 0.03,
  },
  // 72 mm wheels across the front shaft, with guides at the corners that turn balls in; the
  // intake's motor turns at 1800 RPM (the team's figure).
  intakeFront: 0.139,
  intakeHalfWidth: 0.15,
  intakeRpm: 1800,
  // Under the flywheels in the turret's ring, up the curved ramp, on its foot and at the front shaft.
  storage: [[-0.118, 0.21, 0], [-0.073, 0.114, 0], [0.032, 0.083, 0], [0.125, 0.036, 0]],
};

// New robots go at the end: snapshots name a robot by its place in this list, with the 8th place
// reserved (TEAM_IDS in sim/stateCodec.ts). URAN V2 took URAN V1's place, so older apps show it as their V1.
export const ROBOTS: RobotDefinition[] = [URAN_V2, BUMBLE_V, SILVER_BULLET_BLASTER, SIRIUS_SHADOW, BOBIK, WXYZ_RI3D, MECHATRONICS, DHB];
export const DEFAULT_ROBOT_ID = URAN_V2.id;

/**
 * Robots players made in the Workshop (robot/custom.ts): their own (`custom-…`, saved in this
 * browser) and other players' in an online room (`x-…`, named by their blueprint). `custom` stands
 * for one this game doesn't have, e.g. in a replay or in the statistics.
 */
export const CUSTOM_ROBOT = 'custom';
export const isCustomRobotId = (id: unknown): id is string =>
  typeof id === 'string' && (id === CUSTOM_ROBOT || /^(custom|x)-[a-z0-9]{4,16}$/.test(id));

const customRobots = new Map<string, RobotDefinition>();

/** A player-made robot joins the game (or replaces its older version). */
export function addCustomRobot(def: RobotDefinition): void {
  customRobots.set(def.id, def);
}

export function removeCustomRobot(id: string): void {
  customRobots.delete(id);
}

/** A robot with its team, as rooms and the start screen show it: 'URAN92 · URAN V2' (a player's own robot without a team: its name). */
export const robotTitle = (def: RobotDefinition): string => (def.team === def.name ? def.name : `${def.team} · ${def.name}`);

export function robotById(id: string | undefined): RobotDefinition {
  const team = ROBOTS.find(r => r.id === id);
  if (team || !isCustomRobotId(id)) return team ?? URAN_V2;
  return customRobots.get(id) ?? customRobots.get(CUSTOM_ROBOT) ?? URAN_V2;
}
