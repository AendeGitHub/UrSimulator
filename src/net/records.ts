// High score tables on the game server (server/Records.ts): top 100 solo match scores per robot.

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

/** The records API lives on the same server as the online rooms (ws://host/ws → http://host/api/records). */
export function recordsUrl(serverUrl: string): string {
  const url = new URL(serverUrl.replace(/^ws/, 'http'));
  url.pathname = '/api/records';
  url.search = '';
  return url.toString();
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

/** A best score this browser sent to the server, kept so a wiped table can get it back. */
export interface SavedRecord {
  name: string;
  score: number;
}

const SAVED_KEY = 'ursim.records';
/** The server's tables hold this many rows (server/Records.ts RECORDS_LIMIT). */
const TABLE_ROWS = 100;

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

/**
 * Sends the server this browser's bests its table no longer has. Without a database (free
 * Render, no Upstash) the server forgets every table when it restarts, which is whenever it
 * sleeps after 15 minutes without players and on every update.
 */
export async function restoreRecords(serverUrl: string, robots: readonly string[], saved = savedRecords()): Promise<void> {
  await Promise.all(robots.map(async robot => {
    const mine = saved[robot];
    if (!mine?.length) return;
    const table = await fetchRecords(serverUrl, robot);
    // A full table whose last row beats a score has no place for it anyway.
    const lowest = table.length >= TABLE_ROWS ? table[table.length - 1].score : -1;
    for (const r of mine) {
      const there = table.find(e => e.name.toLowerCase() === r.name.toLowerCase());
      if ((there ? there.score : lowest) < r.score) await submitRecord(serverUrl, robot, r.name, r.score);
    }
  }));
}
