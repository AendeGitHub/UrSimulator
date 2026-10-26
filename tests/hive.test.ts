import { describe, expect, it } from 'vitest';
import { CELLS, aimPoint, cellFrame, inCell, stateAngle, tipProgress, upCell, type Vec3 } from '../src/field/hiveGeometry';

const RED_PIVOT: Vec3 = [-0.3236, 1.1163, 0];
const BLUE_PIVOT: Vec3 = [0.3241, 1.1163, 0];

describe('hive geometry', () => {
  it('places the staged red NECTAR (from the CAD) inside the upward red cell', () => {
    for (const p of [[-0.5332, 1.2685, 0.241], [-0.4413, 1.2685, 0.241], [-0.3493, 1.2685, 0.241]] as Vec3[]) {
      expect(inCell(p, 'red', 'pos', RED_PIVOT, 0)).toBe(true);
      expect(inCell(p, 'red', 'neg', RED_PIVOT, 0)).toBe(false);
    }
  });

  it('does not count a ball resting on the outside of the pointed roof', () => {
    // Seen in testing: a pollen on the roof slope near the cell's side at the top.
    expect(inCell([-0.52, 1.53, 0.27], 'red', 'pos', RED_PIVOT, 0)).toBe(false);
    // Same height in the middle of the cell is inside the roof peak.
    expect(inCell([-0.3236, 1.53, 0.27], 'red', 'pos', RED_PIVOT, 0)).toBe(true);
  });

  it('mirrors the cells for the blue hive', () => {
    expect(inCell([0.4417, 1.2682, -0.2415], 'blue', 'pos', BLUE_PIVOT, 0)).toBe(true);
  });

  it('tipping makes the other cell the upward one, as a mirror image', () => {
    const angle = stateAngle('red', 'B');
    const before = cellFrame('red', 'pos', RED_PIVOT, 0);
    const after = cellFrame('red', 'neg', RED_PIVOT, angle);
    expect(after.center[1]).toBeCloseTo(before.center[1], 2);
    expect(after.center[2]).toBeCloseTo(-before.center[2], 2);
    expect(upCell('B')).toBe('neg');
    // The cell that was up is now low.
    expect(cellFrame('red', 'pos', RED_PIVOT, angle).center[1]).toBeLessThan(RED_PIVOT[1]);
  });

  it('turns the blue hive the opposite way', () => {
    expect(stateAngle('blue', 'B')).toBeCloseTo(-stateAngle('red', 'B'));
  });

  it('opening of the upward cell faces outward and 30° up', () => {
    const f = cellFrame('red', 'pos', RED_PIVOT, 0);
    expect(Math.atan2(f.u[1], f.u[2]) * (180 / Math.PI)).toBeCloseTo(30, 5);
    expect(CELLS.pos.u[2]).toBeGreaterThan(0);
  });

  it('aims at the opening, near the manual heights (135.9–166.6 cm)', () => {
    const p = aimPoint('red', 'pos', RED_PIVOT, 0);
    expect(p[1]).toBeGreaterThan(1.36);
    expect(p[1]).toBeLessThan(1.67);
  });

  it('eases the tip from 0 to 1', () => {
    expect(tipProgress(0)).toBe(0);
    expect(tipProgress(1)).toBe(1);
    expect(tipProgress(0.5)).toBeCloseTo(0.5);
  });
});
