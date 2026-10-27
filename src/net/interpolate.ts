// Smooth rendering between network snapshots (30 per second) at 60+ fps.

import type { RobotState, WorldState } from '../sim/state';

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function lerpAngle(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

function lerpRobot(a: RobotState, b: RobotState, k: number): RobotState {
  return {
    ...b,
    x: lerp(a.x, b.x, k),
    z: lerp(a.z, b.z, k),
    yaw: lerpAngle(a.yaw, b.yaw, k),
    heading: lerpAngle(a.heading, b.heading, k),
    // The turret stays within ±180° and unwinds through 0, so no wrap-around here.
    turretYaw: lerp(a.turretYaw, b.turretYaw, k),
    pitch: lerp(a.pitch, b.pitch, k),
    flywheel: lerp(a.flywheel, b.flywheel, k),
  };
}

/** State between snapshots `a` and `b` (k = 0 → a, k = 1 → b). */
export function lerpState(a: WorldState, b: WorldState, k: number): WorldState {
  const transforms = new Float32Array(b.balls.transforms);
  const ta = a.balls.transforms;
  for (let i = 0; i < b.balls.states.length; i++) {
    // Only blend balls that stayed in play; a ball that was just shot or picked up jumps.
    if (a.balls.states[i] !== 0 || b.balls.states[i] !== 0) continue;
    const o = i * 7;
    for (let c = 0; c < 3; c++) transforms[o + c] = lerp(ta[o + c], transforms[o + c], k);
    // Quaternion nlerp along the shorter arc.
    const sign = ta[o + 3] * transforms[o + 3] + ta[o + 4] * transforms[o + 4] + ta[o + 5] * transforms[o + 5] + ta[o + 6] * transforms[o + 6] < 0 ? -1 : 1;
    for (let c = 3; c < 7; c++) transforms[o + c] = lerp(ta[o + c] * sign, transforms[o + c], k);
  }
  return {
    ...b,
    time: lerp(a.time, b.time, k),
    hiveAngles: { red: lerp(a.hiveAngles.red, b.hiveAngles.red, k), blue: lerp(a.hiveAngles.blue, b.hiveAngles.blue, k) },
    robots: b.robots.map(rb => {
      const ra = a.robots.find(r => r.slot === rb.slot);
      return ra ? lerpRobot(ra, rb, k) : rb;
    }),
    balls: { states: b.balls.states, transforms },
  };
}

/**
 * Keeps recent snapshots and estimates the server clock, then renders slightly in the past so
 * there is almost always a newer snapshot to blend toward. How far back follows how evenly
 * snapshots arrive: close behind on a steady connection, further back when they come in bursts
 * (a busy server or Wi-Fi), so motion stays smooth instead of freezing and jumping.
 */
export const INTERPOLATION_DELAY = 0.1;
const MIN_DELAY = 0.07;
const MAX_DELAY = 0.3;
/** Arrival gaps remembered for the estimate */
const GAP_WINDOW = 90;

export class SnapshotBuffer {
  private readonly snaps: WorldState[] = [];
  /** server time − local time, seconds */
  private offset: number | null = null;
  private delay = INTERPOLATION_DELAY;
  private readonly gaps: number[] = [];
  private lastArrival: number | null = null;

  push(s: WorldState, localNow: number): void {
    if (this.lastArrival !== null) {
      this.gaps.push(localNow - this.lastArrival);
      if (this.gaps.length > GAP_WINDOW) this.gaps.shift();
      if (this.gaps.length >= 20) this.delay += (this.targetDelay() - this.delay) * 0.05;
    }
    this.lastArrival = localNow;
    const sample = s.time - localNow;
    if (this.offset === null || Math.abs(sample - this.offset) > 0.5) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.05;
    // Snapshots arrive in order over a WebSocket, but a restarted game resets the clock.
    if (this.snaps.length && s.time < this.snaps[this.snaps.length - 1].time) this.snaps.length = 0;
    this.snaps.push(s);
    if (this.snaps.length > 60) this.snaps.shift();
  }

  clear(): void {
    this.snaps.length = 0;
    this.offset = null;
    this.gaps.length = 0;
    this.lastArrival = null;
    this.delay = INTERPOLATION_DELAY;
  }

  /** Long enough to cover nearly every gap between snapshots. */
  private targetDelay(): number {
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return Math.min(MAX_DELAY, Math.max(MIN_DELAY, p95 + 0.02));
  }

  sample(localNow: number): WorldState | null {
    if (!this.snaps.length || this.offset === null) return null;
    const t = localNow + this.offset - this.delay;
    const last = this.snaps[this.snaps.length - 1];
    if (t >= last.time) return last;
    for (let i = this.snaps.length - 2; i >= 0; i--) {
      const a = this.snaps[i];
      if (a.time <= t) {
        const b = this.snaps[i + 1];
        return lerpState(a, b, (t - a.time) / Math.max(b.time - a.time, 1e-6));
      }
    }
    return this.snaps[0];
  }
}
