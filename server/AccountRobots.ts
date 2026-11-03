// Robots players made in the Workshop, kept with their account: whatever computer they sign in on,
// their robots are in their game (src/net/robotSync.ts brings this side and the browser's
// together). The newest version of a robot wins; a robot deleted on one computer is remembered as
// deleted, so the others delete it too. Its 3D model is a file of the account's.
//
// Keys: robots:<account> → { robots, deleted } · Files: <dir>/<account>/<mesh id>.model

import fs from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_ROBOTS, type CloudRobot, type CloudRobotError, type CloudRobots } from '../src/net/accountProtocol';
import { cleanBlueprint } from '../src/robot/custom';
import { looksLike } from './Gallery';
import type { Db } from './Kv';

type Kept = Omit<CloudRobots, 'models'>;

const isAccount = (id: string) => /^[a-z0-9]{12}$/.test(id);
export const isRobotId = (id: unknown): id is string => typeof id === 'string' && /^custom-[a-z0-9]{4,16}$/.test(id);
const isMeshId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{4,24}$/.test(id);
const galleryId = (id: unknown) => (typeof id === 'string' && /^[a-z0-9]{12}$/.test(id) ? id : undefined);

export class AccountRobots {
  constructor(private readonly db: Db, private readonly dir: string, private readonly now = Date.now) {}

  private file(account: string, mesh: string): string {
    return path.join(this.dir, account, `${mesh}.model`);
  }

  private async kept(account: string): Promise<Kept> {
    const kept = await this.db.read<Kept>(`robots:${account}`);
    return { robots: kept?.robots ?? [], deleted: kept?.deleted ?? [] };
  }

  async list(account: string): Promise<CloudRobots> {
    if (!isAccount(account)) return { robots: [], deleted: [], models: [] };
    const { robots, deleted } = await this.kept(account);
    const files = await fs.readdir(path.join(this.dir, account)).catch(() => [] as string[]);
    return { robots, deleted, models: files.filter(f => f.endsWith('.model')).map(f => f.slice(0, -6)) };
  }

  /**
   * Keeps a robot sent from one of the player's computers (with its model file, when the account
   * doesn't have it yet). An older version than the one kept changes nothing: the kept one comes back.
   */
  async put(account: string, upload: unknown, model: Buffer | null): Promise<CloudRobot | CloudRobotError> {
    const u = (upload ?? {}) as Partial<Record<keyof CloudRobot, unknown>>;
    const blueprint = cleanBlueprint(u.blueprint);
    const saved = typeof u.saved === 'number' && Number.isFinite(u.saved) ? Math.round(u.saved) : NaN;
    // A clock a day ahead is no computer's.
    if (!isAccount(account) || !isRobotId(u.id) || !blueprint || !(saved > 0) || saved > this.now() + 86_400_000) return 'invalid';
    const mesh = blueprint.mesh?.id;
    if (model && (!mesh || model.length > CLOUD_ROBOTS.modelBytes || !looksLike(blueprint.mesh!.format, model))) return 'invalid';
    const robot: CloudRobot = { id: u.id, blueprint, saved };
    const gallery = galleryId(u.gallery);
    const from = galleryId(u.from);
    if (gallery) robot.gallery = gallery;
    if (from) robot.from = from;
    return this.db.locked(`robots:${account}`, async () => {
      const kept = await this.kept(account);
      const old = kept.robots.find(r => r.id === robot.id);
      if (old && old.saved >= saved) return old;
      if (!old && kept.robots.length >= CLOUD_ROBOTS.robots) return 'limit';
      if (mesh && !model && !(await fs.stat(this.file(account, mesh)).catch(() => null))) return 'needModel';
      if (model) {
        const others = await this.modelBytes(account, kept.robots.filter(r => r.id !== robot.id && r.blueprint.mesh?.id !== mesh));
        if (others + model.length > CLOUD_ROBOTS.accountBytes) return 'full';
        await fs.mkdir(path.join(this.dir, account), { recursive: true });
        await fs.writeFile(this.file(account, mesh!), model);
      }
      kept.robots = old ? kept.robots.map(r => (r.id === robot.id ? robot : r)) : [...kept.robots, robot];
      // Made again after it was deleted somewhere: it lives.
      kept.deleted = kept.deleted.filter(d => d.id !== robot.id);
      await this.db.write(`robots:${account}`, kept);
      await this.dropUnused(account, kept);
      return robot;
    });
  }

  /** The player deleted a robot (at `at`, ms); a version saved after that elsewhere stays. */
  async remove(account: string, id: string, at: number): Promise<boolean> {
    if (!isAccount(account) || !isRobotId(id) || !Number.isFinite(at)) return false;
    return this.db.locked(`robots:${account}`, async () => {
      const kept = await this.kept(account);
      const old = kept.robots.find(r => r.id === id);
      if (old && old.saved > at) return false;
      kept.robots = kept.robots.filter(r => r.id !== id);
      kept.deleted = [...kept.deleted.filter(d => d.id !== id), { id, at: Math.round(at) }].slice(-CLOUD_ROBOTS.deleted);
      await this.db.write(`robots:${account}`, kept);
      await this.dropUnused(account, kept);
      return true;
    });
  }

  /** A model file of one of the account's robots. */
  async model(account: string, mesh: string): Promise<Buffer | null> {
    if (!isAccount(account) || !isMeshId(mesh)) return null;
    const { robots } = await this.kept(account);
    if (!robots.some(r => r.blueprint.mesh?.id === mesh)) return null;
    return fs.readFile(this.file(account, mesh)).catch(() => null);
  }

  private async modelBytes(account: string, robots: CloudRobot[]): Promise<number> {
    const meshes = [...new Set(robots.map(r => r.blueprint.mesh?.id).filter(isMeshId))];
    const sizes = await Promise.all(meshes.map(m => fs.stat(this.file(account, m)).then(s => s.size, () => 0)));
    return sizes.reduce((a, b) => a + b, 0);
  }

  /** Model files no robot of the account shows any more. */
  private async dropUnused(account: string, kept: Kept): Promise<void> {
    const used = new Set(kept.robots.map(r => r.blueprint.mesh?.id));
    const files = await fs.readdir(path.join(this.dir, account)).catch(() => [] as string[]);
    await Promise.all(files.filter(f => f.endsWith('.model') && !used.has(f.slice(0, -6))).map(f => fs.rm(path.join(this.dir, account, f), { force: true })));
  }
}
