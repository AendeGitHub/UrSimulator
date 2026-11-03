import { describe, expect, it } from 'vitest';
import { POINTS, earnedPoints, emptyScore, matchRankingPoints, matchWinner, rankingPoints, scoreField, scoreRows, total, type BallSnapshot } from '../src/game/scoring';
import { clearOfWalls, footprint, polygonOverlapsRect, type Zones } from '../src/field/zones';

const W = 1.7951;
const zones: Zones = {
  wall: W,
  loading: {
    red: { minX: -W, maxX: -1.501, minZ: -1.184, maxZ: -0.607 },
    blue: { minX: 1.501, maxX: W, minZ: 0.607, maxZ: 1.184 },
  },
  garden: {
    red: { minX: -W, maxX: -1.204, minZ: 1.73, maxZ: W },
    blue: { minX: 1.204, maxX: W, minZ: -W, maxZ: -1.73 },
  },
  flowers: [[-0.5942, -1.7282]],
};

const pollen = (pos: [number, number, number]): BallSnapshot => ({ kind: 'pollen', color: 'yellow', pos, radius: 0.0355 });
const nectar = (color: 'red' | 'blue', pos: [number, number, number]): BallSnapshot => ({ kind: 'nectar', color, pos, radius: 0.0455 });

describe('field scoring', () => {
  it('gives the flower to the top-most NECTAR and the bonus to the bottom-most', () => {
    const [fx, fz] = zones.flowers[0];
    const balls = [
      pollen([fx, 0.1824, fz]),
      pollen([fx, 0.2558, fz]),
      nectar('blue', [fx, 0.33, fz]),
      nectar('red', [fx, 0.42, fz]),
      pollen([fx, 0.0356, fz]), // bottom ring, below the scoring volume
    ];
    const s = scoreField(balls, zones, { red: 0, blue: 0 });
    expect(s.red.ownedFlowerElements).toBe(4);
    expect(s.blue.flowerBottom).toBe(1);
    expect(s.red.flowerBottom).toBe(0);
  });

  it('a flower with only POLLEN is owned by nobody', () => {
    const [fx, fz] = zones.flowers[0];
    const s = scoreField([pollen([fx, 0.2, fz])], zones, { red: 0, blue: 0 });
    expect(s.red.ownedFlowerElements + s.blue.ownedFlowerElements).toBe(0);
  });

  // The examples of the scoring guide (Manual/scoring material.pdf, FLOWER Scoring – TELEOP).
  it('scores the POLLEN and NECTAR at least partly between the middle and the top ring, in the order they are in (manual 10.5.2)', () => {
    const [fx, fz] = zones.flowers[0];
    const r = 0.0355;
    // Its top just over the middle ring (0.137 m) it scores; just under, it doesn't.
    const s = scoreField([pollen([fx, 0.137 - r - 0.004, fz]), pollen([fx, 0.137 - r + 0.004, fz]), pollen([fx, 0.2, fz]), nectar('red', [fx, 0.29, fz])], zones, { red: 0, blue: 0 });
    expect(s.red).toMatchObject({ flowerBottom: 1, ownedFlowerElements: 3 });
    // "All 4 POLLEN are in the FLOWER scoring volume. The blue NECTAR does not score": over the top
    // ring (0.545 m) it owns nothing.
    const above = scoreField([0.16, 0.23, 0.3, 0.37].map(y => pollen([fx, y, fz])).concat(nectar('blue', [fx, 0.545 + 0.0455 + 0.01, fz])), zones, { red: 0, blue: 0 });
    expect(above.blue).toMatchObject({ flowerBottom: 0, ownedFlowerElements: 0 });
    // "2 NECTAR and 6 POLLEN shown. All are in the FLOWER scoring volume": the top NECTAR's alliance
    // owns all 8 (2 points each), whoever placed them; the bottom one's gets the bonus (5).
    const full = scoreField([
      nectar('red', [fx, 0.17, fz]),
      ...[0.24, 0.31, 0.38, 0.45].map(y => pollen([fx, y, fz])),
      nectar('blue', [fx, 0.5, fz]),
      pollen([fx, 0.52, fz]),
      pollen([fx, 0.53, fz]),
    ], zones, { red: 0, blue: 0 });
    expect(full.red).toMatchObject({ flowerBottom: 1, ownedFlowerElements: 0 });
    expect(full.blue).toMatchObject({ flowerBottom: 0, ownedFlowerElements: 8 });
    expect(POINTS.flowerBottomNectar).toBe(5);
    expect(POINTS.ownedFlowerElement).toBe(2);
  });

  it('counts GARDEN elements for the garden color, whoever put them there', () => {
    const s = scoreField([pollen([-1.6, 0.0355, 1.76]), nectar('blue', [-1.5, 0.0455, 1.75]), pollen([0, 0.0355, 0])], zones, { red: 0, blue: 0 });
    expect(s.red.gardenElements).toBe(2);
    expect(s.blue.gardenElements).toBe(0);
  });
});

describe('robot scoring', () => {
  it('detects PARK when the robot is partly in its loading zone', () => {
    expect(polygonOverlapsRect(footprint(-1.3, -0.9, 0, 0.457, 0.457), zones.loading.red)).toBe(true);
    expect(polygonOverlapsRect(footprint(-0.5, -0.9, 0, 0.457, 0.457), zones.loading.red)).toBe(false);
    expect(polygonOverlapsRect(footprint(-1.3, -0.9, Math.PI / 4, 0.457, 0.457), zones.loading.red)).toBe(true);
  });

  it('LEAVE only once the robot no longer touches the wall', () => {
    expect(clearOfWalls(footprint(-W + 0.2326, -0.25, 0, 0.457, 0.457), W)).toBe(false);
    expect(clearOfWalls(footprint(-1.2, -0.25, 0, 0.457, 0.457), W)).toBe(true);
  });

  it('adds up points and ranking points', () => {
    const s = emptyScore();
    s.leave = 1;
    s.autoTips = 1;
    s.teleopTips = 3;
    s.teleopPark = 1;
    s.field.cellElements = 2;
    expect(total(s)).toBe(3 + 20 + 60 + 5 + 4);
    expect(rankingPoints(s)).toEqual({ swarm: false, pollinator1: true, pollinator2: false });
  });

  it('groups points into the rows of the results display (LEAVE & PARK, HIVE, FLOWER, GARDEN, FOUL)', () => {
    // The FTC display in the reference: Red 3 / 40 / 0 / 1 / 15 = 59, Blue 5 / 22 / 0 / 3 / 0 = 30.
    const red = emptyScore();
    red.leave = 1;
    red.autoTips = 1;
    red.teleopTips = 1;
    red.field.gardenElements = 1;
    red.foulPoints = 15;
    const blue = emptyScore();
    blue.teleopPark = 1;
    blue.teleopTips = 1;
    blue.field.cellElements = 1;
    blue.field.gardenElements = 3;
    expect(scoreRows(red)).toEqual({ leavePark: 3, hive: 40, flower: 0, garden: 1, foul: 15 });
    expect(scoreRows(blue)).toEqual({ leavePark: 5, hive: 22, flower: 0, garden: 3, foul: 0 });
    expect([total(red), total(blue)]).toEqual([59, 30]);
    expect(earnedPoints(red)).toBe(44);
  });

  it('gives 3 RP for a win, 1 for a tie, one for each bonus, none when disqualified', () => {
    const red = emptyScore();
    red.autoTips = 2;
    red.teleopTips = 5;
    red.leave = 2;
    red.autoPark = 1;
    red.teleopPark = 1;
    const blue = emptyScore();
    blue.teleopTips = 4;
    expect(matchWinner({ red, blue })).toBe('red');
    expect(matchRankingPoints({ red, blue })).toEqual({
      red: { result: 'win', swarm: true, pollinator1: true, pollinator2: true, total: 6 },
      blue: { result: 'loss', swarm: false, pollinator1: true, pollinator2: false, total: 1 },
    });

    const tie = matchRankingPoints({ red: emptyScore(), blue: emptyScore() });
    expect(matchWinner({ red: emptyScore(), blue: emptyScore() })).toBeNull();
    expect(tie.red).toEqual({ result: 'tie', swarm: false, pollinator1: false, pollinator2: false, total: 1 });

    red.redCards = 1;
    expect(matchWinner({ red, blue })).toBe('blue');
    expect(matchRankingPoints({ red, blue }).red.total).toBe(0);
    expect(matchRankingPoints({ red, blue }).blue.result).toBe('win');
  });
});
