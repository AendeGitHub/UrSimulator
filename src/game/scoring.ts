// BIOBUZZ point values (manual table 10-2) and field scoring checks.

import { FLOWER_VOLUME, ballInRect, type Zones } from '../field/zones';
import type { Vec3 } from '../field/layout';
import type { Alliance } from '../robot/robotConfig';

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
  /** Elements in the upward cell */
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
  /** Rule violations (manual 10.6): a red card disqualifies — 0 match points */
  warnings: number;
  yellowCards: number;
  redCards: number;
  field: FieldScore;
}

export const emptyScore = (): AllianceScore => ({
  leave: 0, autoPark: 0, autoTips: 0, teleopTips: 0, teleopPark: 0, warnings: 0, yellowCards: 0, redCards: 0, field: emptyField(),
});

/** Point breakdown for one alliance. */
export function breakdown(s: AllianceScore): { label: string; count: number; points: number }[] {
  return [
    { label: 'LEAVE (автоном)', count: s.leave, points: s.leave * POINTS.leave },
    { label: 'PARK (автоном)', count: s.autoPark, points: s.autoPark * POINTS.autoPark },
    { label: 'HIVE TIP (автоном)', count: s.autoTips, points: s.autoTips * POINTS.tip },
    { label: 'HIVE TIP (TeleOp)', count: s.teleopTips, points: s.teleopTips * POINTS.tip },
    { label: 'Мячи в верхней ячейке', count: s.field.cellElements, points: s.field.cellElements * POINTS.cellElement },
    { label: 'Нижний NECTAR в цветке', count: s.field.flowerBottom, points: s.field.flowerBottom * POINTS.flowerBottomNectar },
    { label: 'Мячи в своих цветах', count: s.field.ownedFlowerElements, points: s.field.ownedFlowerElements * POINTS.ownedFlowerElement },
    { label: 'Мячи в GARDEN', count: s.field.gardenElements, points: s.field.gardenElements * POINTS.gardenElement },
    { label: 'PARK (конец матча)', count: s.teleopPark, points: s.teleopPark * POINTS.teleopPark },
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
