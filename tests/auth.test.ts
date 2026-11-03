import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts } from '../server/Accounts';
import { Auth, DevProvider, GoogleProvider, originAllowed, providersFromEnv, verifyIdToken } from '../server/auth';
import { Db, MemoryKv } from '../server/Kv';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'key-1', alg: 'RS256', use: 'sig' };
const NOW = Date.parse('2026-10-29T12:00:00Z');

function idToken(claims: Record<string, unknown>, kid = 'key-1', key = privateKey): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234567890', exp: NOW / 1000 + 3600, name: 'Khussein Maxut', ...claims })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

const keyFor = async (kid: string) => (kid === 'key-1' ? jwk : null);

describe('Google ID tokens', () => {
  it('accepts a token Google signed for this game', async () => {
    expect(await verifyIdToken(idToken({}), CLIENT_ID, keyFor, NOW)).toMatchObject({ sub: '1234567890', name: 'Khussein Maxut' });
  });

  it('refuses forged, foreign, expired and unknown-key tokens', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(verifyIdToken(idToken({}, 'key-1', other), CLIENT_ID, keyFor, NOW)).rejects.toThrow('bad signature');
    await expect(verifyIdToken(idToken({ aud: 'another-app' }), CLIENT_ID, keyFor, NOW)).rejects.toThrow('wrong audience');
    await expect(verifyIdToken(idToken({ iss: 'https://evil.example' }), CLIENT_ID, keyFor, NOW)).rejects.toThrow('wrong issuer');
    await expect(verifyIdToken(idToken({ exp: NOW / 1000 - 3600 }), CLIENT_ID, keyFor, NOW)).rejects.toThrow('expired');
    await expect(verifyIdToken(idToken({}, 'key-2'), CLIENT_ID, keyFor, NOW)).rejects.toThrow('unknown signing key');
    // Changing the claims breaks the signature.
    const [h, , s] = idToken({}).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'someone-else', exp: NOW / 1000 + 60 })).toString('base64url')}.${s}`;
    await expect(verifyIdToken(forged, CLIENT_ID, keyFor, NOW)).rejects.toThrow('bad signature');
  });

  it('trades the code for a token and reads the player from it', async () => {
    const requests: { url: string; body?: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.includes('certs')) return new Response(JSON.stringify({ keys: [jwk] }));
      return new Response(JSON.stringify({ id_token: idToken({}) }));
    }) as typeof fetch;
    const google = new GoogleProvider(CLIENT_ID, 'secret', fakeFetch, () => NOW);
    const url = new URL(google.authorizeUrl('state-1', 'https://ursim.onrender.com/auth/google/callback'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, scope: 'openid profile', state: 'state-1', response_type: 'code' });
    expect(await google.finish(new URLSearchParams({ code: 'abc' }), 'https://ursim.onrender.com/auth/google/callback')).toEqual({ id: '1234567890', name: 'Khussein Maxut' });
    const exchange = new URLSearchParams(requests[0].body);
    expect(Object.fromEntries(exchange)).toMatchObject({ code: 'abc', client_secret: 'secret', grant_type: 'authorization_code' });
    await expect(google.finish(new URLSearchParams({ error: 'access_denied' }), 'x')).rejects.toThrow('access_denied');
  });

  it('only turns on the providers the environment sets up', () => {
    expect(providersFromEnv({}).map(p => p.id)).toEqual([]);
    expect(providersFromEnv({ GOOGLE_CLIENT_ID: 'id' }).map(p => p.id)).toEqual([]);
    expect(providersFromEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', AUTH_DEV_LOGIN: '1' }).map(p => p.id)).toEqual(['google', 'dev']);
  });
});

describe('sign-in pages', () => {
  let server: http.Server | null = null;
  afterEach(() => server?.close());

  async function start() {
    const accounts = new Accounts(new Db(new MemoryKv()));
    const auth = new Auth([new DevProvider()], accounts, 'https://ursim.onrender.com');
    server = http.createServer((req, res) => {
      auth.handle(req, res, new URL(req.url!, 'http://x')).then(handled => !handled && res.writeHead(404).end());
    });
    await new Promise<void>(resolve => server!.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    return { accounts, auth, base };
  }

  it('lets only the game\'s own pages start a sign-in', () => {
    expect(originAllowed('https://ursim.onrender.com', 'https://ursim.onrender.com')).toBe(true);
    expect(originAllowed('http://localhost:5175', 'https://ursim.onrender.com')).toBe(true);
    expect(originAllowed('https://evil.example', 'https://ursim.onrender.com')).toBe(false);
    expect(originAllowed('https://ursim.onrender.com/path', 'https://ursim.onrender.com')).toBe(false);
    expect(originAllowed('https://my.domain', 'https://ursim.onrender.com', ['https://my.domain'])).toBe(true);
  });

  it('hands the popup\'s token to the game window, and a redirect back to the game page', async () => {
    const { accounts, base } = await start();
    const evil = await fetch(`${base}/auth/dev/start?origin=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
    expect(evil.status).toBe(400);
    expect((await fetch(`${base}/auth/google/start?origin=http://localhost:5175`, { redirect: 'manual' })).status).toBe(404);

    const startRes = await fetch(`${base}/auth/dev/start?origin=${encodeURIComponent('http://localhost:5175')}&mode=popup`, { redirect: 'manual' });
    expect(startRes.status).toBe(302);
    const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!;
    const done = await fetch(`${base}/auth/dev/callback?state=${state}&name=Max`);
    const html = await done.text();
    const token = /"token":"([^"]+)"/.exec(html)![1];
    expect(html).toContain('w.postMessage(m,o)');
    expect(html).toContain('"http://localhost:5175"');
    // Without a game window behind it the popup goes back to the game itself.
    const popupBack = await fetch(`${base}/auth/dev/start?origin=${encodeURIComponent('http://localhost:5175')}&return=${encodeURIComponent('http://localhost:5175/?x=1')}`, { redirect: 'manual' });
    const state3 = new URL(popupBack.headers.get('location')!).searchParams.get('state')!;
    expect(await (await fetch(`${base}/auth/dev/callback?state=${state3}&name=Max`)).text()).toMatch(/b="http:\/\/localhost:5175\/\?x=1#ursim_token=[^"]+"/);
    expect((await accounts.session(token))?.name).toBe('Max');
    // A state works once.
    expect((await fetch(`${base}/auth/dev/callback?state=${state}&name=Max`)).status).toBe(400);

    const returnTo = 'http://localhost:5175/?lang=en#old';
    const redirect = await fetch(`${base}/auth/dev/start?origin=${encodeURIComponent('http://localhost:5175')}&mode=redirect&return=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
    const state2 = new URL(redirect.headers.get('location')!).searchParams.get('state')!;
    const back = await fetch(`${base}/auth/dev/callback?state=${state2}&name=Max`, { redirect: 'manual' });
    const location = back.headers.get('location')!;
    expect(location).toMatch(/^http:\/\/localhost:5175\/\?lang=en#ursim_token=/);
    expect((await accounts.session(location.split('ursim_token=')[1]))?.name).toBe('Max');
    // A redirect only goes back to the page that started it.
    expect((await fetch(`${base}/auth/dev/start?origin=${encodeURIComponent('http://localhost:5175')}&mode=redirect&return=${encodeURIComponent('https://evil.example/')}`, { redirect: 'manual' })).status).toBe(400);
  });
});
