// Qualification ranking for the results screen: each team's place among the matches finished
// since the page opened, sorted as in manual table 13-1.

/** One team's part in a finished match. */
export interface RankEntry {
  /** Who is ranked: the name shown on the results (a team, a player or the AI) */
  key: string;
  rp: number;
  /** Alliance MATCH points without the opponent's FOULS */
  points: number;
  tips: number;
  auto: number;
  /** A DISQUALIFIED team's match counts 0 for everything (manual 13.6.3) */
  disqualified: boolean;
}

export type RankMove = 'up' | 'down' | 'same';

export interface Placing {
  rank: number;
  /** Compared with the ranking before this match */
  move: RankMove;
}

interface Totals {
  played: number;
  rp: number;
  points: number;
  tips: number;
  auto: number;
}

export class EventRanking {
  private readonly teams = new Map<string, Totals>();

  /** Adds a finished match and returns each team's place and how it moved; a team in it twice counts once. */
  record(entries: readonly RankEntry[]): Map<string, Placing> {
    const before = this.ranks();
    const unique = new Map(entries.map(e => [e.key, e]));
    for (const e of unique.values()) {
      const t = this.teams.get(e.key) ?? { played: 0, rp: 0, points: 0, tips: 0, auto: 0 };
      t.played++;
      if (!e.disqualified) {
        t.rp += e.rp;
        t.points += e.points;
        t.tips += e.tips;
        t.auto += e.auto;
      }
      this.teams.set(e.key, t);
    }
    const after = this.ranks();
    return new Map([...unique.keys()].map(key => {
      const rank = after.get(key)!;
      const was = before.get(key);
      return [key, { rank, move: was === undefined || was === rank ? 'same' : rank < was ? 'up' : 'down' }];
    }));
  }

  /** Places by RANKING SCORE (average RP), then average points without FOULS, TIPS and AUTO points (table 13-1). */
  private ranks(): Map<string, number> {
    const avg = (t: Totals, k: Exclude<keyof Totals, 'played'>) => t[k] / t.played;
    const sorted = [...this.teams].sort(([ka, a], [kb, b]) =>
      avg(b, 'rp') - avg(a, 'rp') || avg(b, 'points') - avg(a, 'points') || avg(b, 'tips') - avg(a, 'tips')
      || avg(b, 'auto') - avg(a, 'auto') || ka.localeCompare(kb));
    return new Map(sorted.map(([key], i) => [key, i + 1]));
  }
}
