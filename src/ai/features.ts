// What the network sees each decision: 69 numbers about its robot, the balls and FLOWERs it could
// get, where to shoot from, the other robot, what is in the way and the match clock. Positions are
// in the robot's own frame (forward, right), so it plays the same from either alliance.

import type { Ball } from '../sim/BallSim';
import type { PlayerRobot, Simulation } from '../sim/Simulation';
import { neededFlywheel } from './action';
import {
  AUTO_TIME, TELEOP_TIME, allianceSign, ballCost, dist, flowerCost, flowerPlans, frameBox, inShootingPosition, insideBox,
  nextWaypoint, opponentOf, parkSpot, partnerOf, pickableBalls, robotXZ, rotateToRobot, shotPlan, toRobot, waitSpot, type XZ,
} from './field';
import { DEFAULT_TEACHER } from './teacher';

/** Balls the network is shown, cheapest to reach first */
export const BALLS_SEEN = 4;
export const FEATURE_SIZE = 69;

/** Fills `out` from `at` with the features of robot `p`. */
export function observe(sim: Simulation, p: PlayerRobot, out: Float32Array, at = 0): void {
  let i = at;
  const put = (...v: number[]) => {
    for (const x of v) out[i++] = Number.isFinite(x) ? x : 0;
  };
  const me = robotXZ(p);
  const s = allianceSign(p);
  const auto = sim.match.period === 'auto';
  const rel = (point: XZ) => toRobot(p, point).map(v => v / 3);
  const way = (goal: XZ) => rel(nextWaypoint(sim, p, goal, auto).point);

  // Itself (14): where on the field (as seen from its own alliance), motion, load, shooter, arm.
  const yaw = p.robot.yaw + (s < 0 ? Math.PI : 0);
  const [vf, vr] = rotateToRobot(p.robot.yaw, p.robot.velocity);
  const main = p.mech.turret;
  put((me[0] * s) / 1.8, (me[1] * s) / 1.8, Math.cos(yaw), Math.sin(yaw), vf / 2.5, vr / 2.5, p.robot.body.angvel().y / 5,
    p.mech.stored.length / 4, p.mech.shooterOn ? 1 : 0, main.status === 'ready' ? 1 : 0, main.flywheel, neededFlywheel(p),
    p.mech.knocked > 0 ? 1 : 0, p.mech.arm);

  // The balls it could get (4 × 4), and the way to the first one (2). In a 2 vs 2 it sees the
  // nearer opponent, and leaves its partner's part of the field to the partner.
  const opponent = opponentOf(sim, p);
  const partner = partnerOf(sim, p);
  const balls = pickableBalls(sim, p)
    .map(b => ({ b, cost: ballCost(sim, p, b, opponent, partner) }))
    .filter(c => Number.isFinite(c.cost))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, BALLS_SEEN);
  const ballXZ = (b: Ball): XZ => {
    const [x, , z] = sim.balls.position(b);
    return [x, z];
  };
  for (let k = 0; k < BALLS_SEEN; k++) {
    const c = balls[k];
    if (c) put(...rel(ballXZ(c.b)), Math.min(c.cost, 6) / 4, 1);
    else put(0, 0, 0, 0);
  }
  put(...(balls[0] ? way(ballXZ(balls[0].b)) : [0, 0]));

  // The FLOWER it could empty with its arm (7): the way to its approach point, where it is, how
  // much it holds and what it costs.
  const flowers = flowerPlans(sim, p)
    .map(f => ({ f, cost: flowerCost(sim, p, f, opponent, partner) }))
    .filter(c => Number.isFinite(c.cost))
    .sort((a, b) => a.cost - b.cost);
  const flower = flowers[0];
  if (flower) put(1, ...way(flower.f.approach), ...rel(flower.f.center), flower.f.pollen / 4, Math.min(flower.cost, 6) / 4);
  else put(0, 0, 0, 0, 0, 0, 0);

  // Shooting (6): the way to the spot in front of the open cell, and how good a shot is from here.
  const plan = shotPlan(sim, p, DEFAULT_TEACHER.shootNearest, partner);
  const ahead = (me[0] - plan.aim[0]) * plan.facing[0] + (me[1] - plan.aim[1]) * plan.facing[1];
  put(...way(plan.spot), dist(me, plan.spot) / 3, dist(me, plan.aim) / 3, ahead / 1.5, inShootingPosition(p, plan) ? 1 : 0);

  // The other robot (5).
  if (opponent) {
    const o = robotXZ(opponent);
    put(1, ...rel(o), dist(me, o) / 3, opponent.robot.speed / 2.5);
  } else put(0, 0, 0, 0, 0);

  // What is in the way (10): the HIVE frame, the nearest FLOWER, the nearest wall.
  const box = frameBox(sim, 0);
  const near: XZ = [Math.max(box.minX, Math.min(box.maxX, me[0])), Math.max(box.minZ, Math.min(box.maxZ, me[1]))];
  put(...rel(near), Math.min(dist(me, near), 2), insideBox(me, box) ? 1 : 0);
  let nearest = sim.zones.flowers[0];
  for (const f of sim.zones.flowers) if (dist(me, f) < dist(me, nearest)) nearest = f;
  put(...rel(nearest), dist(me, nearest) / 3);
  const wall = sim.zones.wall;
  const gaps: [number, XZ][] = [[wall - me[0], [1, 0]], [wall + me[0], [-1, 0]], [wall - me[1], [0, 1]], [wall + me[1], [0, -1]]];
  const [gap, normal] = gaps.reduce((a, b) => (b[0] < a[0] ? b : a));
  put(Math.min(gap, 1), ...rotateToRobot(p.robot.yaw, normal));

  // The clock (4).
  const period = sim.match.period;
  const left = period === 'auto' ? (AUTO_TIME - sim.match.time) / AUTO_TIME : period === 'teleop' ? sim.match.teleopLeft / TELEOP_TIME : 1;
  put(auto ? 1 : 0, period === 'teleop' ? 1 : 0, period === 'practice' ? 1 : 0, left);

  // Where to park (3) and where to wait when nothing is left to pick up (2).
  const park = parkSpot(sim, p, partner);
  put(...rel(park), dist(me, park) / 3, ...rel(waitSpot(p, partner)));

  if (i - at !== FEATURE_SIZE) throw new Error(`observe() wrote ${i - at} features, expected ${FEATURE_SIZE}`);
}
