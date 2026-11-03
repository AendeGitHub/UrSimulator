// Compares AI drivers in the same full matches:  npm run arena:bot -- <variant> <variant> …
//
// A variant is "network" (src/ai/policy.json), "teacher", "easy" / "medium" / "hard" (the network
// at that level, src/ai/skill.ts), or JSON with teacher options or a level, e.g.
//   npm run arena:bot -- teacher '{"name":"no flowers","teacher":{"flowers":false}}' network
//   npm run arena:bot -- easy medium hard '{"name":"slow","network":true,"level":"medium","skill":{"speed":0.6}}'
// Every variant plays GAMES matches (both alliances, all robot pairs) against the default teacher
// and against a robot that stands still.

import { Pool } from './bot-pool';
import type { EpisodeConfig, EpisodeResult } from '../src/ai/episode';
import type { MlpData } from '../src/ai/mlp';
import { AI_LEVELS, type AiLevel } from '../src/ai/level';
import type { Skill } from '../src/ai/skill';
import { TEACHER_PHASES, type TeacherOptions } from '../src/ai/teacher';
import policy from '../src/ai/policy.json';
import { ROBOTS } from '../src/robot/robots';

const GAMES = Number(process.env.GAMES ?? 28);
const WORKERS = Number(process.env.WORKERS ?? 7);

interface Variant {
  name: string;
  network?: boolean;
  teacher?: Partial<TeacherOptions>;
  level?: AiLevel;
  skill?: Partial<Skill>;
}

const variants: Variant[] = process.argv.slice(2).map(arg =>
  arg === 'network' ? { name: 'network', network: true }
    : arg === 'teacher' ? { name: 'teacher' }
      : AI_LEVELS.includes(arg as AiLevel) ? { name: arg, network: true, level: arg as AiLevel }
        : (JSON.parse(arg) as Variant));
if (!variants.length) variants.push({ name: 'teacher' }, { name: 'network', network: true });

const games: Omit<EpisodeConfig, 'beta' | 'teacher'>[] = Array.from({ length: GAMES }, (_, i) => ({
  mode: 'match',
  seconds: 170,
  bot: { slot: i % 2 ? 'red1' : 'blue1', robot: ROBOTS[i % ROBOTS.length].id },
  opponent: { slot: i % 2 ? 'blue1' : 'red1', robot: ROBOTS[Math.floor(i / 3) % ROBOTS.length].id, driver: i % 4 < 3 ? 'teacher' : 'idle' },
  record: false,
}));

const pool = new Pool(WORKERS);
const started = performance.now();
const mean = (rs: EpisodeResult[], f: (r: EpisodeResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
for (const v of variants) {
  const net = v.network ? (policy.net as MlpData) : null;
  const results = await Promise.all(games.map(g => pool.run({ ...g, beta: net ? 0 : 1, teacher: v.teacher, level: v.level, skill: v.skill }, net)));
  const vsTeacher = results.filter((_, i) => games[i].opponent?.driver === 'teacher');
  const time = mean(results, r => TEACHER_PHASES.reduce((s, k) => s + r.phases[k], 0));
  const phases = TEACHER_PHASES.map(k => `${k} ${((100 * mean(results, r => r.phases[k])) / time).toFixed(0)}%`).join(' ');
  console.log(`${v.name.padEnd(14)} ${mean(results, r => r.score).toFixed(1).padStart(6)} points · vs teacher ${mean(vsTeacher, r => r.score).toFixed(1)}:${mean(vsTeacher, r => r.opponentScore).toFixed(1)} won ${((100 * vsTeacher.filter(r => r.score > r.opponentScore).length) / vsTeacher.length).toFixed(0)}% · tips ${mean(results, r => r.tips).toFixed(1)} · shots ${mean(results, r => r.shots).toFixed(1)} picked ${mean(results, r => r.pickups).toFixed(1)} · fouls ${mean(results, r => r.fouls).toFixed(2)} · ${phases} · ${((performance.now() - started) / 1000).toFixed(0)} s`);
  const calls = new Map<string, number>();
  for (const r of results) for (const c of r.calls) calls.set(c.split(' · ').slice(0, 2).join(' · '), (calls.get(c.split(' · ').slice(0, 2).join(' · ')) ?? 0) + 1);
  if (calls.size) console.log(`${''.padEnd(15)}calls: ${[...calls].map(([c, n]) => `${c} ×${n}`).join(', ')}`);
}
await pool.close();
