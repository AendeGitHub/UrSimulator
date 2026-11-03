import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts, me } from '../server/Accounts';
import { AccountRobots } from '../server/AccountRobots';
import { handleApi } from '../server/api';
import { Auth, DevProvider } from '../server/auth';
import { EmailAuth } from '../server/emailAuth';
import { Gallery } from '../server/Gallery';
import { Db, MemoryKv } from '../server/Kv';
import { Presence } from '../server/Presence';
import { FileStore, Records } from '../server/Records';
import { Replays } from '../server/Replays';
import { Stats } from '../server/Stats';
import { CLOUD_ROBOTS, type CloudRobot, type CloudRobots } from '../src/net/accountProtocol';
import { DEFAULT_BLUEPRINT, cleanBlueprint, type Blueprint } from '../src/robot/custom';

const { signInThroughBrowser } = createRequire(import.meta.url)('../desktop/signin.cjs') as {
  signInThroughBrowser(server: string, provider: string, open: (url: string) => unknown, timeout?: number): Promise<string | null>;
};

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ursim-${name}-`));
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 3)]);
const blueprint = (patch: Partial<Blueprint> = {}) => cleanBlueprint({ ...DEFAULT_BLUEPRINT, ...patch })!;
const withModel = (mesh = 'mesh0001') => blueprint({ mesh: { id: mesh, file: 'robot.glb', format: 'glb', scale: 0.001, up: 'z', turn: 0, signs: true } });
const robot = (id: string, saved: number, bp = blueprint()): CloudRobot => ({ id, blueprint: bp, saved });
const ACCOUNT = 'abcdefghijkl';

let servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a player's robots kept with their account", () => {
  it('keeps the newest version of each robot; an older one changes nothing', async () => {
    const store = new AccountRobots(new Db(new MemoryKv()), tmp('robots'), () => 10_000);
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 100, blueprint({ name: 'One' })), null)).toMatchObject({ saved: 100 });
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 200, blueprint({ name: 'Two' })), null)).toMatchObject({ saved: 200 });
    // From a computer that hadn't heard of the new version: the kept one comes back.
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 150, blueprint({ name: 'Old' })), null)).toMatchObject({ saved: 200, blueprint: { name: 'Two' } });
    expect((await store.list(ACCOUNT)).robots.map(r => r.blueprint.name)).toEqual(['Two']);
    // What a real game never sends.
    expect(await store.put(ACCOUNT, { ...robot('custom-bbbb2222', 100), id: '../x' }, null)).toBe('invalid');
    expect(await store.put(ACCOUNT, robot('custom-bbbb2222', 10_000 + 2 * 86_400_000), null)).toBe('invalid');
    expect(await store.put(ACCOUNT, { id: 'custom-bbbb2222', saved: 5, blueprint: 'robot' }, null)).toBe('invalid');
  });

  it('keeps a model file with the robot, asks for it when missing, and lets go of files no robot shows', async () => {
    const dir = tmp('robots');
    const store = new AccountRobots(new Db(new MemoryKv()), dir);
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 100, withModel('mesh0001')), null)).toBe('needModel');
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 100, withModel('mesh0001')), Buffer.from('this is not a GLB file at all'))).toBe('invalid');
    expect(await store.put(ACCOUNT, robot('custom-aaaa1111', 100, withModel('mesh0001')), GLB)).toMatchObject({ saved: 100 });
    // A copy of it shares the file.
    expect(await store.put(ACCOUNT, robot('custom-bbbb2222', 100, withModel('mesh0001')), null)).toMatchObject({ saved: 100 });
    expect((await store.list(ACCOUNT)).models).toEqual(['mesh0001']);
    expect(await store.model(ACCOUNT, 'mesh0001')).toEqual(GLB);
    expect(await store.model(ACCOUNT, 'nosuchmesh')).toBeNull();
    // The first changes to blocks: the file stays for the copy, then goes with it.
    await store.put(ACCOUNT, robot('custom-aaaa1111', 200), null);
    expect(fs.readdirSync(path.join(dir, ACCOUNT))).toEqual(['mesh0001.model']);
    await store.remove(ACCOUNT, 'custom-bbbb2222', 300);
    expect(fs.readdirSync(path.join(dir, ACCOUNT))).toEqual([]);
  });

  it('remembers deletions for the other computers, but a version saved after the deletion stays', async () => {
    const store = new AccountRobots(new Db(new MemoryKv()), tmp('robots'));
    await store.put(ACCOUNT, robot('custom-aaaa1111', 100), null);
    await store.put(ACCOUNT, robot('custom-bbbb2222', 500), null);
    expect(await store.remove(ACCOUNT, 'custom-aaaa1111', 200)).toBe(true);
    expect(await store.remove(ACCOUNT, 'custom-bbbb2222', 400)).toBe(false);
    const list = await store.list(ACCOUNT);
    expect(list.robots.map(r => r.id)).toEqual(['custom-bbbb2222']);
    expect(list.deleted).toEqual([{ id: 'custom-aaaa1111', at: 200 }]);
    // Made again: it lives.
    await store.put(ACCOUNT, robot('custom-aaaa1111', 300), null);
    expect((await store.list(ACCOUNT)).deleted).toEqual([]);
  });

  it(`keeps at most ${CLOUD_ROBOTS.robots} robots and ${CLOUD_ROBOTS.accountBytes / 1048576} MB of models an account`, async () => {
    const dir = tmp('robots');
    const store = new AccountRobots(new Db(new MemoryKv()), dir);
    for (let i = 0; i < CLOUD_ROBOTS.robots; i++) expect(typeof (await store.put(ACCOUNT, robot(`custom-robot${String(i).padStart(3, '0')}`, 100), null))).toBe('object');
    expect(await store.put(ACCOUNT, robot('custom-onemore1', 100), null)).toBe('limit');
    const other = 'zyxwvutsrqpo';
    const big = Buffer.concat([GLB, Buffer.alloc(CLOUD_ROBOTS.modelBytes - GLB.length)]);
    const fits = Math.floor(CLOUD_ROBOTS.accountBytes / big.length);
    for (let i = 0; i < fits; i++) expect(typeof (await store.put(other, robot(`custom-big${String(i).padStart(4, '0')}`, 100, withModel(`mesh${i}000`)), big))).toBe('object');
    expect(await store.put(other, robot('custom-bigone99', 100, withModel('mesh9999')), big)).toBe('full');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('goes over HTTP with the signed-in player only', async () => {
    const db = new Db(new MemoryKv());
    const accounts = new Accounts(db);
    const robots = new AccountRobots(db, tmp('robots'));
    const ctx = {
      accounts, robots, gallery: new Gallery(db, tmp('gallery')), stats: new Stats(db), presence: new Presence(run => setTimeout(run, 0)),
      auth: new Auth([new DevProvider()], accounts, 'http://localhost'), email: new EmailAuth(db, accounts), replays: new Replays(db, tmp('replays')),
      records: new Records(new FileStore(path.join(tmp('records'), 'r.json'))), roomOf: () => null,
    };
    const base = await listen((req, res) => void handleApi(req, res, new URL(req.url!, 'http://x'), ctx).then(done => !done && res.writeHead(404).end()));
    const max = await accounts.signIn('dev', 'max', 'Max');
    const auth = { authorization: `Bearer ${await accounts.createSession(max.id)}` };
    const pack = (value: object, file?: Buffer) => {
      const json = Buffer.from(JSON.stringify(value));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(json.length);
      return Buffer.concat([length, json, file ?? Buffer.alloc(0)]);
    };
    const put = (r: CloudRobot, file?: Buffer, headers: Record<string, string> = auth) => fetch(`${base}/api/robots/${r.id}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body: pack(r, file) });

    expect((await fetch(`${base}/api/robots`)).status).toBe(401);
    expect((await put(robot('custom-aaaa1111', 100), undefined, {})).status).toBe(401);
    // The robot's id must be the address's.
    expect((await fetch(`${base}/api/robots/custom-aaaa1111`, { method: 'POST', headers: auth, body: pack(robot('custom-bbbb2222', 100)) })).status).toBe(400);
    expect((await put(robot('custom-aaaa1111', 100, withModel('mesh0001')))).status).toBe(428);
    expect((await put(robot('custom-aaaa1111', 100, withModel('mesh0001')), GLB)).status).toBe(200);
    const list = (await (await fetch(`${base}/api/robots`, { headers: auth })).json()) as CloudRobots;
    expect(list).toMatchObject({ robots: [{ id: 'custom-aaaa1111', saved: 100 }], models: ['mesh0001'] });
    expect(Buffer.from(await (await fetch(`${base}/api/robots/model/mesh0001`, { headers: auth })).arrayBuffer())).toEqual(GLB);
    expect((await fetch(`${base}/api/robots/custom-aaaa1111?at=200`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect(((await (await fetch(`${base}/api/robots`, { headers: auth })).json()) as CloudRobots)).toMatchObject({ robots: [], deleted: [{ id: 'custom-aaaa1111', at: 200 }], models: [] });
  });
});

describe('signing up with a service', () => {
  it('a first Google sign-in asks for a name and @username, an e-mail sign-up does not, and picking them is done once', async () => {
    const db = new Db(new MemoryKv());
    const accounts = new Accounts(db);
    const google = await accounts.signIn('google', 'g-123', 'Max Sut');
    expect(me(google)).toMatchObject({ name: 'Max Sut', needsName: true });
    expect(me(await accounts.signIn('email', 'max@example.com', 'Max'))).not.toHaveProperty('needsName');
    // Keeping the names it was given counts as picking them.
    const kept = await accounts.update(google.id, { name: google.name, username: google.username });
    if (typeof kept === 'string') throw new Error(kept);
    expect(me(kept)).not.toHaveProperty('needsName');
    // Signing in again finds the same account, done.
    expect(me(await accounts.signIn('google', 'g-123', 'Max Sut'))).not.toHaveProperty('needsName');
  });

  it("the desktop app signs in in the player's browser and gets the session back on 127.0.0.1", async () => {
    const db = new Db(new MemoryKv());
    const accounts = new Accounts(db);
    let auth: Auth | null = null;
    const base = await listen((req, res) => void auth!.handle(req, res, new URL(req.url!, 'http://x')).then(done => !done && res.writeHead(404).end()));
    auth = new Auth([new DevProvider()], accounts, base);
    // The player's browser: the server's sign-in, the service's form, back to the app's page, whose script posts the token.
    const browser = async (start: string) => {
      const toForm = await fetch(start, { redirect: 'manual' });
      const state = new URL(toForm.headers.get('location')!, base).searchParams.get('state')!;
      const back = (await fetch(`${base}/auth/dev/callback?state=${encodeURIComponent(state)}&name=Max`, { redirect: 'manual' })).headers.get('location')!;
      const [pageUrl, hash] = back.split('#');
      expect(new URL(pageUrl).hostname).toBe('127.0.0.1');
      const html = await (await fetch(pageUrl)).text();
      const post = /fetch\('(\/token\/[0-9a-f]+)'/.exec(html)![1];
      // Another page on this computer can't guess where to post.
      expect((await fetch(new URL('/token/0000', pageUrl), { method: 'POST', body: 'ursim_token=forged' })).status).toBe(404);
      await fetch(new URL(post, pageUrl), { method: 'POST', body: hash });
    };
    const token = await signInThroughBrowser(base, 'dev', browser);
    expect(await accounts.session(token)).toMatchObject({ name: 'Max' });
    // A sign-in nobody finishes is given up.
    expect(await signInThroughBrowser(base, 'dev', () => undefined, 50)).toBeNull();
  });
});
