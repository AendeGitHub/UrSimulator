// Statistics of every finished game: the totals on the main menu, each signed-in player's match
// history and career numbers, the high score tables of each period (season and month,
// src/net/periods.ts) and the ranked ladder of online matches (Elo).
//
// Keys: totals · seen:a:<account> / seen:d:<browser> (counted once) · history:<account> ·
// career:<account> (by period) · board:<period>:<solo|duo>:<robot|all> · ranked:<period>

import {
  GAME_TYPES,
  emptyCareer,
  type BoardEntry,
  type BoardKind,
  type CareerStats,
  type GameType,
  type HistoryEntry,
  type MatchResult,
  type RankedEntry,
  type Totals,
} from '../src/net/accountProtocol';
import { ALL_TIME, periodsOf } from '../src/net/periods';
import type { Alliance } from '../src/robot/robotConfig';
import { isCustomRobotId } from '../src/robot/robots';
import type { Account } from './Accounts';
import type { Db } from './Kv';

export const BOARD_LIMIT = 100;
export const HISTORY_LIMIT = 200;
export const START_RATING = 1000;
/** How far one ranked match moves a rating */
export const ELO_K = 32;

/** A driver of a finished game. */
export interface GamePlayer {
  /** The browser they played in (players without an account are counted by it) */
  device?: string;
  account?: Pick<Account, 'id' | 'name' | 'username'> | null;
  /** A guest's name for the high score tables */
  name?: string;
  alliance: Alliance;
  robot: string;
}

export interface GameRecord {
  type: GameType;
  mode: 'match' | 'practice';
  /** Seconds */
  duration: number;
  /** A match: each alliance's final score */
  score?: Record<Alliance, number>;
  players: GamePlayer[];
  /** Alliances with an AI robot */
  ai: Alliance[];
  date?: Date;
}

export interface RecordOutcome {
  /** A record run: where it put gamepad1's player in the season's table for the robot */
  board: { rank: number | null; best: number; improved: boolean } | null;
}

/** The totals of finished games (the number of accounts is server/Accounts.ts's). */
export type GameTotals = Omit<Totals, 'accounts'>;

export const emptyTotals = (): GameTotals => ({ players: 0, games: { solo: 0, duo: 0, '1v1': 0, '2v2': 0, practice: 0 }, signedInGames: 0, playtime: 0 });

const other = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');
const byRank = (a: BoardEntry, b: BoardEntry) => b.score - a.score || a.date.localeCompare(b.date);
/** One row per player: an account, or a guest's name. */
const rowKey = (e: Pick<BoardEntry, 'user' | 'name'>) => (e.user ? `a:${e.user}` : `n:${e.name.toLowerCase()}`);

/** A player's rating change after a ranked match: each side's average against the other's. */
export function eloChange(mine: number, theirs: number, result: MatchResult, k = ELO_K): number {
  const expected = 1 / (1 + 10 ** ((theirs - mine) / 400));
  const actual = result === 'win' ? 1 : result === 'tie' ? 0.5 : 0;
  return Math.round(k * (actual - expected));
}

/** Who won, from one alliance's side. */
function resultFor(score: Record<Alliance, number>, alliance: Alliance): MatchResult {
  const mine = score[alliance];
  const theirs = score[other(alliance)];
  return mine === theirs ? 'tie' : mine > theirs ? 'win' : 'loss';
}

/**
 * A high score run: a 2:30 match with no opponent (the AI changes the score) — one player
 * alone (solo), or two on a split screen in one alliance (duo).
 */
export function recordRun(game: GameRecord): BoardKind | null {
  if (game.mode !== 'match' || !game.score || game.ai.length) return null;
  // Robots players made can be as quick as they like within the Workshop's limits: no tables for them.
  if (game.players.some(p => isCustomRobotId(p.robot))) return null;
  if (game.type === 'solo' && game.players.length === 1) return 'solo';
  if (game.type === 'duo' && game.players.length === 2 && game.players[0].alliance === game.players[1].alliance) return 'duo';
  return null;
}

/** A ranked match: online, a 2:30 match, every robot driven by a signed-in player, someone on each side. */
export function isRanked(game: GameRecord): boolean {
  if ((game.type !== '1v1' && game.type !== '2v2') || game.mode !== 'match' || !game.score || game.ai.length) return false;
  if (!game.players.every(p => p.account)) return false;
  return game.players.some(p => p.alliance === 'red') && game.players.some(p => p.alliance === 'blue');
}

export class Stats {
  constructor(private readonly db: Db) {}

  async totals(): Promise<GameTotals> {
    const saved = await this.db.read<GameTotals>('totals');
    const totals = emptyTotals();
    if (!saved) return totals;
    return { players: saved.players ?? 0, games: { ...totals.games, ...saved.games }, signedInGames: saved.signedInGames ?? 0, playtime: saved.playtime ?? 0 };
  }

  /**
   * Counts the games signed-in players played before that count was kept, from their histories:
   * once, when the server starts. Players of one game share its date. A full history has forgotten
   * its oldest games: those come from the career (twice if two signed-in players played one).
   */
  async backfill(): Promise<void> {
    const saved = await this.db.read<GameTotals>('totals');
    if (!saved || saved.signedInGames !== undefined) return;
    const games = new Set<string>();
    let older = 0;
    for (const key of await this.db.keys('history:')) {
      const history = (await this.db.read<HistoryEntry[]>(key)) ?? [];
      for (const e of history) games.add(`${e.date} ${e.type}`);
      if (history.length < HISTORY_LIMIT) continue;
      const career = await this.db.read<Record<string, CareerStats>>(`career:${key.slice('history:'.length)}`);
      older += Math.max(0, (career?.[ALL_TIME]?.games ?? 0) - history.length);
    }
    await this.db.update<GameTotals>('totals', old => ({ ...emptyTotals(), ...old, signedInGames: games.size + older }));
  }

  /** Counts a player the first time any of their ids (account, browser) finishes a game. */
  private async firstGame(p: GamePlayer): Promise<boolean> {
    const keys = [p.account && `seen:a:${p.account.id}`, p.device && `seen:d:${p.device}`].filter((k): k is string => !!k);
    if (!keys.length) return false;
    const added = await Promise.all(keys.map(k => this.db.add(k, 1)));
    return added.every(Boolean);
  }

  async record(game: GameRecord): Promise<RecordOutcome> {
    const date = game.date ?? new Date();
    const periods = periodsOf(date);
    const duration = Math.max(0, Math.round(game.duration));

    const newPlayers = (await Promise.all(game.players.map(p => this.firstGame(p)))).filter(Boolean).length;
    const signedIn = game.players.some(p => p.account);
    await this.db.update<GameTotals>('totals', old => {
      const t = old ?? emptyTotals();
      return {
        players: (t.players ?? 0) + newPlayers,
        games: { ...emptyTotals().games, ...t.games, [game.type]: (t.games?.[game.type] ?? 0) + 1 },
        signedInGames: (t.signedInGames ?? 0) + Number(signedIn),
        playtime: (t.playtime ?? 0) + duration,
      };
    });

    const ratings = isRanked(game) ? await this.rate(game, periods) : new Map<string, number>();

    // Each signed-in driver's history and career.
    const opponents = (a: Alliance) => game.ai.includes(other(a)) || game.players.some(p => p.alliance === other(a));
    await Promise.all(game.players.map(async p => {
      if (!p.account) return;
      const match = game.mode === 'match' && game.score;
      const entry: HistoryEntry = {
        date: date.toISOString(),
        type: game.type,
        mode: game.mode,
        robot: p.robot,
        alliance: p.alliance,
        duration,
        score: match ? game.score![p.alliance] : null,
        opponent: match && opponents(p.alliance) ? game.score![other(p.alliance)] : null,
        result: match && opponents(p.alliance) ? resultFor(game.score!, p.alliance) : null,
        ai: game.ai.includes(other(p.alliance)),
      };
      const rating = ratings.get(p.account.id);
      if (rating !== undefined) entry.rating = rating;
      await this.db.update<HistoryEntry[]>(`history:${p.account.id}`, old => [entry, ...(old ?? [])].slice(0, HISTORY_LIMIT));
      await this.db.update<Record<string, CareerStats>>(`career:${p.account.id}`, old => {
        const career = old ?? {};
        for (const key of [...periods, ALL_TIME]) career[key] = addGame(career[key], entry);
        return career;
      });
    }));

    const kind = recordRun(game);
    if (!kind) return { board: null };
    const first = game.players[0];
    if (!first.account && !first.name) return { board: null };
    const row: BoardEntry = {
      name: first.account?.name ?? first.name!,
      ...(first.account && { user: first.account.id, username: first.account.username }),
      robot: kind === 'duo' ? game.players.map(p => p.robot).join('+') : first.robot,
      score: game.score![first.alliance],
      date: date.toISOString(),
    };
    const robots = kind === 'solo' ? [first.robot, 'all'] : ['all'];
    let outcome: RecordOutcome['board'] = null;
    for (const period of periods) {
      for (const robot of robots) {
        const result = await this.submit(`board:${period}:${kind}:${robot}`, row);
        // What the results screen shows: the place in this season's table for the robot.
        if (period === periods[0] && robot === robots[0]) outcome = result;
      }
    }
    return { board: outcome };
  }

  /** One row per player: a better score replaces the old one. */
  private async submit(key: string, row: BoardEntry): Promise<{ rank: number | null; best: number; improved: boolean }> {
    let result = { rank: null as number | null, best: row.score, improved: true };
    await this.db.update<BoardEntry[]>(key, old => {
      const entries = old ?? [];
      const mine = entries.find(e => rowKey(e) === rowKey(row));
      if (mine && mine.score >= row.score) {
        result = { rank: entries.indexOf(mine) + 1, best: mine.score, improved: false };
        // The name may have changed since.
        Object.assign(mine, { name: row.name, username: row.username });
        return entries;
      }
      const next = [...entries.filter(e => e !== mine), row].sort(byRank).slice(0, BOARD_LIMIT);
      const index = next.indexOf(row);
      result = { rank: index >= 0 ? index + 1 : null, best: row.score, improved: true };
      return next;
    });
    return result;
  }

  board(period: string, kind: BoardKind, robot: string): Promise<BoardEntry[]> {
    return this.db.read<BoardEntry[]>(`board:${period}:${kind}:${robot}`).then(e => e ?? []);
  }

  /** Moves every player's rating in each period's ladder; returns the season's change for each. */
  private async rate(game: GameRecord, periods: readonly string[]): Promise<Map<string, number>> {
    const changes = new Map<string, number>();
    for (const period of periods) {
      await this.db.update<Record<string, RankedEntry>>(`ranked:${period}`, old => {
        const ladder = old ?? {};
        const entry = (a: Pick<Account, 'id' | 'name' | 'username'>): RankedEntry => (ladder[a.id] ??= { id: a.id, username: a.username, name: a.name, rating: START_RATING, wins: 0, losses: 0, ties: 0 });
        const side = (alliance: Alliance) => game.players.filter(p => p.alliance === alliance).map(p => entry(p.account!));
        const average = (list: RankedEntry[]) => list.reduce((s, e) => s + e.rating, 0) / list.length;
        const red = side('red');
        const blue = side('blue');
        const ratingOf = { red: average(red), blue: average(blue) };
        for (const p of game.players) {
          const e = entry(p.account!);
          const result = resultFor(game.score!, p.alliance);
          const change = eloChange(ratingOf[p.alliance], ratingOf[other(p.alliance)], result);
          e.rating += change;
          e[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'ties']++;
          Object.assign(e, { username: p.account!.username, name: p.account!.name });
          if (period === periods[0]) changes.set(e.id, change);
        }
        return ladder;
      });
    }
    return changes;
  }

  async ranked(period: string): Promise<RankedEntry[]> {
    const ladder = (await this.db.read<Record<string, RankedEntry>>(`ranked:${period}`)) ?? {};
    return Object.values(ladder).sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, BOARD_LIMIT);
  }

  async rankedOf(period: string, accountId: string): Promise<RankedEntry | null> {
    return (await this.db.read<Record<string, RankedEntry>>(`ranked:${period}`))?.[accountId] ?? null;
  }

  async career(accountId: string): Promise<Record<string, CareerStats>> {
    return (await this.db.read<Record<string, CareerStats>>(`career:${accountId}`)) ?? {};
  }

  async history(accountId: string): Promise<HistoryEntry[]> {
    return (await this.db.read<HistoryEntry[]>(`history:${accountId}`)) ?? [];
  }
}

function addGame(old: CareerStats | undefined, e: HistoryEntry): CareerStats {
  const s = old ? { ...emptyCareer(), ...old, byType: { ...emptyCareer().byType, ...old.byType } } : emptyCareer();
  s.games++;
  s.playtime += e.duration;
  s.byType[e.type]++;
  if (e.result === 'win') s.wins++;
  else if (e.result === 'loss') s.losses++;
  else if (e.result === 'tie') s.ties++;
  if (e.score !== null && e.score > s.best) s.best = e.score;
  return s;
}

/** A game type the totals know. */
export const isGameType = (t: unknown): t is GameType => GAME_TYPES.includes(t as GameType);
