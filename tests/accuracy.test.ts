import { describe, expect, it } from 'vitest';
import { URAN_V2 } from '../src/robot/robots';
import { shotRange, shotSpread } from '../src/sim/Mechanisms';

describe('shooting accuracy by distance', () => {
  const acc = URAN_V2.shooter;

  it('is tight inside the sweet spot and scatters far away', () => {
    const near = shotSpread(0.9, acc);
    const far = shotSpread(2.2, acc);
    expect(near.angle).toBeLessThan((1 * Math.PI) / 180);
    expect(near.speed).toBeLessThan(0.01);
    expect(far.angle).toBeGreaterThan((4 * Math.PI) / 180);
    expect(far.speed).toBeGreaterThan(0.06);
  });

  it('gets steadily worse with distance', () => {
    let last = 0;
    for (let d = 0.5; d <= 3.5; d += 0.25) {
      const s = shotSpread(d, acc).angle;
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('names the range for the HUD', () => {
    expect(shotRange(0.9, acc)).toBe('near');
    expect(shotRange(1.4, acc)).toBe('mid');
    expect(shotRange(2.0, acc)).toBe('far');
  });
});
