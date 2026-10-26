// A game session supplies world states to draw and takes the local driver's input.
// LocalSession runs the simulation in the browser; NetSession (net/NetSession.ts) talks to a server.

import type { AllianceScore } from './scoring';
import type { Alliance } from '../robot/robotConfig';
import type { FieldLayout } from '../field/layout';
import { robotById } from '../robot/robots';
import type { ColliderPart } from '../sim/colliders';
import { PHYSICS_DT, Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import type { GameMode, RobotInput, Slot } from '../sim/types';

export interface SessionEvents {
  toast(text: string): void;
  finished(score: Record<Alliance, AllianceScore>): void;
}

export interface Session {
  readonly online: boolean;
  /** Robot this browser drives, or null when watching */
  readonly localSlot: Slot | null;
  /** Advances time and hands over this frame's input. */
  update(dt: number, input: RobotInput | null): void;
  state(): WorldState | null;
  /** Driver names shown on the robot signs */
  names(): Partial<Record<Slot, string>>;
  dispose(): void;
}

const MAX_STEPS_PER_FRAME = 8;

export class LocalSession implements Session {
  readonly online = false;
  private readonly sim: Simulation;
  private accumulator = 0;
  private cached: WorldState | null = null;

  private readonly team: string;

  constructor(layout: FieldLayout, colliders: ColliderPart[], readonly localSlot: Slot, robotId: string, mode: GameMode, events: SessionEvents) {
    this.sim = new Simulation(layout, colliders, {
      toast: text => events.toast(text),
      finished: () => events.finished(structuredClone(this.sim.match.score)),
    });
    this.team = robotById(robotId).team;
    this.sim.addRobot(localSlot, this.team, robotId);
    this.sim.start(mode);
  }

  get simulation(): Simulation {
    return this.sim;
  }

  update(dt: number, input: RobotInput | null): void {
    if (input) this.sim.setInput(this.localSlot, input);
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

  names(): Partial<Record<Slot, string>> {
    return { [this.localSlot]: this.team };
  }

  dispose(): void {
    this.sim.world.free();
  }
}
