// Messages between the browser and the game server.
// JSON text frames for the lobby and events; binary frames carry world snapshots (sim/state.ts).

import type { AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import type { RuleOptions } from '../sim/Referee';
import type { GameMode, RobotInput, Slot } from '../sim/types';

export const DEFAULT_PORT = 8787;
export const MAX_PLAYERS = 4;
/** Snapshots per second sent to every player */
export const SNAPSHOT_RATE = 30;

export interface RoomPlayer {
  id: number;
  name: string;
  /** Robot id (robots.ts) */
  robot: string;
  /** null = watching without a robot */
  slot: Slot | null;
}

export interface RoomInfo {
  code: string;
  hostId: number;
  players: RoomPlayer[];
  /** What is being played right now, or null in the lobby */
  running: GameMode | null;
  /** The host's house rules for the current or last game */
  rules: RuleOptions;
}

export type ClientMessage =
  | { t: 'hello'; name: string; robot?: string }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'slot'; slot: Slot | null }
  | { t: 'start'; mode: GameMode; rules?: RuleOptions }
  | { t: 'stop' }
  | { t: 'input'; input: RobotInput }
  | { t: 'leave' };

/** Why the server refused something; the browser shows it in the player's language (ui/i18n.ts). */
export type ErrorCode = 'serverFull' | 'noRoom' | 'roomFull' | 'slotTaken' | 'matchRunning' | 'hostOnly';

export type ServerMessage =
  | { t: 'welcome'; id: number }
  | { t: 'room'; room: RoomInfo | null }
  // `message` is Russian text for clients older than `code`.
  | { t: 'error'; code?: ErrorCode; message: string }
  | { t: 'toast'; text: string }
  | { t: 'finished'; score: Record<Alliance, AllianceScore> };

/** Room codes avoid letters that are easy to confuse when read aloud or typed (I, O). */
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function cleanName(name: string, fallback = 'Игрок'): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 16) || fallback;
}
