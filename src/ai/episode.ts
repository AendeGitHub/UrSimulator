// One training or test game for the AI driver (tools/train-bot.ts, tools/bot-arena.ts): its robot
// against an opponent, driven by the teacher, the network, or a mix of the two (DAgger). At every
// decision it records what it saw and what the teacher would have done there: that is what the
// network learns from.

import type { FieldLayout } from '../field/layout';
import { total } from '../game/scoring';
import type { ColliderPart } from '../sim/colliders';
import { DEFAULT_RULES, type RuleOptions } from '../sim/Referee';
import { Simulation } from '../sim/Simulation';
import { slotAlliance, type GameMode, type Slot } from '../sim/types';
import { ACTION_SIZE, DECISION_DT, DECISION_STEPS, Reflexes, encodeAction, idleAction, toRobotInput } from './action';
import { Bot, networkBrain, teacherBrain, type Brain } from './Bot';
import { FEATURE_SIZE, observe } from './features';
import type { Mlp } from './mlp';
import type { AiLevel } from './level';
import { Handicap, SKILLS, type Skill } from './skill';
import { TEACHER_PHASES, Teacher, type TeacherOptions, type TeacherPhase } from './teacher';

export interface EpisodeConfig {
  mode: GameMode;
  /** Practice runs this long; a match ends by itself */
  seconds: number;
  bot: { slot: Slot; robot: string };
  opponent: { slot: Slot; robot: string; driver: 'teacher' | 'network' | 'idle'; teacher?: Partial<TeacherOptions>; level?: AiLevel } | null;
  /** The AI robot's level (skill.ts); none: the brain's decisions as they are, as in training */
  level?: AiLevel;
  /** Changes to that level's skill (hard's without a level), to try new ones (tools/bot-arena.ts) */
  skill?: Partial<Skill>;
  /** The AI robot's teacher (default: DEFAULT_TEACHER) */
  teacher?: Partial<TeacherOptions>;
  /** Chance that a decision carried out is the teacher's (1: the teacher drives, 0: the network) */
  beta: number;
  record: boolean;
  /** House rules other than the defaults */
  rules?: Partial<RuleOptions>;
}

export interface EpisodeResult {
  samples: number;
  /** samples × FEATURE_SIZE */
  features: Float32Array;
  /** samples × ACTION_SIZE: the teacher's action */
  labels: Float32Array;
  score: number;
  opponentScore: number;
  tips: number;
  cells: number;
  /** MINOR and MAJOR FOULs the AI robot committed, and every call against it */
  fouls: number;
  calls: string[];
  /** Balls the AI robot shot and picked up */
  shots: number;
  pickups: number;
  /** Seconds the teacher spent on each part of the job (what it would have done when the network drives) */
  phases: Record<TeacherPhase, number>;
}

/** Plays one game (call initPhysics() first). `net` is needed unless the teacher drives. */
export function runEpisode(layout: FieldLayout, colliders: ColliderPart[], cfg: EpisodeConfig, net: Mlp | null): EpisodeResult {
  let finished = false;
  const sim = new Simulation(layout, colliders, { toast: () => {}, finished: () => (finished = true) });
  if (cfg.rules) sim.setRules({ ...DEFAULT_RULES, ...cfg.rules });
  sim.addRobot(cfg.bot.slot, 'AI', cfg.bot.robot);
  let opponent: Bot | null = null;
  if (cfg.opponent) {
    sim.addRobot(cfg.opponent.slot, 'opponent', cfg.opponent.robot);
    const brain: Brain | null = cfg.opponent.driver === 'teacher' ? teacherBrain(cfg.opponent.teacher) : cfg.opponent.driver === 'network' && net ? networkBrain(net) : null;
    if (brain) opponent = new Bot(cfg.opponent.slot, brain, cfg.opponent.level);
  }
  sim.start(cfg.mode);

  const teacher = new Teacher(cfg.teacher);
  const reflexes = new Reflexes();
  const handicap = cfg.level || cfg.skill ? new Handicap({ ...SKILLS[cfg.level ?? 'hard'], ...cfg.skill }) : null;
  const student = net ? networkBrain(net) : null;
  const maxSamples = cfg.record ? Math.ceil((cfg.seconds * 120) / DECISION_STEPS) + 8 : 0;
  const features = new Float32Array(maxSamples * FEATURE_SIZE);
  const labels = new Float32Array(maxSamples * ACTION_SIZE);
  let samples = 0;
  const p = sim.robots.get(cfg.bot.slot)!;
  const steps = Math.round(cfg.seconds * 120);
  const phases = Object.fromEntries(TEACHER_PHASES.map(k => [k, 0])) as Record<TeacherPhase, number>;
  let shots = 0;
  let pickups = 0;
  let stored = p.mech.stored.length;

  for (let step = 0; step < steps && !finished; step++) {
    if (step % DECISION_STEPS === 0) {
      let action = idleAction();
      if (sim.match.robotEnabled) {
        const wanted = teacher.act(sim, p, DECISION_DT);
        phases[teacher.phase] += DECISION_DT;
        if (cfg.record && samples < maxSamples) {
          observe(sim, p, features, samples * FEATURE_SIZE);
          encodeAction(wanted, labels, samples * ACTION_SIZE);
          samples++;
        }
        action = !student || Math.random() < cfg.beta ? wanted : student(sim, p);
      }
      sim.setInput(cfg.bot.slot, toRobotInput(reflexes.apply(sim, p, handicap ? handicap.apply(sim, p, action) : action), p));
    }
    opponent?.drive(sim);
    sim.step();
    const now = p.mech.stored.length;
    if (now > stored) pickups += now - stored;
    // Balls leave by the shooter (transfer) or the intake (eject, which the AI never uses).
    else if (now < stored) shots += stored - now;
    stored = now;
  }

  const alliance = slotAlliance(cfg.bot.slot);
  const other = alliance === 'red' ? 'blue' : 'red';
  const s = sim.match.score;
  sim.world.free();
  return {
    samples,
    features: features.slice(0, samples * FEATURE_SIZE),
    labels: labels.slice(0, samples * ACTION_SIZE),
    score: total(s[alliance]),
    opponentScore: total(s[other]),
    tips: s[alliance].autoTips + s[alliance].teleopTips,
    cells: s[alliance].field.cellElements,
    fouls: s[alliance].minorFouls + s[alliance].majorFouls,
    calls: [...s[alliance].calls],
    shots,
    pickups,
    phases,
  };
}
