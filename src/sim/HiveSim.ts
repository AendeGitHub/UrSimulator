// A HIVE: kinematic body that tips when enough POLLEN / NECTAR land in the upward cell.
// Tipping rotates the hive 60°, so the full cell turns over and its balls spill out by physics.

import RAPIER from '@dimforge/rapier3d-compat';
import { aimPoint, inCell, stateAngle, tipProgress, upCell, type HiveState, type Vec3 } from '../field/hiveGeometry';
import type { Alliance } from '../robot/robotConfig';
import type { Ball, BallSim } from './BallSim';
import type { ColliderPart } from './colliders';

/** NECTAR weighs as much as 2 POLLEN; a cell tips with the weight of 10 POLLEN (5 NECTAR). */
export const NECTAR_WEIGHT = 2;
export const TIP_LOAD = 10;
const TIP_DURATION = 0.7;

export class HiveSim {
  state: HiveState = 'A';
  angle = 0;
  tips = 0;
  /** Seconds since the current tip started, or null when resting. */
  private tipping: number | null = null;
  private from = 0;
  private readonly body: RAPIER.RigidBody;

  /** Called when a tip finishes (the damper touches the frame). */
  onTip?: (hive: HiveSim) => void;

  constructor(world: RAPIER.World, readonly alliance: Alliance, readonly pivot: Vec3, shape: ColliderPart) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...pivot));
    // Polycarbonate skins absorb hits: balls that make it into a cell stay there.
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices)
        .setFriction(0.6)
        .setRestitution(0)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
  }

  get isTipping(): boolean {
    return this.tipping !== null;
  }

  reset(): void {
    this.state = 'A';
    this.tips = 0;
    this.tipping = null;
    this.setAngle(stateAngle(this.alliance, 'A'), true);
  }

  /** Balls (not held) inside the upward cell. */
  ballsInUpCell(balls: BallSim): Ball[] {
    const cell = upCell(this.state);
    return balls.all.filter(b => b.state === 'field' && inCell(balls.position(b), this.alliance, cell, this.pivot, this.angle));
  }

  /** Auto-aim target: the opening of the upward cell. */
  target(): Vec3 {
    return aimPoint(this.alliance, upCell(this.state), this.pivot, this.angle);
  }

  step(dt: number, balls: BallSim): void {
    if (this.tipping === null) {
      const load = this.ballsInUpCell(balls).reduce((s, b) => s + (b.kind === 'nectar' ? NECTAR_WEIGHT : 1), 0);
      if (load >= TIP_LOAD) {
        this.tipping = 0;
        this.from = this.angle;
        this.state = this.state === 'A' ? 'B' : 'A';
      }
      return;
    }
    this.tipping += dt;
    const to = stateAngle(this.alliance, this.state);
    const t = this.tipping / TIP_DURATION;
    this.setAngle(this.from + (to - this.from) * tipProgress(t), false);
    if (t >= 1) {
      this.tipping = null;
      this.tips++;
      this.onTip?.(this);
    }
  }

  private setAngle(angle: number, teleport: boolean): void {
    this.angle = angle;
    const q = { x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) };
    if (teleport) this.body.setRotation(q, true);
    else this.body.setNextKinematicRotation(q);
  }
}
