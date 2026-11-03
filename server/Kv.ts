// Storage for accounts, sessions, statistics and the period leaderboards: a key-value store, kept
// like the high scores (server/Records.ts) — a JSON file by default, an Upstash Redis database
// when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. Free Render wipes its disk on
// every restart, so accounts only last there with Upstash.

import fs from 'node:fs';
import path from 'node:path';

export interface Kv {
  get(key: string): Promise<string | null>;
  /** `ttl`: forget the key after this many seconds */
  set(key: string, value: string, ttl?: number): Promise<void>;
  /** Sets the key only if it is missing; true when it did. */
  add(key: string, value: string): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Every key starting with `prefix` (counting what was saved before a count was kept) */
  keys(prefix: string): Promise<string[]>;
}

interface Item {
  v: string;
  /** Expiry, ms since 1970 */
  e?: number;
}

/** Keys in memory: tests, and the base of the file store. */
export class MemoryKv implements Kv {
  protected items = new Map<string, Item>();

  constructor(protected readonly now: () => number = Date.now) {}

  private live(key: string): Item | null {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.e !== undefined && item.e <= this.now()) {
      this.items.delete(key);
      return null;
    }
    return item;
  }

  protected changed(): void {}

  async get(key: string): Promise<string | null> {
    return this.live(key)?.v ?? null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    this.items.set(key, ttl ? { v: value, e: this.now() + ttl * 1000 } : { v: value });
    this.changed();
  }

  async add(key: string, value: string): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    if (this.items.delete(key)) this.changed();
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.items.keys()].filter(key => key.startsWith(prefix) && this.live(key));
  }
}

/** Every key in one JSON file, rewritten (write, then rename) after each change. */
export class FileKv extends MemoryKv {
  constructor(private readonly file: string, now: () => number = Date.now) {
    super(now);
    try {
      this.items = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Item>));
    } catch {
      // No file yet (or an unreadable one): start empty.
    }
  }

  protected override changed(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.items)));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Upstash's REST API, in the same database as the high scores (keys start with ursim:). */
export class UpstashKv implements Kv {
  constructor(private readonly url: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  }

  async get(key: string): Promise<string | null> {
    const value = await this.command(['GET', `ursim:${key}`]);
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    await this.command(ttl ? ['SET', `ursim:${key}`, value, 'EX', Math.ceil(ttl)] : ['SET', `ursim:${key}`, value]);
  }

  async add(key: string, value: string): Promise<boolean> {
    return (await this.command(['SET', `ursim:${key}`, value, 'NX'])) === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', `ursim:${key}`]);
  }

  async keys(prefix: string): Promise<string[]> {
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = (await this.command(['SCAN', cursor, 'MATCH', `ursim:${prefix}*`, 'COUNT', 1000])) as [string, string[]];
      cursor = String(next);
      // SCAN may return a key twice.
      for (const key of batch) keys.add(key.slice('ursim:'.length));
    } while (cursor !== '0');
    return [...keys];
  }
}

/** JSON values on top of a Kv; changes to one key run one after another. */
export class Db {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(readonly kv: Kv) {}

  async read<T>(key: string): Promise<T | null> {
    const text = await this.kv.get(key);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  write(key: string, value: unknown, ttl?: number): Promise<void> {
    return this.kv.set(key, JSON.stringify(value), ttl);
  }

  add(key: string, value: unknown): Promise<boolean> {
    return this.kv.add(key, JSON.stringify(value));
  }

  del(key: string): Promise<void> {
    return this.kv.del(key);
  }

  keys(prefix: string): Promise<string[]> {
    return this.kv.keys(prefix);
  }

  /** Runs `run` after every earlier job on the same lock (a key, or any name). */
  locked<T>(lock: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queue.get(lock) ?? Promise.resolve()).then(run, run);
    const tail = result.catch(() => undefined);
    this.queue.set(lock, tail);
    // Forget finished locks, so the map doesn't grow with every key ever changed.
    void tail.then(() => this.queue.get(lock) === tail && this.queue.delete(lock));
    return result;
  }

  /** Reads a value, changes it and writes it back, with no other change to the key in between. */
  update<T>(key: string, change: (old: T | null) => T, ttl?: number): Promise<T> {
    return this.locked(key, async () => {
      const next = change(await this.read<T>(key));
      await this.write(key, next, ttl);
      return next;
    });
  }
}

/** Upstash when configured, otherwise a file next to the server (DB_FILE moves it). */
export function createDb(root: string, env: NodeJS.ProcessEnv = process.env): { db: Db; storage: string } {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { db: new Db(new UpstashKv(url, token)), storage: 'upstash' };
  const file = env.DB_FILE ?? path.join(root, 'data', 'db.json');
  return { db: new Db(new FileKv(file)), storage: file };
}
