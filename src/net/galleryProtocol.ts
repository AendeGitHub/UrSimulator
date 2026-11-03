// The robot gallery (server/Gallery.ts): robots players made in the Workshop and published for
// everyone to add to their own robots and play.
//
//   GET    /api/gallery?sort&q&offset          a page of the list (GalleryPage)
//   POST   /api/gallery                        publish one: [u32 LE JSON length][JSON GalleryUpload][its 3D model, if any]
//   GET    /api/gallery/<id>                   the whole robot (GalleryRobot)
//   DELETE /api/gallery/<id>                   its author or a moderator takes it down
//   GET    /api/gallery/<id>/thumb · /model    its card picture, its 3D model file
//   POST   /api/gallery/<id>/added · /report · /restore   someone added it; reported it; a moderator puts it back

import type { Blueprint, IntakeKind, MeshFormat } from '../robot/custom';
import type { PublicAccount } from './accountProtocol';

export const GALLERY = {
  /** Robots in a page of the list */
  pageSize: 24,
  /** Robots one player can have in the gallery */
  perAccount: 20,
  /** Robots in the gallery at most */
  total: 5000,
  /** A 3D model file and a card picture at most, and all the models together, bytes */
  modelBytes: 25 * 1024 * 1024,
  thumbBytes: 256 * 1024,
  allModelBytes: 4 * 1024 * 1024 * 1024,
  /** Reports from this many players hide a robot until a moderator looks at it */
  hideAfter: 3,
} as const;

export type GallerySort = 'new' | 'popular';

/** A robot as the gallery's list shows it. */
export interface GalleryEntry {
  id: string;
  name: string;
  team: string;
  author: PublicAccount;
  /** When it was published and last updated (ISO) */
  created: string;
  updated: string;
  /** What it does, for its line in the list: top speed (m/s), what it takes, turrets, Flower Mode */
  speed: number;
  intake: IntakeKind;
  turrets: number;
  arm: boolean;
  /** Its 3D model file, if it has one */
  model: { format: MeshFormat; size: number } | null;
  /** Players who added it to their robots */
  added: number;
  /** Hidden after reports: only its author and the moderators see it */
  hidden: boolean;
}

/** The whole robot: what it is made of (its blueprint's mesh, if any, is the model file's fit). */
export interface GalleryRobot extends GalleryEntry {
  blueprint: Blueprint;
}

export interface GalleryPage {
  robots: GalleryEntry[];
  /** Robots that match, in all pages */
  total: number;
  /** The signed-in player may take down anyone's robot and put back hidden ones */
  moderator: boolean;
}

/** What the game sends to publish a robot (its model, if any, follows in the request). */
export interface GalleryUpload {
  /** The robot's id in the player's browser: publishing it again updates it */
  source: string;
  blueprint: Blueprint;
  /** Its card picture: a data URL (WebP, PNG or JPEG) */
  thumb: string;
}

/** Why the server refused to publish a robot (the Workshop says it in the player's language). */
export type GalleryError = 'signIn' | 'invalid' | 'tooLarge' | 'limit' | 'full' | 'tooMany';
