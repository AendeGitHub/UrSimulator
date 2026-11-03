// Signing in with an e-mail address and a password, for players without Google. The password is
// kept only as a scrypt hash with a salt of its own, so not even the server can read it back. The
// address is the account's identity (identity:email:<address>, server/Accounts.ts) and is never
// shown to anyone; the account gets an @username from the name like any other.
//
// Keys: password:<address> → { hash, name }

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { cleanName } from '../src/net/records';
import type { Accounts } from './Accounts';
import type { Db } from './Kv';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** Failed sign-ins to one address before it waits FAILURE_WINDOW */
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60_000;
/** scrypt's cost: about 50 ms and 16 MB of memory a try */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;

export type EmailError = 'badEmail' | 'shortPassword' | 'noName' | 'emailTaken' | 'wrongPassword' | 'tooMany';
export type EmailResult = { token: string } | { error: EmailError };

interface PasswordRecord {
  /** scrypt$N$r$p$salt$key, base64url */
  hash: string;
  /** The name it was made with: an account lost in between is made again with it */
  name: string;
}

/** The address in lower case, or null when it can't be one. */
export function cleanEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const address = email.trim().toLowerCase();
  return address.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address) ? address : null;
}

const isPassword = (password: unknown): password is string =>
  typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

function derive(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...params, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string, random: (bytes: number) => Buffer = randomBytes): Promise<string> {
  const salt = random(16);
  const key = await derive(password, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function checkPassword(password: string, hash: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = hash.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class EmailAuth {
  private readonly failures = new Map<string, { start: number; count: number }>();
  /** Checked when the address has no account, so a wrong address takes as long as a wrong password */
  private dummy: Promise<string> | null = null;

  constructor(private readonly db: Db, private readonly accounts: Accounts, private readonly now = Date.now) {}

  async register(email: unknown, password: unknown, name: unknown): Promise<EmailResult> {
    const address = cleanEmail(email);
    if (!address) return { error: 'badEmail' };
    if (!isPassword(password)) return { error: 'shortPassword' };
    if (typeof name !== 'string' || !name.trim()) return { error: 'noName' };
    const record: PasswordRecord = { hash: await hashPassword(password), name: cleanName(name) };
    // The address is claimed first, so two sign-ups with it can't both get in.
    if (!(await this.db.add(`password:${address}`, record))) return { error: 'emailTaken' };
    return this.session(address, record);
  }

  async login(email: unknown, password: unknown): Promise<EmailResult> {
    const address = cleanEmail(email);
    if (!address || typeof password !== 'string' || password.length > PASSWORD_MAX) return { error: 'wrongPassword' };
    if (this.blocked(address)) return { error: 'tooMany' };
    const record = await this.db.read<PasswordRecord>(`password:${address}`);
    this.dummy ??= hashPassword('not a password');
    const ok = await checkPassword(password, record?.hash ?? (await this.dummy));
    if (!record || !ok) {
      this.failed(address);
      return { error: 'wrongPassword' };
    }
    this.failures.delete(address);
    return this.session(address, record);
  }

  private async session(address: string, record: PasswordRecord): Promise<EmailResult> {
    const account = await this.accounts.signIn('email', address, record.name);
    return { token: await this.accounts.createSession(account.id) };
  }

  private blocked(address: string): boolean {
    const entry = this.failures.get(address);
    if (entry && this.now() - entry.start > FAILURE_WINDOW) this.failures.delete(address);
    return (this.failures.get(address)?.count ?? 0) >= MAX_FAILURES;
  }

  private failed(address: string): void {
    const entry = this.failures.get(address);
    if (entry) entry.count++;
    else this.failures.set(address, { start: this.now(), count: 1 });
  }

  /** Forgets addresses whose failures are old. */
  cleanup(): void {
    for (const [address, entry] of this.failures) if (this.now() - entry.start > FAILURE_WINDOW) this.failures.delete(address);
  }
}
