// Shot planning for the auto-aiming shooter.

export const GRAVITY = 9.81;
/** Air density, kg/m³ */
const AIR_DENSITY = 1.2;
/** A spinning shot's flight is followed in physics steps (Simulation's), s */
const FLIGHT_STEP = 1 / 120;

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
 * The Magnus force on a ball of `radius` and `mass` flying at `speed` and spinning at `w` rad/s
 * about an axis across its path: its acceleration across the path, m/s². Lift coefficient
 * S / (2S + 1) of the spin factor S = r w / v: a third for a ball turning as if it rolled through
 * the air, half that at a quarter of the spin.
 */
export function magnusAccel(speed: number, w: number, radius: number, mass: number): number {
  if (speed < 1e-3 || w === 0) return 0;
  const s = (radius * Math.abs(w)) / speed;
  return (0.5 * AIR_DENSITY * Math.PI * radius * radius * (s / (2 * s + 1)) * speed * speed) / mass;
}

/** How a shot spins (ShooterSpec.spin) and how the air slows the ball (BallSim). */
export interface ShotSpin {
  /** Spin as a fraction of rolling (r ω / v): + frontspin, its top turning forward; − backspin */
  spin: number;
  radius: number;
  mass: number;
  /** Linear and angular damping of the ball in the air, 1/s */
  damping: number;
  spinDamping: number;
}

/**
 * Height and time at which a spinning ball launched at (vh forward, vy up) has flown `distance`,
 * followed step by step as BallSim flies it: frontspin bends its path down, backspin up. Null if
 * it never gets that far.
 */
function spinningFlight(distance: number, vh: number, vy: number, s: ShotSpin): { height: number; time: number } | null {
  let [x, y, vx, vz, t] = [0, 0, vh, vy, 0];
  let w = (s.spin * Math.hypot(vh, vy)) / s.radius;
  while (t < 4) {
    const speed = Math.hypot(vx, vz);
    // Across the path, (vz, −vx) / v for frontspin: below it.
    const a = (Math.sign(w) * magnusAccel(speed, w, s.radius, s.mass)) / Math.max(speed, 1e-3);
    [vx, vz] = [vx + a * vz * FLIGHT_STEP, vz + (-a * vx - GRAVITY) * FLIGHT_STEP];
    vx /= 1 + FLIGHT_STEP * s.damping;
    vz /= 1 + FLIGHT_STEP * s.damping;
    w /= 1 + FLIGHT_STEP * s.spinDamping;
    const [px, py] = [x, y];
    x += vx * FLIGHT_STEP;
    y += vz * FLIGHT_STEP;
    t += FLIGHT_STEP;
    if (x >= distance) {
      const f = (distance - px) / (x - px);
      return { height: py + (y - py) * f, time: t - (1 - f) * FLIGHT_STEP };
    }
    if (vx <= 0 || y < -2) return null;
  }
  return null;
}

/**
 * Lob that arrives at `target` descending at `descent` radians below horizontal.
 * `robotVel` (x, z) is subtracted so the ball still hits while the robot is moving.
 *
 * With horizontal distance d and height h, a parabola through the target with slope -tan(descent)
 * there needs flight time T = sqrt(2 (h + d tan(descent)) / g).
 *
 * A spinning ball (`spin`) leaves at the same angle, as fast as it takes to still pass through the
 * target (faster with frontspin, which bends it down and makes it drop in more steeply).
 */
export function solveShot(
  launch: [number, number, number],
  target: [number, number, number],
  descent: number,
  robotVel: [number, number] = [0, 0],
  spin?: ShotSpin,
): ShotSolution {
  const dx = target[0] - launch[0];
  const dz = target[2] - launch[2];
  const h = target[1] - launch[1];
  const d = Math.max(Math.hypot(dx, dz), 0.05);
  let T = Math.sqrt((2 * Math.max(h + d * Math.tan(descent), 0.05)) / GRAVITY);
  let vh = d / T;
  let vy = h / T + (GRAVITY * T) / 2;
  if (spin?.spin) {
    // Secant on the speed: the height the ball passes the target at, against the target's.
    const miss = (k: number) => {
      const f = spinningFlight(d, vh * k, vy * k, spin);
      return f ? { k, off: f.height - h, time: f.time } : { k, off: -2, time: T };
    };
    let [a, b] = [miss(1), miss(1.03)];
    for (let i = 0; i < 8 && Math.abs(b.off) > 0.0005 && b.off !== a.off; i++) {
      const k = Math.max(0.5, Math.min(2, b.k - (b.off * (b.k - a.k)) / (b.off - a.off)));
      [a, b] = [b, miss(k)];
    }
    [vh, vy, T] = [vh * b.k, vy * b.k, b.time];
  }
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
