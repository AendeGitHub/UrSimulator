// A game session runs the simulation in the browser and takes each local driver's input.

import type { AllianceScore } from './scoring';
import type { Alliance } from '../robot/robotConfig';
import type { FieldLayout } from '../field/layout';
import { robotById } from '../robot/robots';
import type { ColliderPart } from '../sim/colliders';
import { PHYSICS_DT, Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import type { RuleOptions } from '../sim/Referee';
import type { GameMode, RobotInput, Slot } from '../sim/types';

export interface SessionEvents {
  toast(text: string): void;
  finished(score: Record<Alliance, AllianceScore>): void;
}

/** A robot on the field and who drives it. */
export interface Driver {
  slot: Slot;
  /** Robot id (robots.ts) */
  robot: string;
}

const MAX_STEPS_PER_FRAME = 8;

export class Session {
  private readonly sim: Simulation;
  private accumulator = 0;
  private cached: WorldState | null = null;

  /** One driver for solo play, two for a split-screen game. */
  constructor(layout: FieldLayout, colliders: ColliderPart[], readonly drivers: readonly Driver[], mode: GameMode, rules: RuleOptions, events: SessionEvents) {
    this.sim = new Simulation(layout, colliders, {
      toast: text => events.toast(text),
      finished: () => events.finished(structuredClone(this.sim.match.score)),
    });
    for (const d of drivers) this.sim.addRobot(d.slot, robotById(d.robot).team, d.robot);
    this.sim.setRules(rules);
    this.sim.start(mode);
  }

  get simulation(): Simulation {
    return this.sim;
  }

  /** Advances time and hands over this frame's input of each driver. */
  update(dt: number, inputs: Partial<Record<Slot, RobotInput>>): void {
    for (const [slot, input] of Object.entries(inputs) as [Slot, RobotInput][]) this.sim.setInput(slot, input);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      this.sim.step();
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // too slow to catch up; drop time
    this.cached = null;
  }

  state(): WorldState {
    this.cached ??= this.sim.state();
    return this.cached;
  }

  dispose(): void {
    this.sim.world.free();
  }
}
