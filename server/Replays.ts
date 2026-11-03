// The signed-in players' match archive: every match they finish can be watched again from their
// career (ui/RecordsScreen.ts). The recording (game/replayFile.ts, gzipped by the browser) is a
// file of its own; the list of a player's matches is a key in the database. Only the player sees
// their archive.
//
// Files: <dir>/<account id>/<replay id>.urp · Keys: replays:<account id> → ReplayInfo[], newest first

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_REPLAYS, type ReplayInfo, type ReplayUpload } from '../src/net/accountProtocol';
import { cleanName } from '../src/net/records';
import { isCustomRobotId } from '../src/robot/robots';
import { SLOTS, slotAlliance, type Slot } from '../src/sim/types';
import type { Db } from './Kv';
import { MAX_SCORE, Records } from './Records';

/** A 2:30 match of four robots is about 2 MB; this leaves room for a long one. */
export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
/** The longest recording that is still one match, s */
const MAX_DURATION = 600;
const ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{12}$/.test(id);
const isScore = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SCORE;

/** What the game says about its recording, or null when no real game sends that. */
export function cleanReplayUpload(body: unknown): ReplayUpload | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const { type, robot, alliance, score, opponent, duration, robots, names, ai, version } = b;
  if (type !== 'solo' && type !== 'duo' && type !== '1v1' && type !== '2v2') return null;
  const isRobot = (id: unknown): id is string => Records.isRobot(id) || isCustomRobotId(id);
  if (!isRobot(robot) || (alliance !== 'red' && alliance !== 'blue')) return null;
  if (!isScore(score) || !isScore(opponent)) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) return null;
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,20}$/.test(version)) return null;
  const bySlot = <T>(value: unknown, clean: (v: unknown) => T | null): Partial<Record<Slot, T>> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Partial<Record<Slot, T>> = {};
    for (const [slot, v] of Object.entries(value)) {
      const c = clean(v);
      if (!SLOTS.includes(slot as Slot) || c === null) return null;
      out[slot as Slot] = c;
    }
    return out;
  };
  const cleanRobots = bySlot(robots, v => (isRobot(v) ? v : null));
  const cleanNames = bySlot(names, v => (typeof v === 'string' ? (v.trim() ? cleanName(v) : '') : null));
  if (!cleanRobots || !Object.keys(cleanRobots).length || !cleanNames) return null;
  if (!Array.isArray(ai) || !ai.every(s => SLOTS.includes(s)) || new Set(ai).size !== ai.length) return null;
  return { type, robot, alliance, score, opponent, duration, robots: cleanRobots, names: cleanNames, ai: ai as Slot[], version };
}

export class Replays {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly random: (bytes: number) => Buffer = randomBytes,
    private readonly now = () => new Date(),
  ) {}

  private file(account: string, id: string): string {
    return path.join(this.dir, account, `${id}.urp`);
  }

  list(account: string): Promise<ReplayInfo[]> {
    return this.db.read<ReplayInfo[]>(`replays:${account}`).then(list => list ?? []);
  }

  /** Keeps a recording (gzipped) in the player's archive; the oldest beyond MAX_REPLAYS go. */
  async save(account: string, upload: ReplayUpload, data: Buffer): Promise<ReplayInfo> {
    if (!isId(account)) throw new Error('bad account');
    const id = [...this.random(12)].map(b => ID_LETTERS[b % ID_LETTERS.length]).join('');
    await fs.mkdir(path.join(this.dir, account), { recursive: true });
    await fs.writeFile(this.file(account, id), data);
    const rivals = (Object.keys(upload.robots) as Slot[]).some(s => slotAlliance(s) !== upload.alliance);
    const result = !rivals ? null : upload.score > upload.opponent ? 'win' : upload.score < upload.opponent ? 'loss' : 'tie';
    const info: ReplayInfo = { ...upload, id, date: this.now().toISOString(), result, size: data.length };
    let dropped: ReplayInfo[] = [];
    await this.db.update<ReplayInfo[]>(`replays:${account}`, old => {
      const list = [info, ...(old ?? [])];
      dropped = list.slice(MAX_REPLAYS);
      return list.slice(0, MAX_REPLAYS);
    });
    await Promise.all(dropped.map(r => fs.rm(this.file(account, r.id), { force: true })));
    return info;
  }

  /** The recording, if it is in this player's archive. */
  async read(account: string, id: string): Promise<Buffer | null> {
    if (!isId(account) || !isId(id) || !(await this.list(account)).some(r => r.id === id)) return null;
    return fs.readFile(this.file(account, id)).catch(() => null);
  }

  async remove(account: string, id: string): Promise<boolean> {
    if (!isId(account) || !isId(id)) return false;
    let found = false;
    await this.db.update<ReplayInfo[]>(`replays:${account}`, old => {
      const list = old ?? [];
      found = list.some(r => r.id === id);
      return list.filter(r => r.id !== id);
    });
    if (found) await fs.rm(this.file(account, id), { force: true });
    return found;
  }
}
