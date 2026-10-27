import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, keyLabel, rebind, withDefaults } from '../src/input/bindings';

describe('control bindings', () => {
  it('rebinding to a button another action uses swaps the two', () => {
    const b = rebind(DEFAULT_BINDINGS, 'pad', 'intake', 'right_bumper');
    expect(b.pad.intake).toBe('right_bumper');
    expect(b.pad.transfer).toBe('left_bumper');
    const k = rebind(DEFAULT_BINDINGS, 'keys', 'forward', 'ArrowUp');
    expect(k.keys.forward).toBe('ArrowUp');
    expect(DEFAULT_BINDINGS.keys.forward).toBe('KeyW');
  });

  it('fills in actions missing from saved bindings', () => {
    const b = withDefaults({ pad: { ...DEFAULT_BINDINGS.pad, intake: 'a' } } as never);
    expect(b.pad.intake).toBe('a');
    expect(b.keys.pause).toBe('Escape');
  });

  it('names keys the way players know them', () => {
    expect(keyLabel('KeyF')).toBe('F');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('ArrowUp')).toBe('↑');
  });
});
