import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts, type Account } from '../server/Accounts';
import { AccountRobots } from '../server/AccountRobots';
import { handleApi } from '../server/api';
import { Auth, DevProvider } from '../server/auth';
import { EmailAuth } from '../server/emailAuth';
import { Gallery, readThumb } from '../server/Gallery';
import { Db, MemoryKv } from '../server/Kv';
import { Presence } from '../server/Presence';
import { FileStore, Records } from '../server/Records';
import { Replays } from '../server/Replays';
import { Stats } from '../server/Stats';
import { GALLERY, type GalleryPage, type GalleryRobot } from '../src/net/galleryProtocol';
import { DEFAULT_BLUEPRINT, cleanBlueprint, type Blueprint } from '../src/robot/custom';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ursim-${name}-`));
/** The smallest files that look like what they say */
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(24, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\u001a\n'), Buffer.alloc(24, 1)]);
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 2)]);
const picture = (data = WEBP, type = 'image/webp') => `data:${type};base64,${data.toString('base64')}`;
const blueprint = (patch: Partial<Blueprint> = {}) => cleanBlueprint({ ...DEFAULT_BLUEPRINT, ...patch })!;
const withModel = (patch: Partial<Blueprint> = {}) => blueprint({ ...patch, mesh: { id: 'local1234', file: 'robot.glb', format: 'glb', scale: 0.001, up: 'z', turn: 1, signs: true } });

async function setup(moderators = ['mod']) {
  const db = new Db(new MemoryKv());
  const accounts = new Accounts(db);
  const dir = tmp('gallery');
  const gallery = new Gallery(db, dir, new Set(moderators));
  const player = async (name: string): Promise<Account> => accounts.signIn('dev', name.toLowerCase(), name);
  return { db, accounts, gallery, dir, player };
}

describe('the robot gallery', () => {
  it('publishes a robot with its picture and 3D model; publishing it again updates it in its place', async () => {
    const { gallery, dir, player } = await setup();
    const max = await player('Max');
    const ann = await player('Ann');
    const first = await gallery.publish(max, { source: 'custom-aaaa1111', blueprint: withModel({ name: 'Rocket', team: 'URAN92' }), thumb: picture() }, GLB);
    if (typeof first === 'string') throw new Error(first);
    expect(first).toMatchObject({ name: 'Rocket', team: 'URAN92', author: { username: 'max' }, added: 0, hidden: false, model: { format: 'glb', size: GLB.length } });
    // Its model is the gallery's file now.
    expect(first.blueprint.mesh).toMatchObject({ id: `gal${first.id}`, format: 'glb', scale: 0.001, up: 'z', turn: 1 });
    expect(await gallery.model(first.id, null)).toEqual(GLB);
    expect(await gallery.thumb(first.id)).toEqual({ data: WEBP, type: 'image/webp' });

    const second = await gallery.publish(ann, { source: 'custom-bbbb2222', blueprint: blueprint({ name: 'Bee' }), thumb: picture(PNG, 'image/png') }, null);
    if (typeof second === 'string') throw new Error(second);
    expect(second.model).toBeNull();
    expect(second.blueprint.mesh).toBeNull();

    // A new version: same id, its place kept, no model any more.
    const again = await gallery.publish(max, { source: 'custom-aaaa1111', blueprint: blueprint({ name: 'Rocket 2' }), thumb: picture() }, null);
    if (typeof again === 'string') throw new Error(again);
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(first.created);
    expect(again.model).toBeNull();
    expect(fs.existsSync(path.join(dir, `${first.id}.model`))).toBe(false);
    const page = await gallery.list({ sort: 'new' }, null);
    expect(page.robots.map(r => r.name)).toEqual(['Bee', 'Rocket 2']);
    expect(page.total).toBe(2);
    // The list never shows what only the server needs.
    expect(Object.keys(page.robots[0])).not.toContain('source');
  });

  it('takes only what a real game sends: a clean blueprint, a small WebP, PNG or JPEG, a model like its format', async () => {
    const { gallery, player } = await setup();
    const max = await player('Max');
    const publish = (upload: object, model: Buffer | null = null) => gallery.publish(max, { source: 'custom-aaaa1111', blueprint: blueprint(), thumb: picture(), ...upload }, model);
    expect(await publish({ blueprint: 'robot' })).toBe('invalid');
    expect(await publish({ source: '../../etc' })).toBe('invalid');
    expect(await publish({ thumb: 'data:image/svg+xml;base64,PHN2Zy8+' })).toBe('invalid');
    // A PNG that says it is a WebP.
    expect(await publish({ thumb: picture(PNG, 'image/webp') })).toBe('invalid');
    expect(await publish({ thumb: picture(Buffer.concat([WEBP, Buffer.alloc(GALLERY.thumbBytes)])) })).toBe('invalid');
    // A model without the blueprint's fit for it, or not a GLB at all.
    expect(await publish({}, GLB)).toBe('invalid');
    expect(await publish({ blueprint: withModel() }, Buffer.from('not a model, just some text here'))).toBe('invalid');
    expect(await publish({ blueprint: withModel() }, Buffer.alloc(GALLERY.modelBytes + 1))).toBe('tooLarge');
    // Its numbers are cleaned like the Workshop cleans them.
    const ok = await publish({ blueprint: { ...blueprint(), rpm: 99999, name: '<b>Bad</b>' } });
    if (typeof ok === 'string') throw new Error(ok);
    expect(ok.blueprint.rpm).toBe(1200);
    expect(ok.name).not.toMatch(/[<>]/);
    expect(readThumb(picture(PNG, 'image/png'))?.type).toBe('image/png');
  });

  it(`keeps at most ${GALLERY.perAccount} robots of one player`, async () => {
    const { gallery, player } = await setup();
    const max = await player('Max');
    for (let i = 0; i < GALLERY.perAccount; i++) {
      expect(typeof (await gallery.publish(max, { source: `custom-robot${String(i).padStart(3, '0')}`, blueprint: blueprint(), thumb: picture() }, null))).toBe('object');
    }
    expect(await gallery.publish(max, { source: 'custom-onemore1', blueprint: blueprint(), thumb: picture() }, null)).toBe('limit');
    // Updating one of them is fine.
    expect(typeof (await gallery.publish(max, { source: 'custom-robot000', blueprint: blueprint(), thumb: picture() }, null))).toBe('object');
  });

  it('its author or a moderator takes a robot down, nobody else; its files go', async () => {
    const { gallery, dir, player } = await setup(['mod']);
    const max = await player('Max');
    const ann = await player('Ann');
    const mod = await player('Mod');
    const publish = async (source: string) => {
      const r = await gallery.publish(max, { source, blueprint: withModel(), thumb: picture() }, GLB);
      if (typeof r === 'string') throw new Error(r);
      return r;
    };
    const a = await publish('custom-aaaa1111');
    const b = await publish('custom-bbbb2222');
    expect(await gallery.remove(a.id, ann)).toBe('forbidden');
    expect(await gallery.remove(a.id, max)).toBe('ok');
    expect(await gallery.remove(b.id, mod)).toBe('ok');
    expect(await gallery.remove(b.id, mod)).toBe('notFound');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect((await gallery.list({}, null)).total).toBe(0);
    expect(gallery.isModerator(mod)).toBe(true);
    expect(gallery.isModerator(max)).toBe(false);
  });

  it('counts each player who adds a robot once, and lists the most added first', async () => {
    const { gallery, player } = await setup();
    const max = await player('Max');
    const [a, b] = await Promise.all(['custom-aaaa1111', 'custom-bbbb2222'].map(async source => {
      const r = await gallery.publish(max, { source, blueprint: blueprint({ name: source.slice(7, 11) }), thumb: picture() }, null);
      if (typeof r === 'string') throw new Error(r);
      return r;
    }));
    expect(await gallery.added(b.id, 'd:browser-0001')).toBe(true);
    expect(await gallery.added(b.id, 'd:browser-0001')).toBe(false);
    expect(await gallery.added(b.id, 'a:account-0002')).toBe(true);
    expect(await gallery.added(a.id, 'd:browser-0001')).toBe(true);
    expect(await gallery.added('nosuchrobot1', 'd:browser-0001')).toBe(false);
    const popular = await gallery.list({ sort: 'popular' }, null);
    expect(popular.robots.map(r => [r.name, r.added])).toEqual([['bbbb', 2], ['aaaa', 1]]);
  });

  it('hides a robot reported by enough players until a moderator puts it back; its author and the moderators still see it', async () => {
    const { gallery, player } = await setup(['mod']);
    const max = await player('Max');
    const mod = await player('Mod');
    const robot = await gallery.publish(max, { source: 'custom-aaaa1111', blueprint: blueprint({ name: 'Rude' }), thumb: picture() }, null);
    if (typeof robot === 'string') throw new Error(robot);
    // Its author can't report it, and each player counts once.
    expect(await gallery.report(robot.id, max)).toBe(false);
    const reporters = await Promise.all(Array.from({ length: GALLERY.hideAfter }, (_, i) => player(`Fan${i}`)));
    for (const [i, fan] of reporters.entries()) {
      expect(await gallery.report(robot.id, fan)).toBe(true);
      expect(await gallery.report(robot.id, fan)).toBe(false);
      expect((await gallery.list({}, null)).total).toBe(i < GALLERY.hideAfter - 1 ? 1 : 0);
    }
    expect(await gallery.get(robot.id, reporters[0])).toBeNull();
    expect((await gallery.list({}, max)).robots[0]).toMatchObject({ name: 'Rude', hidden: true });
    expect((await gallery.list({}, mod)).robots[0]).toMatchObject({ hidden: true });
    expect(await gallery.restore(robot.id, max)).toBe(false);
    expect(await gallery.restore(robot.id, mod)).toBe(true);
    expect((await gallery.list({}, null)).robots[0]).toMatchObject({ name: 'Rude', hidden: false });
  });

  it("finds robots by name, team or author, shows a player only their own when asked, and pages through", async () => {
    const { gallery, player } = await setup();
    const max = await player('Max');
    const ann = await player('Ann');
    await gallery.publish(max, { source: 'custom-aaaa1111', blueprint: blueprint({ name: 'Rocket', team: 'URAN92' }), thumb: picture() }, null);
    await gallery.publish(ann, { source: 'custom-bbbb2222', blueprint: blueprint({ name: 'Bee', team: 'SWB' }), thumb: picture() }, null);
    const names = async (options: Parameters<Gallery['list']>[0], viewer: Account | null = null) => (await gallery.list(options, viewer)).robots.map(r => r.name);
    expect(await names({ q: 'rock' })).toEqual(['Rocket']);
    expect(await names({ q: 'swb' })).toEqual(['Bee']);
    expect(await names({ q: 'ann' })).toEqual(['Bee']);
    expect(await names({ mine: true }, max)).toEqual(['Rocket']);
    expect(await names({ mine: true })).toEqual([]);
    expect(await names({ offset: 1 })).toEqual(['Rocket']);
  });
});

describe('the gallery over HTTP', () => {
  let server: http.Server | null = null;
  afterEach(() => server?.close());

  it('lists, publishes with a model, serves the picture and the model, counts, reports and takes down', async () => {
    const db = new Db(new MemoryKv());
    const accounts = new Accounts(db);
    const gallery = new Gallery(db, tmp('gallery'), new Set());
    const ctx = {
      accounts, gallery, stats: new Stats(db), presence: new Presence(run => setTimeout(run, 0)), auth: new Auth([new DevProvider()], accounts, 'http://localhost'),
      email: new EmailAuth(db, accounts), replays: new Replays(db, tmp('replays')), records: new Records(new FileStore(path.join(tmp('records'), 'r.json'))), roomOf: () => null,
      robots: new AccountRobots(db, tmp('robots')),
    };
    server = http.createServer((req, res) => void handleApi(req, res, new URL(req.url!, 'http://x'), ctx).then(handled => !handled && res.writeHead(404).end()));
    await new Promise<void>(resolve => server!.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const max = await accounts.signIn('dev', 'max', 'Max');
    const token = await accounts.createSession(max.id);
    const auth = { authorization: `Bearer ${token}` };

    const body = (upload: object, model?: Buffer) => {
      const json = Buffer.from(JSON.stringify(upload));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(json.length);
      return Buffer.concat([length, json, model ?? Buffer.alloc(0)]);
    };
    const upload = { source: 'custom-aaaa1111', blueprint: withModel({ name: 'Rocket' }), thumb: picture() };
    const post = (b: Buffer, headers: Record<string, string> = auth) => fetch(`${base}/api/gallery`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body: b });
    expect((await post(body(upload, GLB), {})).status).toBe(401);
    expect((await post(Buffer.from('garbage'))).status).toBe(400);
    const res = await post(body(upload, GLB));
    expect(res.status).toBe(200);
    const robot = (await res.json()) as GalleryRobot;
    expect(robot.model).toEqual({ format: 'glb', size: GLB.length });

    const page = (await (await fetch(`${base}/api/gallery?sort=new`)).json()) as GalleryPage;
    expect(page).toMatchObject({ total: 1, moderator: false });
    expect(page.robots[0].name).toBe('Rocket');
    const full = (await (await fetch(`${base}/api/gallery/${robot.id}`)).json()) as GalleryRobot;
    expect(full.blueprint.name).toBe('Rocket');
    const thumb = await fetch(`${base}/api/gallery/${robot.id}/thumb?v=1`);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(Buffer.from(await thumb.arrayBuffer())).toEqual(WEBP);
    expect(Buffer.from(await (await fetch(`${base}/api/gallery/${robot.id}/model`)).arrayBuffer())).toEqual(GLB);

    const added = (who: object) => fetch(`${base}/api/gallery/${robot.id}/added`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) }).then(r => r.json());
    expect(await added({ device: 'browser-0001' })).toEqual({ counted: true });
    expect(await added({ device: 'browser-0001' })).toEqual({ counted: false });
    expect((await fetch(`${base}/api/gallery/${robot.id}/report`, { method: 'POST', body: '{}' })).status).toBe(401);

    expect((await fetch(`${base}/api/gallery/${robot.id}`, { method: 'DELETE' })).status).toBe(401);
    expect((await fetch(`${base}/api/gallery/${robot.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/gallery/${robot.id}`)).status).toBe(404);
  });
});
