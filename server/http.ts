// Small HTTP helpers shared by the server's routes.

import type http from 'node:http';

/** A record submission or an API request is a tiny JSON object. */
export const MAX_BODY_BYTES = 1024;

// The dev game runs on another port than the server, so the API allows any origin. Sign-in
// travels in the Authorization header, never in cookies, so other sites can't act for a player.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
  'access-control-allow-headers': 'content-type, authorization',
};

export function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

/** A file for the browser: a replay (never kept by caches in between), a gallery robot's picture or model. */
export function sendBytes(res: http.ServerResponse, data: Buffer, { type = 'application/octet-stream', cache = 'private, no-store' } = {}): void {
  res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': cache, ...CORS });
  res.end(data);
}

/** The answer to a browser asking whether it may send a request from another origin. */
export function sendPreflight(res: http.ServerResponse): void {
  res.writeHead(204, CORS);
  res.end();
}

export function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** A binary request body (a replay), or null when it is larger than `limit`. */
export function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A JSON object from the request body, or null when it isn't one. */
export async function readJson(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readBody(req, limit));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function clientAddress(req: http.IncomingMessage): string {
  // Render and similar hosts put the player's address first in X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.socket.remoteAddress || '?';
}

/** The session token a request carries, if any. */
export function bearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** So many requests a minute from one address. */
export class RateLimit {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute: number, private readonly now = Date.now) {}

  allow(req: http.IncomingMessage): boolean {
    const now = this.now();
    const ip = clientAddress(req);
    const entry = this.hits.get(ip);
    if (!entry || now - entry.start > 60_000) {
      this.hits.set(ip, { start: now, count: 1 });
      return true;
    }
    return ++entry.count <= this.perMinute;
  }

  /** Forgets addresses that went quiet. */
  cleanup(): void {
    const now = this.now();
    for (const [ip, entry] of this.hits) if (now - entry.start > 60_000) this.hits.delete(ip);
  }
}
