// Leaderboard periods: the FTC season (September to August; UrSim's first is BIOBUZZ 2026–27)
// and the calendar months in it, in UTC. Keys: season '2026', month '2026-10', and 'all' for a
// player's whole career.

export const FIRST_SEASON = 2026;
/** The FTC game of each season */
const SEASON_GAMES: Record<number, string> = { 2026: 'BIOBUZZ' };
/** A season starts in September (0-based month). */
const SEASON_START = 8;

export const ALL_TIME = 'all';

const pad = (n: number) => String(n).padStart(2, '0');

/** The season a date falls in; games from before UrSim's first season count in it. */
export function seasonOf(date: Date): number {
  const year = date.getUTCFullYear();
  return Math.max(FIRST_SEASON, date.getUTCMonth() >= SEASON_START ? year : year - 1);
}

/** The month a date falls in ('2026-10'); before the first season: its first month. */
export function monthOf(date: Date): string {
  if (date.getUTCFullYear() < FIRST_SEASON || (date.getUTCFullYear() === FIRST_SEASON && date.getUTCMonth() < SEASON_START)) {
    return `${FIRST_SEASON}-${pad(SEASON_START + 1)}`;
  }
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** The leaderboards a game played on this date goes into: its season and its month. */
export function periodsOf(date: Date): [string, string] {
  return [String(seasonOf(date)), monthOf(date)];
}

export const isSeasonKey = (key: string) => /^\d{4}$/.test(key);
export const isMonthKey = (key: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
export const isPeriodKey = (key: unknown): key is string => typeof key === 'string' && (isSeasonKey(key) || isMonthKey(key));

/** The season a period key belongs to. */
export function seasonOfKey(key: string): number {
  if (isSeasonKey(key)) return Number(key);
  const [year, month] = key.split('-').map(Number);
  return month - 1 >= SEASON_START ? year : year - 1;
}

/** Whether a date is inside a period ('all' takes everything). */
export function inPeriod(date: Date, key: string): boolean {
  if (key === ALL_TIME) return true;
  return isSeasonKey(key) ? String(seasonOf(date)) === key : monthOf(date) === key;
}

/** Every season so far, the current one first. */
export function seasons(now = new Date()): number[] {
  const list: number[] = [];
  for (let s = seasonOf(now); s >= FIRST_SEASON; s--) list.push(s);
  return list;
}

/** A season's months that have begun, the latest first. */
export function seasonMonths(season: number, now = new Date()): string[] {
  const current = monthOf(now);
  const list: string[] = [];
  for (let i = 0; i < 12; i++) {
    const month = SEASON_START + i;
    const key = `${season + Math.floor(month / 12)}-${pad((month % 12) + 1)}`;
    if (key > current) break;
    list.push(key);
  }
  return list.reverse();
}

/** 'BIOBUZZ 2026–27', or just '2027–28' for a season whose game isn't known yet. */
export function seasonLabel(season: number): string {
  const years = `${season}–${String(season + 1).slice(2)}`;
  return SEASON_GAMES[season] ? `${SEASON_GAMES[season]} ${years}` : years;
}

/** 'October 2026' in the interface language. */
export function monthLabel(key: string, language: string): string {
  const [year, month] = key.split('-').map(Number);
  const text = new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}
