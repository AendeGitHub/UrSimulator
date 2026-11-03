// Player accounts: made on the first sign-in with a service (Google now, Steam later), each with
// a unique @username, sessions for the browsers signed in to it, and friends.
//
// Keys: account:<id> · identity:<provider>:<their id> → account id · username:<name> → account id
// · session:<sha256 of the token> → account id (the token itself is only in the browser)
// · count:accounts → how many accounts were made.

import { createHash, randomBytes } from 'node:crypto';
import { isUsername, usernameFrom, type FriendRequestResult, type Me, type Provider, type PublicAccount } from '../src/net/accountProtocol';
import { cleanName } from '../src/net/records';
import type { Db } from './Kv';

export interface Account {
  id: string;
  username: string;
  name: string;
  created: string;
  /** Sign-in services: provider → the player's id there */
  identities: Partial<Record<Provider, string>>;
  friends: string[];
  /** Friend requests to this player, and the ones they sent */
  incoming: string[];
  outgoing: string[];
  /**
   * False for an account a service's first sign-in made (Google…): its name and @username come from
   * the service until the player picks their own. Missing on older accounts: those are done.
   */
  named?: boolean;
}

/** A browser stays signed in this long without signing in again, s. */
export const SESSION_TTL = 180 * 24 * 3600;
export const MAX_FRIENDS = 200;
const ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const COUNT = 'count:accounts';

export const publicAccount = (a: Account): PublicAccount => ({ id: a.id, username: a.username, name: a.name });
export const me = (a: Account): Me => ({
  ...publicAccount(a),
  created: a.created,
  providers: Object.keys(a.identities) as Provider[],
  ...(a.named === false && { needsName: true }),
});

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Accounts {
  constructor(private readonly db: Db, private readonly random: (bytes: number) => Buffer = randomBytes) {}

  private newId(): string {
    return [...this.random(12)].map(b => ID_LETTERS[b % ID_LETTERS.length]).join('');
  }

  byId(id: string): Promise<Account | null> {
    return typeof id === 'string' && /^[a-z0-9]{12}$/.test(id) ? this.db.read<Account>(`account:${id}`) : Promise.resolve(null);
  }

  async byUsername(username: string): Promise<Account | null> {
    const name = username.replace(/^@/, '').toLowerCase();
    if (!isUsername(name)) return null;
    const id = await this.db.read<string>(`username:${name}`);
    return id ? this.byId(id) : null;
  }

  /** An id or a @username. */
  async find(who: string): Promise<Account | null> {
    return (await this.byId(who)) ?? this.byUsername(who);
  }

  /** A friend change touches two accounts: all changes to accounts run one after another. */
  private changeAccounts<T>(run: () => Promise<T>): Promise<T> {
    return this.db.locked('accounts', run);
  }

  private save(account: Account): Promise<void> {
    return this.db.write(`account:${account.id}`, account);
  }

  /** Claims a free username like `wanted` (wanted, wanted2, wanted3, …). */
  private async claimUsername(wanted: string, id: string): Promise<string> {
    let base = usernameFrom(wanted);
    if (base.length < 3) base = `player${base}`;
    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '' : String(i < 50 ? i : Math.floor(this.random(3).readUIntBE(0, 3) % 1_000_000));
      const name = base.slice(0, 20 - suffix.length) + suffix;
      if (await this.db.add(`username:${name}`, id)) return name;
    }
  }

  /** The account behind a service's player id; the first sign-in makes it. */
  signIn(provider: Provider, providerId: string, profileName: string, now = new Date()): Promise<Account> {
    const identityKey = `identity:${provider}:${providerId}`;
    return this.db.locked(identityKey, async () => {
      const id = await this.db.read<string>(identityKey);
      const existing = id ? await this.byId(id) : null;
      if (existing) return existing;
      const account: Account = {
        id: this.newId(),
        username: '',
        name: cleanName(profileName),
        created: now.toISOString(),
        identities: { [provider]: providerId },
        friends: [],
        incoming: [],
        outgoing: [],
        // An e-mail sign-up typed its name; a service's gives the service's.
        named: provider === 'email',
      };
      account.username = await this.claimUsername(profileName, account.id);
      await this.save(account);
      await this.db.write(identityKey, account.id);
      await this.db.update<number>(COUNT, n => (n ?? 0) + 1);
      return account;
    });
  }

  /** How many accounts were made (the main menu shows it). */
  async count(): Promise<number> {
    return (await this.db.read<number>(COUNT)) ?? 0;
  }

  /** Counts the accounts made before the count was kept: once, when the server starts. */
  async backfill(): Promise<void> {
    if ((await this.db.read<number>(COUNT)) !== null) return;
    await this.db.add(COUNT, (await this.db.keys('account:')).length);
  }

  /** A new session token for a browser. */
  async createSession(accountId: string): Promise<string> {
    const token = this.random(32).toString('base64url');
    await this.db.write(`session:${hash(token)}`, accountId, SESSION_TTL);
    return token;
  }

  async session(token: unknown): Promise<Account | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const id = await this.db.read<string>(`session:${hash(token)}`);
    return id ? this.byId(id) : null;
  }

  endSession(token: string): Promise<void> {
    return this.db.del(`session:${hash(token)}`);
  }

  /** A new display name and/or @username (the same ones again: the player keeps them). */
  update(id: string, change: { name?: unknown; username?: unknown }): Promise<Account | 'invalid' | 'taken'> {
    return this.changeAccounts(async () => {
      const account = await this.byId(id);
      if (!account) return 'invalid';
      if (change.name !== undefined) {
        if (typeof change.name !== 'string' || !change.name.trim()) return 'invalid';
        account.name = cleanName(change.name);
      }
      if (change.username !== undefined && change.username !== account.username) {
        const name = typeof change.username === 'string' ? change.username.replace(/^@/, '').toLowerCase() : '';
        if (!isUsername(name)) return 'invalid';
        if (!(await this.db.add(`username:${name}`, id))) return 'taken';
        await this.db.del(`username:${account.username}`);
        account.username = name;
      }
      account.named = true;
      await this.save(account);
      return account;
    });
  }

  // ---- friends ----------------------------------------------------------------

  private async pair(a: string, b: string): Promise<[Account, Account] | null> {
    const [x, y] = await Promise.all([this.byId(a), this.byId(b)]);
    return x && y ? [x, y] : null;
  }

  /** Asks `who` (an id or @username) to be friends; asking someone who asked first makes friends. */
  request(fromId: string, who: string): Promise<FriendRequestResult> {
    return this.changeAccounts(async () => {
      const to = await this.find(who);
      const from = await this.byId(fromId);
      if (!to || !from) return 'unknown';
      if (to.id === from.id) return 'self';
      if (from.friends.includes(to.id) || from.outgoing.includes(to.id)) return 'already';
      if (from.incoming.includes(to.id)) {
        await this.befriend(from, to);
        return 'accepted';
      }
      if (from.friends.length >= MAX_FRIENDS || to.incoming.length >= MAX_FRIENDS) return 'already';
      from.outgoing.push(to.id);
      to.incoming.push(from.id);
      await Promise.all([this.save(from), this.save(to)]);
      return 'sent';
    });
  }

  private async befriend(a: Account, b: Account): Promise<void> {
    for (const [x, y] of [[a, b], [b, a]]) {
      x.incoming = x.incoming.filter(id => id !== y.id);
      x.outgoing = x.outgoing.filter(id => id !== y.id);
      if (!x.friends.includes(y.id)) x.friends.push(y.id);
    }
    await Promise.all([this.save(a), this.save(b)]);
  }

  accept(id: string, otherId: string): Promise<boolean> {
    return this.changeAccounts(async () => {
      const pair = await this.pair(id, otherId);
      if (!pair || !pair[0].incoming.includes(otherId)) return false;
      await this.befriend(...pair);
      return true;
    });
  }

  /** Declines a request, takes back one this player sent, or ends a friendship. */
  remove(id: string, otherId: string): Promise<boolean> {
    return this.changeAccounts(async () => {
      const pair = await this.pair(id, otherId);
      if (!pair) return false;
      for (const [x, y] of [pair, [pair[1], pair[0]]]) {
        x.friends = x.friends.filter(f => f !== y.id);
        x.incoming = x.incoming.filter(f => f !== y.id);
        x.outgoing = x.outgoing.filter(f => f !== y.id);
      }
      await Promise.all([this.save(pair[0]), this.save(pair[1])]);
      return true;
    });
  }

  /** Accounts by id, skipping any that no longer exist. */
  async many(ids: readonly string[]): Promise<Account[]> {
    return (await Promise.all(ids.map(id => this.byId(id)))).filter((a): a is Account => a !== null);
  }
}
