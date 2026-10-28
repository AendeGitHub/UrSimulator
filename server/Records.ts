// High scores: the top 100 solo match scores for each robot, one entry (the best) per player.
//
// Stored in a JSON file by default. Free hosting (Render free plan) wipes the disk on every
// restart, so when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set the records live
// in an Upstash Redis database instead (free tier, survives restarts). Without one, the tables
// come back from the copies players' browsers keep (restore) and, on a deploy, from the server
// version being replaced.

import fs from 'node:fs';
import path from 'node:path';
import { cleanName } from '../src/net/records';
import { ROBOTS } from '../src/robot/robots';

export const RECORDS_LIMIT = 100;
/** No real solo match comes close; anything above is a broken or forged request. */
export const MAX_SCORE = 1500;

export interface RecordEntry {
  name: string;
  score: number;
  /** ISO date of the match */
  date: string;
}

export interface SubmitResult {
  /** 1-based place in the robot's table, or null when not in the top 100 */
  rank: number | null;
  /** The player's best for this robot after this match */
  best: number;
  /** This match beat the player's previous best */
  improved: boolean;
}

export interface RecordsStore {
  load(robot: string): Promise<RecordEntry[]>;
  save(robot: string, entries: RecordEntry[]): Promise<void>;
}

/** All tables in one JSON file. */
export class FileStore implements RecordsStore {
  constructor(private readonly file: string) {}

  private readAll(): Record<string, RecordEntry[]> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  async load(robot: string): Promise<RecordEntry[]> {
    return this.readAll()[robot] ?? [];
  }

  async save(robot: string, entries: RecordEntry[]): Promise<void> {
    const all = this.readAll();
    all[robot] = entries;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash never leaves half a file.
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(all));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

/** One Redis key per robot through Upstash's REST API (no client library needed). */
export class UpstashStore implements RecordsStore {
  constructor(private readonly url: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async command(args: string[]): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  }

  async load(robot: string): Promise<RecordEntry[]> {
    const value = await this.command(['GET', `ursim:records:${robot}`]);
    return typeof value === 'string' ? JSON.parse(value) : [];
  }

  async save(robot: string, entries: RecordEntry[]): Promise<void> {
    await this.command(['SET', `ursim:records:${robot}`, JSON.stringify(entries)]);
  }
}

/** Players are told apart by name, ignoring case. */
const playerKey = (name: string) => name.toLowerCase();

/** Best score first; equal scores: whoever got there first stays ahead. */
const byRank = (a: RecordEntry, b: RecordEntry) => b.score - a.score || a.date.localeCompare(b.date);

/** A row sent back by a browser or another server, or null when it is not a valid one. */
export function cleanEntry(raw: unknown, now = new Date()): RecordEntry | null {
  const e = raw as Partial<RecordEntry> | null;
  if (!e || typeof e.name !== 'string' || !e.name.trim()) return null;
  if (typeof e.score !== 'number' || !Number.isInteger(e.score) || e.score < 0 || e.score > MAX_SCORE) return null;
  const time = typeof e.date === 'string' ? Date.parse(e.date) : NaN;
  // A date from the future would put the row behind ones it tied with later.
  const date = new Date(Number.isFinite(time) ? Math.min(time, now.getTime()) : now.getTime());
  return { name: cleanName(e.name), score: e.score, date: date.toISOString() };
}

export class Records {
  /** Changes to one robot's table run one after another, so two at once cannot overwrite each other. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(private readonly store: RecordsStore) {}

  static isRobot(id: unknown): id is string {
    return typeof id === 'string' && ROBOTS.some(r => r.id === id);
  }

  async top(robot: string): Promise<RecordEntry[]> {
    return (await this.store.load(robot)).slice(0, RECORDS_LIMIT);
  }

  private queued<T>(robot: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queue.get(robot) ?? Promise.resolve()).then(run, run);
    this.queue.set(robot, result.catch(() => undefined));
    return result;
  }

  submit(robot: string, rawName: string, score: number, now = new Date()): Promise<SubmitResult> {
    return this.queued(robot, async (): Promise<SubmitResult> => {
      const name = cleanName(rawName);
      const entries = await this.store.load(robot);
      const key = playerKey(name);
      const mine = entries.find(e => playerKey(e.name) === key);
      const improved = !mine || score > mine.score;
      if (improved) {
        // One player = one record: the better score replaces the old one.
        const next = entries.filter(e => playerKey(e.name) !== key);
        next.push({ name, score, date: now.toISOString() });
        next.sort(byRank);
        const kept = next.slice(0, RECORDS_LIMIT);
        await this.store.save(robot, kept);
        const index = kept.findIndex(e => playerKey(e.name) === key);
        return { rank: index >= 0 ? index + 1 : null, best: score, improved };
      }
      const index = entries.indexOf(mine!);
      return { rank: index + 1, best: mine!.score, improved };
    });
  }

  /**
   * Puts back rows a wiped table lost, with their own dates. A player keeps the better of the
   * two scores; rows the table already has stay as they are. Returns the table afterwards.
   */
  restore(robot: string, rows: readonly RecordEntry[]): Promise<RecordEntry[]> {
    return this.queued(robot, async () => {
      const entries = await this.store.load(robot);
      const byPlayer = new Map(entries.map(e => [playerKey(e.name), e]));
      let changed = false;
      for (const row of rows) {
        const there = byPlayer.get(playerKey(row.name));
        if (there && there.score >= row.score) continue;
        byPlayer.set(playerKey(row.name), row);
        changed = true;
      }
      if (!changed) return entries.slice(0, RECORDS_LIMIT);
      const kept = [...byPlayer.values()].sort(byRank).slice(0, RECORDS_LIMIT);
      await this.store.save(robot, kept);
      return kept;
    });
  }
}

/** Upstash when configured, otherwise a file next to the server. */
export function createRecords(root: string, env: NodeJS.ProcessEnv = process.env): { records: Records; storage: string } {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { records: new Records(new UpstashStore(url, token)), storage: 'upstash' };
  const file = env.RECORDS_FILE ?? path.join(root, 'data', 'records.json');
  return { records: new Records(new FileStore(file)), storage: file };
}
