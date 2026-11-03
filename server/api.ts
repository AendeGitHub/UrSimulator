// The accounts and statistics API (src/net/account.ts is the browser's side):
//
//   GET  /api/stats                       totals for the main menu, and who is online
//   POST /api/games                       a game finished at this computer (online rooms: the lobby reports them)
//   GET  /api/leaderboard?period&kind&robot   a high score table of a season or month
//   GET  /api/ranked?period               the online ladder
//   GET  /api/career?user&period          a player's numbers and match history (no user: the signed-in one)
//   GET|PATCH /api/me · POST /api/auth/logout · GET /api/auth/providers
//   POST /api/auth/email/register {email, password, name} · POST /api/auth/email/login {email, password} → {token}
//   GET|POST /api/friends · POST /api/friends/accept · POST /api/friends/remove
//   GET|POST /api/replays · GET|DELETE /api/replays/<id>   the signed-in player's match archive
//   /api/gallery…                         the robot gallery (src/net/galleryProtocol.ts)
//   GET /api/robots · POST|DELETE /api/robots/<id> · GET /api/robots/model/<mesh>   the player's own robots, kept with their account

import type http from 'node:http';
import {
  CLOUD_ROBOTS,
  emptyCareer,
  type CareerResponse,
  type FriendInfo,
  type FriendsResponse,
  type GameReportResult,
  type GameType,
} from '../src/net/accountProtocol';
import { GALLERY, type GalleryError } from '../src/net/galleryProtocol';
import type { RoomSummary } from '../src/net/lobbyProtocol';
import { ALL_TIME, inPeriod, isPeriodKey, periodsOf } from '../src/net/periods';
import type { Alliance } from '../src/robot/robotConfig';
import { isCustomRobotId } from '../src/robot/robots';
import { me, publicAccount, type Account, type Accounts } from './Accounts';
import type { AccountRobots } from './AccountRobots';
import type { Auth } from './auth';
import type { EmailAuth, EmailError } from './emailAuth';
import type { Gallery } from './Gallery';
import { RateLimit, bearer, readBytes, readJson, sendBytes, sendJson, sendPreflight } from './http';
import type { Presence } from './Presence';
import { MAX_SCORE, Records } from './Records';
import { MAX_REPLAY_BYTES, cleanReplayUpload, type Replays } from './Replays';
import { recordRun, type GamePlayer, type Stats } from './Stats';

export interface ApiContext {
  accounts: Accounts;
  stats: Stats;
  presence: Presence;
  auth: Auth;
  /** Signing in with an e-mail and a password (null: off) */
  email: EmailAuth | null;
  /** The match archive */
  replays: Replays;
  /** Robots players published */
  gallery: Gallery;
  /** Each player's own robots, on every computer they sign in on */
  robots: AccountRobots;
  /** The all-time tables older versions of the game still show */
  records: Records;
  /** The online room a signed-in player is in */
  roomOf(account: string): RoomSummary | null;
}

/** The longest practice that counts, s */
const MAX_DURATION = 4 * 3600;
const isAlliance = (a: unknown): a is Alliance => a === 'red' || a === 'blue';
const isDevice = (d: unknown): d is string => typeof d === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d);
const isScore = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SCORE;

/** One game a minute is plenty (a match lasts 2:30); this leaves room for a shared address. */
const games = new RateLimit(12);
/** Profile and friend changes */
const changes = new RateLimit(30);
/** E-mail sign-ups and sign-ins (each address also has its own limit, server/emailAuth.ts) */
const emailTries = new RateLimit(20);
/** Recordings: one per match, and watching or removing them */
const replayUploads = new RateLimit(6);
const replayReads = new RateLimit(60);
/** The robot gallery: pages and pictures, publishing, adding and reporting */
const galleryReads = new RateLimit(240);
const galleryUploads = new RateLimit(6);
const galleryActions = new RateLimit(30);
/** A player's robots coming and going with their account: all of them at the first sign-in */
const robotSync = new RateLimit(300);

const EMAIL_STATUS: Record<EmailError, number> = { badEmail: 400, shortPassword: 400, noName: 400, emailTaken: 409, wrongPassword: 401, tooMany: 429 };
const GALLERY_STATUS: Record<GalleryError, number> = { signIn: 401, invalid: 400, tooLarge: 413, limit: 409, full: 507, tooMany: 429 };

export function cleanupApi(): void {
  games.cleanup();
  changes.cleanup();
  emailTries.cleanup();
  replayUploads.cleanup();
  replayReads.cleanup();
  galleryReads.cleanup();
  galleryUploads.cleanup();
  galleryActions.cleanup();
  robotSync.cleanup();
}

/**
 * A robot sent to the gallery: [u32 LE length of the JSON][JSON: GalleryUpload][its 3D model, if
 * any]. Null when it is not one.
 */
export function parseGalleryBody(body: Buffer, maxJson: number = GALLERY.thumbBytes * 2 + 16384): { upload: unknown; model: Buffer | null } | null {
  if (body.length < 8) return null;
  const length = body.readUInt32LE(0);
  // The card picture travels in the JSON as base64.
  if (length > maxJson || 4 + length > body.length) return null;
  try {
    const upload: unknown = JSON.parse(body.subarray(4, 4 + length).toString('utf8'));
    const model = body.subarray(4 + length);
    return { upload, model: model.length ? model : null };
  } catch {
    return null;
  }
}

/**
 * A recording sent by the game: [u32 LE length of the JSON][JSON: ReplayUpload][the gzipped
 * recording]. Null when it is not one.
 */
export function parseReplayBody(body: Buffer): { upload: NonNullable<ReturnType<typeof cleanReplayUpload>>; data: Buffer } | null {
  if (body.length < 8) return null;
  const length = body.readUInt32LE(0);
  if (length > 4096 || 4 + length >= body.length) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(body.subarray(4, 4 + length).toString('utf8'));
  } catch {
    return null;
  }
  const upload = cleanReplayUpload(meta);
  const data = body.subarray(4 + length);
  // gzip starts with 1f 8b.
  if (!upload || data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b) return null;
  return { upload, data };
}

/** The game a browser reported, or null when it is not a valid one. */
export function parseReport(body: Record<string, unknown>): {
  type: GameType;
  mode: 'match' | 'practice';
  duration: number;
  score?: Record<Alliance, number>;
  players: { alliance: Alliance; robot: string }[];
  ai: Alliance[];
  device: string;
  name: string | null;
} | null {
  const { type, mode, duration, score, players, ai, device, name } = body;
  if (mode !== 'match' && mode !== 'practice') return null;
  if (mode === 'practice' ? type !== 'practice' : type !== 'solo' && type !== 'duo') return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  if (!isDevice(device)) return null;
  if (!Array.isArray(players) || players.length < 1 || players.length > 2) return null;
  if (type === 'solo' && players.length !== 1) return null;
  if (type === 'duo' && players.length !== 2) return null;
  const drivers = players.map(p => p as { alliance?: unknown; robot?: unknown });
  // A robot the player made counts as a game, but never in the high score tables (Stats.recordRun).
  if (!drivers.every(p => isAlliance(p.alliance) && (Records.isRobot(p.robot) || isCustomRobotId(p.robot)))) return null;
  if (!Array.isArray(ai) || ai.length > 2 || !ai.every(isAlliance) || new Set(ai).size !== ai.length) return null;
  let finalScore: Record<Alliance, number> | undefined;
  if (mode === 'match') {
    const s = score as Partial<Record<Alliance, unknown>> | null;
    if (!s || !isScore(s.red) || !isScore(s.blue)) return null;
    finalScore = { red: s.red, blue: s.blue };
  }
  return {
    type: type as GameType,
    mode,
    duration: Math.min(duration, MAX_DURATION),
    score: finalScore,
    players: drivers.map(p => ({ alliance: p.alliance as Alliance, robot: p.robot as string })),
    ai: ai as Alliance[],
    device,
    name: typeof name === 'string' && name.trim() ? name : null,
  };
}

/** The signed-in account of a request, if any. */
async function signedIn(req: http.IncomingMessage, ctx: ApiContext): Promise<Account | null> {
  const token = bearer(req);
  return token ? ctx.accounts.session(token) : null;
}

async function friendsOf(account: Account, ctx: ApiContext): Promise<FriendsResponse> {
  const [friends, incoming, outgoing] = await Promise.all([account.friends, account.incoming, account.outgoing].map(ids => ctx.accounts.many(ids)));
  const info = (a: Account): FriendInfo => ({ ...publicAccount(a), online: ctx.presence.isOnline(a.id), room: ctx.roomOf(a.id) });
  // Online first, then by name.
  const list = friends.map(info).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { friends: list, incoming: incoming.map(publicAccount), outgoing: outgoing.map(publicAccount) };
}

/** Handles /api/… requests of this API; false for any other address. */
export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: ApiContext): Promise<boolean> {
  // One recording of the archive: /api/replays/<id>; one robot of the gallery: /api/gallery/<id>[/…].
  const replayId = /^\/api\/replays\/([a-z0-9]{12})$/.exec(url.pathname)?.[1];
  const robot = /^\/api\/gallery\/([a-z0-9]{12})(\/(?:thumb|model|added|report|restore))?$/.exec(url.pathname);
  const robotId = robot?.[1] ?? '';
  // One of the player's own robots: /api/robots/<id>, or a model of theirs: /api/robots/model/<mesh>.
  const own = /^\/api\/robots\/(?:(custom-[a-z0-9]{4,16})|model\/([a-z0-9]{4,24}))$/.exec(url.pathname);
  const route = `${req.method} ${replayId ? '/api/replays/:id' : robot ? `/api/gallery/:id${robot[2] ?? ''}` : own ? (own[1] ? '/api/robots/:id' : '/api/robots/model/:mesh') : url.pathname}`;
  const q = url.searchParams;
  if (!replayId && !robot && !own && !/^\/api\/(stats|games|leaderboard|ranked|career|me|auth\/logout|auth\/providers|auth\/email\/(register|login)|friends(\/accept|\/remove)?|replays|gallery|robots)$/.test(url.pathname)) return false;
  if (req.method === 'OPTIONS') {
    sendPreflight(res);
    return true;
  }
  const reply = (status: number, body: unknown) => {
    sendJson(res, status, body);
    return true;
  };
  const unauthorized = () => reply(401, { error: 'sign in first' });

  switch (route) {
    case 'GET /api/stats':
      sendJson(res, 200, { ...(await ctx.stats.totals()), accounts: await ctx.accounts.count(), ...ctx.presence.counts() });
      return true;

    case 'GET /api/auth/providers':
      sendJson(res, 200, { ...ctx.auth.enabled(), email: !!ctx.email });
      return true;

    case 'POST /api/auth/email/register':
    case 'POST /api/auth/email/login': {
      if (!ctx.email) return reply(404, { error: 'not found' });
      if (!emailTries.allow(req)) return reply(429, { error: 'tooMany' });
      const body = await readJson(req);
      if (!body) return reply(400, { error: 'bad request' });
      const result = url.pathname.endsWith('register')
        ? await ctx.email.register(body.email, body.password, body.name)
        : await ctx.email.login(body.email, body.password);
      return 'token' in result ? reply(200, result) : reply(EMAIL_STATUS[result.error], { error: result.error });
    }

    case 'POST /api/games': {
      if (!games.allow(req)) return reply(429, { error: 'too many requests' });
      const body = await readJson(req);
      const report = body && parseReport(body);
      if (!report) return reply(400, { error: 'bad request' });
      const account = await signedIn(req, ctx);
      const players: GamePlayer[] = report.players.map((p, i) => i === 0
        ? { ...p, device: report.device, account, name: account ? account.name : report.name ?? undefined }
        // gamepad2 on a split screen: no account or browser of their own.
        : p);
      const game = { type: report.type, mode: report.mode, duration: report.duration, score: report.score, players, ai: report.ai };
      const { board } = await ctx.stats.record(game);
      // Older versions of the game read the all-time table of each robot.
      const name = players[0].name;
      if (recordRun(game) === 'solo' && name) await ctx.records.submit(players[0].robot, name, report.score![players[0].alliance]).catch(() => undefined);
      sendJson(res, 200, (board ?? {}) satisfies Partial<GameReportResult>);
      return true;
    }

    case 'GET /api/leaderboard': {
      const period = q.get('period') ?? periodsOf(new Date())[0];
      const kind = q.get('kind') === 'duo' ? 'duo' : 'solo';
      const robot = q.get('robot') ?? 'all';
      if (!isPeriodKey(period) || (robot !== 'all' && !Records.isRobot(robot))) return reply(400, { error: 'bad request' });
      sendJson(res, 200, { period, kind, robot, entries: await ctx.stats.board(period, kind, robot) });
      return true;
    }

    case 'GET /api/ranked': {
      const period = q.get('period') ?? periodsOf(new Date())[0];
      if (!isPeriodKey(period)) return reply(400, { error: 'bad request' });
      sendJson(res, 200, { period, entries: await ctx.stats.ranked(period) });
      return true;
    }

    case 'GET /api/career': {
      const who = q.get('user');
      const account = who ? await ctx.accounts.find(who) : await signedIn(req, ctx);
      if (!account) return who ? reply(404, { error: 'no such player' }) : unauthorized();
      const period = q.get('period') ?? ALL_TIME;
      if (period !== ALL_TIME && !isPeriodKey(period)) return reply(400, { error: 'bad request' });
      const [career, history, ranked] = await Promise.all([
        ctx.stats.career(account.id),
        ctx.stats.history(account.id),
        ctx.stats.rankedOf(period === ALL_TIME ? periodsOf(new Date())[0] : period, account.id),
      ]);
      const body: CareerResponse = {
        account: publicAccount(account),
        stats: career[period] ?? emptyCareer(),
        allTime: career[ALL_TIME] ?? emptyCareer(),
        ranked,
        history: history.filter(e => inPeriod(new Date(e.date), period)),
      };
      sendJson(res, 200, body);
      return true;
    }

    case 'GET /api/me': {
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      sendJson(res, 200, me(account));
      return true;
    }

    case 'PATCH /api/me': {
      if (!changes.allow(req)) return reply(429, { error: 'too many requests' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      const body = await readJson(req);
      if (!body) return reply(400, { error: 'bad request' });
      const result = await ctx.accounts.update(account.id, { name: body.name, username: body.username });
      if (result === 'invalid') sendJson(res, 400, { error: 'invalid' });
      else if (result === 'taken') sendJson(res, 409, { error: 'taken' });
      else sendJson(res, 200, me(result));
      return true;
    }

    case 'POST /api/auth/logout': {
      const token = bearer(req);
      if (token) await ctx.accounts.endSession(token);
      sendJson(res, 200, { ok: true });
      return true;
    }

    case 'GET /api/replays': {
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      sendJson(res, 200, { replays: await ctx.replays.list(account.id) });
      return true;
    }

    case 'POST /api/replays': {
      if (!replayUploads.allow(req)) return reply(429, { error: 'too many requests' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      const body = await readBytes(req, MAX_REPLAY_BYTES + 8192);
      if (!body) return reply(413, { error: 'too large' });
      const parsed = parseReplayBody(body);
      if (!parsed) return reply(400, { error: 'bad request' });
      sendJson(res, 200, await ctx.replays.save(account.id, parsed.upload, parsed.data));
      return true;
    }

    case 'GET /api/replays/:id':
    case 'DELETE /api/replays/:id': {
      if (!replayReads.allow(req)) return reply(429, { error: 'too many requests' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      if (req.method === 'DELETE') return reply((await ctx.replays.remove(account.id, replayId!)) ? 200 : 404, {});
      const data = await ctx.replays.read(account.id, replayId!);
      if (!data) return reply(404, { error: 'no such replay' });
      sendBytes(res, data);
      return true;
    }

    case 'GET /api/friends': {
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      sendJson(res, 200, await friendsOf(account, ctx));
      return true;
    }

    case 'GET /api/gallery': {
      if (!galleryReads.allow(req)) return reply(429, { error: 'tooMany' });
      const viewer = await signedIn(req, ctx);
      const options = { sort: q.get('sort') === 'popular' ? 'popular' as const : 'new' as const, q: q.get('q') ?? '', offset: Number(q.get('offset')) || 0, mine: q.get('mine') === '1' };
      sendJson(res, 200, await ctx.gallery.list(options, viewer));
      return true;
    }

    case 'POST /api/gallery': {
      if (!galleryUploads.allow(req)) return reply(429, { error: 'tooMany' });
      const account = await signedIn(req, ctx);
      if (!account) return reply(401, { error: 'signIn' });
      const body = await readBytes(req, GALLERY.modelBytes + GALLERY.thumbBytes * 2 + 32768);
      if (!body) return reply(413, { error: 'tooLarge' });
      const parsed = parseGalleryBody(body);
      if (!parsed) return reply(400, { error: 'invalid' });
      const result = await ctx.gallery.publish(account, parsed.upload, parsed.model);
      if (typeof result === 'string') return reply(GALLERY_STATUS[result], { error: result });
      sendJson(res, 200, result);
      return true;
    }

    case 'GET /api/gallery/:id': {
      if (!galleryReads.allow(req)) return reply(429, { error: 'tooMany' });
      const found = await ctx.gallery.get(robotId, await signedIn(req, ctx));
      return found ? reply(200, found) : reply(404, { error: 'no such robot' });
    }

    case 'DELETE /api/gallery/:id': {
      if (!galleryActions.allow(req)) return reply(429, { error: 'tooMany' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      const result = await ctx.gallery.remove(robotId, account);
      return reply(result === 'ok' ? 200 : result === 'forbidden' ? 403 : 404, {});
    }

    case 'GET /api/gallery/:id/thumb': {
      if (!galleryReads.allow(req)) return reply(429, { error: 'tooMany' });
      const thumb = await ctx.gallery.thumb(robotId);
      if (!thumb) return reply(404, { error: 'no such robot' });
      // Its address changes with every new version (?v=), so browsers may keep it.
      sendBytes(res, thumb.data, { type: thumb.type, cache: 'public, max-age=604800' });
      return true;
    }

    case 'GET /api/gallery/:id/model': {
      if (!galleryActions.allow(req)) return reply(429, { error: 'tooMany' });
      const model = await ctx.gallery.model(robotId, await signedIn(req, ctx));
      if (!model) return reply(404, { error: 'no such model' });
      sendBytes(res, model, { cache: 'public, max-age=604800' });
      return true;
    }

    case 'POST /api/gallery/:id/added': {
      if (!galleryActions.allow(req)) return reply(429, { error: 'tooMany' });
      const account = await signedIn(req, ctx);
      const body = await readJson(req);
      const who = account ? `a:${account.id}` : isDevice(body?.device) ? `d:${body.device}` : null;
      if (!who) return reply(400, { error: 'bad request' });
      return reply(200, { counted: await ctx.gallery.added(robotId, who) });
    }

    case 'GET /api/robots':
    case 'POST /api/robots/:id':
    case 'DELETE /api/robots/:id':
    case 'GET /api/robots/model/:mesh': {
      if (!robotSync.allow(req)) return reply(429, { error: 'tooMany' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      if (route === 'GET /api/robots') return reply(200, await ctx.robots.list(account.id));
      if (route === 'DELETE /api/robots/:id') return reply(200, { done: await ctx.robots.remove(account.id, own![1], Number(q.get('at')) || Date.now()) });
      if (route === 'GET /api/robots/model/:mesh') {
        const model = await ctx.robots.model(account.id, own![2]);
        if (!model) return reply(404, { error: 'no such model' });
        sendBytes(res, model);
        return true;
      }
      const body = await readBytes(req, CLOUD_ROBOTS.modelBytes + 65536);
      if (!body) return reply(413, { error: 'tooLarge' });
      const parsed = parseGalleryBody(body, 32768);
      if (!parsed || (parsed.upload as { id?: unknown })?.id !== own![1]) return reply(400, { error: 'invalid' });
      const kept = await ctx.robots.put(account.id, parsed.upload, parsed.model);
      if (typeof kept === 'string') return reply(kept === 'invalid' ? 400 : kept === 'needModel' ? 428 : 409, { error: kept });
      return reply(200, kept);
    }

    case 'POST /api/gallery/:id/report':
    case 'POST /api/gallery/:id/restore': {
      if (!galleryActions.allow(req)) return reply(429, { error: 'tooMany' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      const done = url.pathname.endsWith('report') ? await ctx.gallery.report(robotId, account) : await ctx.gallery.restore(robotId, account);
      return reply(200, { done });
    }

    case 'POST /api/friends':
    case 'POST /api/friends/accept':
    case 'POST /api/friends/remove': {
      if (!changes.allow(req)) return reply(429, { error: 'too many requests' });
      const account = await signedIn(req, ctx);
      if (!account) return unauthorized();
      const body = await readJson(req);
      const who = body?.username ?? body?.id;
      if (typeof who !== 'string' || !who) return reply(400, { error: 'bad request' });
      let result: string;
      let other: Account | null;
      if (url.pathname === '/api/friends') {
        other = await ctx.accounts.find(who);
        result = await ctx.accounts.request(account.id, who);
      } else {
        other = await ctx.accounts.byId(who);
        const done = url.pathname.endsWith('accept') ? await ctx.accounts.accept(account.id, who) : await ctx.accounts.remove(account.id, who);
        result = done ? 'ok' : 'unknown';
      }
      // Both players' friend lists (and who they tell when they come online) changed.
      for (const a of await ctx.accounts.many([account.id, ...(other ? [other.id] : [])])) ctx.presence.setFriends(a.id, a.friends);
      if (other) ctx.presence.friendsChanged(account.id, other.id);
      const fresh = await ctx.accounts.byId(account.id);
      sendJson(res, 200, { result, ...(fresh ? await friendsOf(fresh, ctx) : {}) });
      return true;
    }
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}
