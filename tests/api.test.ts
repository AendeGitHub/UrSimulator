import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts } from '../server/Accounts';
import { handleApi, parseReport } from '../server/api';
import { Auth, DevProvider } from '../server/auth';
import { EmailAuth } from '../server/emailAuth';
import { AccountRobots } from '../server/AccountRobots';
import { Gallery } from '../server/Gallery';
import { Replays } from '../server/Replays';
import { Db, FileKv, MemoryKv } from '../server/Kv';
import { Presence, type PresenceSocket } from '../server/Presence';
import { FileStore, Records } from '../server/Records';
import { Stats } from '../server/Stats';
import type { CareerResponse, FriendsResponse, PresenceServerMessage } from '../src/net/accountProtocol';
import { periodsOf } from '../src/net/periods';

let server: http.Server | null = null;
afterEach(() => server?.close());

async function start(db = new Db(new MemoryKv())) {
  const accounts = new Accounts(db);
  const stats = new Stats(db);
  const presence = new Presence(run => setTimeout(run, 0));
  const auth = new Auth([new DevProvider()], accounts, 'http://localhost');
  const records = new Records(new FileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-')), 'records.json')));
  const email = new EmailAuth(db, accounts);
  const replays = new Replays(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-replays-')));
  const gallery = new Gallery(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-gallery-')), new Set(['mod']));
  const robots = new AccountRobots(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-robots-')));
  const ctx = { accounts, stats, presence, auth, email, replays, gallery, robots, records, roomOf: () => null };
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    handleApi(req, res, url, ctx).then(handled => !handled && res.writeHead(404).end());
  });
  await new Promise<void>(resolve => server!.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async <T>(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const signIn = async (name: string) => {
    const account = await accounts.signIn('dev', name.toLowerCase(), name);
    return { account, token: await accounts.createSession(account.id) };
  };
  return { call, signIn, presence, records, accounts, base, replays, gallery };
}

const soloMatch = (score: number) => ({ type: 'solo', mode: 'match', duration: 152, score: { red: score, blue: 0 }, players: [{ alliance: 'red', robot: 'uran-v2' }], ai: [], device: 'browser-0001' });
const season = periodsOf(new Date())[0];

describe('match archive', () => {
  const upload = { type: 'solo', robot: 'uran-v2', alliance: 'red', score: 120, opponent: 40, duration: 154.2, robots: { red1: 'uran-v2', blue1: 'bumble-v' }, names: { red1: 'Max' }, ai: ['blue1'], version: '1.3.0' };
  const body = (meta: object, data: Buffer = gzipSync(Buffer.from('URP1 recording'))) => {
    const json = Buffer.from(JSON.stringify(meta));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(json.length);
    return Buffer.concat([length, json, data]);
  };

  it("keeps a player's matches to watch again, for nobody else", async () => {
    const { base, call, signIn } = await start();
    const max = await signIn('Max');
    const ann = await signIn('Ann');
    const post = (b: Buffer, token?: string) => fetch(`${base}/api/replays`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(token && { authorization: `Bearer ${token}` }) }, body: b });
    const get = (id: string, token: string) => fetch(`${base}/api/replays/${id}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await post(body(upload))).status).toBe(401);
    expect((await post(body({ ...upload, robot: 'tank' }), max.token)).status).toBe(400);
    expect((await post(body(upload, Buffer.from('not gzip at all, honestly')), max.token)).status).toBe(400);
    const saved = (await (await post(body(upload), max.token)).json()) as { id: string };
    expect(saved).toMatchObject({ result: 'win', score: 120, opponent: 40, names: { red1: 'Max' }, ai: ['blue1'] });

    const list = await call<{ replays: { id: string }[] }>('GET', '/api/replays', undefined, max.token);
    expect(list.body.replays.map(r => r.id)).toEqual([saved.id]);
    const file = await get(saved.id, max.token);
    expect(gunzipSync(Buffer.from(await file.arrayBuffer())).toString()).toBe('URP1 recording');

    expect((await get(saved.id, ann.token)).status).toBe(404);
    expect((await call('GET', '/api/replays', undefined, ann.token)).body).toEqual({ replays: [] });
    expect((await call('DELETE', `/api/replays/${saved.id}`, undefined, ann.token)).status).toBe(404);
    expect((await call('DELETE', `/api/replays/${saved.id}`, undefined, max.token)).status).toBe(200);
    expect((await get(saved.id, max.token)).status).toBe(404);
  });

  it('keeps only the latest matches, and their files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-replays-'));
    const db = new Db(new MemoryKv());
    const replays = new Replays(db, dir);
    const account = 'abcdefghijkl';
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) ids.push((await replays.save(account, { ...upload, score: i } as never, gzipSync(Buffer.from(`match ${i}`)))).id);
    const list = await replays.list(account);
    expect(list).toHaveLength(30);
    expect(list[0].score).toBe(31);
    expect(await replays.read(account, ids[0])).toBeNull();
    expect(fs.readdirSync(path.join(dir, account))).toHaveLength(30);
    expect(gunzipSync((await replays.read(account, ids[31]))!).toString()).toBe('match 31');
  });
});

describe('accounts API', () => {
  it('signs up and in with an e-mail and a password, which is never stored as typed', async () => {
    const db = new Db(new MemoryKv());
    const { call } = await start(db);
    expect((await call<Record<string, boolean>>('GET', '/api/auth/providers')).body).toMatchObject({ email: true, dev: true });
    const signUp = (body: object) => call<{ token?: string; error?: string }>('POST', '/api/auth/email/register', body);
    expect((await signUp({ email: 'not-an-address', password: 'long enough', name: 'Max' })).body.error).toBe('badEmail');
    expect((await signUp({ email: 'max@example.com', password: 'short', name: 'Max' })).body.error).toBe('shortPassword');
    expect((await signUp({ email: 'max@example.com', password: 'long enough', name: ' ' })).body.error).toBe('noName');

    const made = await signUp({ email: ' Max@Example.com ', password: 'long enough', name: 'Max' });
    expect(made.status).toBe(200);
    const me = await call<{ name: string; username: string; providers: string[] }>('GET', '/api/me', undefined, made.body.token);
    expect(me.body).toMatchObject({ name: 'Max', username: 'max', providers: ['email'] });
    // Nobody sees the address, and the password is only a hash.
    expect(JSON.stringify(me.body)).not.toContain('example.com');
    const stored = await db.read<{ hash: string }>('password:max@example.com');
    expect(stored!.hash).toMatch(/^scrypt\$/);
    expect(stored!.hash).not.toContain('long enough');

    const again = await signUp({ email: 'max@example.com', password: 'another one', name: 'Max 2' });
    expect([again.status, again.body.error]).toEqual([409, 'emailTaken']);

    const signIn = (email: string, password: string) => call<{ token?: string; error?: string }>('POST', '/api/auth/email/login', { email, password });
    expect((await signIn('max@example.com', 'wrong password')).status).toBe(401);
    expect((await signIn('nobody@example.com', 'long enough')).body.error).toBe('wrongPassword');
    const back = await signIn('MAX@example.com', 'long enough');
    expect(back.status).toBe(200);
    expect((await call<{ username: string }>('GET', '/api/me', undefined, back.body.token)).body.username).toBe('max');
  });

  it('makes an address wait after many wrong passwords, and only that address', async () => {
    const time = { ms: 0 };
    const db = new Db(new MemoryKv());
    const email = new EmailAuth(db, new Accounts(db), () => time.ms);
    await email.register('a@b.kz', 'right password', 'A');
    await email.register('c@d.kz', 'other password', 'C');
    for (let i = 0; i < 10; i++) expect(await email.login('a@b.kz', `guess ${i}!!`)).toEqual({ error: 'wrongPassword' });
    expect(await email.login('a@b.kz', 'right password')).toEqual({ error: 'tooMany' });
    expect(await email.login('c@d.kz', 'other password')).toHaveProperty('token');
    time.ms += 16 * 60_000;
    expect(await email.login('a@b.kz', 'right password')).toHaveProperty('token');
  });

  it('counts a guest\'s and a signed-in player\'s games and shows them in the tables and the career', async () => {
    const { call, signIn, records } = await start();
    const max = await signIn('Max');
    expect((await call('POST', '/api/games', soloMatch(110), max.token)).body).toEqual({ rank: 1, best: 110, improved: true });
    await call('POST', '/api/games', { ...soloMatch(90), device: 'browser-0002', name: 'Guest' });
    // Without a name a guest's game only counts in the totals.
    await call('POST', '/api/games', { ...soloMatch(300), device: 'browser-0003' });
    await call('POST', '/api/games', { type: 'practice', mode: 'practice', duration: 61, players: [{ alliance: 'blue', robot: 'bumble-v' }], ai: [], device: 'browser-0001' }, max.token);

    const totals = (await call<{ players: number; accounts: number; games: Record<string, number>; signedInGames: number; online: number }>('GET', '/api/stats')).body;
    expect(totals).toMatchObject({ players: 3, accounts: 1, games: { solo: 3, practice: 1 }, signedInGames: 2, online: 0 });

    const board = (await call<{ entries: { name: string; username?: string; score: number }[] }>('GET', `/api/leaderboard?period=${season}&kind=solo&robot=all`)).body.entries;
    expect(board.map(e => [e.name, e.username, e.score])).toEqual([['Max', 'max', 110], ['Guest', undefined, 90]]);
    // The all-time table older versions show gets the runs too.
    expect((await records.top('uran-v2')).map(e => e.name)).toEqual(['Max', 'Guest']);

    const career = (await call<CareerResponse>('GET', '/api/career?period=all', undefined, max.token)).body;
    expect(career.account.username).toBe('max');
    expect(career.stats).toMatchObject({ games: 2, best: 110, playtime: 213 });
    expect(career.history.map(e => e.type)).toEqual(['practice', 'solo']);
    // Anyone can look at a player's career by @username.
    expect((await call<CareerResponse>('GET', `/api/career?user=max&period=${season}`)).body.stats.games).toBe(2);
    expect((await call('GET', '/api/career')).status).toBe(401);
    expect((await call('GET', '/api/career?user=nobody')).status).toBe(404);
  });

  it('refuses reports that no real game sends', async () => {
    const { call } = await start();
    expect((await call('POST', '/api/games', { ...soloMatch(100), type: '1v1' })).status).toBe(400);
    expect((await call('POST', '/api/games', { ...soloMatch(100), score: { red: 99999, blue: 0 } })).status).toBe(400);
    expect((await call('POST', '/api/games', { ...soloMatch(100), players: [{ alliance: 'green', robot: 'uran-v2' }] })).status).toBe(400);
    expect((await call('POST', '/api/games', { ...soloMatch(100), device: '!' })).status).toBe(400);
    expect(parseReport({ ...soloMatch(100), duration: 1e9 })?.duration).toBe(4 * 3600);
  });

  it('shows and changes the signed-in player; signing out ends the session', async () => {
    const { call, signIn } = await start();
    const max = await signIn('Max');
    await signIn('Sasha');
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect((await call('GET', '/api/me', undefined, max.token)).body).toMatchObject({ name: 'Max', username: 'max', providers: ['dev'] });
    expect((await call('PATCH', '/api/me', { username: 'sasha' }, max.token)).status).toBe(409);
    expect((await call('PATCH', '/api/me', { username: 'max 2' }, max.token)).status).toBe(400);
    expect((await call('PATCH', '/api/me', { username: 'maxk', name: 'Max K' }, max.token)).body).toMatchObject({ username: 'maxk', name: 'Max K' });
    await call('POST', '/api/auth/logout', {}, max.token);
    expect((await call('GET', '/api/me', undefined, max.token)).status).toBe(401);
  });

  it('adds friends, tells them, and shows who is online', async () => {
    const { call, signIn, presence } = await start();
    const max = await signIn('Max');
    const sasha = await signIn('Sasha');
    const messages: PresenceServerMessage[] = [];
    const socket: PresenceSocket = { send: m => messages.push(m) };
    const id = presence.connect(socket)!;
    presence.identify(id, 'browser-sasha', { id: sasha.account.id, friends: [] });

    expect((await call<{ result: string }>('POST', '/api/friends', { username: '@sasha' }, max.token)).body.result).toBe('sent');
    expect(messages.some(m => m.t === 'friends')).toBe(true);
    const pending = (await call<FriendsResponse>('GET', '/api/friends', undefined, sasha.token)).body;
    expect(pending.incoming.map(a => a.username)).toEqual(['max']);
    const accepted = (await call<FriendsResponse & { result: string }>('POST', '/api/friends/accept', { id: max.account.id }, sasha.token)).body;
    expect(accepted.friends).toEqual([expect.objectContaining({ username: 'max', online: false, room: null })]);
    expect((await call<FriendsResponse>('GET', '/api/friends', undefined, max.token)).body.friends).toEqual([expect.objectContaining({ username: 'sasha', online: true })]);
    await call('POST', '/api/friends/remove', { id: sasha.account.id }, max.token);
    expect((await call<FriendsResponse>('GET', '/api/friends', undefined, sasha.token)).body.friends).toEqual([]);
    expect((await call('POST', '/api/friends', { username: 'sasha' })).status).toBe(401);
  });

  it('keeps accounts and statistics across a server restart (file storage)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ursim-')), 'db.json');
    const first = await start(new Db(new FileKv(file)));
    const max = await first.signIn('Max');
    await first.call('POST', '/api/games', soloMatch(77), max.token);
    server!.close();
    const again = await start(new Db(new FileKv(file)));
    expect((await again.call('GET', '/api/me', undefined, max.token)).body).toMatchObject({ username: 'max' });
    expect((await again.call<{ games: { solo: number } }>('GET', '/api/stats')).body.games.solo).toBe(1);
  });
});

describe('who is online', () => {
  it('counts browsers once however many tabs, and the signed-in players among them', async () => {
    const presence = new Presence(run => (run(), setTimeout(() => undefined, 0)));
    const sent: PresenceServerMessage[] = [];
    const socket = { send: (m: PresenceServerMessage) => sent.push(m) };
    const a = presence.connect(socket)!;
    const b = presence.connect(socket)!;
    const c = presence.connect(socket)!;
    presence.identify(a, 'browser-a', { id: 'max', friends: ['sasha'] });
    presence.identify(b, 'browser-a', { id: 'max', friends: ['sasha'] });
    presence.identify(c, 'browser-c', null);
    expect(presence.counts()).toEqual({ online: 2, signedIn: 1 });
    expect(presence.isOnline('max')).toBe(true);
    const sasha = presence.connect(socket)!;
    presence.identify(sasha, 'browser-s', { id: 'sasha', friends: ['max'] });
    sent.length = 0;
    // Max closes one tab: still online. The other: Sasha hears about it.
    presence.disconnect(a);
    expect(sent.filter(m => m.t === 'friends')).toHaveLength(0);
    presence.disconnect(b);
    expect(sent.filter(m => m.t === 'friends')).toHaveLength(1);
    expect(presence.counts()).toEqual({ online: 2, signedIn: 1 });
  });
});
