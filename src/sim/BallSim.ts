// All POLLEN and NECTAR in a match: physics bodies and who holds them.
// The ball list is built the same way everywhere (ballSpecs), so ball ids match between
// the server, the browser simulation and the renderer.

import RAPIER from '@dimforge/rapier3d-compat';
import { NECTAR_RADIUS, POLLEN_RADIUS, type FieldLayout, type Vec3 } from '../field/layout';
import type { Alliance } from '../robot/robotConfig';
import { SLOTS, type Slot } from './types';

export type BallColor = 'yellow' | Alliance;
export type BallState = 'field' | 'held' | 'staged';
export type BallKind = 'pollen' | 'nectar';

export interface BallSpec {
  kind: BallKind;
  color: BallColor;
  radius: number;
  /** field: free physics body · held: inside a robot · staged: waiting with the human player */
  homeState: BallState;
  pos: Vec3;
  /** Robot slot whose pre-load this is */
  owner?: Slot;
}

export interface Ball extends BallSpec {
  readonly id: number;
  readonly body: RAPIER.RigidBody;
  /** Kept: body.collider(0) makes a new wrapper object on every call. */
  readonly collider: RAPIER.Collider;
  state: BallState;
  /** NECTAR handed back to the drive team after leaving the field (re-entered any time, G427) */
  returned: boolean;
  /** Which robot last shot or ejected it and how long ago (for the referee); null otherwise */
  launch: { by: Slot; kind: 'shot' | 'eject'; age: number } | null;
}

/** Pre-loaded POLLEN per robot (manual 10.3.4). */
export const PRELOAD = 4;

/** Hollow polyethylene balls (Gopher ResisDent); NECTAR weighs as much as 2 POLLEN. */
const MASS = { pollen: 0.045, nectar: 0.09 };
/**
 * Plastic balls barely bounce: combined with the foam tiles (same value) a 1 m drop bounces
 * about 5 cm, off walls and other balls a little more.
 */
export const BALL_RESTITUTION = 0.22;
const BALL_FRICTION = 0.55;
/** Balls fly almost freely but roll to a stop on the foam tiles. */
const AIR_DAMPING = 0.02;
const FLOOR_DAMPING = 0.6;

export function ballSpecs(layout: FieldLayout): BallSpec[] {
  const wall = layout.wallInnerHalf;
  const onField = (p: Vec3) => Math.abs(p[0]) < wall && Math.abs(p[2]) < wall;
  const specs: BallSpec[] = [];
  for (const p of layout.pollen.filter(onField)) {
    specs.push({ kind: 'pollen', color: 'yellow', radius: POLLEN_RADIUS, homeState: 'field', pos: p });
  }
  SLOTS.forEach((owner, s) => {
    for (let i = 0; i < PRELOAD; i++) {
      specs.push({ kind: 'pollen', color: 'yellow', radius: POLLEN_RADIUS, homeState: 'held', pos: [s, -5 - i, 0], owner });
    }
  });
  for (const color of ['red', 'blue'] as const) {
    for (const p of layout.nectar[color]) {
      // NECTAR above the floor sits in the upward hive cell; the rest waits in the alliance area.
      specs.push({ kind: 'nectar', color, radius: NECTAR_RADIUS, homeState: p[1] > 0.5 ? 'field' : 'staged', pos: p });
    }
  }
  return specs;
}

export class BallSim {
  readonly all: Ball[];
  /**
   * Every ball's position and rotation after the last physics step (x y z qx qy qz qw per ball).
   * Reading them from Rapier allocates on every call and most balls lie asleep, so the simulation
   * reads this copy, refreshed by sync().
   */
  readonly transforms: Float32Array;
  /** Balls that were awake at the last sync() */
  private readonly awake: Uint8Array;

  constructor(world: RAPIER.World, layout: FieldLayout) {
    this.all = ballSpecs(layout).map((spec, id) => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(...spec.pos).setLinearDamping(AIR_DAMPING).setAngularDamping(0.9).setCcdEnabled(true),
      );
      const collider = world.createCollider(RAPIER.ColliderDesc.ball(spec.radius).setMass(MASS[spec.kind]).setRestitution(BALL_RESTITUTION).setFriction(BALL_FRICTION), body);
      return { ...spec, id, body, collider, state: spec.homeState, returned: false, launch: null };
    });
    this.transforms = new Float32Array(this.all.length * 7);
    this.awake = new Uint8Array(this.all.length);
    this.reset();
  }

  /** Puts every ball back where the match starts. */
  reset(): void {
    for (const b of this.all) {
      b.state = b.homeState;
      b.returned = false;
      b.launch = null;
      b.body.setEnabled(b.state === 'field');
      b.body.setTranslation({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }, false);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      if (b.state === 'field') b.body.sleep();
      this.store(b);
    }
  }

  /** Call after every physics step: refreshes the balls that moved (awake now or until now). */
  sync(): void {
    for (const b of this.all) {
      if (b.state !== 'field') continue;
      const sleeping = b.body.isSleeping();
      if (!sleeping || this.awake[b.id]) this.store(b);
      this.awake[b.id] = sleeping ? 0 : 1;
    }
  }

  private store(b: Ball): void {
    const t = b.body.translation();
    const r = b.body.rotation();
    this.transforms.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], b.id * 7);
  }

  /** POLLEN that start the match inside the robot in `slot`. */
  preloads(slot: Slot): Ball[] {
    return this.all.filter(b => b.owner === slot);
  }

  position(b: Ball): Vec3 {
    const o = b.id * 7;
    return [this.transforms[o], this.transforms[o + 1], this.transforms[o + 2]];
  }

  hold(b: Ball): void {
    const [x, y, z] = this.position(b);
    b.state = 'held';
    b.launch = null;
    b.body.setEnabled(false);
    // Resting balls sleep; wake the ones that leaned on this ball (e.g. a stack in a flower) so they fall.
    for (const o of this.all) {
      if (o.state !== 'field' || !o.body.isSleeping()) continue;
      const [ox, oy, oz] = this.position(o);
      if (Math.hypot(ox - x, oy - y, oz - z) < 0.35) o.body.wakeUp();
    }
  }

  /** Puts a ball into play at `pos` with velocity `vel`. */
  release(b: Ball, pos: Vec3, vel: Vec3): void {
    b.state = 'field';
    b.returned = false;
    b.launch = null;
    b.body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, true);
    b.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setEnabled(true);
    b.body.wakeUp();
    this.store(b);
    this.awake[b.id] = 1;
  }

  /** NECTAR given back to the human player: it waits at `pos` in the alliance area. */
  giveBack(b: Ball, pos: Vec3): void {
    b.state = 'staged';
    b.returned = true;
    b.launch = null;
    b.body.setEnabled(false);
    b.body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, false);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.store(b);
  }

  /** Rolling resistance on the floor only, so it does not slow shots in the air. */
  step(dt: number): void {
    for (const b of this.all) {
      if (b.launch) b.launch.age += dt;
      if (b.state !== 'field' || b.body.isSleeping()) continue;
      const onFloor = this.transforms[b.id * 7 + 1] < b.radius + 0.01;
      const damping = onFloor ? FLOOR_DAMPING : AIR_DAMPING;
      if (b.body.linearDamping() !== damping) b.body.setLinearDamping(damping);
    }
  }
}
