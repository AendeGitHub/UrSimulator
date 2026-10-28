// High score tables on the game server (server/Records.ts): top 100 solo match scores per robot.

export const DEFAULT_PORT = 8787;
/** The public server; the desktop app (loaded from app://) keeps its high scores there. */
export const PUBLIC_SERVER_URL = 'https://ursim.onrender.com';

export interface RecordEntry {
  name: string;
  score: number;
  date: string;
}

export interface SubmitResult {
  rank: number | null;
  best: number;
  improved: boolean;
}

/** Where the high score server is: ?server=… in the address, the Vite dev setup, or the page's own host. */
export function defaultServerUrl(): string {
  const param = new URLSearchParams(location.search).get('server');
  if (param) return param;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return PUBLIC_SERVER_URL;
  if (import.meta.env.DEV) return `http://${location.hostname || 'localhost'}:${DEFAULT_PORT}`;
  return location.origin;
}

/** The records API of a server address (an old ws://host/ws one works too). */
export function recordsUrl(serverUrl: string, action = ''): string {
  const url = new URL(serverUrl.replace(/^ws/, 'http'));
  url.pathname = action ? `/api/records/${action}` : '/api/records';
  url.search = '';
  return url.toString();
}

export function cleanName(name: string, fallback = 'Игрок'): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 16) || fallback;
}

export async function fetchRecords(serverUrl: string, robot: string): Promise<RecordEntry[]> {
  const res = await fetch(`${recordsUrl(serverUrl)}?robot=${encodeURIComponent(robot)}`);
  if (!res.ok) throw new Error(`records ${res.status}`);
  return ((await res.json()) as { entries: RecordEntry[] }).entries;
}

export async function submitRecord(serverUrl: string, robot: string, name: string, score: number): Promise<SubmitResult> {
  const res = await fetch(recordsUrl(serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ robot, name, score }),
  });
  if (!res.ok) throw new Error(`records ${res.status}`);
  return (await res.json()) as SubmitResult;
}

/** Gives a restarted server back rows it lost, with their dates; answers with the whole table. */
export async function sendBackRecords(serverUrl: string, robot: string, entries: RecordEntry[]): Promise<RecordEntry[]> {
  const res = await fetch(recordsUrl(serverUrl, 'restore'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ robot, entries }),
  });
  if (!res.ok) throw new Error(`records ${res.status}`);
  return ((await res.json()) as { entries: RecordEntry[] }).entries;
}

/** A best score this browser sent to the server, kept so a wiped table can get it back. */
export interface SavedRecord {
  name: string;
  score: number;
}

const SAVED_KEY = 'ursim.records';
const TABLES_KEY = 'ursim.tables';
/** The server's tables hold this many rows (server/Records.ts RECORDS_LIMIT). */
const TABLE_ROWS = 100;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Bests sent from this browser, by robot id. */
export function savedRecords(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, SavedRecord[]> {
  try {
    const saved = JSON.parse(storage.getItem(SAVED_KEY) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Keeps a player's score for a robot if it beats what this browser has for that name. */
export function rememberRecord(robot: string, name: string, score: number, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  try {
    const saved = savedRecords(storage);
    const list = saved[robot] ?? [];
    const mine = list.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (mine && mine.score >= score) return;
    saved[robot] = [...list.filter(r => r !== mine), { name, score }];
    storage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // No storage: only the server keeps records.
  }
}

/** The last copy of each robot's whole table this browser got from the server. */
export function savedTables(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, RecordEntry[]> {
  try {
    const tables = JSON.parse(storage.getItem(TABLES_KEY) ?? '{}');
    return tables && typeof tables === 'object' ? tables : {};
  } catch {
    return {};
  }
}

function rememberTable(robot: string, entries: RecordEntry[], storage: Store): void {
  try {
    storage.setItem(TABLES_KEY, JSON.stringify({ ...savedTables(storage), [robot]: entries }));
  } catch {
    // No storage: this browser cannot help a wiped server.
  }
}

/** One row per player (the best score; equal scores: the earlier date), best first, top 100. */
export function mergeTables(...tables: readonly RecordEntry[][]): RecordEntry[] {
  const best = new Map<string, RecordEntry>();
  for (const e of tables.flat()) {
    const key = e.name.toLowerCase();
    const there = best.get(key);
    if (!there || e.score > there.score || (e.score === there.score && e.date < there.date)) best.set(key, e);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, TABLE_ROWS);
}

/**
 * Fetches the tables and gives the server back the rows it lost: this browser's own bests and
 * every row of the copies it kept. Without a database (free Render, no Upstash) the server
 * forgets every table when it restarts, which is whenever it sleeps after 15 minutes without
 * players and on every update; any player who saw a table before that brings it back.
 */
export async function restoreRecords(
  serverUrl: string,
  robots: readonly string[],
  saved = savedRecords(),
  storage: Store = localStorage,
  now = new Date(),
): Promise<Record<string, RecordEntry[]>> {
  const tables = savedTables(storage);
  const result: Record<string, RecordEntry[]> = {};
  await Promise.all(robots.map(async robot => {
    const table = await fetchRecords(serverUrl, robot);
    const mine = (saved[robot] ?? []).map(r => ({ name: r.name, score: r.score, date: now.toISOString() }));
    const kept = mergeTables(table, tables[robot] ?? [], mine);
    const there = new Map(table.map(e => [e.name.toLowerCase(), e.score]));
    const lost = kept.filter(e => (there.get(e.name.toLowerCase()) ?? -1) < e.score);
    let final = table;
    if (lost.length) {
      try {
        final = await sendBackRecords(serverUrl, robot, lost);
      } catch {
        // An older server without restore: keep the rows here for the next try.
        final = kept;
      }
    }
    rememberTable(robot, final, storage);
    result[robot] = final;
  }));
  return result;
}
