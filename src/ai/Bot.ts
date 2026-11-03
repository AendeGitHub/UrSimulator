// The AI driver in a game: 20 times a second its brain (the trained network, or the teacher during
// training) picks an action, its level (skill.ts) carries it out, the reflexes check it, and it goes
// to the robot as gamepad input.

import type { PlayerRobot, Simulation } from '../sim/Simulation';
import type { Slot } from '../sim/types';
import { DECISION_DT, DECISION_STEPS, Reflexes, idleAction, toRobotInput, type BotAction } from './action';
import { FEATURE_SIZE, observe } from './features';
import { Mlp, type MlpData } from './mlp';
import type { AiLevel } from './level';
import { Handicap, SKILLS } from './skill';
import { Teacher, type TeacherOptions } from './teacher';

export type Brain = (sim: Simulation, p: PlayerRobot) => BotAction;

/** The network's raw outputs as an action: tanh for the sticks, logit > 0 for the buttons. */
export function decodeOutputs(o: ArrayLike<number>): BotAction {
  return { forward: Math.tanh(o[0]), strafe: Math.tanh(o[1]), turn: Math.tanh(o[2]), intake: o[3] > 0, transfer: o[4] > 0, shooter: o[5] > 0, arm: o[6] > 0 };
}

export function networkBrain(net: Mlp | MlpData): Brain {
  const mlp = net instanceof Mlp ? net : Mlp.fromData(net);
  const x = new Float32Array(FEATURE_SIZE);
  return (sim, p) => {
    observe(sim, p, x);
    return decodeOutputs(mlp.forward(x));
  };
}

export function teacherBrain(options: Partial<TeacherOptions> = {}): Brain {
  const teacher = new Teacher(options);
  return (sim, p) => teacher.act(sim, p, DECISION_DT);
}

export class Bot {
  private readonly reflexes = new Reflexes();
  private readonly handicap: Handicap;
  private steps = 0;
  /** What it decided last (after the reflexes) */
  action = idleAction();

  constructor(readonly slot: Slot, private readonly brain: Brain, private current: AiLevel = 'hard') {
    this.handicap = new Handicap(SKILLS[current]);
  }

  get level(): AiLevel {
    return this.current;
  }

  /** From the next decision on, it drives at this level. */
  set level(level: AiLevel) {
    this.current = level;
    this.handicap.skill = SKILLS[level];
  }

  /** Call before every physics step; it decides every DECISION_STEPS of them. */
  drive(sim: Simulation): void {
    if (this.steps++ % DECISION_STEPS !== 0) return;
    const p = sim.robots.get(this.slot);
    if (!p) return;
    const wanted = sim.match.robotEnabled ? this.brain(sim, p) : idleAction();
    this.action = this.reflexes.apply(sim, p, this.handicap.apply(sim, p, wanted));
    sim.setInput(this.slot, toRobotInput(this.action, p));
  }
}
