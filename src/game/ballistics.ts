// Shot planning for the auto-aiming shooter.

export const GRAVITY = 9.81;

export interface ShotSolution {
  /** World yaw of the launch direction (0 = +X, CCW positive, same convention as the robot) */
  yaw: number;
  /** Launch elevation above horizontal, rad */
  pitch: number;
  /** Launch speed relative to the shooter (robot motion already compensated), m/s */
  speed: number;
  /** Time of flight, s */
  time: number;
  /** Horizontal distance to the target, m */
  distance: number;
}

/**
 * Lob that arrives at `target` descending at `descent` radians below horizontal.
 * `robotVel` (x, z) is subtracted so the ball still hits while the robot is moving.
 *
 * With horizontal distance d and height h, a parabola through the target with slope -tan(descent)
 * there needs flight time T = sqrt(2 (h + d tan(descent)) / g).
 */
export function solveShot(
  launch: [number, number, number],
  target: [number, number, number],
  descent: number,
  robotVel: [number, number] = [0, 0],
): ShotSolution {
  const dx = target[0] - launch[0];
  const dz = target[2] - launch[2];
  const h = target[1] - launch[1];
  const d = Math.max(Math.hypot(dx, dz), 0.05);
  const T = Math.sqrt((2 * Math.max(h + d * Math.tan(descent), 0.05)) / GRAVITY);
  const vh = d / T;
  const vy = h / T + (GRAVITY * T) / 2;
  // Required world velocity minus what the robot already gives the ball.
  const vx = (dx / d) * vh - robotVel[0];
  const vz = (dz / d) * vh - robotVel[1];
  const horiz = Math.hypot(vx, vz);
  return {
    yaw: Math.atan2(-vz, vx),
    pitch: Math.atan2(vy, horiz),
    speed: Math.hypot(horiz, vy),
    time: T,
    distance: d,
  };
}

/** Launch velocity vector (world) for a yaw/pitch/speed. */
export function launchVelocity(yaw: number, pitch: number, speed: number): [number, number, number] {
  const horiz = Math.cos(pitch) * speed;
  return [Math.cos(yaw) * horiz, Math.sin(pitch) * speed, -Math.sin(yaw) * horiz];
}
