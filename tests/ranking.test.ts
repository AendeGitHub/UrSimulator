import { describe, expect, it } from 'vitest';
import { EventRanking, type RankEntry } from '../src/game/ranking';

const entry = (key: string, rp: number, points = 0, extra: Partial<RankEntry> = {}): RankEntry =>
  ({ key, rp, points, tips: 0, auto: 0, disqualified: false, ...extra });

describe('qualification ranking (manual 13.6.3)', () => {
  it('ranks by average RP, then by average points without fouls, and says who moved', () => {
    const ranking = new EventRanking();
    let places = ranking.record([entry('URAN92', 1, 40), entry('SWB · AI', 4, 60)]);
    expect(places.get('SWB · AI')).toEqual({ rank: 1, move: 'same' });
    expect(places.get('URAN92')).toEqual({ rank: 2, move: 'same' });

    places = ranking.record([entry('URAN92', 6, 90), entry('SWB · AI', 0, 10)]);
    expect(places.get('URAN92')).toEqual({ rank: 1, move: 'up' });
    expect(places.get('SWB · AI')).toEqual({ rank: 2, move: 'down' });

    // The same RANKING SCORE: more points per match wins.
    const tied = new EventRanking();
    places = tied.record([entry('A', 3, 50), entry('B', 3, 70)]);
    expect(places.get('B')?.rank).toBe(1);
  });

  it('counts a team on the field twice once, and a disqualified match as 0', () => {
    const ranking = new EventRanking();
    ranking.record([entry('URAN92', 3, 50), entry('URAN92', 3, 50), entry('SWB', 1, 20)]);
    const places = ranking.record([entry('URAN92', 6, 100, { disqualified: true }), entry('SWB', 1, 20)]);
    // URAN92: (3 + 0) / 2 = 1.5 RP a match, SWB: 1.
    expect(places.get('URAN92')?.rank).toBe(1);
    expect(ranking.record([entry('SWB', 4, 20)]).get('SWB')).toEqual({ rank: 1, move: 'up' });
  });
});
