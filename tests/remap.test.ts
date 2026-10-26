import { describe, expect, it } from 'vitest';
import { readGamepad, type RawPad } from '../src/input/gamepad';
import { RemapWizard } from '../src/input/remap';

function pad(buttons: number[], axes: number[]): RawPad {
  return { buttons: buttons.map(v => ({ pressed: v > 0.5, value: v })), axes };
}

describe('button assignment wizard', () => {
  it('assigns a button, a POV-hat d-pad, an axis trigger and a stick', () => {
    const w = new RemapWizard(['a', 'dpad_up', 'right_trigger', 'left_stick_y']);
    const idleAxes = [0, 0, -1, 1.28];
    const idle = pad([0, 0, 0, 0], idleAxes);
    w.update(idle); // baseline

    expect(w.update(pad([0, 1, 0, 0], idleAxes))).toBe('a');
    w.update(idle); // release

    expect(w.update(pad([0, 0, 0, 0], [0, 0, -1, -1]))).toBe('dpad_up'); // hat axis 3 jumps to -1
    w.update(idle);

    expect(w.update(pad([0, 0, 0, 0], [0, 0, 0.9, 1.28]))).toBe('right_trigger'); // axis 2 rests at -1
    w.update(idle);

    expect(w.update(pad([0, 0, 0, 0], [0, -0.95, -1, 1.28]))).toBe('left_stick_y');
    expect(w.done).toBe(true);

    const g = readGamepad(pad([0, 1, 0, 0], [0, -1, 1, -1]), w.mapping);
    expect(g.a).toBe(true);
    expect(g.dpad_up).toBe(true);
    expect(g.right_trigger).toBeCloseTo(1);
    expect(g.left_stick_y).toBeCloseTo(-1); // up stays negative, as in the FTC SDK
  });

  it('catches every F310 D-mode hat direction, including the small "left" step', () => {
    const neutral = 9 / 7;
    const w = new RemapWizard(['dpad_up', 'dpad_down', 'dpad_left', 'dpad_right']);
    const hat = (v: number) => pad([], [0, 0, 0, 0, 0, 0, 0, 0, 0, v]);
    w.update(hat(neutral));
    for (const v of [-1, 1 / 7, 5 / 7, -3 / 7]) {
      expect(w.update(hat(v))).toBeDefined();
      w.update(hat(neutral));
    }
    expect(w.done).toBe(true);
    expect(readGamepad(hat(5 / 7), w.mapping).dpad_left).toBe(true);
    expect(readGamepad(hat(5 / 7), w.mapping).dpad_down).toBe(false);
  });

  it('waits for release before the next step and supports skipping', () => {
    const w = new RemapWizard(['a', 'b']);
    w.update(pad([0, 0], []));
    expect(w.update(pad([1, 0], []))).toBe('a');
    expect(w.update(pad([1, 0], []))).toBeUndefined(); // still held
    w.skip();
    expect(w.done).toBe(true);
    expect(w.mapping.b).toBeUndefined();
  });
});
