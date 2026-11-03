// How well the AI drives: easy, medium or hard, picked by the player (or by an online room's
// admin). The trained network always decides what to do; a lower level carries it out like a less
// practiced driver: slower on the sticks, late off the line when a period starts, a moment to think
// after a full load and after shooting it, a turret that can't aim on the move, and shots fired
// before the turret has quite settled. Hard is the network at its best.

import { robotsEnabled, type Period } from '../sim/Match';
import { CAPACITY } from '../sim/Mechanisms';
import type { PlayerRobot, Simulation } from '../sim/Simulation';
import { DECISION_DT, type BotAction } from './action';
import type { AiLevel } from './level';

export interface Skill {
  /** Top driving speed, share of full stick */
  speed: number;
  /** Fastest turn, share of full stick */
  turn: number;
  /** Seconds it stands before moving when AUTO, TELEOP or practice starts */
  start: number;
  /** Seconds it stands to think once it has a full load and once it has shot it (random between the two) */
  think: [number, number];
  /** Its turrets aim on the move (with the house rule on); without, it stops to shoot */
  movingShots: boolean;
  /** Extra shot scatter (standard deviation), rad */
  aim: number;
}

const DEG = Math.PI / 180;

/**
 * Tuned in the arena against the teacher (npm run arena:bot -- easy medium hard, 28 matches each):
 * hard scores about 150 points a match, medium 94 and easy 49. Shot scatter matters most.
 */
export const SKILLS: Record<AiLevel, Skill> = {
  easy: { speed: 0.45, turn: 0.55, start: 1.5, think: [1.2, 2], movingShots: false, aim: 8 * DEG },
  medium: { speed: 0.8, turn: 0.85, start: 0.5, think: [0.3, 0.7], movingShots: true, aim: 5 * DEG },
  hard: { speed: 1, turn: 1, start: 0, think: [0, 0], movingShots: true, aim: 0 },
};

/** Carries out the brain's decisions at a level; one per AI robot, called every decision. */
export class Handicap {
  /** Seconds left standing (starting late, thinking) */
  private wait = 0;
  private period: Period | null = null;
  private stored = -1;

  constructor(public skill: Skill, private readonly random: () => number = Math.random) {}

  apply(sim: Simulation, p: PlayerRobot, a: BotAction): BotAction {
    const s = this.skill;
    // Set every decision: the house rules are applied to every robot again when they change.
    p.mech.aimError = s.aim;
    p.mech.movingShots = sim.ruleOptions.movingShots && s.movingShots;
    const { period } = sim.match;
    if (period !== this.period) {
      this.period = period;
      if (robotsEnabled(period)) this.wait = Math.max(this.wait, s.start);
    }
    const stored = p.mech.stored.length;
    if (this.stored >= 0 && stored !== this.stored && (stored === 0 || stored === CAPACITY)) {
      const [min, max] = s.think;
      this.wait = Math.max(this.wait, min + (max - min) * this.random());
    }
    this.stored = stored;
    // Standing still, the mechanisms still do what the brain says: a volley goes on to its last
    // ball, the flywheel spins up for the next one.
    if (this.wait > 0) {
      this.wait -= DECISION_DT;
      return { ...a, forward: 0, strafe: 0, turn: 0 };
    }
    return { ...a, forward: a.forward * s.speed, strafe: a.strafe * s.speed, turn: a.turn * s.turn };
  }
}
