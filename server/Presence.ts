// Who has the game open: every browser keeps a small WebSocket (/presence) while the game is
// open, signed in or not. It gives the "4 online · 3 signed in" line and tells friends who's online.

import type { OnlineCount, PresenceServerMessage } from '../src/net/accountProtocol';

export const MAX_PRESENCE = 5000;
/** Counts go out at most this often, ms */
const BROADCAST_MS = 2000;

export interface PresenceSocket {
  send(message: PresenceServerMessage): void;
}

interface Connection {
  socket: PresenceSocket;
  device: string | null;
  account: string | null;
  /** That account's friends, told when it comes online or goes */
  friends: readonly string[];
}

export class Presence {
  private readonly connections = new Map<number, Connection>();
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout) {}

  /** A new browser; null when there are too many. */
  connect(socket: PresenceSocket): number | null {
    if (this.connections.size >= MAX_PRESENCE) return null;
    const id = this.nextId++;
    this.connections.set(id, { socket, device: null, account: null, friends: [] });
    socket.send({ t: 'online', ...this.counts() });
    return id;
  }

  /** The browser said which it is, and who is signed in to it (null: nobody). */
  identify(id: number, device: string | null, account: { id: string; friends: readonly string[] } | null): void {
    const c = this.connections.get(id);
    if (!c) return;
    const was = c.account;
    c.device = device;
    c.account = account?.id ?? null;
    c.friends = account?.friends ?? [];
    if (was !== c.account) {
      if (was && !this.isOnline(was)) this.friendsChanged(was);
      if (c.account && this.sockets(c.account).length === 1) this.notifyFriends(c);
    }
    this.countsChanged();
  }

  disconnect(id: number): void {
    const c = this.connections.get(id);
    if (!c) return;
    this.connections.delete(id);
    if (c.account && !this.isOnline(c.account)) this.notifyFriends(c);
    this.countsChanged();
  }

  /** Browsers (each counted once, however many tabs) and the signed-in players among them. */
  counts(): OnlineCount {
    const browsers = new Set<string>();
    const accounts = new Set<string>();
    for (const [id, c] of this.connections) {
      browsers.add(c.device ?? `#${id}`);
      if (c.account) accounts.add(c.account);
    }
    return { online: browsers.size, signedIn: accounts.size };
  }

  isOnline(account: string): boolean {
    return this.sockets(account).length > 0;
  }

  private sockets(account: string): Connection[] {
    return [...this.connections.values()].filter(c => c.account === account);
  }

  /** Something about these players' friends changed (a request, an answer, someone online). */
  friendsChanged(...accounts: string[]): void {
    for (const c of this.connections.values()) if (c.account && accounts.includes(c.account)) c.socket.send({ t: 'friends' });
  }

  /** An account's friend list changed: who to tell when it comes and goes. */
  setFriends(account: string, friends: readonly string[]): void {
    for (const c of this.connections.values()) if (c.account === account) c.friends = friends;
  }

  private notifyFriends(c: Connection): void {
    if (c.friends.length) this.friendsChanged(...c.friends);
  }

  /** Everyone gets the new counts, a few at a time when many browsers come and go. */
  private countsChanged(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      // Also to a browser whose first counts came before the server knew who it was.
      const counts = this.counts();
      for (const c of this.connections.values()) c.socket.send({ t: 'online', ...counts });
    }, BROADCAST_MS);
  }
}
