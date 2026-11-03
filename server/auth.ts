// Signing in. The game opens /auth/<provider>/start in a popup (or the whole page, when popups
// are blocked); the provider sends the player back to /auth/<provider>/callback, where the server
// finds or makes their account and hands the game a session token. The token only lives in the
// browser (the server keeps its hash) and goes with every request as `Authorization: Bearer …`.
//
// Google: OAuth 2.0 / OpenID Connect with the client from GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET; the ID token's signature is checked against Google's public keys.
// Steam (the Steam version) will be one more AuthProvider: OpenID 2.0 on the website, a
// session ticket in the desktop game. AUTH_DEV_LOGIN=1 adds a name-only sign-in for local testing.

import { createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import type http from 'node:http';
import { usernameFrom, type Provider } from '../src/net/accountProtocol';
import type { Accounts } from './Accounts';

export interface AuthProfile {
  /** The player's id at the provider */
  id: string;
  name: string;
}

export interface AuthProvider {
  readonly id: Provider;
  /** Where the player signs in */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Who came back to the callback */
  finish(query: URLSearchParams, redirectUri: string): Promise<AuthProfile>;
}

/** The parts of a Google ID token this server reads. */
export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  name?: string;
  given_name?: string;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/** Clocks differ a little, s */
const CLOCK_SKEW = 60;
/** Google's keys change every few days; the server checks for new ones this often, ms */
const KEYS_TTL = 3600_000;
/** A sign-in has this long to come back, ms */
const PENDING_TTL = 10 * 60_000;

const base64url = (text: string) => Buffer.from(text, 'base64url');

/** Checks a signed (RS256) ID token: signature, issuer, audience and expiry. */
export async function verifyIdToken(
  token: string,
  clientId: string,
  keyFor: (kid: string) => Promise<JsonWebKey | null>,
  now = Date.now(),
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = JSON.parse(base64url(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected token algorithm');
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, base64url(parts[2]))) throw new Error('bad signature');
  const claims = JSON.parse(base64url(parts[1]).toString('utf8')) as IdTokenClaims;
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error('wrong issuer');
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId)) throw new Error('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now / 1000) throw new Error('expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('no subject');
  return claims;
}

export class GoogleProvider implements AuthProvider {
  readonly id = 'google';
  private keys: { list: JsonWebKey[]; fetched: number } | null = null;

  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly fetchFn: typeof fetch = fetch, private readonly now = Date.now) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL(GOOGLE_AUTH);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Only who the player is and their name: no e-mail.
      scope: 'openid profile',
      state,
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  private async keyFor(kid: string): Promise<JsonWebKey | null> {
    const find = () => this.keys?.list.find(k => (k as { kid?: string }).kid === kid) ?? null;
    if (this.keys && this.now() - this.keys.fetched < KEYS_TTL && find()) return find();
    const res = await this.fetchFn(GOOGLE_KEYS);
    if (!res.ok) throw new Error(`Google keys ${res.status}`);
    this.keys = { list: ((await res.json()) as { keys: JsonWebKey[] }).keys, fetched: this.now() };
    return find();
  }

  async finish(query: URLSearchParams, redirectUri: string): Promise<AuthProfile> {
    const code = query.get('code');
    if (!code) throw new Error(query.get('error') ?? 'no code');
    const res = await this.fetchFn(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const { id_token } = (await res.json()) as { id_token?: string };
    if (!id_token) throw new Error('no ID token');
    const claims = await verifyIdToken(id_token, this.clientId, kid => this.keyFor(kid), this.now());
    return { id: claims.sub, name: claims.name ?? claims.given_name ?? '' };
  }
}

/** Local testing only (AUTH_DEV_LOGIN=1): sign in with any name, no password. */
export class DevProvider implements AuthProvider {
  readonly id = 'dev';

  authorizeUrl(state: string, redirectUri: string): string {
    return `${new URL(redirectUri).origin}/auth/dev/form?state=${encodeURIComponent(state)}`;
  }

  async finish(query: URLSearchParams): Promise<AuthProfile> {
    const name = (query.get('name') ?? '').trim();
    const id = usernameFrom(name);
    if (!id) throw new Error('no name');
    return { id, name };
  }
}

/** The providers the environment sets up. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): AuthProvider[] {
  const list: AuthProvider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) list.push(new GoogleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET));
  if (env.AUTH_DEV_LOGIN === '1') list.push(new DevProvider());
  return list;
}

/** Pages that may receive a session token: the game's own site, a local development copy, and AUTH_ORIGINS. */
export function originAllowed(origin: string, publicUrl: string, extra: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (origin === new URL(publicUrl).origin || extra.includes(origin)) return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

interface Pending {
  provider: Provider;
  origin: string;
  /** A popup hands the token to the game's window; otherwise the game page loads again with it */
  popup: boolean;
  /** The game's page, to come back to (also from a popup cut off from the game's window) */
  returnTo: string | null;
  created: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** JSON inside a <script>: nothing in it can end the script. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function page(res: http.ServerResponse, status: number, title: string, body: string, script = ''): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;background:#0f1216;color:#eef2f6;display:grid;place-items:center;min-height:90vh;margin:0}
main{max-width:360px;padding:24px;text-align:center}input,button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #444;background:#161b22;color:#fff;margin:6px 0;width:100%;box-sizing:border-box}
button{cursor:pointer;border-color:#888;font-weight:700}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`);
}

export class Auth {
  private readonly pending = new Map<string, Pending>();
  private readonly providers: Map<Provider, AuthProvider>;

  constructor(
    providers: readonly AuthProvider[],
    private readonly accounts: Accounts,
    private readonly publicUrl: string,
    private readonly extraOrigins: readonly string[] = [],
    private readonly now = Date.now,
  ) {
    this.providers = new Map(providers.map(p => [p.id, p]));
  }

  /** Which sign-in buttons the game shows (e-mail is server/emailAuth.ts). */
  enabled(): Record<Exclude<Provider, 'email'>, boolean> {
    return { google: this.providers.has('google'), steam: this.providers.has('steam'), dev: this.providers.has('dev') };
  }

  private redirectUri(provider: Provider): string {
    return `${this.publicUrl}/auth/${provider}/callback`;
  }

  /** /auth/… pages; false for any other address. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/auth\/([a-z]+)\/(start|callback|form)$/.exec(url.pathname);
    if (!match) return false;
    const provider = this.providers.get(match[1] as Provider);
    if (req.method !== 'GET') {
      page(res, 405, 'UrSim', '<p>Method not allowed</p>');
      return true;
    }
    if (!provider) {
      page(res, 404, 'UrSim', '<p>This sign-in is not set up on this server.</p>');
      return true;
    }
    if (match[2] === 'start') this.start(provider, url.searchParams, res);
    else if (match[2] === 'form') this.devForm(provider, url.searchParams, res);
    else await this.callback(provider, url.searchParams, res);
    return true;
  }

  private start(provider: AuthProvider, query: URLSearchParams, res: http.ServerResponse): void {
    const origin = query.get('origin') ?? '';
    const popup = query.get('mode') !== 'redirect';
    const returnTo = query.get('return');
    let returnOk = returnTo === null ? popup : false;
    try {
      returnOk ||= new URL(returnTo!).origin === origin;
    } catch {
      // Not an address: refused below.
    }
    if (!originAllowed(origin, this.publicUrl, this.extraOrigins) || !returnOk) {
      page(res, 400, 'UrSim', '<p>Sign-in can only start from the game.</p>');
      return;
    }
    const now = this.now();
    for (const [state, p] of this.pending) if (now - p.created > PENDING_TTL) this.pending.delete(state);
    const state = randomBytes(24).toString('base64url');
    this.pending.set(state, { provider: provider.id, origin, popup, returnTo, created: now });
    res.writeHead(302, { location: provider.authorizeUrl(state, this.redirectUri(provider.id)), 'cache-control': 'no-store' });
    res.end();
  }

  private devForm(provider: AuthProvider, query: URLSearchParams, res: http.ServerResponse): void {
    if (provider.id !== 'dev') {
      page(res, 404, 'UrSim', '<p>Not found</p>');
      return;
    }
    const state = escapeHtml(query.get('state') ?? '');
    page(res, 200, 'UrSim · test sign-in', `<h2>Test sign-in</h2><p>Local server only: any name, no password.</p>
<form action="/auth/dev/callback"><input type="hidden" name="state" value="${state}"><input name="name" maxlength="16" placeholder="Name" required autofocus><button>Sign in</button></form>`);
  }

  private async callback(provider: AuthProvider, query: URLSearchParams, res: http.ServerResponse): Promise<void> {
    const state = query.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.provider !== provider.id || this.now() - pending.created > PENDING_TTL) {
      page(res, 400, 'UrSim', '<p>This sign-in has expired. Start it again from the game.</p>');
      return;
    }
    let token: string;
    try {
      const profile = await provider.finish(query, this.redirectUri(provider.id));
      const account = await this.accounts.signIn(provider.id, profile.id, profile.name);
      token = await this.accounts.createSession(account.id);
    } catch (err) {
      console.warn(`sign-in (${provider.id}):`, (err as Error).message);
      return this.finish(res, pending, { error: 'failed' });
    }
    this.finish(res, pending, { token });
  }

  /** Hands the result to the game: into the window that opened the popup, or back to the game's page. */
  private finish(res: http.ServerResponse, pending: Pending, result: { token: string } | { error: string }): void {
    const back = pending.returnTo && `${pending.returnTo.split('#')[0]}#${'token' in result ? `ursim_token=${result.token}` : `ursim_auth_error=${result.error}`}`;
    if (!pending.popup) {
      res.writeHead(302, { location: back!, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const ok = 'token' in result;
    // On the game's own site the token also goes straight into its storage, in case the
    // provider's pages cut this popup off from the game's window; a popup with no game window
    // behind it (opened as a tab) goes back to the game with the token.
    const script = `var m=${scriptJson({ ursim: 'auth', ...result })},o=${scriptJson(pending.origin)},b=${scriptJson(back)};
try{if(m.token&&location.origin===o)localStorage.setItem('ursim.session',m.token)}catch(e){}
var w=null;try{w=window.opener}catch(e){}
if(w){try{w.postMessage(m,o)}catch(e){}setTimeout(function(){window.close()},400)}else if(b){location.replace(b)}`;
    page(res, ok ? 200 : 400, 'UrSim', ok ? '<p>Signed in. You can close this window.</p>' : '<p>Sign-in failed. Close this window and try again.</p>', script);
  }
}
