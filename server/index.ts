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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const TICK_MS = 4;
/** Protects a small free server from overload. */
const MAX_CONNECTIONS = 200;
/** Inputs arrive 60 times a second; anything far above that is a broken or hostile client. */
const MAX_MESSAGES_PER_SECOND = 150;
/** Hosting proxies drop silent connections, and ping/pong also finds dead ones. */
const HEARTBEAT_MS = 25_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
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

  const started = Date.now();
  const server = http.createServer((req, res) =>
    serveStatic(req, res, () => ({ ok: true, rooms: lobby.roomCount, players: wss.clients.size, uptime: Math.round((Date.now() - started) / 1000) })));
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
