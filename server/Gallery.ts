// The robot gallery: robots players made in the Workshop (src/robot/custom.ts), published for
// everyone. A signed-in player keeps up to GALLERY.perAccount robots there (publishing one of theirs
// again updates it); anyone can list them, look at one and add it to their own robots. A robot
// reported by GALLERY.hideAfter players is hidden until a moderator (GALLERY_ADMINS) puts it back;
// its author and the moderators can take it down.
//
// Files: <dir>/<id>.thumb (the card picture) · <dir>/<id>.model (the 3D model)
// Keys: gallery:index → the list, first published first · gallery:robot:<id> → its blueprint
// · gallery:added:<id>:<who> and gallery:report:<id>:<who> (each player counts once)

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GALLERY, type GalleryEntry, type GalleryError, type GalleryPage, type GalleryRobot, type GallerySort, type GalleryUpload } from '../src/net/galleryProtocol';
import { cleanBlueprint, intakeKind, topSpeed, withoutMesh, type Blueprint, type MeshFormat } from '../src/robot/custom';
import { publicAccount, type Account } from './Accounts';
import type { Db } from './Kv';

const ID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const INDEX = 'gallery:index';
export const isGalleryId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{12}$/.test(id);

/** A gallery robot as the server keeps it: what the list shows, and what only the server knows. */
interface Indexed extends GalleryEntry {
  /** The robot's id in its author's browser */
  source: string;
  thumbType: string;
  /** Players who reported it */
  reports: number;
}

const entryOf = (e: Indexed): GalleryEntry => ({
  id: e.id, name: e.name, team: e.team, author: e.author, created: e.created, updated: e.updated,
  speed: e.speed, intake: e.intake, turrets: e.turrets, arm: e.arm, model: e.model, added: e.added, hidden: e.hidden,
});

/** The card picture in a data URL as bytes and their type; null unless it is a small WebP, PNG or JPEG. */
export function readThumb(dataUrl: unknown): { data: Buffer; type: string } | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return null;
  const data = Buffer.from(m[2], 'base64');
  if (data.length < 12 || data.length > GALLERY.thumbBytes) return null;
  // The bytes have to be what the type says.
  const kind = data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG' ? 'image/png'
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
    : data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp'
    : null;
  return kind === m[1] ? { data, type: kind } : null;
}

/** Whether a 3D file looks like its format: a GLB starts with "glTF", a glTF is JSON, a binary STL has its header. */
export function looksLike(format: MeshFormat, data: Buffer): boolean {
  if (format === 'glb') return data.length > 20 && data.toString('latin1', 0, 4) === 'glTF';
  if (format === 'gltf') return /^\s*\{/.test(data.toString('utf8', 0, 64).replace(/^﻿/, ''));
  if (format === 'stl') return data.length >= 84;
  return data.length > 0;
}

export class Gallery {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    /** Usernames of the players who look after the gallery */
    private readonly moderators: ReadonlySet<string> = new Set(),
    private readonly random: (bytes: number) => Buffer = randomBytes,
    private readonly now = () => new Date(),
  ) {}

  isModerator(account: Account | null): boolean {
    return !!account && this.moderators.has(account.username);
  }

  private file(id: string, kind: 'thumb' | 'model'): string {
    return path.join(this.dir, `${id}.${kind}`);
  }

  private index(): Promise<Indexed[]> {
    return this.db.read<Indexed[]>(INDEX).then(list => list ?? []);
  }

  /** A hidden robot shows only to its author and the moderators. */
  private visible(e: Indexed, viewer: Account | null): boolean {
    return !e.hidden || (!!viewer && (viewer.id === e.author.id || this.isModerator(viewer)));
  }

  /**
   * A page of the list: newest first or the most added first, robots whose name, team or author has
   * `q` in it, only the viewer's own with `mine`.
   */
  async list(options: { sort?: GallerySort; q?: string; offset?: number; mine?: boolean }, viewer: Account | null): Promise<GalleryPage> {
    const q = (options.q ?? '').trim().toLowerCase().slice(0, 40);
    let robots = (await this.index()).filter(e => this.visible(e, viewer));
    if (options.mine) robots = robots.filter(e => e.author.id === viewer?.id);
    if (q) robots = robots.filter(e => [e.name, e.team, e.author.name, e.author.username].some(s => s.toLowerCase().includes(q)));
    if (options.sort === 'popular') robots = [...robots].sort((a, b) => b.added - a.added || b.created.localeCompare(a.created));
    else robots = [...robots].reverse();
    const offset = Math.max(0, Math.floor(options.offset ?? 0)) || 0;
    return { robots: robots.slice(offset, offset + GALLERY.pageSize).map(entryOf), total: robots.length, moderator: this.isModerator(viewer) };
  }

  /** The whole robot, with what it is made of. */
  async get(id: string, viewer: Account | null): Promise<GalleryRobot | null> {
    if (!isGalleryId(id)) return null;
    const entry = (await this.index()).find(e => e.id === id);
    if (!entry || !this.visible(entry, viewer)) return null;
    const blueprint = cleanBlueprint((await this.db.read<{ blueprint: unknown }>(`gallery:robot:${id}`))?.blueprint);
    return blueprint && { ...entryOf(entry), blueprint };
  }

  /**
   * Publishes a robot with its card picture and 3D model (if it has one), or updates the robot this
   * player published from the same robot of theirs. Its place in the list, its count and a hide
   * after reports stay.
   */
  async publish(author: Account, upload: unknown, model: Buffer | null): Promise<GalleryRobot | GalleryError> {
    const u = (upload ?? {}) as Partial<Record<keyof GalleryUpload, unknown>>;
    const source = typeof u.source === 'string' && /^custom-[a-z0-9]{4,16}$/.test(u.source) ? u.source : null;
    const bp = cleanBlueprint(u.blueprint);
    const thumb = readThumb(u.thumb);
    if (!source || !bp || !thumb) return 'invalid';
    if (model && model.length > GALLERY.modelBytes) return 'tooLarge';
    // A model comes with the blueprint's fit for it, and looks like its format.
    if (model && (!bp.mesh || !looksLike(bp.mesh.format, model))) return 'invalid';
    return this.db.locked(INDEX, async () => {
      const index = await this.index();
      const old = index.find(e => e.author.id === author.id && e.source === source);
      if (!old && index.filter(e => e.author.id === author.id).length >= GALLERY.perAccount) return 'limit';
      if (!old && index.length >= GALLERY.total) return 'full';
      // The server's disk: all the models together stay under GALLERY.allModelBytes.
      const models = index.reduce((sum, e) => sum + (e === old ? 0 : e.model?.size ?? 0), 0);
      if (model && models + model.length > GALLERY.allModelBytes) return 'full';
      const id = old?.id ?? [...this.random(12)].map(b => ID_LETTERS[b % ID_LETTERS.length]).join('');
      const blueprint: Blueprint = model ? { ...bp, mesh: { ...bp.mesh!, id: `gal${id}` } } : withoutMesh(bp);
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.file(id, 'thumb'), thumb.data);
      if (model) await fs.writeFile(this.file(id, 'model'), model);
      else await fs.rm(this.file(id, 'model'), { force: true });
      await this.db.write(`gallery:robot:${id}`, { blueprint });
      const now = this.now().toISOString();
      const entry: Indexed = {
        id,
        name: blueprint.name,
        team: blueprint.team,
        author: publicAccount(author),
        created: old?.created ?? now,
        updated: now,
        speed: Math.round(topSpeed(blueprint) * 100) / 100,
        intake: intakeKind(blueprint),
        turrets: blueprint.turrets.length,
        arm: blueprint.arm,
        model: model ? { format: blueprint.mesh!.format, size: model.length } : null,
        added: old?.added ?? 0,
        // A new version doesn't undo the reports: a moderator does.
        hidden: old?.hidden ?? false,
        source,
        thumbType: thumb.type,
        reports: old?.reports ?? 0,
      };
      await this.db.write(INDEX, old ? index.map(e => (e.id === id ? entry : e)) : [...index, entry]);
      return { ...entryOf(entry), blueprint };
    });
  }

  /** Takes a robot down: its author, or a moderator. */
  async remove(id: string, by: Account): Promise<'ok' | 'notFound' | 'forbidden'> {
    if (!isGalleryId(id)) return 'notFound';
    return this.db.locked(INDEX, async () => {
      const index = await this.index();
      const entry = index.find(e => e.id === id);
      if (!entry) return 'notFound';
      if (entry.author.id !== by.id && !this.isModerator(by)) return 'forbidden';
      await this.db.write(INDEX, index.filter(e => e.id !== id));
      await this.db.del(`gallery:robot:${id}`);
      await Promise.all((['thumb', 'model'] as const).map(kind => fs.rm(this.file(id, kind), { force: true })));
      return 'ok';
    });
  }

  /** Its card picture and the picture's type. */
  async thumb(id: string): Promise<{ data: Buffer; type: string } | null> {
    if (!isGalleryId(id)) return null;
    const entry = (await this.index()).find(e => e.id === id);
    const data = entry && (await fs.readFile(this.file(id, 'thumb')).catch(() => null));
    return data ? { data, type: entry!.thumbType } : null;
  }

  /** Its 3D model file. */
  async model(id: string, viewer: Account | null): Promise<Buffer | null> {
    if (!isGalleryId(id)) return null;
    const entry = (await this.index()).find(e => e.id === id);
    if (!entry?.model || !this.visible(entry, viewer)) return null;
    return fs.readFile(this.file(id, 'model')).catch(() => null);
  }

  /** Changes one robot in the list, unless it is gone. */
  private change(id: string, edit: (e: Indexed) => void): Promise<boolean> {
    return this.db.locked(INDEX, async () => {
      const index = await this.index();
      const entry = index.find(e => e.id === id);
      if (!entry) return false;
      edit(entry);
      await this.db.write(INDEX, index);
      return true;
    });
  }

  /** A player (account or browser) added it to their robots: each counts once. */
  async added(id: string, who: string): Promise<boolean> {
    if (!isGalleryId(id) || !(await this.index()).some(e => e.id === id)) return false;
    if (!(await this.db.add(`gallery:added:${id}:${who}`, 1))) return false;
    return this.change(id, e => e.added++);
  }

  /** A signed-in player reports it: enough of them hide it until a moderator looks. */
  async report(id: string, by: Account): Promise<boolean> {
    if (!isGalleryId(id) || !(await this.index()).some(e => e.id === id && e.author.id !== by.id)) return false;
    if (!(await this.db.add(`gallery:report:${id}:${by.id}`, 1))) return false;
    return this.change(id, e => {
      e.reports++;
      if (e.reports >= GALLERY.hideAfter) e.hidden = true;
    });
  }

  /** A moderator looked at a hidden robot and puts it back. */
  async restore(id: string, by: Account): Promise<boolean> {
    if (!isGalleryId(id) || !this.isModerator(by)) return false;
    return this.change(id, e => {
      e.hidden = false;
      e.reports = 0;
    });
  }
}
