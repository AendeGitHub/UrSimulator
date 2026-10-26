import { describe, expect, it } from 'vitest';
import { emptyScore, rankingPoints, scoreField, total, type BallSnapshot } from '../src/game/scoring';
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
});
