// UrSim game server: WebSocket rooms with the authoritative simulation.
// Also serves the built game (dist/) so one address is enough for players.
//
//   npm run server          (development, next to `npm run dev`)
//   PORT=8787 node dist-server/index.mjs   (after npm run build && npm run build:server)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FieldLayout } from '../src/field/layout';
import { DEFAULT_PORT, type ClientMessage } from '../src/net/protocol';
import { parseColliders } from '../src/sim/colliders';
import { initPhysics } from '../src/sim/Simulation';
import { Lobby } from './Lobby';
import { MAX_SCORE, Records, createRecords } from './Records';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
// Each wake-up costs CPU, and a free server only gets about 10 ms of it per 100 ms: waking every
// 4 ms used that up early and froze the room for the rest of each 100 ms (snapshots in bursts).
const TICK_MS = 15;
/** Protects a small free server from overload. */
const MAX_CONNECTIONS = 200;
/** Inputs arrive 60 times a second; anything far above that is a broken or hostile client. */
const MAX_MESSAGES_PER_SECOND = 150;
/** Hosting proxies drop silent connections, and ping/pong also finds dead ones. */
const HEARTBEAT_MS = 25_000;
/** A record submission is a tiny JSON object. */
const MAX_BODY_BYTES = 1024;
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
};

/** Field data from the built game if present, otherwise from the source assets. */
function assetPath(name: string): string {
  const built = path.join(DIST, 'assets', name);
  return fs.existsSync(built) ? built : path.join(ROOT, 'public', 'assets', name);
}

function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  // The dev game runs on another port than the server, so the records API allows any origin.
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const recordPosts = new Map<string, { start: number; count: number }>();

function clientAddress(req: http.IncomingMessage): string {
  // Render and similar hosts put the player's address first in X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.socket.remoteAddress || '?';
}

function allowRecordPost(req: http.IncomingMessage): boolean {
  const now = Date.now();
  const ip = clientAddress(req);
  const entry = recordPosts.get(ip);
  if (!entry || now - entry.start > 60_000) {
    recordPosts.set(ip, { start: now, count: 1 });
    return true;
  }
  return ++entry.count <= RECORD_POSTS_PER_MINUTE;
}

/** GET /api/records?robot=id → the top 100 · POST /api/records {robot, name, score} → place. */
async function handleRecords(req: http.IncomingMessage, res: http.ServerResponse, url: URL, records: Records): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
    return void res.end();
  }
  if (req.method === 'GET') {
    const robot = url.searchParams.get('robot');
    if (!Records.isRobot(robot)) return sendJson(res, 400, { error: 'unknown robot' });
    return sendJson(res, 200, { robot, entries: await records.top(robot) });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (!allowRecordPost(req)) return sendJson(res, 429, { error: 'too many requests' });
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

async function main(): Promise<void> {
  await initPhysics();
  const layout: FieldLayout = JSON.parse(fs.readFileSync(assetPath('field-layout.json'), 'utf8'));
  const bin = fs.readFileSync(assetPath('field-colliders.bin'));
  const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  const lobby = new Lobby(layout, colliders);
  const { records, storage } = createRecords(ROOT);
  console.log(`High scores: ${storage}`);

  const started = Date.now();
  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    if (url.pathname === '/api/records') {
      handleRecords(req, res, url, records).catch(err => {
        console.error('records:', err);
        if (!res.headersSent) sendJson(res, 503, { error: 'records unavailable' });
      });
      return;
    }
    serveStatic(req, res, () => ({ ok: true, rooms: lobby.roomCount, players: wss.clients.size, uptime: Math.round((Date.now() - started) / 1000) }));
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws: WebSocket) => {
    if (wss.clients.size > MAX_CONNECTIONS) return ws.close(1013, 'Server full');
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const id = lobby.connect({
      sendText: msg => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      sendBinary: data => ws.readyState === ws.OPEN && ws.send(data, { binary: true }),
    });
    let windowStart = Date.now();
    let count = 0;
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (isBinary || ++count > MAX_MESSAGES_PER_SECOND) return;
      try {
        lobby.handle(id, JSON.parse(data.toString()) as ClientMessage);
      } catch {
        // Ignore malformed messages.
      }
    });
    ws.on('close', () => lobby.disconnect(id));
    ws.on('error', () => ws.terminate());
  });

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of recordPosts) if (now - entry.start > 60_000) recordPosts.delete(ip);
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    lobby.tick(Math.min((now - last) / 1000, 0.25));
    last = now;
  }, TICK_MS);

  server.listen(PORT, () => console.log(`UrSim server on http://localhost:${PORT} (WebSocket /ws)`));
  // Hosting platforms stop the old version with SIGTERM during a deploy.
  process.on('SIGTERM', () => {
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
