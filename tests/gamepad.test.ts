import { describe, expect, it } from 'vitest';
import { STANDARD_MAPPING, applyDeadzone, detectModel, parseIds, readGamepad, type RawPad } from '../src/input/gamepad';

function rawPad(pressed: number[] = [], axes: number[] = [0, 0, 0, 0], analog: Record<number, number> = {}): RawPad {
  return {
    buttons: Array.from({ length: 18 }, (_, i) => ({ pressed: pressed.includes(i), value: analog[i] ?? (pressed.includes(i) ? 1 : 0) })),
    axes,
  };
}

describe('controller detection', () => {
  it('reads vendor/product ids in Chrome and Firefox formats', () => {
    expect(parseIds('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toEqual({ vendor: '054c', product: '0ce6' });
    expect(parseIds('54c-9cc-Wireless Controller')).toEqual({ vendor: '054c', product: '09cc' });
  });

  it('recognizes PS4, PS5 and both F310 modes', () => {
    expect(detectModel('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('ps4');
    expect(detectModel('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('ps5');
    expect(detectModel('Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)')).toBe('f310');
    expect(detectModel('Logitech Dual Action (Vendor: 046d Product: c216)')).toBe('f310');
    expect(detectModel('054c-0ce6-DualSense Wireless Controller')).toBe('ps5');
  });

  it('rejects other controllers', () => {
    expect(detectModel('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('unsupported');
  });
});

describe('FTC gamepad mapping', () => {
  it('maps standard buttons to FTC names (✕ = a, △ = y)', () => {
    const g = readGamepad(rawPad([0, 3, 12, 5]), STANDARD_MAPPING);
    expect(g.a).toBe(true);
    expect(g.y).toBe(true);
    expect(g.dpad_up).toBe(true);
    expect(g.right_bumper).toBe(true);
    expect(g.b).toBe(false);
  });

  it('keeps FTC stick signs: up is negative', () => {
    const g = readGamepad(rawPad([], [0, -1, 0.5, 0]), STANDARD_MAPPING);
    expect(g.left_stick_y).toBeCloseTo(-1);
    expect(g.right_stick_x).toBeGreaterThan(0.4);
  });

  it('reads analog triggers', () => {
    const g = readGamepad(rawPad([], undefined, { 7: 0.5 }), STANDARD_MAPPING);
    expect(g.right_trigger).toBeCloseTo(0.5);
    expect(g.left_trigger).toBe(0);
  });

  it('ignores stick drift inside the deadzone and still reaches full deflection', () => {
    expect(applyDeadzone(0.03, 0.02, 0.06)).toEqual([0, 0]);
    const [x] = applyDeadzone(1, 0, 0.06);
    expect(x).toBeCloseTo(1);
  });
});
