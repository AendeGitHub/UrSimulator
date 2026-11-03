// The player's own robots, kept in this browser: their blueprints and card pictures in localStorage,
// uploaded 3D files in IndexedDB (they can be tens of MB). Every saved robot is in the game's robot
// list (robots.ts) from the start, so a match, the AI and replays find it like a team's robot. A
// robot travels as a file (with its 3D model) or as a share code (blueprint only); a signed-in
// player's robots are also kept with their account (net/robotSync.ts).

const DELETED_KEY = 'ursim.robots.deleted';

import { cleanBlueprint, customDefinition, readShareCode, sharedRobotId, withoutMesh, type Blueprint } from './custom';
import { addCustomRobot, removeCustomRobot, robotById, type RobotDefinition } from './robots';

const LIST_KEY = 'ursim.robots';
/** What a robot file says it is, and its extension */
const FILE_KIND = 'ursim-robot';
export const ROBOT_FILE_EXTENSION = '.ursimbot';

export interface SavedRobot {
  id: string;
  blueprint: Blueprint;
  /** A picture of the robot for its card (a data URL), made when it was saved */
  thumb?: string;
  /** When it was last saved, ms */
  saved: number;
  /** The gallery robot it is published as (server/Gallery.ts), and the one it was added from */
  gallery?: string;
  from?: string;
  /** The account it is kept with (none: made while signed out, the next account to sign in takes it) */
  owner?: string;
}

/** A robot deleted here: the account it belonged to deletes it too when it next syncs. */
export interface DeletedRobot {
  id: string;
  /** When, ms */
  at: number;
  owner?: string;
}

const randomId = (length: number) => Array.from(crypto.getRandomValues(new Uint8Array(length)), b => (b % 36).toString(36)).join('');
export const newRobotId = () => `custom-${randomId(10)}`;
export const newMeshId = () => randomId(12);

const isPicture = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:image/') && value.length < 400_000;
const galleryId = (value: unknown) => (typeof value === 'string' && /^[a-z0-9]{12}$/.test(value) ? value : undefined);
const accountId = galleryId;

function readList(): SavedRobot[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r: Partial<SavedRobot>) => {
      const blueprint = cleanBlueprint(r?.blueprint);
      if (!blueprint || typeof r.id !== 'string' || !/^custom-[a-z0-9]{4,16}$/.test(r.id)) return [];
      return [{ id: r.id, blueprint, thumb: isPicture(r.thumb) ? r.thumb : undefined, saved: Number(r.saved) || 0, gallery: galleryId(r.gallery), from: galleryId(r.from), owner: accountId(r.owner) }];
    });
  } catch {
    // No storage, or unreadable: no robots of one's own.
    return [];
  }
}

function readDeleted(): DeletedRobot[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((d: DeletedRobot) => typeof d?.id === 'string' && Number.isFinite(d.at)).map(d => ({ id: d.id, at: d.at, owner: accountId(d.owner) })) : [];
  } catch {
    return [];
  }
}

let robots: SavedRobot[] = typeof localStorage === 'undefined' ? [] : readList();
let deleted: DeletedRobot[] = typeof localStorage === 'undefined' ? [] : readDeleted();
for (const r of robots) addCustomRobot(definitionOf(r));

const listeners = new Set<() => void>();
/** Called after the player saves or deletes a robot here (not after changes the account brings). */
export function onRobotsChange(listener: () => void): void {
  listeners.add(listener);
}

/** The robot a saved one plays as. */
export function definitionOf(r: SavedRobot): RobotDefinition {
  return customDefinition(r.id, r.blueprint, r.thumb);
}

/** This player's robots, oldest first. */
export function savedRobots(): readonly SavedRobot[] {
  return robots;
}

export function savedRobot(id: string): SavedRobot | undefined {
  return robots.find(r => r.id === id);
}

/** Every robot a player here can pick: the teams', then their own. */
export function playableRobots(teams: readonly RobotDefinition[]): RobotDefinition[] {
  return [...teams, ...robots.map(r => robotById(r.id))];
}

/** Keeps the list; without room for the pictures, it keeps the robots without them. False when nothing could be kept. */
function writeList(): boolean {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(robots));
    return true;
  } catch {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(robots.map(r => ({ ...r, thumb: undefined }))));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A new robot, or a new version of one: it is in the game right away. Where it is in the gallery
 * and whose it is stay unless `robot` says otherwise. `quiet`: a change the account brought, not the
 * player's. False when this browser couldn't keep it.
 */
export function saveRobot(next: SavedRobot, quiet = false): boolean {
  const old = savedRobot(next.id);
  const robot: SavedRobot = { gallery: old?.gallery, from: old?.from, owner: old?.owner, ...next };
  robots = old ? robots.map(r => (r.id === robot.id ? robot : r)) : [...robots, robot];
  const kept = writeList();
  addCustomRobot(definitionOf(robot));
  const oldMesh = old?.blueprint.mesh?.id;
  if (oldMesh && oldMesh !== robot.blueprint.mesh?.id) void dropMeshIfUnused(oldMesh);
  if (!quiet) for (const l of listeners) l();
  return kept;
}

/** Deletes a robot here; the player's account deletes it too (`quiet`: the account deleted it already). */
export function deleteRobot(id: string, quiet = false): void {
  const old = savedRobot(id);
  if (!old) return;
  robots = robots.filter(r => r.id !== id);
  writeList();
  removeCustomRobot(id);
  if (old.blueprint.mesh) void dropMeshIfUnused(old.blueprint.mesh.id);
  if (quiet) return;
  deleted = [...deleted.filter(d => d.id !== id), { id, at: Date.now(), owner: old.owner }].slice(-200);
  writeDeleted();
  for (const l of listeners) l();
}

/** Robots deleted here that an account may still keep. */
export function deletedRobots(): readonly DeletedRobot[] {
  return deleted;
}

/** The account has heard of these deletions. */
export function forgetDeleted(ids: readonly string[]): void {
  deleted = deleted.filter(d => !ids.includes(d.id));
  writeDeleted();
}

function writeDeleted(): void {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
  } catch {
    // The account then keeps the robot: it comes back at the next sign-in.
  }
}

/**
 * Another player's robot in an online room joins the game under its shared id (the same on every
 * computer). One that is this player's own keeps its 3D model and picture here.
 */
export function addSharedRobot(bp: Blueprint): string {
  const id = sharedRobotId(bp);
  if (robotById(id).id === id) return id;
  const mine = robots.find(r => sharedRobotId(r.blueprint) === id);
  addCustomRobot(customDefinition(id, mine?.blueprint ?? withoutMesh(bp), mine?.thumb));
  return id;
}

// ---- 3D files ------------------------------------------------------------------

const DB_NAME = 'ursim-models';
const STORE = 'files';
let db: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.catch(() => (db = null));
  return db;
}

async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
  });
}

export const putMeshFile = (id: string, data: ArrayBuffer): Promise<void> => inStore('readwrite', s => s.put(data, id)).then(() => undefined);
export const getMeshFile = (id: string): Promise<ArrayBuffer | null> => inStore<unknown>('readonly', s => s.get(id)).then(d => (d instanceof ArrayBuffer ? d : null));

/** A file no saved robot shows any more. */
async function dropMeshIfUnused(id: string): Promise<void> {
  if (robots.some(r => r.blueprint.mesh?.id === id)) return;
  await inStore('readwrite', s => s.delete(id)).catch(() => undefined);
}

// ---- sharing -------------------------------------------------------------------

/** A robot and its 3D file (if any) read from a robot file or a share code. */
export interface ImportedRobot {
  blueprint: Blueprint;
  model: ArrayBuffer | null;
}

function toBase64(data: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data]));
  });
}

/** A robot file: its blueprint and its 3D model, so it plays the same on another computer. */
export async function exportRobot(r: SavedRobot): Promise<Blob> {
  const model = r.blueprint.mesh ? await getMeshFile(r.blueprint.mesh.id) : null;
  const file = { kind: FILE_KIND, version: 1, blueprint: model ? r.blueprint : withoutMesh(r.blueprint), model: model ? await toBase64(model) : undefined };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** The robot in a robot file or a share code; null when the text is neither. */
export async function importRobot(text: string): Promise<ImportedRobot | null> {
  const fromCode = readShareCode(text);
  if (fromCode) return { blueprint: fromCode, model: null };
  try {
    const file = JSON.parse(text) as { kind?: unknown; blueprint?: unknown; model?: unknown };
    if (file?.kind !== FILE_KIND) return null;
    const blueprint = cleanBlueprint(file.blueprint);
    if (!blueprint) return null;
    const model = blueprint.mesh && typeof file.model === 'string'
      ? await (await fetch(`data:application/octet-stream;base64,${file.model}`)).arrayBuffer()
      : null;
    return { blueprint: model ? blueprint : withoutMesh(blueprint), model };
  } catch {
    return null;
  }
}
