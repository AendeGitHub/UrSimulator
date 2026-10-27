import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, RECORDS_LIMIT, Records, UpstashStore, type RecordEntry, type RecordsStore } from '../server/Records';
import { recordsUrl, rememberRecord, restoreRecords, savedRecords } from '../src/net/records';

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
    expect(await records.submit('uran-v2', 'Max', 200)).toEqual({ rank: 1, best: 200, improved: true });
    expect(await records.submit('uran-v2', 'Sasha', 220)).toMatchObject({ rank: 1, improved: true });
    expect(await records.submit('uran-v2', 'max', 150)).toEqual({ rank: 2, best: 200, improved: false });
    expect(await records.submit('uran-v2', 'Max', 250)).toEqual({ rank: 1, best: 250, improved: true });
    const top = await records.top('uran-v2');
    expect(top.map(e => [e.name, e.score])).toEqual([['Max', 250], ['Sasha', 220]]);
  });

  it('keeps separate tables per robot and only the top 100', async () => {
    const store = new MemoryStore();
    const records = new Records(store);
    for (let i = 0; i < RECORDS_LIMIT + 5; i++) await records.submit('uran-v2', `P${i}`, i);
    await records.submit('other', 'Max', 10);
    const top = await records.top('uran-v2');
    expect(top).toHaveLength(RECORDS_LIMIT);
    expect(top[0].score).toBe(RECORDS_LIMIT + 4);
    expect(top.at(-1)!.score).toBe(5);
    expect(await records.submit('uran-v2', 'Low', 1)).toMatchObject({ rank: null, improved: true });
    expect(store.tables.get('other')).toHaveLength(1);
  });

  it('handles submissions that arrive at the same time without losing any', async () => {
    const records = new Records(new MemoryStore());
    await Promise.all(['A', 'B', 'C', 'D'].map((n, i) => records.submit('uran-v2', n, 100 + i)));
    expect((await records.top('uran-v2')).map(e => e.name)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('stores tables in a JSON file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-')), 'data', 'records.json');
    await new Records(new FileStore(file)).submit('uran-v2', 'Max', 120);
    const again = new Records(new FileStore(file));
    expect((await again.top('uran-v2'))[0]).toMatchObject({ name: 'Max', score: 120 });
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
    await records.submit('uran-v2', 'Max', 90);
    expect((await records.top('uran-v2'))[0].score).toBe(90);
    expect(calls.map(c => c[0])).toEqual(['GET', 'SET', 'GET']);
    expect(calls[0][1]).toBe('ursim:records:uran-v2');
  });

  it('finds the records API on the game server', () => {
    expect(recordsUrl('https://ursim.onrender.com')).toBe('https://ursim.onrender.com/api/records');
    expect(recordsUrl('http://localhost:8787/')).toBe('http://localhost:8787/api/records');
    // Addresses saved by versions with online rooms
    expect(recordsUrl('wss://ursim.onrender.com/ws')).toBe('https://ursim.onrender.com/api/records');
  });
});

describe('high scores kept in the browser', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("keeps each player's best per robot", () => {
    const storage = memory();
    rememberRecord('bumble-v', 'Max', 120, storage);
    rememberRecord('bumble-v', 'max', 90, storage);
    rememberRecord('bumble-v', 'Sasha', 50, storage);
    rememberRecord('bumble-v', 'MAX', 150, storage);
    expect(savedRecords(storage)['bumble-v']).toEqual([{ name: 'Sasha', score: 50 }, { name: 'MAX', score: 150 }]);
  });

  it('sends a restarted server the bests its table lost, and nothing it still has', async () => {
    const server = new Records(new MemoryStore());
    await server.submit('bumble-v', 'Sasha', 70);
    const posts: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const robot = new URL(url).searchParams.get('robot');
      if (!init) return new Response(JSON.stringify({ robot, entries: await server.top(robot!) }));
      const body = JSON.parse(String(init.body));
      posts.push(`${body.name} ${body.score}`);
      return new Response(JSON.stringify(await server.submit(body.robot, body.name, body.score)));
    }) as typeof fetch;
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      await restoreRecords('https://example.test', ['bumble-v', 'uran-v2'], { 'bumble-v': [{ name: 'Max', score: 228 }, { name: 'Sasha', score: 60 }] });
    } finally {
      globalThis.fetch = real;
    }
    expect(posts).toEqual(['Max 228']);
    expect((await server.top('bumble-v')).map(e => `${e.name} ${e.score}`)).toEqual(['Max 228', 'Sasha 70']);
  });
});
