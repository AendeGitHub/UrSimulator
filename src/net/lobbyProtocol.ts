// Online play: messages between the browser and the lobby server (server/Lobby.ts).
//
// The server only keeps the room list and passes messages along; it runs no physics. The room's
// admin runs the match in their browser and the other players connect to it directly (WebRTC,
// net/peer.ts). When a direct connection can't be made, the game data goes through the server:
// binary frames of [kind u8][player id u16][payload].

import type { AiLevel } from '../ai/level';
import type { StartPose } from '../field/startPose';
import type { ScoreDisplay } from '../game/scoreDisplay';
import type { Blueprint } from '../robot/custom';
import type { RuleOptions } from '../sim/Referee';
import type { GameMode, Slot } from '../sim/types';

export type RoomFormat = '1v1' | '2v2';

/** The driver stations of each format, in the order new players fill them (alliances alternate). */
export const FORMAT_SLOTS: Record<RoomFormat, Slot[]> = {
  '1v1': ['red1', 'blue1'],
  '2v2': ['red1', 'blue1', 'red2', 'blue2'],
};

/** A closed room's password: 4 English letters, any case. */
export const PASSWORD_LENGTH = 4;

export function normalizePassword(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, PASSWORD_LENGTH);
}

export const isPassword = (text: unknown): text is string => typeof text === 'string' && /^[A-Z]{4}$/.test(text);

export interface RoomPlayer {
  id: number;
  name: string;
  /** Robot id (robots.ts) */
  robot: string;
  /** A robot the player made (robot/custom.ts): what it is, so everyone's game can build it */
  custom?: Blueprint;
  /** null = no driver station yet */
  slot: Slot | null;
  /** Where this player's robot starts (red side, field/startPose.ts); null: the usual spot */
  start: StartPose | null;
}

/** A room as the room list shows it. */
export interface RoomSummary {
  id: string;
  /** The admin's name */
  name: string;
  format: RoomFormat;
  players: number;
  /** Closed: joining needs the password */
  locked: boolean;
  /** A match is being played */
  running: boolean;
  /** A 2:30 match, or endless like practice */
  mode: GameMode;
  /** Made by quick play: anyone looking for a game lands here, and the match starts by itself */
  quick: boolean;
}

/** The room a player is in, with everyone in it. */
export interface RoomInfo extends RoomSummary {
  adminId: number;
  members: RoomPlayer[];
  /** Driver stations the admin gave to the AI, with its robot; a player who takes one replaces it */
  ai: Partial<Record<Slot, string>>;
  /** How well the room's AI drives (the admin picks it; missing from an older server: the usual level) */
  aiLevel?: AiLevel;
  /** The admin's rules for everyone in the room */
  rules: RuleOptions;
  /** A closed room's password (only players inside see it) */
  password: string | null;
  /** What everyone's scoreboard shows during the match: the admin picks it */
  scoreDisplay: ScoreDisplay;
  /** A quick-play room with players enough: seconds until its match starts by itself (null: not counting) */
  autoStartIn: number | null;
}

export type ClientMessage =
  /** `device`: this browser (counted in the totals); `token`: the session of a signed-in player */
  | { t: 'hello'; name: string; device?: string; token?: string | null }
  /**
   * `start`: the player's own start for this robot (red side), if they picked one; `custom`: the
   * blueprint of a robot they made (its id is custom-…)
   */
  | { t: 'create'; format: RoomFormat; robot: string; custom?: Blueprint | null; start?: StartPose | null; rules: RuleOptions; scoreDisplay?: ScoreDisplay; aiLevel?: AiLevel }
  | { t: 'join'; room: string; robot: string; custom?: Blueprint | null; start?: StartPose | null; password?: string }
  | { t: 'leave' }
  /** Quick play: into any open room; with none, together with others looking, or into a room of one's own */
  | { t: 'quick'; robot: string; custom?: Blueprint | null; start?: StartPose | null }
  | { t: 'quickCancel' }
  | { t: 'slot'; slot: Slot | null }
  | { t: 'robot'; robot: string; custom?: Blueprint | null; start?: StartPose | null }
  /** Admin: a password closes the room, null opens it */
  | { t: 'lock'; password: string | null }
  /** Admin: the AI on a free driver station with this robot, or null to take it off */
  | { t: 'ai'; slot: Slot; robot: string | null }
  /** Admin: how well every AI in the room drives */
  | { t: 'aiLevel'; level: AiLevel }
  | { t: 'rules'; rules: RuleOptions }
  | { t: 'mode'; mode: GameMode }
  | { t: 'scoreDisplay'; display: ScoreDisplay }
  | { t: 'start' }
  | { t: 'stop' }
  /** Admin: the match ended with this score (each alliance's points) — for everyone's statistics */
  | { t: 'result'; score: { red: number; blue: number } }
  /** WebRTC offer / answer / ICE candidate for another player in the room */
  | { t: 'signal'; to: number; data: unknown };

/** Why the server refused something; the game shows it in the player's language (ui/i18n.ts). */
export type LobbyError = 'serverFull' | 'noRoom' | 'roomFull' | 'badPassword' | 'running' | 'slotTaken' | 'adminOnly' | 'notReady';

export type ServerMessage =
  | { t: 'welcome'; id: number }
  /** The open rooms, sent to everyone who is not in a room */
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'error'; code: LobbyError }
  /** Quick play is looking for a room for this player (false: stopped without one) */
  | { t: 'quick'; searching: boolean }
  | { t: 'signal'; from: number; data: unknown };

/** Binary frames relayed through the server when there is no direct connection. */
export const RELAY = {
  /** Header: kind, then the other player's id */
  header: 3,
} as const;
