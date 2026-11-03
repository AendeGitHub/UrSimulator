import { describe, expect, it } from 'vitest';
import { STANDARD_MAPPING, applyDeadzone, detectModel, guessMapping, looksLikeDs4, padName, parseIds, readGamepad, type RawPad } from '../src/input/gamepad';

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

  it('recognizes the Xbox 360 controller and any XInput pad on Windows', () => {
    expect(detectModel('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox360');
    expect(detectModel('xinput')).toBe('xbox360');
    expect(detectModel('Microsoft X-Box 360 pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)')).toBe('xbox360');
    expect(detectModel('45e-28e-Microsoft X-Box 360 pad')).toBe('xbox360');
    expect(detectModel('45e-719-Xbox 360 Wireless Receiver')).toBe('xbox360');
  });

  it('takes every other controller: Xbox One / Series, Nintendo, any pad', () => {
    expect(detectModel('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
    expect(detectModel('45e-2ea-Xbox Wireless Controller')).toBe('xbox');
    expect(detectModel('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('switch');
    expect(detectModel('8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)')).toBe('generic');
    expect(detectModel('Logitech Cordless RumblePad 2 (Vendor: 046d Product: c219)')).toBe('generic');
    // Only a name, as Safari gives it
    expect(detectModel('Xbox Wireless Controller')).toBe('xbox');
    expect(detectModel('Pro Controller')).toBe('switch');
    expect(detectModel('Wireless Controller')).toBe('ps4');
    expect(detectModel('USB Gamepad')).toBe('generic');
  });

  it('gives other makers\' pads the family they name: REV\'s PS4 gamepad, "for Xbox" pads', () => {
    expect(detectModel('REV USB PS4 Compatible Gamepad (Vendor: 1234 Product: 5678)')).toBe('ps4');
    expect(detectModel('Wireless Controller (Vendor: 7545 Product: 0104)')).toBe('ps4');
    expect(detectModel('GameSir Wireless Controller (Vendor: 3537 Product: 1022)')).toBe('generic');
    expect(detectModel('Afterglow Gamepad for Xbox 360 (Vendor: 0e6f Product: 0213)')).toBe('xbox360');
    expect(detectModel('HORIPAD for Nintendo Switch (STANDARD GAMEPAD Vendor: 0f0d Product: 00c1)')).toBe('switch');
  });

  it('names a family\'s own pads by the family and any other pad by its own name', () => {
    expect(padName({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' })).toBe('Xbox One / Series');
    expect(padName({ id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' })).toBe('Xbox 360');
    expect(padName({ id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)' })).toBe('PS4 DualShock 4');
    expect(padName({ id: 'REV USB PS4 Compatible Gamepad (Vendor: 1234 Product: 5678)' })).toBe('REV USB PS4 Compatible Gamepad');
    expect(padName({ id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)' })).toBe('8BitDo Pro 2');
    expect(padName({ id: '79-6-Generic   USB  Joystick  ' })).toBe('Generic USB Joystick');
    expect(padName({ id: 'Unknown Gamepad (STANDARD GAMEPAD)' })).toBe('Unknown Gamepad');
    expect(padName({ id: '(Vendor: 1234 Product: 5678)' }).length).toBeGreaterThan(0);
  });
});

describe('layout guess for a pad without a standard one', () => {
  const pad = (axes: number[], buttons = 12): RawPad => ({ buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })), axes });

  it('DirectInput pad in Chrome: right stick on Z / Rz, the hat as the d-pad', () => {
    const m = guessMapping(pad([0, 0, 0, 0, 0, 0, 0, 0, 0, 9 / 7]));
    expect(m.left_stick_x).toEqual({ kind: 'axis', index: 0, sign: 1 });
    expect(m.right_stick_x).toEqual({ kind: 'axis', index: 2, sign: 1 });
    expect(m.right_stick_y).toEqual({ kind: 'axis', index: 5, sign: 1 });
    expect(m.a).toEqual({ kind: 'button', index: 0 });
    expect(m.touchpad).toBeUndefined();
    const left = readGamepad({ buttons: pad([]).buttons, axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5 / 7] }, m);
    expect(left.dpad_left).toBe(true);
    expect(left.dpad_up).toBe(false);
  });

  it('Xbox-like pad: triggers resting at -1 are triggers, not the right stick', () => {
    const m = guessMapping(pad([0, 0, -1, 0, 0, -1]));
    expect(m.right_stick_x).toEqual({ kind: 'axis', index: 3, sign: 1 });
    expect(m.right_stick_y).toEqual({ kind: 'axis', index: 4, sign: 1 });
    expect(m.left_trigger).toEqual({ kind: 'axisRange', index: 2, rest: -1, full: 1 });
    expect(m.right_trigger).toEqual({ kind: 'axisRange', index: 5, rest: -1, full: 1 });
    // Nothing pressed: the robot stays still.
    const g = readGamepad(pad([0, 0, -1, 0, 0, -1]), m);
    expect([g.right_stick_x, g.right_stick_y, g.left_trigger, g.right_trigger]).toEqual([0, 0, 0, 0]);
  });

  it('a DualShock 4 copy in its raw layout: □ ✕ ○ △, PS, touchpad, L2 / R2 on axes 3 and 4', () => {
    const rest = [0, 0, 0, -1, -1, 0, 0, 0, 0, 9 / 7];
    expect(looksLikeDs4(pad(rest, 14))).toBe(true);
    expect(looksLikeDs4(pad([0, 0, -1, 0, 0, -1], 14))).toBe(false);
    const m = guessMapping(pad(rest, 14));
    expect([m.x, m.a, m.b, m.y]).toEqual([0, 1, 2, 3].map(index => ({ kind: 'button', index })));
    expect(m.guide).toEqual({ kind: 'button', index: 12 });
    expect(m.touchpad).toEqual({ kind: 'button', index: 13 });
    expect(m.dpad_up).toEqual({ kind: 'axisValue', index: 9, value: -1 });
    expect(m.left_trigger).toEqual({ kind: 'axisRange', index: 3, rest: -1, full: 1 });
    expect([m.right_stick_x, m.right_stick_y]).toEqual([{ kind: 'axis', index: 2, sign: 1 }, { kind: 'axis', index: 5, sign: 1 }]);
    // ✕ pressed: FTC a (arm down), not x.
    const cross = readGamepad({ buttons: pad(rest, 14).buttons.map((b, i) => (i === 1 ? { pressed: true, value: 1 } : b)), axes: rest }, m);
    expect([cross.a, cross.x, cross.dpad_up]).toEqual([true, false, false]);
  });

  it('a pad with four axes in a row (Firefox) gets both sticks', () => {
    const m = guessMapping(pad([0, 0, 0, 0]));
    expect(m.right_stick_x).toEqual({ kind: 'axis', index: 2, sign: 1 });
    expect(m.right_stick_y).toEqual({ kind: 'axis', index: 3, sign: 1 });
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
