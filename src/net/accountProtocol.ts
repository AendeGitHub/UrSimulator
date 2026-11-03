// Accounts, statistics, friends and presence: what the browser and the server (server/Accounts.ts,
// server/Stats.ts, server/api.ts) send each other.

import type { Blueprint } from '../robot/custom';
import type { Alliance } from '../robot/robotConfig';
import type { Slot } from '../sim/types';
import type { RoomSummary } from './lobbyProtocol';

/** Sign-in services (and an e-mail with a password). Steam comes with the Steam version of the game. */
export type Provider = 'google' | 'steam' | 'dev' | 'email';

/** What anyone can see of an account. */
export interface PublicAccount {
  id: string;
  /** Unique, shown as @username: 3–20 of a–z, 0–9 and _ */
  username: string;
  /** Shown in tables and rooms (16 characters at most, like a guest's name) */
  name: string;
}

/** The signed-in player's own account. */
export interface Me extends PublicAccount {
  created: string;
  /** The services this account signs in with */
  providers: Provider[];
  /** Made by a first sign-in with a service (Google…): the player still picks their name and @username */
  needsName?: boolean;
}

/** A robot the player made, kept with their account so it is theirs on every computer (server/AccountRobots.ts). */
export interface CloudRobot {
  /** Its id in every browser of the player (custom-…) */
  id: string;
  /** What it is made of; its mesh, if any, names a model file kept with the account */
  blueprint: Blueprint;
  /** When it was last changed, ms */
  saved: number;
  /** The gallery robot it is published as, and the one it was added from */
  gallery?: string;
  from?: string;
}

export interface CloudRobots {
  robots: CloudRobot[];
  /** Robots deleted (their id and when), so the player's other computers delete them too */
  deleted: { id: string; at: number }[];
  /** The model files kept with the account (mesh ids) */
  models: string[];
}

export const CLOUD_ROBOTS = {
  /** Robots one account keeps */
  robots: 50,
  /** A model file at most, and all of one account's together, bytes */
  modelBytes: 25 * 1024 * 1024,
  accountBytes: 250 * 1024 * 1024,
  /** Deletions remembered for the other computers */
  deleted: 200,
} as const;

/** Why the server didn't keep a robot. */
export type CloudRobotError = 'invalid' | 'needModel' | 'limit' | 'full';

/** How a game is counted: one player at the computer (also against the AI), two on a split
 *  screen, an online room, or practice anywhere. */
export type GameType = 'solo' | 'duo' | '1v1' | '2v2' | 'practice';
export const GAME_TYPES: GameType[] = ['solo', 'duo', '1v1', '2v2', 'practice'];

/** The totals on the main menu. */
export interface Totals {
  /** Everyone who ever finished a game: accounts, and browsers of players without one */
  players: number;
  /** Accounts made, also ones that haven't finished a game yet */
  accounts: number;
  games: Record<GameType, number>;
  /** Of `games`, the ones a signed-in player drove in */
  signedInGames: number;
  /** Seconds played by everyone */
  playtime: number;
}

export interface OnlineCount {
  /** Browsers with the game open */
  online: number;
  /** Of those, signed-in players */
  signedIn: number;
}

export type MatchResult = 'win' | 'loss' | 'tie';

/** One game in a player's match history. */
export interface HistoryEntry {
  date: string;
  type: GameType;
  mode: 'match' | 'practice';
  /** The robot this player drove (robots.ts id) */
  robot: string;
  alliance: Alliance;
  /** Seconds */
  duration: number;
  /** A match: the player's alliance's score and the other one's (null when nobody played it) */
  score: number | null;
  opponent: number | null;
  /** Null when there was nobody to beat (a match alone, or practice) */
  result: MatchResult | null;
  /** The other alliance had an AI robot */
  ai: boolean;
  /** A ranked online match: the player's rating change */
  rating?: number;
}

/** A player's numbers for a period. */
export interface CareerStats {
  games: number;
  wins: number;
  losses: number;
  ties: number;
  /** Seconds */
  playtime: number;
  /** Best match score */
  best: number;
  byType: Record<GameType, number>;
}

export const emptyCareer = (): CareerStats => ({
  games: 0,
  wins: 0,
  losses: 0,
  ties: 0,
  playtime: 0,
  best: 0,
  byType: { solo: 0, duo: 0, '1v1': 0, '2v2': 0, practice: 0 },
});

/** Wins out of the games that had a winner or a tie, 0–1; null before any. */
export function winRate(s: Pick<CareerStats, 'wins' | 'losses' | 'ties'>): number | null {
  const decided = s.wins + s.losses + s.ties;
  return decided ? s.wins / decided : null;
}

export interface RankedEntry extends PublicAccount {
  rating: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface CareerResponse {
  account: PublicAccount;
  /** The period asked for */
  stats: CareerStats;
  allTime: CareerStats;
  /** Ranked online in that period, if the player played any */
  ranked: RankedEntry | null;
  /** That period's games, newest first */
  history: HistoryEntry[];
}

/** A match in the signed-in player's archive (server/Replays.ts), as the career lists it. */
export interface ReplayInfo {
  id: string;
  date: string;
  type: Exclude<GameType, 'practice'>;
  /** The robot this player drove, their alliance, its score and the other alliance's */
  robot: string;
  alliance: Alliance;
  score: number;
  opponent: number;
  /** Null when there was nobody to beat (no robot on the other alliance) */
  result: MatchResult | null;
  /** Seconds of recording, the 3-2-1 included */
  duration: number;
  /** Every robot on the field, the players' names and the AI's stations */
  robots: Partial<Record<Slot, string>>;
  names: Partial<Record<Slot, string>>;
  ai: Slot[];
  /** The game version that recorded it (a much older one may not play) */
  version: string;
  /** Bytes kept on the server */
  size: number;
}

/** What the game sends with a recording; the server adds the rest. */
export type ReplayUpload = Omit<ReplayInfo, 'id' | 'date' | 'result' | 'size'>;

/** Each player keeps this many of their latest matches. */
export const MAX_REPLAYS = 30;

/** A row of a high score table. Guests have only a name. */
export interface BoardEntry {
  name: string;
  /** The account behind the row */
  user?: string;
  username?: string;
  /** Robot id; a duo row: both robots, 'a+b' */
  robot: string;
  score: number;
  date: string;
}

export type BoardKind = 'solo' | 'duo';
/** A high score table: one robot's, or 'all' for every robot together. */
export type BoardRobot = string | 'all';

export interface FriendInfo extends PublicAccount {
  online: boolean;
  /** The online room they're in, if any */
  room: RoomSummary | null;
}

export interface FriendsResponse {
  friends: FriendInfo[];
  /** Requests to this player, and the ones they sent */
  incoming: PublicAccount[];
  outgoing: PublicAccount[];
}

export type FriendRequestResult = 'sent' | 'accepted' | 'already' | 'self' | 'unknown';

/** A game finished at this computer, as the browser reports it (online games: the room's admin, via the lobby). */
export interface GameReportBody {
  type: 'solo' | 'duo' | 'practice';
  mode: 'match' | 'practice';
  /** Seconds played */
  duration: number;
  /** A match: each alliance's final score */
  score?: Record<Alliance, number>;
  /** The drivers at this computer: gamepad1 first */
  players: { alliance: Alliance; robot: string }[];
  /** Alliances with an AI robot */
  ai: Alliance[];
  /** This browser (players without an account are counted by it) */
  device: string;
  /** A guest's name for the high score table */
  name?: string;
}

/** The answer to a reported match that can go into a high score table. */
export interface GameReportResult {
  /** Place in the season's table for that robot (null: not in the top 100), if it was a record run */
  rank: number | null;
  best: number;
  improved: boolean;
}

export type PresenceClientMessage = { t: 'hello'; device: string; token: string | null };

export type PresenceServerMessage =
  | ({ t: 'online' } & OnlineCount)
  /** Something about this player's friends changed: fetch the list again */
  | { t: 'friends' };

/** 3–20 of a–z, 0–9 and _. */
export const isUsername = (text: unknown): text is string => typeof text === 'string' && /^[a-z0-9_]{3,20}$/.test(text);

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ғ: 'g', қ: 'q', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

/** A username made from a name: 'Хусейн Max' → 'khuseynmax'; '' when nothing usable is left. */
export function usernameFrom(name: string): string {
  return [...name.toLowerCase()]
    .map(ch => CYRILLIC[ch] ?? ch)
    .join('')
    // Accented Latin letters lose their accents.
    .normalize('NFKD')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);
}
