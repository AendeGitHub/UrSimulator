// What the AI driver knows about the field: which balls it can pick up, which FLOWERs it can empty,
// where to shoot from and how to drive around the HIVE frame. Shared by the teacher (teacher.ts)
// and the network's inputs (features.ts), so both see the field the same way.

import { cellFrame, upCell } from '../field/hiveGeometry';
import { FLOWER_VOLUME } from '../field/zones';
import { wrapAngle } from '../robot/mecanum';
import { robotById } from '../robot/robots';
import type { Ball } from '../sim/BallSim';
import type { PlayerRobot, Simulation } from '../sim/Simulation';

export type XZ = [number, number];
type Box = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Ideal distance from the cell opening to shoot from: inside every robot's sweet spot, m */
export const SHOOT_DISTANCE = 1.0;
/** The nearest good spot to shoot from: this far from the opening, at most this far off its axis */
const SHOOT_ZONE = { near: 0.85, far: 1.15, angle: (35 * Math.PI) / 180 };
/** A FLOWER's tube (Mechanisms FLOWER_TUBE) */
const FLOWER_TUBE = { radius: 0.09, height: 0.62 };
/** A ball on the floor (higher ones sit in a FLOWER, a cell or on a robot) */
const FLOOR_HEIGHT = 0.12;
/** FLOWER tubes keep their POLLEN out of an intake's reach */
const FLOWER_KEEP_OUT = 0.13;
/** Margin added around the HIVE frame for a robot's half diagonal when planning a path, m */
const FRAME_MARGIN = 0.45;
/**
 * In a 2 vs 2, partners split the field: a ball or a FLOWER nearer (by `margin` m) to the partner
 * costs `ball` / `flower` more (it's theirs), and they stand `room` m apart to shoot and wait.
 */
const PARTNER = { margin: 0.15, ball: 1, flower: 1.5, room: 0.55 };
/** Seconds of AUTO and TELEOP for the time-left input */
export const AUTO_TIME = 30;
export const TELEOP_TIME = 120;

export const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function robotXZ(p: PlayerRobot): XZ {
  const [x, , z] = p.robot.position;
  return [x, z];
}

/** A world point in the robot's own frame: [forward, right]. Yaw 0 faces +X, right is +Z. */
export function toRobot(p: PlayerRobot, point: XZ): XZ {
  const [x, z] = robotXZ(p);
  return rotateToRobot(p.robot.yaw, [point[0] - x, point[1] - z]);
}

/** A world direction or velocity in a frame turned by `yaw`: [forward, right]. */
export function rotateToRobot(yaw: number, [dx, dz]: XZ): XZ {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Yaw that faces from `from` toward `to`. */
export const yawToward = (from: XZ, to: XZ) => Math.atan2(-(to[1] - from[1]), to[0] - from[0]);

/** +1 for red, -1 for blue: the field turned 180° looks the same from the other alliance. */
export const allianceSign = (p: PlayerRobot) => (p.robot.alliance === 'red' ? 1 : -1);

/** Clearly on this robot's own half of the field (where it may take balls during AUTO, G402). */
export const ownHalf = (p: PlayerRobot, [x]: XZ) => x * allianceSign(p) < -0.2;

/** The other alliance's robot nearest to this one (in a 2 vs 2 the one it has to mind most). */
export const opponentOf = (sim: Simulation, p: PlayerRobot): PlayerRobot | null => nearestRobot(sim, p, q => q.robot.alliance !== p.robot.alliance);

/** Its partner in a 2 vs 2: the other robot of its alliance. */
export const partnerOf = (sim: Simulation, p: PlayerRobot): PlayerRobot | null => nearestRobot(sim, p, q => q.robot.alliance === p.robot.alliance);

/** The partner is nearer to `point` than this robot (by a margin): in a 2 vs 2 that's their part of the field. */
const partnersPoint = (p: PlayerRobot, partner: PlayerRobot | null, point: XZ): boolean =>
  !!partner && dist(robotXZ(partner), point) + PARTNER.margin < dist(robotXZ(p), point);

/**
 * A spot for this robot that its partner may already hold (to wait): the partner nearer to it
 * keeps it, and this one stands `room` m along z from it, on its own side (or the free one).
 */
function besidePartner(p: PlayerRobot, partner: PlayerRobot | null, spot: XZ, limit: number): XZ {
  if (!partner || dist(robotXZ(partner), spot) > PARTNER.room || !partnersPoint(p, partner, spot)) return spot;
  const side = robotXZ(p)[1] >= robotXZ(partner)[1] ? 1 : -1;
  const z = Math.abs(spot[1] + side * PARTNER.room) <= limit ? spot[1] + side * PARTNER.room : spot[1] - side * PARTNER.room;
  return [spot[0], z];
}

/** The robot nearest to this one, of either alliance unless `which` says. */
export function nearestRobot(sim: Simulation, p: PlayerRobot, which: (q: PlayerRobot) => boolean = () => true): PlayerRobot | null {
  const at = robotXZ(p);
  let best: PlayerRobot | null = null;
  let bestDist = Infinity;
  for (const q of sim.robots.values()) {
    if (q === p || !which(q)) continue;
    const d = dist(at, robotXZ(q));
    if (d < bestDist) {
      best = q;
      bestDist = d;
    }
  }
  return best;
}

export const insideBox = ([x, z]: XZ, b: Box) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;

/** The HIVE frame's footprint, grown by `margin` (by default room for a robot's half diagonal). */
export function frameBox(sim: Simulation, margin = FRAME_MARGIN): Box {
  const b = sim.frameBox ?? { minX: -0.66, maxX: 0.66, minZ: -0.51, maxZ: 0.51 };
  return { minX: b.minX - margin, maxX: b.maxX + margin, minZ: b.minZ - margin, maxZ: b.maxZ + margin };
}

/** Does the segment a→b pass through the box? (slab test) */
function segmentHitsBox(a: XZ, b: XZ, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [p, d, lo, hi] of [[a[0], b[0] - a[0], box.minX, box.maxX], [a[1], b[1] - a[1], box.minZ, box.maxZ]]) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let ta = (lo - p) / d;
    let tb = (hi - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Next point to drive to on the way to `goal`: the goal itself, or the corner of the HIVE frame to go
 * round. `ownSide` keeps the detour on the robot's own half (AUTO).
 */
export function nextWaypoint(sim: Simulation, p: PlayerRobot, goal: XZ, ownSide = false): { point: XZ; length: number } {
  const from = robotXZ(p);
  const box = frameBox(sim);
  const inner = frameBox(sim, FRAME_MARGIN - 0.05);
  // Robots fit under the HIVEs (over the frame's base), but it is a trap of frame posts: get out
  // first, through the open long sides if it is right under them.
  if (insideBox(from, inner) && !insideBox(goal, frameBox(sim, FRAME_MARGIN + 0.1))) {
    const under = insideBox(from, frameBox(sim, 0));
    const exits: XZ[] = [[from[0], box.minZ - 0.03], [from[0], box.maxZ + 0.03]];
    if (!under) exits.push([box.minX - 0.03, from[1]], [box.maxX + 0.03, from[1]]);
    let exit = exits[0];
    for (const e of exits) if (dist(from, e) + 0.3 * dist(e, goal) < dist(from, exit) + 0.3 * dist(exit, goal)) exit = e;
    return { point: exit, length: dist(from, exit) + dist(exit, goal) };
  }
  if (!segmentHitsBox(from, goal, inner)) return { point: goal, length: dist(from, goal) };
  const corners: XZ[] = [[box.minX, box.minZ], [box.minX, box.maxZ], [box.maxX, box.minZ], [box.maxX, box.maxZ]];
  let best: XZ = goal;
  let bestLength = Infinity;
  for (const c of corners) {
    if (ownSide && !ownHalf(p, c)) continue;
    if (segmentHitsBox(from, c, inner)) continue;
    // From a corner the goal may still be behind the box: then it is two corners away.
    const length = dist(from, c) + (segmentHitsBox(c, goal, inner) ? 1.5 : 0) + dist(c, goal);
    if (length < bestLength) {
      best = c;
      bestLength = length;
    }
  }
  if (bestLength === Infinity) return { point: goal, length: dist(from, goal) + 2 };
  return { point: best, length: bestLength };
}

/** Balls this robot's intake can take right now. */
export function pickableBalls(sim: Simulation, p: PlayerRobot): Ball[] {
  const def = robotById(p.robotId);
  // NECTAR a lift's box takes is for FLOWERs, which the AI doesn't score:
  // it goes for what it shoots.
  const kinds = def.lift ? def.intakes.filter(k => k !== 'nectar') : def.intakes;
  const wall = sim.zones.wall - 0.03;
  const box = frameBox(sim, 0.08);
  return sim.balls.all.filter(b => {
    if (b.state !== 'field' || !kinds.includes(b.kind)) return false;
    // The opponent's NECTAR is theirs (G408).
    if (b.kind === 'nectar' && b.color !== p.robot.alliance) return false;
    const [x, y, z] = sim.balls.position(b);
    if (y > FLOOR_HEIGHT || Math.abs(x) > wall || Math.abs(z) > wall) return false;
    if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) return false;
    return !sim.zones.flowers.some(f => dist(f, [x, z]) < FLOWER_KEEP_OUT);
  });
}

/**
 * How hard a ball is to get: path length, plus turning toward it, plus an opponent next to it, plus
 * a partner nearer to it (2 vs 2).
 */
export function ballCost(sim: Simulation, p: PlayerRobot, b: Ball, opponent: PlayerRobot | null, partner: PlayerRobot | null = null): number {
  const [x, , z] = sim.balls.position(b);
  const at: XZ = [x, z];
  const auto = sim.match.period === 'auto';
  if (auto && !ownHalf(p, at)) return Infinity;
  const { length } = nextWaypoint(sim, p, at, auto);
  const turn = Math.abs(wrapAngle(yawToward(robotXZ(p), at) - p.robot.yaw));
  const contested = opponent ? Math.max(0, 0.6 - dist(robotXZ(opponent), at)) * 2 : 0;
  return length + turn * 0.15 + contested + (partnersPoint(p, partner, at) ? PARTNER.ball : 0);
}

export interface ShotPlan {
  /** The cell opening, on the floor (x, z) */
  aim: XZ;
  /** Horizontal direction the opening faces */
  facing: XZ;
  /** Where to stand */
  spot: XZ;
}

/**
 * Where to shoot into this robot's HIVE from: in front of the upward cell's opening, straight out or
 * (`nearest`) the closest point of the zone it shoots well from, round the zone from a partner
 * nearer to the HIVE (2 vs 2).
 */
export function shotPlan(sim: Simulation, p: PlayerRobot, nearest = false, partner: PlayerRobot | null = null): ShotPlan {
  const hive = sim.hives[p.robot.alliance];
  const target = hive.target();
  const { u } = cellFrame(p.robot.alliance, upCell(hive.state), hive.pivot, hive.angle);
  const len = Math.hypot(u[0], u[2]) || 1;
  const facing: XZ = [u[0] / len, u[2] / len];
  const aim: XZ = [target[0], target[2]];
  let dir = facing;
  let r = SHOOT_DISTANCE;
  if (nearest) {
    const at = robotXZ(p);
    const d: XZ = [at[0] - aim[0], at[1] - aim[1]];
    r = Math.max(SHOOT_ZONE.near, Math.min(SHOOT_ZONE.far, Math.hypot(d[0], d[1])));
    // How far round the zone a point is from straight out (clockwise negative), within the zone.
    const angleOf = ([x, z]: XZ) => {
      const [dx, dz] = [x - aim[0], z - aim[1]];
      return Math.max(-SHOOT_ZONE.angle, Math.min(SHOOT_ZONE.angle, Math.atan2(facing[0] * dz - facing[1] * dx, facing[0] * dx + facing[1] * dz)));
    };
    let off = angleOf(at);
    if (partner && dist(robotXZ(partner), aim) < dist(at, aim)) {
      // The partner, nearer to the HIVE, keeps its place: room beside it, on this robot's side if
      // the zone has it.
      const theirs = angleOf(robotXZ(partner));
      const gap = PARTNER.room / r;
      if (Math.abs(off - theirs) < gap) {
        const side = off >= theirs ? 1 : -1;
        off = Math.abs(theirs + side * gap) <= SHOOT_ZONE.angle ? theirs + side * gap : theirs - side * gap;
        off = Math.max(-SHOOT_ZONE.angle, Math.min(SHOOT_ZONE.angle, off));
      }
    }
    dir = [facing[0] * Math.cos(off) - facing[1] * Math.sin(off), facing[0] * Math.sin(off) + facing[1] * Math.cos(off)];
  }
  const limit = sim.zones.wall - 0.32;
  const spot: XZ = [
    Math.max(-limit, Math.min(limit, aim[0] + dir[0] * r)),
    Math.max(-limit, Math.min(limit, aim[1] + dir[1] * r)),
  ];
  // In AUTO it stays on its own half (G402).
  const s = allianceSign(p);
  if (sim.match.period === 'auto' && spot[0] * s > -0.3) spot[0] = -0.3 * s;
  return { aim, facing, spot };
}

/** In front of the opening and close enough for an accurate shot. */
export function inShootingPosition(p: PlayerRobot, plan: ShotPlan): boolean {
  const at = robotXZ(p);
  const d = dist(at, plan.aim);
  const ahead = (at[0] - plan.aim[0]) * plan.facing[0] + (at[1] - plan.aim[1]) * plan.facing[1];
  return d > 0.65 && d < 1.3 && ahead > 0.55;
}

/** A FLOWER whose POLLEN a lowered arm can pull out (Flower Mode) and how to get at it. */
export interface FlowerPlan {
  center: XZ;
  /** Where to stand, facing it, to lower the arm before creeping up */
  approach: XZ;
  /** POLLEN in its tube while the bottom one is POLLEN low enough to pull out */
  pollen: number;
}

/** FLOWERs this robot's arm can take POLLEN from right now. */
export function flowerPlans(sim: Simulation, p: PlayerRobot): FlowerPlan[] {
  const def = robotById(p.robotId);
  if (!def.arm || !def.intakes.includes('pollen')) return [];
  // Room in front: the lowered arm, the tube, and space to swing the arm down.
  const standOff = Math.max(def.arm.box.x[1], p.robot.cfg.length / 2) + FLOWER_TUBE.radius + 0.22;
  return sim.zones.flowers.flatMap(center => {
    const inTube = sim.balls.all
      .filter(b => b.state === 'field')
      .map(b => ({ b, at: sim.balls.position(b) }))
      .filter(({ at }) => at[1] < FLOWER_TUBE.height && dist([at[0], at[2]], center) < FLOWER_TUBE.radius)
      .sort((a, b) => a.at[1] - b.at[1]);
    // Only POLLEN below the middle ring comes out (G418); NECTAR at the bottom blocks the rest.
    if (!inTube.length || inTube[0].b.kind !== 'pollen' || inTube[0].at[1] > FLOWER_VOLUME.yMin) return [];
    // Out from the wall it stands at, into the field.
    const out: XZ = Math.abs(center[0]) > Math.abs(center[1]) ? [-Math.sign(center[0]), 0] : [0, -Math.sign(center[1])];
    const approach: XZ = [center[0] + out[0] * standOff, center[1] + out[1] * standOff];
    return [{ center, approach, pollen: inTube.filter(t => t.b.kind === 'pollen').length }];
  });
}

/** Like ballCost for a FLOWER visit: the way there, lowering the arm, less for each ball it holds. */
export function flowerCost(sim: Simulation, p: PlayerRobot, f: FlowerPlan, opponent: PlayerRobot | null, partner: PlayerRobot | null = null): number {
  const auto = sim.match.period === 'auto';
  if (auto && !ownHalf(p, f.center)) return Infinity;
  const { length } = nextWaypoint(sim, p, f.approach, auto);
  const room = Math.max(0, 4 - p.mech.stored.length);
  const contested = opponent ? Math.max(0, 0.7 - dist(robotXZ(opponent), f.approach)) * 3 : 0;
  return length + 0.8 - 0.3 * Math.min(f.pollen, room) + contested + (partnersPoint(p, partner, f.approach) ? PARTNER.flower : 0);
}

/** Where to wait with nothing to pick up: its own half, between the HIVE and the wall (beside a partner there). */
export const waitSpot = (p: PlayerRobot, partner: PlayerRobot | null = null): XZ => besidePartner(p, partner, [-1.15 * allianceSign(p), 0], 1.2);

/**
 * Center of this alliance's loading zone, where robots park at the end (5 points). Two partners
 * take an end of it each, apart: touching the zone is enough.
 */
export function parkSpot(sim: Simulation, p: PlayerRobot, partner: PlayerRobot | null = null): XZ {
  const r = sim.zones.loading[p.robot.alliance];
  const x = (r.minX + r.maxX) / 2;
  if (!partner) return [x, (r.minZ + r.maxZ) / 2];
  return [x, robotXZ(p)[1] <= robotXZ(partner)[1] ? r.minZ : r.maxZ];
}
