// BIOBUZZ point values (manual table 10-2) and field scoring checks.

import { FLOWER_VOLUME, ballInRect, type Zones } from '../field/zones';
import type { Vec3 } from '../field/layout';
import type { Alliance } from '../robot/robotConfig';
import type { Slot } from '../sim/types';
import { t } from '../ui/i18n';

export const POINTS = {
  leave: 3,
  autoPark: 5,
  teleopPark: 5,
  tip: 20,
  cellElement: 2,
  flowerBottomNectar: 5,
  ownedFlowerElement: 2,
  gardenElement: 1,
};

/** Ranking point thresholds for regular events (manual table 10-3). */
export const RP_THRESHOLDS = { swarm: 16, pollinator1: 4, pollinator2: 7 };

export interface BallSnapshot {
  kind: 'pollen' | 'nectar';
  color: 'yellow' | Alliance;
  pos: Vec3;
  radius: number;
}

export interface FieldScore {
  /** Elements in the upward cell (they score if still there at the end, manual 10.5.1) */
  cellElements: number;
  flowerBottom: number;
  ownedFlowerElements: number;
  gardenElements: number;
}

const emptyField = (): FieldScore => ({ cellElements: 0, flowerBottom: 0, ownedFlowerElements: 0, gardenElements: 0 });

/** Scores that depend on where balls are (assessed when everything comes to rest). */
export function scoreField(balls: BallSnapshot[], zones: Zones, upCellElements: Record<Alliance, number>): Record<Alliance, FieldScore> {
  const result = { red: emptyField(), blue: emptyField() };
  for (const a of ['red', 'blue'] as const) result[a].cellElements = upCellElements[a];

  for (const [fx, fz] of zones.flowers) {
    const inside = balls.filter(b =>
      Math.hypot(b.pos[0] - fx, b.pos[2] - fz) < FLOWER_VOLUME.radius &&
      b.pos[1] + b.radius > FLOWER_VOLUME.yMin && b.pos[1] - b.radius < FLOWER_VOLUME.yMax);
    const nectar = inside.filter(b => b.kind === 'nectar').sort((a, b) => a.pos[1] - b.pos[1]);
    if (!nectar.length) continue;
    const bottom = nectar[0].color as Alliance;
    const owner = nectar[nectar.length - 1].color as Alliance;
    result[bottom].flowerBottom += 1;
    result[owner].ownedFlowerElements += inside.length;
  }

  for (const a of ['red', 'blue'] as const) {
    result[a].gardenElements = balls.filter(b => ballInRect(b.pos, b.radius, zones.garden[a])).length;
  }
  return result;
}

export interface AllianceScore {
  leave: number;
  autoPark: number;
  autoTips: number;
  teleopTips: number;
  teleopPark: number;
  /** Which robots were PARKED (at least partly in the LOADING ZONE, manual 10.5.4): end of AUTO and end of the match */
  autoParked: Slot[];
  teleopParked: Slot[];
  /** Rule violations (manual 10.6): a red card disqualifies — 0 match points */
  warnings: number;
  yellowCards: number;
  redCards: number;
  /** FOULS this alliance committed */
  minorFouls: number;
  majorFouls: number;
  /** Points credited to this alliance for the opponent's FOULS */
  foulPoints: number;
  /** Referee calls against this alliance, e.g. "G410 · MAJOR FOUL · Red 1" (sim/Referee.ts) */
  calls: string[];
  field: FieldScore;
}

export const emptyScore = (): AllianceScore => ({
  leave: 0, autoPark: 0, autoTips: 0, teleopTips: 0, teleopPark: 0, autoParked: [], teleopParked: [], warnings: 0, yellowCards: 0, redCards: 0,
  minorFouls: 0, majorFouls: 0, foulPoints: 0, calls: [], field: emptyField(),
});

/** Point breakdown for one alliance. */
export function breakdown(s: AllianceScore): { label: string; count: number; points: number }[] {
  return [
    { label: t('score.leave'), count: s.leave, points: s.leave * POINTS.leave },
    { label: t('score.autoPark'), count: s.autoPark, points: s.autoPark * POINTS.autoPark },
    { label: t('score.autoTips'), count: s.autoTips, points: s.autoTips * POINTS.tip },
    { label: t('score.teleopTips'), count: s.teleopTips, points: s.teleopTips * POINTS.tip },
    { label: t('score.cell'), count: s.field.cellElements, points: s.field.cellElements * POINTS.cellElement },
    { label: t('score.flowerBottom'), count: s.field.flowerBottom, points: s.field.flowerBottom * POINTS.flowerBottomNectar },
    { label: t('score.ownedFlower'), count: s.field.ownedFlowerElements, points: s.field.ownedFlowerElements * POINTS.ownedFlowerElement },
    { label: t('score.garden'), count: s.field.gardenElements, points: s.field.gardenElements * POINTS.gardenElement },
    { label: t('score.teleopPark'), count: s.teleopPark, points: s.teleopPark * POINTS.teleopPark },
    { label: t('score.fouls'), count: 1, points: s.foulPoints },
  ];
}

export function total(s: AllianceScore): number {
  if (s.redCards > 0) return 0;
  return breakdown(s).reduce((sum, row) => sum + row.points, 0);
}

export function rankingPoints(s: AllianceScore): { swarm: boolean; pollinator1: boolean; pollinator2: boolean } {
  const tips = s.autoTips + s.teleopTips;
  const leavePark = s.leave * POINTS.leave + s.autoPark * POINTS.autoPark + s.teleopPark * POINTS.teleopPark;
  return {
    swarm: leavePark >= RP_THRESHOLDS.swarm,
    pollinator1: tips >= RP_THRESHOLDS.pollinator1,
    pollinator2: tips >= RP_THRESHOLDS.pollinator2,
  };
}

/** Points by row of the FTC results display: the groups of manual table 10-2, then the opponent's FOULS. */
export interface ScoreRows {
  leavePark: number;
  /** HIVE TIPS and the POLLEN / NECTAR left in the upward CELL */
  hive: number;
  flower: number;
  garden: number;
  foul: number;
}

export function scoreRows(s: AllianceScore): ScoreRows {
  const f = s.field;
  return {
    leavePark: s.leave * POINTS.leave + s.autoPark * POINTS.autoPark + s.teleopPark * POINTS.teleopPark,
    hive: (s.autoTips + s.teleopTips) * POINTS.tip + f.cellElements * POINTS.cellElement,
    flower: f.flowerBottom * POINTS.flowerBottomNectar + f.ownedFlowerElements * POINTS.ownedFlowerElement,
    garden: f.gardenElements * POINTS.gardenElement,
    foul: s.foulPoints,
  };
}

/** What the alliance scored on the field itself: no points from the opponent's FOULS, no red card zeroing it. */
export function earnedPoints(s: AllianceScore): number {
  const r = scoreRows(s);
  return r.leavePark + r.hive + r.flower + r.garden;
}

/** Points scored in AUTO (a ranking tiebreaker, manual table 13-1). */
export function autoPoints(s: AllianceScore): number {
  return s.leave * POINTS.leave + s.autoPark * POINTS.autoPark + s.autoTips * POINTS.tip;
}

export type MatchResult = 'win' | 'tie' | 'loss';

/** The RANKING POINTS of the results display (manual table 10-2): WIN 3 or TIE 1, then SWARM, POLLINATOR 1 and 2. */
export interface MatchRankingPoints {
  result: MatchResult;
  swarm: boolean;
  pollinator1: boolean;
  pollinator2: boolean;
  total: number;
}

/** The winning alliance, or null for a tie. */
export function matchWinner(score: Record<Alliance, AllianceScore>): Alliance | null {
  const red = total(score.red);
  const blue = total(score.blue);
  return red === blue ? null : red > blue ? 'red' : 'blue';
}

/** Both alliances' RP. A DISQUALIFIED alliance (red card) gets none (manual 13.6.3). */
export function matchRankingPoints(score: Record<Alliance, AllianceScore>): Record<Alliance, MatchRankingPoints> {
  const winner = matchWinner(score);
  const of = (a: Alliance): MatchRankingPoints => {
    if (score[a].redCards > 0) return { result: 'loss', swarm: false, pollinator1: false, pollinator2: false, total: 0 };
    const result: MatchResult = winner === null ? 'tie' : winner === a ? 'win' : 'loss';
    const rp = rankingPoints(score[a]);
    const won = result === 'win' ? 3 : result === 'tie' ? 1 : 0;
    return { result, ...rp, total: won + Number(rp.swarm) + Number(rp.pollinator1) + Number(rp.pollinator2) };
  };
  return { red: of('red'), blue: of('blue') };
}
