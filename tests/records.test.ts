import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, RECORDS_LIMIT, Records, UpstashStore, type RecordEntry, type RecordsStore } from '../server/Records';
import { recordsUrl } from '../src/net/records';

class MemoryStore implements RecordsStore {
  readonly tables = new Map<string, RecordEntry[]>();
  async load(robot: string) {
    return structuredClone(this.tables.get(robot) ?? []);
  }
  async save(robot: string, entries: RecordEntry[]) {
    this.tables.set(robot, structuredClone(entries));
  }
}

describe('high scores', () => {
  it('keeps one record per player: a better score replaces the old one, a worse one is ignored', async () => {
    const records = new Records(new MemoryStore());
    expect(await records.submit('uran-v1', 'Max', 200)).toEqual({ rank: 1, best: 200, improved: true });
    expect(await records.submit('uran-v1', 'Sasha', 220)).toMatchObject({ rank: 1, improved: true });
    expect(await records.submit('uran-v1', 'max', 150)).toEqual({ rank: 2, best: 200, improved: false });
    expect(await records.submit('uran-v1', 'Max', 250)).toEqual({ rank: 1, best: 250, improved: true });
    const top = await records.top('uran-v1');
    expect(top.map(e => [e.name, e.score])).toEqual([['Max', 250], ['Sasha', 220]]);
  });

  it('keeps separate tables per robot and only the top 100', async () => {
    const store = new MemoryStore();
    const records = new Records(store);
    for (let i = 0; i < RECORDS_LIMIT + 5; i++) await records.submit('uran-v1', `P${i}`, i);
    await records.submit('other', 'Max', 10);
    const top = await records.top('uran-v1');
    expect(top).toHaveLength(RECORDS_LIMIT);
    expect(top[0].score).toBe(RECORDS_LIMIT + 4);
    expect(top.at(-1)!.score).toBe(5);
    expect(await records.submit('uran-v1', 'Low', 1)).toMatchObject({ rank: null, improved: true });
    expect(store.tables.get('other')).toHaveLength(1);
  });

  it('handles submissions that arrive at the same time without losing any', async () => {
    const records = new Records(new MemoryStore());
    await Promise.all(['A', 'B', 'C', 'D'].map((n, i) => records.submit('uran-v1', n, 100 + i)));
    expect((await records.top('uran-v1')).map(e => e.name)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('stores tables in a JSON file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-')), 'data', 'records.json');
    await new Records(new FileStore(file)).submit('uran-v1', 'Max', 120);
    const again = new Records(new FileStore(file));
    expect((await again.top('uran-v1'))[0]).toMatchObject({ name: 'Max', score: 120 });
  });

  it('talks to Upstash with GET / SET commands', async () => {
    const db = new Map<string, string>();
    const calls: string[][] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const args = JSON.parse(String(init.body)) as string[];
      calls.push(args);
      const result = args[0] === 'GET' ? db.get(args[1]) ?? null : (db.set(args[1], args[2]), 'OK');
      return new Response(JSON.stringify({ result }));
    }) as typeof fetch;
    const records = new Records(new UpstashStore('https://example.upstash.io', 'token', fakeFetch));
    await records.submit('uran-v1', 'Max', 90);
    expect((await records.top('uran-v1'))[0].score).toBe(90);
    expect(calls.map(c => c[0])).toEqual(['GET', 'SET', 'GET']);
    expect(calls[0][1]).toBe('ursim:records:uran-v1');
  });

  it('finds the records API next to the WebSocket server', () => {
    expect(recordsUrl('wss://ursim.onrender.com/ws')).toBe('https://ursim.onrender.com/api/records');
    expect(recordsUrl('ws://localhost:8787/ws')).toBe('http://localhost:8787/api/records');
  });
});
