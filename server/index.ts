// UrSim web server: serves the built game (dist/), keeps the high score tables, the online room
// list (WebSocket /ws, server/Lobby.ts), accounts with Google sign-in (server/auth.ts), everyone's
// statistics and friends (server/api.ts) and who is online (WebSocket /presence). Matches run in
// the room admin's browser, not here.
//
//   npm run server          (development, next to `npm run dev`)
//   PORT=8787 node dist-server/index.mjs   (after npm run build && npm run build:server)
//
// HOST=127.0.0.1 accepts only local connections, for a server behind a proxy such as Caddy.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PresenceClientMessage } from '../src/net/accountProtocol';
import type { ClientMessage } from '../src/net/lobbyProtocol';
import { DEFAULT_PORT } from '../src/net/records';
import { ROBOTS } from '../src/robot/robots';
import { Accounts } from './Accounts';
import { cleanupApi, handleApi } from './api';
import { Auth, providersFromEnv } from './auth';
import { AccountRobots } from './AccountRobots';
import { EmailAuth } from './emailAuth';
import { Gallery } from './Gallery';
import { Replays } from './Replays';
import { RateLimit, readBody, sendJson, sendPreflight, sendText } from './http';
import { createDb } from './Kv';
import { Lobby } from './Lobby';
import { Presence } from './Presence';
import { MAX_SCORE, RECORDS_LIMIT, Records, cleanEntry, createRecords, type RecordEntry } from './Records';
import { Stats } from './Stats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HOST = process.env.HOST || undefined;
/** Old records are cleaned out of the rate limiter this often, ms */
const CLEANUP_MS = 60_000;
/** A whole table sent back by a browser: 100 rows of about 80 bytes. */
const MAX_RESTORE_BYTES = 16 * 1024;
/** How long a new server waits for the tables of the version it replaces, ms */
const HANDOFF_TIMEOUT_MS = 20_000;
/** Hosting proxies drop silent connections, and ping/pong also finds dead ones, ms */
const HEARTBEAT_MS = 25_000;
/** Lobby messages and signaling: a few a second, a burst of ICE candidates at most */
const MAX_TEXT_PER_SECOND = 60;
/** Relayed game data: 30 snapshots a second to each of 3 players, inputs 60 a second */
const MAX_BINARY_PER_SECOND = 300;
const MAX_FRAME_BYTES = 16 * 1024;
/** One player finishes a match every 2.5 minutes; this leaves room for a shared address. */
const RECORD_POSTS_PER_MINUTE = 12;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const recordPosts = new RateLimit(RECORD_POSTS_PER_MINUTE);

/**
 * POST /api/records/restore {robot, entries} → the table after putting back the rows it lost.
 * Browsers keep a copy of every table they see and send it back to a server that restarted
 * without a database.
 */
async function handleRestore(req: http.IncomingMessage, res: http.ServerResponse, records: Records): Promise<void> {
  if (req.method === 'OPTIONS') return sendPreflight(res);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (!recordPosts.allow(req)) return sendJson(res, 429, { error: 'too many requests' });
  let body: { robot?: unknown; entries?: unknown };
  try {
    body = JSON.parse(await readBody(req, MAX_RESTORE_BYTES));
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const { robot, entries } = body;
  if (!Records.isRobot(robot) || !Array.isArray(entries) || entries.length > RECORDS_LIMIT) return sendJson(res, 400, { error: 'bad request' });
  const rows = entries.map(e => cleanEntry(e)).filter((e): e is RecordEntry => e !== null);
  return sendJson(res, 200, { robot, entries: await records.restore(robot, rows) });
}

/**
 * During a deploy Render keeps the old version answering at the public address until the new
 * one is up, so a new server without a database copies the tables from it first.
 */
async function takeOverTables(records: Records, publicUrl: string): Promise<void> {
  const signal = AbortSignal.timeout(HANDOFF_TIMEOUT_MS);
  await Promise.all(ROBOTS.map(async ({ id }) => {
    try {
      const res = await fetch(`${publicUrl}/api/records?robot=${encodeURIComponent(id)}`, { signal });
      if (!res.ok) return;
      const { entries } = (await res.json()) as { entries?: unknown };
      if (!Array.isArray(entries)) return;
      const rows = entries.map(e => cleanEntry(e)).filter((e): e is RecordEntry => e !== null);
      if (rows.length) console.log(`High scores: ${rows.length} rows for ${id} from the previous version`);
      await records.restore(id, rows);
    } catch {
      // No old version running (it was asleep) or it did not answer in time.
    }
  }));
}

/** GET /api/records?robot=id → the top 100 · POST /api/records {robot, name, score} → place. */
async function handleRecords(req: http.IncomingMessage, res: http.ServerResponse, url: URL, records: Records): Promise<void> {
  if (req.method === 'OPTIONS') return sendPreflight(res);
  if (req.method === 'GET') {
    const robot = url.searchParams.get('robot');
    if (!Records.isRobot(robot)) return sendJson(res, 400, { error: 'unknown robot' });
    return sendJson(res, 200, { robot, entries: await records.top(robot) });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (!recordPosts.allow(req)) return sendJson(res, 429, { error: 'too many requests' });
  let body: { robot?: unknown; name?: unknown; score?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const { robot, name, score } = body;
  if (!Records.isRobot(robot) || typeof name !== 'string' || !name.trim()) return sendJson(res, 400, { error: 'bad request' });
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) return sendJson(res, 400, { error: 'bad score' });
  return sendJson(res, 200, await records.submit(robot, name, score));
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, health: () => object): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname === '/health') return sendText(res, 200, JSON.stringify(health()), 'application/json');
  const file = path.normalize(path.join(DIST, pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (!fs.existsSync(DIST)) return sendText(res, 200, 'UrSim server is running. Build the game (npm run build) to serve it here.');
    return sendText(res, 404, 'Not found');
  }
  // Vite names its bundles with a content hash, so those never change. Everything else (page,
  // models, field data) has a fixed name: browsers must check with us before reusing a copy.
  const hashed = /[-.][A-Za-z0-9_]{8,}\.(js|css)$/.test(file);
  const modified = fs.statSync(file).mtime;
  modified.setMilliseconds(0);
  const since = Date.parse(req.headers['if-modified-since'] ?? '');
  if (!hashed && since >= modified.getTime()) {
    res.writeHead(304);
    return void res.end();
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'last-modified': modified.toUTCString(),
  });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}

/** The address players reach this server at: Google sends them back there after signing in. */
function publicUrl(): string {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
}

/** Pings every socket; ones that didn't answer the last ping are gone. */
function heartbeat(servers: WebSocketServer[]): void {
  const alive = new WeakMap<WebSocket, boolean>();
  for (const wss of servers) {
    wss.on('connection', (ws: WebSocket) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
    });
  }
  setInterval(() => {
    for (const wss of servers) {
      for (const ws of wss.clients) {
        if (!alive.get(ws)) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }
  }, HEARTBEAT_MS).unref();
}

async function main(): Promise<void> {
  const { records, storage } = createRecords(ROOT);
  console.log(`High scores: ${storage}`);
  const { db, storage: dbStorage } = createDb(ROOT);
  console.log(`Accounts and statistics: ${dbStorage}`);
  // Render sets RENDER; its free disk is wiped on every restart.
  if (storage !== 'upstash' && process.env.RENDER) {
    console.warn('High scores, accounts and statistics are kept in files that Render wipes on every restart: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (README → High scores).');
    const publicUrl = process.env.RENDER_EXTERNAL_URL;
    if (publicUrl) await takeOverTables(records, publicUrl);
  }

  const accounts = new Accounts(db);
  const stats = new Stats(db);
  // Accounts and signed-in players' games from before the server counted them: counted once.
  await Promise.all([accounts.backfill(), stats.backfill()]).catch(err => console.error('counting older accounts and games:', err));
  const presence = new Presence();
  const providers = providersFromEnv();
  const auth = new Auth(providers, accounts, publicUrl(), (process.env.AUTH_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean));
  const email = new EmailAuth(db, accounts);
  // Match recordings and the gallery's pictures and models: next to the database file (REPLAYS_DIR
  // and GALLERY_DIR move them).
  const dataDir = process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : path.join(ROOT, 'data');
  const replaysDir = process.env.REPLAYS_DIR ?? path.join(dataDir, 'replays');
  const replays = new Replays(db, replaysDir);
  console.log(`Match archive: ${replaysDir}`);
  // GALLERY_ADMINS: usernames (comma-separated) of the players who may take down anyone's robot.
  const galleryDir = process.env.GALLERY_DIR ?? path.join(dataDir, 'gallery');
  const moderators = new Set((process.env.GALLERY_ADMINS ?? '').split(',').map(u => u.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
  const gallery = new Gallery(db, galleryDir, moderators);
  // Each player's own robots' 3D models (ROBOTS_DIR moves them).
  const robots = new AccountRobots(db, process.env.ROBOTS_DIR ?? path.join(dataDir, 'robots'));
  console.log(`Robot gallery: ${galleryDir}${moderators.size ? ` (moderators: ${[...moderators].map(u => `@${u}`).join(', ')})` : ' (no moderators: set GALLERY_ADMINS)'}`);
  console.log(`Sign-in: e-mail${providers.map(p => `, ${p.id}`).join('')}${providers.some(p => p.id === 'google') ? '' : ' (Google: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, README → Accounts)'}`);
  const lobby = new Lobby(Math.random, {
    identify: async token => accounts.session(token),
    game: game => void stats.record(game).catch(err => console.error('statistics:', err)),
  });
  const api = { accounts, stats, presence, auth, email, replays, gallery, robots, records, roomOf: (account: string) => lobby.roomOf(account) };

  const started = Date.now();
  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    if (url.pathname === '/api/records' || url.pathname === '/api/records/restore') {
      const handle = url.pathname === '/api/records' ? handleRecords(req, res, url, records) : handleRestore(req, res, records);
      handle.catch(err => {
        console.error('records:', err);
        if (!res.headersSent) sendJson(res, 503, { error: 'records unavailable' });
      });
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      const handle = url.pathname.startsWith('/auth/') ? auth.handle(req, res, url) : handleApi(req, res, url, api);
      handle.then(handled => {
        if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not found' });
      }, err => {
        console.error(`${url.pathname}:`, err);
        if (!res.headersSent) sendJson(res, 503, { error: 'unavailable' });
      });
      return;
    }
    serveStatic(req, res, () => ({
      ok: true,
      uptime: Math.round((Date.now() - started) / 1000),
      records: storage === 'upstash' ? 'upstash' : 'file',
      accounts: dbStorage === 'upstash' ? 'upstash' : 'file',
      signIn: ['email', ...providers.map(p => p.id)],
      rooms: lobby.roomCount,
      players: lobby.clientCount,
      ...presence.counts(),
    }));
  });

  // Two WebSocket addresses on one server: each upgrade goes to the one its path names.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const presenceWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const target = pathname === '/ws' ? wss : pathname === '/presence' ? presenceWss : null;
    if (!target) return socket.destroy();
    target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
  });
  heartbeat([wss, presenceWss]);

  wss.on('connection', (ws: WebSocket) => {
    const id = lobby.connect({
      send: msg => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      sendBinary: data => ws.readyState === ws.OPEN && ws.send(data, { binary: true }),
    });
    if (id === null) return ws.close(1013, 'Server full');
    let windowStart = Date.now();
    let texts = 0;
    let binaries = 0;
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        texts = binaries = 0;
      }
      if (isBinary) {
        if (++binaries <= MAX_BINARY_PER_SECOND) lobby.binary(id, data instanceof Buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer));
        return;
      }
      if (++texts > MAX_TEXT_PER_SECOND) return;
      try {
        lobby.message(id, JSON.parse(data.toString()) as ClientMessage);
      } catch {
        // Ignore malformed messages.
      }
    });
    ws.on('close', () => lobby.disconnect(id));
    ws.on('error', () => ws.terminate());
  });

  presenceWss.on('connection', (ws: WebSocket) => {
    const id = presence.connect({ send: msg => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) });
    if (id === null) return ws.close(1013, 'Server full');
    let hellos = 0;
    ws.on('message', (data, isBinary) => {
      // A hello when the game opens and on every sign-in or sign-out; nothing else comes.
      if (isBinary || ++hellos > 20) return;
      let msg: PresenceClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.t !== 'hello') return;
      const device = typeof msg.device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.device) ? msg.device : null;
      accounts.session(msg.token).then(
        account => presence.identify(id, device, account && { id: account.id, friends: account.friends }),
        () => presence.identify(id, device, null),
      );
    });
    ws.on('close', () => presence.disconnect(id));
    ws.on('error', () => ws.terminate());
  });

  setInterval(() => {
    recordPosts.cleanup();
    cleanupApi();
    email.cleanup();
  }, CLEANUP_MS).unref();
  // Quick play places the players looking for a game and starts its rooms' matches.
  setInterval(() => lobby.tick(), 1000).unref();

  server.listen(PORT, HOST, () => console.log(`UrSim server on http://${HOST ?? 'localhost'}:${PORT} (rooms: WebSocket /ws, online count: /presence)`));
  // Hosting platforms stop the old version with SIGTERM during a deploy.
  process.on('SIGTERM', () => {
    wss.close();
    presenceWss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
