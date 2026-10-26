// Gamepad model detection and FTC-style button mapping.
// Supported controllers (the same ones allowed on an FTC Driver Station): PS4, PS5, Logitech F310.

export type PadModel = 'ps4' | 'ps5' | 'f310' | 'keyboard' | 'unsupported';

/** Gamepad state with the same field names as the FTC SDK `Gamepad` class. */
export interface FtcGamepad {
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  dpad_up: boolean;
  dpad_down: boolean;
  dpad_left: boolean;
  dpad_right: boolean;
  left_bumper: boolean;
  right_bumper: boolean;
  left_trigger: number;
  right_trigger: number;
  /** -1 = left, +1 = right */
  left_stick_x: number;
  /** -1 = up, +1 = down (same as FTC SDK) */
  left_stick_y: number;
  right_stick_x: number;
  right_stick_y: number;
  left_stick_button: boolean;
  right_stick_button: boolean;
  back: boolean;
  start: boolean;
  guide: boolean;
  touchpad: boolean;
}

export type ControlId = keyof FtcGamepad;
export type ButtonId = { [K in ControlId]: FtcGamepad[K] extends boolean ? K : never }[ControlId];
export type AnalogId = Exclude<ControlId, ButtonId>;

export const BUTTONS: ButtonId[] = [
  'a', 'b', 'x', 'y', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'left_bumper', 'right_bumper',
  'left_stick_button', 'right_stick_button', 'back', 'start', 'guide', 'touchpad',
];
export const STICKS = ['left_stick_x', 'left_stick_y', 'right_stick_x', 'right_stick_y'] as const;
export const TRIGGERS = ['left_trigger', 'right_trigger'] as const;

export function emptyGamepad(): FtcGamepad {
  return {
    a: false, b: false, x: false, y: false,
    dpad_up: false, dpad_down: false, dpad_left: false, dpad_right: false,
    left_bumper: false, right_bumper: false, left_trigger: 0, right_trigger: 0,
    left_stick_x: 0, left_stick_y: 0, right_stick_x: 0, right_stick_y: 0,
    left_stick_button: false, right_stick_button: false,
    back: false, start: false, guide: false, touchpad: false,
  };
}

/** How one FTC control is read from the raw browser Gamepad. */
export type Binding =
  | { kind: 'button'; index: number }
  /** Stick axis; value = sign * axis. */
  | { kind: 'axis'; index: number; sign: 1 | -1 }
  /** Trigger reported as an axis; normalized from `rest` (released) to `full` (pressed). */
  | { kind: 'axisRange'; index: number; rest: number; full: number }
  /** D-pad reported as a POV-hat axis; pressed while the axis is near `value`. */
  | { kind: 'axisValue'; index: number; value: number };

export type Mapping = Partial<Record<ControlId, Binding>>;

/** W3C "standard" gamepad layout — what Chrome/Electron report for PS4, PS5 and F310. */
export const STANDARD_MAPPING: Mapping = {
  a: { kind: 'button', index: 0 },
  b: { kind: 'button', index: 1 },
  x: { kind: 'button', index: 2 },
  y: { kind: 'button', index: 3 },
  left_bumper: { kind: 'button', index: 4 },
  right_bumper: { kind: 'button', index: 5 },
  left_trigger: { kind: 'button', index: 6 },
  right_trigger: { kind: 'button', index: 7 },
  back: { kind: 'button', index: 8 },
  start: { kind: 'button', index: 9 },
  left_stick_button: { kind: 'button', index: 10 },
  right_stick_button: { kind: 'button', index: 11 },
  dpad_up: { kind: 'button', index: 12 },
  dpad_down: { kind: 'button', index: 13 },
  dpad_left: { kind: 'button', index: 14 },
  dpad_right: { kind: 'button', index: 15 },
  guide: { kind: 'button', index: 16 },
  touchpad: { kind: 'button', index: 17 },
  left_stick_x: { kind: 'axis', index: 0, sign: 1 },
  left_stick_y: { kind: 'axis', index: 1, sign: 1 },
  right_stick_x: { kind: 'axis', index: 2, sign: 1 },
  right_stick_y: { kind: 'axis', index: 3, sign: 1 },
};

const SONY = '054c';
const LOGITECH = '046d';
const PS5_PRODUCTS = ['0ce6', '0df2']; // DualSense, DualSense Edge
const F310_PRODUCTS = ['c216', 'c21d']; // D (DirectInput) mode, X (XInput) mode

/** Extracts USB vendor/product ids from a browser gamepad id string. */
export function parseIds(id: string): { vendor?: string; product?: string } {
  // Chrome / Electron: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
  let m = id.match(/Vendor:\s*([0-9a-f]{1,4})\s*Product:\s*([0-9a-f]{1,4})/i);
  // Firefox / Safari: "54c-ce6-DualSense Wireless Controller"
  if (!m) m = id.match(/^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i);
  if (!m) return {};
  return { vendor: m[1].toLowerCase().padStart(4, '0'), product: m[2].toLowerCase().padStart(4, '0') };
}

export function detectModel(id: string): PadModel {
  const { vendor, product } = parseIds(id);
  if (vendor === SONY) return product && PS5_PRODUCTS.includes(product) ? 'ps5' : 'ps4';
  if (vendor === LOGITECH && product && F310_PRODUCTS.includes(product)) return 'f310';
  if (vendor) return 'unsupported';
  // Some browsers give only a name.
  if (/dualsense/i.test(id)) return 'ps5';
  if (/dualshock|wireless controller/i.test(id)) return 'ps4';
  if (/f310|dual action/i.test(id)) return 'f310';
  return 'unsupported';
}

export const MODEL_NAMES: Record<PadModel, string> = {
  ps4: 'PS4 DualShock 4',
  ps5: 'PS5 DualSense',
  f310: 'Logitech F310',
  keyboard: 'Клавиатура',
  unsupported: 'Неподдерживаемый геймпад',
};

/** Raw state the mapping reads from; matches the shape of the browser `Gamepad`. */
export interface RawPad {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function readAnalog(raw: RawPad, b: Binding | undefined): number {
  if (!b) return 0;
  switch (b.kind) {
    case 'button': {
      const btn = raw.buttons[b.index];
      return btn ? Math.max(btn.value, btn.pressed ? 1 : 0) : 0;
    }
    case 'axis':
      return clamp((raw.axes[b.index] ?? 0) * b.sign, -1, 1);
    case 'axisRange': {
      const span = b.full - b.rest;
      return span === 0 ? 0 : clamp(((raw.axes[b.index] ?? b.rest) - b.rest) / span, 0, 1);
    }
    case 'axisValue':
      return Math.abs((raw.axes[b.index] ?? 99) - b.value) < 0.1 ? 1 : 0;
  }
}

/** Radial deadzone, rescaled so the output still reaches 1 at full deflection. */
export function applyDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < deadzone) return [0, 0];
  const scale = Math.min(1, (mag - deadzone) / (1 - deadzone)) / mag;
  return [x * scale, y * scale];
}

export const STICK_DEADZONE = 0.06;

export function readGamepad(raw: RawPad, mapping: Mapping, out: FtcGamepad = emptyGamepad()): FtcGamepad {
  for (const id of BUTTONS) out[id] = readAnalog(raw, mapping[id]) > 0.5;
  out.left_trigger = readAnalog(raw, mapping.left_trigger);
  out.right_trigger = readAnalog(raw, mapping.right_trigger);
  [out.left_stick_x, out.left_stick_y] = applyDeadzone(
    readAnalog(raw, mapping.left_stick_x), readAnalog(raw, mapping.left_stick_y), STICK_DEADZONE);
  [out.right_stick_x, out.right_stick_y] = applyDeadzone(
    readAnalog(raw, mapping.right_stick_x), readAnalog(raw, mapping.right_stick_y), STICK_DEADZONE);
  return out;
}

/** Combines two gamepads (e.g. keyboard + controller): buttons OR-ed, analog takes the larger magnitude. */
export function mergeGamepads(into: FtcGamepad, other: FtcGamepad): FtcGamepad {
  for (const id of BUTTONS) into[id] = into[id] || other[id];
  for (const id of [...STICKS, ...TRIGGERS]) {
    if (Math.abs(other[id]) > Math.abs(into[id])) into[id] = other[id];
  }
  return into;
}
