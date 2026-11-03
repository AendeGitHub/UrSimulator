import { describe, expect, it } from 'vitest';
import { MATCH_COUNTDOWN, RECORDING, recordingTime } from '../src/game/matchTimer';
import { DURATION } from '../src/sim/Match';

describe('match timer recording', () => {
  it('plays its own 3-2-1 before the match and nothing in practice', () => {
    expect(recordingTime('practice', 12, 0)).toBeNull();
    expect(recordingTime('auto', 0, MATCH_COUNTDOWN)).toBeCloseTo(RECORDING.from);
    expect(recordingTime('auto', 0, 1)).toBeCloseTo(RECORDING.auto - 1);
    expect(MATCH_COUNTDOWN).toBeGreaterThanOrEqual(3);
  });

  it('stays in step with the match at every sound of the recording', () => {
    // Measured in the recording: AUTO ends at 34.2 s, the red 0:03 of the transition starts at
    // 39.1 s, TELEOP at 42.2 s, END GAME at 132.25 s and the end buzzer at 162.3 s.
    expect(recordingTime('auto', DURATION.auto, 0)).toBeCloseTo(34.15, 1);
    expect(recordingTime('transition', DURATION.transition - 3, 0)).toBeCloseTo(39.15, 1);
    expect(recordingTime('teleop', 0, 0)).toBeCloseTo(42.25, 1);
    expect(recordingTime('teleop', DURATION.teleop - 30, 0)).toBeCloseTo(132.25, 1);
    expect(recordingTime('post', 0, 0)).toBeCloseTo(162.25, 1);
    // The step from the transition into TELEOP is too small to make the recording jump.
    expect(Math.abs(recordingTime('teleop', 0, 0)! - recordingTime('transition', DURATION.transition, 0)!)).toBeLessThan(0.25);
  });
});
