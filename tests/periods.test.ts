import { describe, expect, it } from 'vitest';
import { inPeriod, monthLabel, monthOf, periodsOf, seasonLabel, seasonMonths, seasonOf, seasonOfKey, seasons } from '../src/net/periods';

const d = (iso: string) => new Date(iso);

describe('leaderboard periods', () => {
  it('puts a game in its FTC season (September to August) and its month', () => {
    expect(periodsOf(d('2026-10-29T12:00:00Z'))).toEqual(['2026', '2026-10']);
    expect(periodsOf(d('2027-08-31T23:00:00Z'))).toEqual(['2026', '2027-08']);
    expect(periodsOf(d('2027-09-01T00:00:00Z'))).toEqual(['2027', '2027-09']);
  });

  it('counts games from before the first season in its first month', () => {
    expect(seasonOf(d('2026-05-01T00:00:00Z'))).toBe(2026);
    expect(monthOf(d('2026-05-01T00:00:00Z'))).toBe('2026-09');
  });

  it('lists the seasons so far and the months of a season that have begun', () => {
    expect(seasons(d('2026-10-29T00:00:00Z'))).toEqual([2026]);
    expect(seasons(d('2028-01-01T00:00:00Z'))).toEqual([2027, 2026]);
    expect(seasonMonths(2026, d('2026-11-03T00:00:00Z'))).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(seasonMonths(2026, d('2030-01-01T00:00:00Z'))).toHaveLength(12);
    expect(seasonMonths(2026, d('2030-01-01T00:00:00Z'))[0]).toBe('2027-08');
  });

  it('knows which season a key belongs to and which dates are in it', () => {
    expect(seasonOfKey('2027-03')).toBe(2026);
    expect(seasonOfKey('2027-09')).toBe(2027);
    expect(inPeriod(d('2027-03-02T00:00:00Z'), '2026')).toBe(true);
    expect(inPeriod(d('2027-03-02T00:00:00Z'), '2027-03')).toBe(true);
    expect(inPeriod(d('2027-03-02T00:00:00Z'), '2027-04')).toBe(false);
    expect(inPeriod(d('2020-01-01T00:00:00Z'), 'all')).toBe(true);
  });

  it('names seasons by their game and months in the interface language', () => {
    expect(seasonLabel(2026)).toBe('BIOBUZZ 2026–27');
    expect(seasonLabel(2027)).toBe('2027–28');
    expect(monthLabel('2026-10', 'en')).toBe('October 2026');
    expect(monthLabel('2026-10', 'ru')).toMatch(/^Октябрь 2026/);
  });
});
