// The browser's side of accounts and statistics (server/api.ts, server/auth.ts): the session
// token, signing in through a popup, the signed-in player, friends, and the numbers the menus show.

import type {
  BoardEntry,
  BoardKind,
  CareerResponse,
  CloudRobot,
  CloudRobots,
  FriendRequestResult,
  FriendsResponse,
  GameReportBody,
  GameReportResult,
  Me,
  OnlineCount,
  Provider,
  RankedEntry,
  ReplayInfo,
  ReplayUpload,
  Totals,
} from './accountProtocol';
import type { ReplayFrame } from '../game/replay';
import { gunzip, gzip, packReplay, unpackReplay } from '../game/replayFile';
import type { GalleryEntry, GalleryPage, GalleryRobot, GallerySort, GalleryUpload } from './galleryProtocol';
import { defaultServerUrl } from './records';

const TOKEN_KEY = 'ursim.session';
const DEVICE_KEY = 'ursim.device';

let memoryDevice: string | null = null;

/** This browser's random id: players without an account are counted by it. */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): string {
  try {
    const saved = storage?.getItem(DEVICE_KEY);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  } catch {
    // No storage: an id for this visit only.
  }
  const id = memoryDevice ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  memoryDevice = id;
  try {
    storage?.setItem(DEVICE_KEY, id);
  } catch {
    // Kept in memory only.
  }
  return id;
}

function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Signed in for this visit only.
  }
}

/** The desktop app's way to sign in with a service through the player's browser (desktop/preload.cjs). */
interface DesktopBridge {
  signIn(provider: Provider, server: string): Promise<string | null>;
}

const desktopBridge = (): DesktopBridge | undefined => (globalThis as { ursimDesktop?: DesktopBridge }).ursimDesktop;
const onWebsite = () => location.protocol === 'http:' || location.protocol === 'https:';

/** Signing in with a service (Google…) works on the website, and in a desktop app that opens the browser for it. */
export const canSignIn = () => onWebsite() || !!desktopBridge();

/** The desktop app: a service's sign-in opens in the player's browser. */
export const signInInBrowser = () => !onWebsite() && !!desktopBridge();

/** A request body of JSON and a file after it: [u32 LE length of the JSON][JSON][the file]. */
function packUpload(value: unknown, file: ArrayBuffer | null): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify(value));
  const body = new Uint8Array(4 + meta.length + (file?.byteLength ?? 0));
  new DataView(body.buffer).setUint32(0, meta.length, true);
  body.set(meta, 4);
  if (file) body.set(new Uint8Array(file), 4 + meta.length);
  return body;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
  }
}

export class AccountClient {
  me: Me | null = null;
  private token: string | null = savedToken();
  private readonly listeners = new Set<(me: Me | null) => void>();
  private popupWatch: ReturnType<typeof setInterval> | null = null;

  constructor(readonly server = defaultServerUrl()) {
    // Back from a sign-in that replaced the whole page (popups blocked): the token is in the address.
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('ursim_token');
    if (token || hash.has('ursim_auth_error')) {
      if (token) this.setToken(token);
      history.replaceState(null, '', location.pathname + location.search);
    }
    window.addEventListener('message', e => {
      if (e.origin !== new URL(this.server).origin || e.data?.ursim !== 'auth') return;
      if (typeof e.data.token === 'string') this.signedIn(e.data.token);
    });
    // The popup on the game's own site puts the token straight into storage.
    window.addEventListener('storage', e => {
      if (e.key === TOKEN_KEY && e.newValue && e.newValue !== this.token) this.signedIn(e.newValue);
    });
  }

  get sessionToken(): string | null {
    return this.token;
  }

  /** Called with the player whenever they sign in or out (and once their account has loaded). */
  onChange(listener: (me: Me | null) => void): void {
    this.listeners.add(listener);
  }

  private setToken(token: string | null): void {
    this.token = token;
    saveToken(token);
  }

  private changed(): void {
    for (const l of this.listeners) l(this.me);
  }

  private async signedIn(token: string): Promise<void> {
    this.setToken(token);
    if (this.popupWatch) clearInterval(this.popupWatch);
    this.popupWatch = null;
    await this.load();
  }

  /** `raw`: a binary body instead of JSON. */
  async api<T>(route: string, init: { method?: string; body?: unknown; raw?: Uint8Array } = {}): Promise<T> {
    const type = init.raw ? 'application/octet-stream' : init.body !== undefined ? 'application/json' : null;
    const res = await fetch(new URL(route, this.server), {
      method: init.method ?? 'GET',
      headers: { ...(type && { 'content-type': type }), ...(this.token && { authorization: `Bearer ${this.token}` }) },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? String(res.status));
    return body;
  }

  /** The signed-in player, from the server (null when signed out or the session ended). */
  async load(): Promise<Me | null> {
    if (!this.token) {
      this.me = null;
      this.changed();
      return null;
    }
    try {
      this.me = await this.api<Me>('/api/me');
    } catch (err) {
      // A session that ended (or was signed out elsewhere); a server that's down keeps it.
      if (err instanceof ApiError && err.status === 401) this.setToken(null);
      this.me = null;
    }
    this.changed();
    return this.me;
  }

  providers(): Promise<Record<Provider, boolean>> {
    return this.api('/api/auth/providers');
  }

  /**
   * Opens the provider's sign-in in a popup; when popups are blocked, the whole page goes there and
   * comes back. The desktop app signs in in the player's browser instead.
   */
  signIn(provider: Provider): void {
    const desktop = desktopBridge();
    if (desktop && !onWebsite()) {
      desktop.signIn(provider, this.server).then(token => {
        if (token) void this.signedIn(token);
      }, () => undefined);
      return;
    }
    const start = new URL(`/auth/${provider}/start`, this.server);
    start.searchParams.set('origin', location.origin);
    start.searchParams.set('return', location.href.split('#')[0]);
    const w = 480;
    const hgt = 640;
    const popup = window.open(`${start}&mode=popup`, '_blank', `popup,width=${w},height=${hgt},left=${Math.round(screenX + (outerWidth - w) / 2)},top=${Math.round(screenY + (outerHeight - hgt) / 2)}`);
    if (!popup) {
      start.searchParams.set('mode', 'redirect');
      location.href = start.toString();
      return;
    }
    // In case the token reached storage but no message came (the provider cut the popup off from this window).
    if (this.popupWatch) clearInterval(this.popupWatch);
    this.popupWatch = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(this.popupWatch!);
      this.popupWatch = null;
      const token = savedToken();
      if (token && token !== this.token) void this.signedIn(token);
    }, 500);
  }

  /** Signs up (with a name) or in with an e-mail and a password; null when it worked, else the server's reason. */
  async emailSignIn(kind: 'register' | 'login', fields: { email: string; password: string; name?: string }): Promise<string | null> {
    try {
      const { token } = await this.api<{ token: string }>(`/api/auth/email/${kind}`, { method: 'POST', body: fields });
      await this.signedIn(token);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.code : 'failed';
    }
  }

  async signOut(): Promise<void> {
    if (this.token) await this.api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    this.setToken(null);
    this.me = null;
    this.changed();
  }

  async update(change: { name?: string; username?: string }): Promise<Me> {
    this.me = await this.api<Me>('/api/me', { method: 'PATCH', body: change });
    this.changed();
    return this.me;
  }

  totals(): Promise<Totals & OnlineCount> {
    return this.api('/api/stats');
  }

  reportGame(report: Omit<GameReportBody, 'device'>): Promise<Partial<GameReportResult>> {
    return this.api('/api/games', { method: 'POST', body: { ...report, device: deviceId() } });
  }

  leaderboard(period: string, kind: BoardKind, robot: string): Promise<BoardEntry[]> {
    const q = new URLSearchParams({ period, kind, robot });
    return this.api<{ entries: BoardEntry[] }>(`/api/leaderboard?${q}`).then(r => r.entries);
  }

  ranked(period: string): Promise<RankedEntry[]> {
    return this.api<{ entries: RankedEntry[] }>(`/api/ranked?period=${encodeURIComponent(period)}`).then(r => r.entries);
  }

  /** A player's career (no user: the signed-in player's). */
  career(user: string | null, period: string): Promise<CareerResponse> {
    const q = new URLSearchParams({ period, ...(user && { user }) });
    return this.api(`/api/career?${q}`);
  }

  friends(): Promise<FriendsResponse> {
    return this.api('/api/friends');
  }

  requestFriend(username: string): Promise<FriendsResponse & { result: FriendRequestResult }> {
    return this.api('/api/friends', { method: 'POST', body: { username } });
  }

  acceptFriend(id: string): Promise<FriendsResponse> {
    return this.api('/api/friends/accept', { method: 'POST', body: { id } });
  }

  // ---- the match archive --------------------------------------------------------

  /** The signed-in player's recorded matches, newest first. */
  replays(): Promise<ReplayInfo[]> {
    return this.api<{ replays: ReplayInfo[] }>('/api/replays').then(r => r.replays);
  }

  /** Puts a finished match into the archive. */
  async saveReplay(info: ReplayUpload, frames: readonly ReplayFrame[]): Promise<ReplayInfo> {
    const meta = new TextEncoder().encode(JSON.stringify(info));
    const data = await gzip(packReplay(frames));
    const body = new Uint8Array(4 + meta.length + data.length);
    new DataView(body.buffer).setUint32(0, meta.length, true);
    body.set(meta, 4);
    body.set(data, 4 + meta.length);
    return this.api<ReplayInfo>('/api/replays', { method: 'POST', raw: body });
  }

  /** A match from the archive, ready to watch. */
  async replay(id: string): Promise<ReplayFrame[]> {
    const res = await fetch(new URL(`/api/replays/${id}`, this.server), { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, String(res.status));
    return unpackReplay(await gunzip(new Uint8Array(await res.arrayBuffer())));
  }

  deleteReplay(id: string): Promise<unknown> {
    return this.api(`/api/replays/${id}`, { method: 'DELETE' });
  }

  /** Declines a request, takes one back, or removes a friend. */
  removeFriend(id: string): Promise<FriendsResponse> {
    return this.api('/api/friends/remove', { method: 'POST', body: { id } });
  }

  // ---- the robot gallery ----------------------------------------------------------

  /** A page of the gallery: newest or most added first, matching `q`, or only the player's own. */
  gallery(options: { sort: GallerySort; q?: string; offset?: number; mine?: boolean }): Promise<GalleryPage> {
    const q = new URLSearchParams({ sort: options.sort });
    if (options.q) q.set('q', options.q);
    if (options.offset) q.set('offset', String(options.offset));
    if (options.mine) q.set('mine', '1');
    return this.api(`/api/gallery?${q}`);
  }

  galleryRobot(id: string): Promise<GalleryRobot> {
    return this.api(`/api/gallery/${id}`);
  }

  /** The address of a gallery robot's card picture (it changes with every new version). */
  galleryThumb(entry: GalleryEntry): string {
    return new URL(`/api/gallery/${entry.id}/thumb?v=${encodeURIComponent(entry.updated)}`, this.server).toString();
  }

  /** A gallery robot's 3D model file. */
  async galleryModel(entry: GalleryEntry): Promise<ArrayBuffer> {
    const res = await fetch(new URL(`/api/gallery/${entry.id}/model?v=${encodeURIComponent(entry.updated)}`, this.server), {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, String(res.status));
    return res.arrayBuffer();
  }

  /** Publishes a robot (again: a new version of it), with its 3D model if it has one. */
  publishRobot(upload: GalleryUpload, model: ArrayBuffer | null): Promise<GalleryRobot> {
    return this.api('/api/gallery', { method: 'POST', raw: packUpload(upload, model) });
  }

  unpublishRobot(id: string): Promise<unknown> {
    return this.api(`/api/gallery/${id}`, { method: 'DELETE' });
  }

  /** Tells the gallery a player added the robot (each player counts once). */
  galleryAdded(id: string): Promise<unknown> {
    return this.api(`/api/gallery/${id}/added`, { method: 'POST', body: { device: deviceId() } });
  }

  reportRobot(id: string): Promise<unknown> {
    return this.api(`/api/gallery/${id}/report`, { method: 'POST', body: {} });
  }

  /** A moderator puts a hidden robot back. */
  restoreRobot(id: string): Promise<unknown> {
    return this.api(`/api/gallery/${id}/restore`, { method: 'POST', body: {} });
  }

  // ---- the player's own robots, kept with the account --------------------------

  cloudRobots(): Promise<CloudRobots> {
    return this.api('/api/robots');
  }

  /** Keeps a robot with the account (with its model file when the account lacks it); the version kept comes back. */
  putCloudRobot(robot: CloudRobot, model: ArrayBuffer | null): Promise<CloudRobot> {
    return this.api(`/api/robots/${robot.id}`, { method: 'POST', raw: packUpload(robot, model) });
  }

  deleteCloudRobot(id: string, at: number): Promise<unknown> {
    return this.api(`/api/robots/${id}?at=${Math.round(at)}`, { method: 'DELETE' });
  }

  async cloudModel(mesh: string): Promise<ArrayBuffer> {
    const res = await fetch(new URL(`/api/robots/model/${mesh}`, this.server), { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, String(res.status));
    return res.arrayBuffer();
  }
}
