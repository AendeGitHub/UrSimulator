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
