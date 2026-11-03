// A game session runs the simulation in the browser, takes each local driver's input and lets the
// AI drive its robots.

import { Bot } from '../ai/Bot';
import { aiBrain } from '../ai/policy';
import { DEFAULT_AI_LEVEL, type AiLevel } from '../ai/level';
import type { AllianceScore } from './scoring';
import type { Alliance } from '../robot/robotConfig';
import type { FieldLayout } from '../field/layout';
import type { StartPose } from '../field/startPose';
import { lerpState } from '../net/interpolate';
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
  /** Where its driver wants it to start (red side, field/startPose.ts); the usual spot if missing */
  start?: StartPose | null;
  /** A robot the AI drives: how well (ai/skill.ts) */
  level?: AiLevel;
}

/** What the game loop needs from a game, whether it runs here or in an online room's admin's browser. */
export interface GameSession {
  readonly ai: readonly Driver[];
  /** A game at this computer: the AI drives at this level from now on */
  setAiLevel?(level: AiLevel): void;
  /** Advances the game with this frame's input of each driver at this computer. */
  update(dt: number, inputs: Partial<Record<Slot, RobotInput>>): void;
  state(): WorldState | null;
  /** Every frame, also during the countdown and the pause menu: online games talk to the network. */
  frame?(dt: number, startIn: number): void;
  /** Online, not the admin: the admin's countdown, null once the game is under way */
  readonly remoteStartIn?: number | null;
  /** Online: keeps running behind the pause menu */
  readonly online?: boolean;
  dispose(): void;
}

/**
 * Up to 0.1 s of play a frame (frame times are capped there too): real time down to 10 frames a
 * second. A slower computer plays in slow motion instead of falling ever further behind.
 */
const MAX_STEPS_PER_FRAME = 12;

export class Session implements GameSession {
  private readonly sim: Simulation;
  private readonly bots: Bot[];
  /** The robots the AI drives, at their level now */
  private aiDrivers: Driver[];
  private accumulator = 0;
  /** The world before the last physics step: frames show it blended with the world now */
  private previous: WorldState | null = null;
  private cached: WorldState | null = null;

  /** One driver for solo play, two for a split-screen game; `ai`: robots the trained network drives. */
  constructor(layout: FieldLayout, colliders: ColliderPart[], readonly drivers: readonly Driver[], ai: readonly Driver[], mode: GameMode, rules: RuleOptions, events: SessionEvents) {
    this.sim = new Simulation(layout, colliders, {
      toast: text => events.toast(text),
      finished: () => events.finished(structuredClone(this.sim.match.score)),
    });
    for (const d of [...drivers, ...ai]) this.sim.addRobot(d.slot, robotById(d.robot).team, d.robot);
    this.sim.setStarts(Object.fromEntries(drivers.map(d => [d.slot, d.start])));
    this.aiDrivers = ai.map(d => ({ ...d, level: d.level ?? DEFAULT_AI_LEVEL }));
    this.bots = this.aiDrivers.map(d => new Bot(d.slot, aiBrain(), d.level));
    this.sim.setRules(rules);
    this.sim.start(mode);
  }

  get ai(): readonly Driver[] {
    return this.aiDrivers;
  }

  setAiLevel(level: AiLevel): void {
    for (const bot of this.bots) bot.level = level;
    this.aiDrivers = this.aiDrivers.map(d => ({ ...d, level }));
  }

  get simulation(): Simulation {
    return this.sim;
  }

  /** Advances time and hands over this frame's input of each driver. */
  update(dt: number, inputs: Partial<Record<Slot, RobotInput>>): void {
    for (const [slot, input] of Object.entries(inputs) as [Slot, RobotInput][]) this.sim.setInput(slot, input);
    this.accumulator += dt;
    const steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.accumulator / PHYSICS_DT));
    for (let i = 0; i < steps; i++) {
      if (i === steps - 1) this.previous = this.sim.state();
      for (const bot of this.bots) bot.drive(this.sim);
      this.sim.step();
      this.accumulator -= PHYSICS_DT;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // too slow to catch up; drop time
    this.cached = null;
  }

  /**
   * The world as a frame shows it: between the last two physics steps, as far on as the time since
   * the last one (one step behind), so robots and balls move evenly at any frame rate. Physics runs
   * 120 steps a second; drawn as they are, a 144 Hz screen would show some steps twice and a 75 Hz
   * one would skip every other.
   */
  state(): WorldState {
    if (!this.cached) {
      const now = this.sim.state();
      this.cached = this.previous ? lerpState(this.previous, now, Math.min(1, this.accumulator / PHYSICS_DT)) : now;
    }
    return this.cached;
  }

  dispose(): void {
    this.sim.world.free();
  }
}
