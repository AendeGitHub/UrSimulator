import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts, SESSION_TTL } from '../server/Accounts';
import { Db, FileKv, MemoryKv, UpstashKv } from '../server/Kv';
import { isUsername, usernameFrom } from '../src/net/accountProtocol';

/** Predictable "random" bytes so ids and tokens differ between calls. */
function counter() {
  let n = 0;
  return (bytes: number) => Buffer.from(Array.from({ length: bytes }, (_, i) => (n * 7 + i * 13 + 1) % 256).map((b, i) => (i === 0 ? n++ % 256 : b)));
}

describe('storage', () => {
  it('forgets keys after their time to live and adds only missing ones', async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    await kv.set('a', '1', 10);
    expect(await kv.get('a')).toBe('1');
    expect(await kv.add('a', '2')).toBe(false);
    now = 10_001;
    expect(await kv.get('a')).toBeNull();
    expect(await kv.add('a', '3')).toBe(true);
    expect(await kv.get('a')).toBe('3');
  });

  it('lists the keys with a prefix that are still kept', async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    await kv.set('account:a', '1');
    await kv.set('account:b', '2', 10);
    await kv.set('identity:google:1', 'a');
    expect(await kv.keys('account:')).toEqual(['account:a', 'account:b']);
    now = 10_001;
    expect(await kv.keys('account:')).toEqual(['account:a']);
  });

  it('keeps everything in a file that survives a restart', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-')), 'data', 'db.json');
    const accounts = new Accounts(new Db(new FileKv(file)));
    const max = await accounts.signIn('google', 'g-1', 'Max');
    const token = await accounts.createSession(max.id);
    const again = new Accounts(new Db(new FileKv(file)));
    expect((await again.session(token))?.id).toBe(max.id);
    expect((await again.byUsername('@max'))?.name).toBe('Max');
  });

  it('talks to Upstash with GET / SET (EX, NX) / DEL / SCAN under ursim:', async () => {
    const calls: string[][] = [];
    const db = new Map<string, string>();
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const args = JSON.parse(String(init.body)) as string[];
      calls.push(args);
      let result: unknown = null;
      if (args[0] === 'GET') result = db.get(args[1]) ?? null;
      if (args[0] === 'SET') {
        if (args.includes('NX') && db.has(args[1])) result = null;
        else {
          db.set(args[1], args[2]);
          result = 'OK';
        }
      }
      if (args[0] === 'DEL') db.delete(args[1]);
      if (args[0] === 'SCAN') {
        const keys = [...db.keys()].filter(k => k.startsWith(args[3].slice(0, -1)));
        // Two pages, the second one repeating a key of the first.
        result = args[1] === '0' ? ['7', keys.slice(0, 1)] : ['0', keys];
      }
      return new Response(JSON.stringify({ result }));
    }) as typeof fetch;
    const kv = new UpstashKv('https://example.upstash.io', 'token', fakeFetch);
    await kv.set('session:x', 'acc', SESSION_TTL);
    expect(await kv.add('username:max', 'acc')).toBe(true);
    expect(await kv.add('username:max', 'other')).toBe(false);
    expect(await kv.get('session:x')).toBe('acc');
    await kv.del('session:x');
    expect(await kv.get('session:x')).toBeNull();
    expect(calls[0]).toEqual(['SET', 'ursim:session:x', 'acc', 'EX', String(SESSION_TTL)]);
    expect(calls[1]).toEqual(['SET', 'ursim:username:max', 'acc', 'NX']);
    await kv.add('username:sasha', 'acc2');
    expect(await kv.keys('username:')).toEqual(['username:max', 'username:sasha']);
    expect(calls.at(-1)).toEqual(['SCAN', '7', 'MATCH', 'ursim:username:*', 'COUNT', '1000']);
  });
});

describe('accounts', () => {
  it('makes an account on the first sign-in and finds it on the next ones', async () => {
    const accounts = new Accounts(new Db(new MemoryKv()), counter());
    const first = await accounts.signIn('google', 'g-1', 'Khussein Maxut');
    const again = await accounts.signIn('google', 'g-1', 'Someone Else');
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ username: 'khusseinmaxut', name: 'Khussein Maxut', identities: { google: 'g-1' } });
    // The same name signing in with another Google account gets a username of its own.
    expect((await accounts.signIn('google', 'g-2', 'Khussein Maxut')).username).toBe('khusseinmaxut2');
  });

  it('counts the accounts made, and once the ones made before the count', async () => {
    const db = new Db(new MemoryKv());
    const accounts = new Accounts(db, counter());
    await accounts.signIn('google', 'g-1', 'Max');
    await accounts.signIn('google', 'g-1', 'Max');
    await accounts.signIn('email', 'sasha@mail.kz', 'Sasha');
    expect(await accounts.count()).toBe(2);
    // A database from before the count.
    await db.del('count:accounts');
    await accounts.backfill();
    await accounts.backfill();
    await accounts.signIn('google', 'g-3', 'Ann');
    expect(await accounts.count()).toBe(3);
  });

  it('makes usernames from any name', () => {
    expect(usernameFrom('Хусейн Max')).toBe('khuseynmax');
    expect(usernameFrom('Әлия Қасым')).toBe('aliyaqasym');
    expect(usernameFrom('José_92')).toBe('jose_92');
    expect(isUsername(usernameFrom('a'.repeat(40)))).toBe(true);
    expect(usernameFrom('!!!')).toBe('');
  });

  it('gives a name without letters a playerN username', async () => {
    const accounts = new Accounts(new Db(new MemoryKv()), counter());
    expect((await accounts.signIn('google', 'g-1', '★')).username).toBe('player');
    expect((await accounts.signIn('google', 'g-2', '')).username).toBe('player2');
  });

  it('keeps a browser signed in with a token and signs it out', async () => {
    const accounts = new Accounts(new Db(new MemoryKv()), counter());
    const max = await accounts.signIn('google', 'g-1', 'Max');
    const token = await accounts.createSession(max.id);
    expect((await accounts.session(token))?.id).toBe(max.id);
    expect(await accounts.session('not-a-real-token-at-all')).toBeNull();
    expect(await accounts.session(undefined)).toBeNull();
    await accounts.endSession(token);
    expect(await accounts.session(token)).toBeNull();
  });

  it('changes the name and the @username, refusing taken or invalid ones', async () => {
    const accounts = new Accounts(new Db(new MemoryKv()), counter());
    const max = await accounts.signIn('google', 'g-1', 'Max');
    await accounts.signIn('google', 'g-2', 'Sasha');
    expect(await accounts.update(max.id, { username: 'sasha' })).toBe('taken');
    expect(await accounts.update(max.id, { username: 'A!' })).toBe('invalid');
    expect(await accounts.update(max.id, { name: '   ' })).toBe('invalid');
    const renamed = await accounts.update(max.id, { username: '@Max_K', name: '  Max   K ' });
    expect(renamed).toMatchObject({ username: 'max_k', name: 'Max K' });
    expect((await accounts.byUsername('max_k'))?.id).toBe(max.id);
    // The old username is free again.
    expect(await accounts.byUsername('max')).toBeNull();
    expect(await accounts.update((await accounts.signIn('google', 'g-3', 'New')).id, { username: 'max' })).toMatchObject({ username: 'max' });
  });
});

describe('friends', () => {
  async function three() {
    const accounts = new Accounts(new Db(new MemoryKv()), counter());
    const a = await accounts.signIn('google', 'a', 'Anna');
    const b = await accounts.signIn('google', 'b', 'Boris');
    const c = await accounts.signIn('google', 'c', 'Chen');
    return { accounts, a, b, c };
  }

  it('sends a request by @username; accepting makes both friends', async () => {
    const { accounts, a, b } = await three();
    expect(await accounts.request(a.id, '@boris')).toBe('sent');
    expect(await accounts.request(a.id, 'boris')).toBe('already');
    expect((await accounts.byId(b.id))!.incoming).toEqual([a.id]);
    expect((await accounts.byId(a.id))!.outgoing).toEqual([b.id]);
    expect(await accounts.accept(b.id, a.id)).toBe(true);
    const [a2, b2] = await accounts.many([a.id, b.id]);
    expect(a2).toMatchObject({ friends: [b.id], outgoing: [], incoming: [] });
    expect(b2).toMatchObject({ friends: [a.id], outgoing: [], incoming: [] });
  });

  it('asking someone who already asked makes friends straight away', async () => {
    const { accounts, a, b } = await three();
    await accounts.request(a.id, 'boris');
    expect(await accounts.request(b.id, 'anna')).toBe('accepted');
    expect((await accounts.byId(a.id))!.friends).toEqual([b.id]);
  });

  it('refuses unknown players and oneself; declining and removing clear both sides', async () => {
    const { accounts, a, b, c } = await three();
    expect(await accounts.request(a.id, 'nobody')).toBe('unknown');
    expect(await accounts.request(a.id, 'anna')).toBe('self');
    await accounts.request(a.id, 'boris');
    expect(await accounts.remove(b.id, a.id)).toBe(true);
    expect((await accounts.byId(a.id))!.outgoing).toEqual([]);
    expect((await accounts.byId(b.id))!.incoming).toEqual([]);
    // Accepting a request that was never sent does nothing.
    expect(await accounts.accept(c.id, a.id)).toBe(false);
    await accounts.request(a.id, 'chen');
    await accounts.accept(c.id, a.id);
    await accounts.remove(a.id, c.id);
    expect((await accounts.byId(c.id))!.friends).toEqual([]);
  });

  it('a rename and a friend request at the same time both stick', async () => {
    const { accounts, a } = await three();
    await Promise.all([accounts.update(a.id, { name: 'Anna K' }), accounts.request(a.id, 'boris'), accounts.request(a.id, 'chen')]);
    expect(await accounts.byId(a.id)).toMatchObject({ name: 'Anna K', outgoing: expect.arrayContaining([expect.any(String), expect.any(String)]) });
  });
});
