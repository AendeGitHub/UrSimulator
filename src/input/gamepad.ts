// Gamepad model detection and FTC-style button mapping.
// Every controller plays. The ones an FTC Driver Station takes (PS4, PS5, Logitech F310, Xbox 360) and
// the other big families (Xbox One / Series, Nintendo Switch) get their own button names, and so do
// other makers' pads that call themselves after one (REV's PS4 compatible gamepad, "for Xbox" pads);
// any other pad is called by its own name and shows A B X Y, as most pads print them.

import { t } from '../ui/i18n';

export type PadModel = 'ps4' | 'ps5' | 'f310' | 'xbox360' | 'xbox' | 'switch' | 'generic' | 'keyboard';

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

/** W3C "standard" gamepad layout — what browsers report for nearly every pad they know. */
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
const MICROSOFT = '045e';
const NINTENDO = '057e';
const PS5_PRODUCTS = ['0ce6', '0df2']; // DualSense, DualSense Edge
const F310_PRODUCTS = ['c216', 'c21d']; // D (DirectInput) mode, X (XInput) mode
const XBOX360_PRODUCTS = ['028e', '028f', '0291', '02a1', '0719']; // wired, Play & Charge, wireless receivers

/** Extracts USB vendor/product ids from a browser gamepad id string. */
export function parseIds(id: string): { vendor?: string; product?: string } {
  // Chrome / Electron: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
  let m = id.match(/Vendor:\s*([0-9a-f]{1,4})\s*Product:\s*([0-9a-f]{1,4})/i);
  // Firefox / Safari: "54c-ce6-DualSense Wireless Controller"
  if (!m) m = id.match(/^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i);
  if (!m) return {};
  return { vendor: m[1].toLowerCase().padStart(4, '0'), product: m[2].toLowerCase().padStart(4, '0') };
}

/** A pad's own name, without the browser's additions ("8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 …)", "2dc8-6006-8BitDo Pro 2"). */
function ownName(id: string): string {
  return id
    .replace(/\s*\([^)]*\b(vendor|standard gamepad)\b[^)]*\)\s*$/i, '')
    .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectModel(id: string): PadModel {
  const { vendor, product } = parseIds(id);
  if (vendor === SONY) return product && PS5_PRODUCTS.includes(product) ? 'ps5' : 'ps4';
  if (vendor === LOGITECH && product && F310_PRODUCTS.includes(product)) return 'f310';
  if (vendor === MICROSOFT) return product && XBOX360_PRODUCTS.includes(product) ? 'xbox360' : 'xbox';
  if (vendor === NINTENDO) return 'switch';
  // Otherwise the name: some browsers give nothing else, and other makers' pads name the family they
  // copy. On Windows every XInput pad (an F310 on "X" too, REV's PS4 compatible gamepad, which
  // turns into an Xbox pad on a PC) is "Xbox 360 Controller (XInput STANDARD GAMEPAD)" in Chrome and
  // "xinput" in Firefox. "Wireless Controller" alone is what a DualShock 4 and its copies call themselves.
  if (/xinput|x-?box 360/i.test(id)) return 'xbox360';
  if (/x-?box/i.test(id)) return 'xbox';
  if (/dualsense|ps5/i.test(id)) return 'ps5';
  if (/pro controller|joy-?con|nintendo/i.test(id)) return 'switch';
  if (/dualshock|ps4|playstation/i.test(id) || /^wireless controller$/i.test(ownName(id))) return 'ps4';
  if (/f310|dual action/i.test(id)) return 'f310';
  return 'generic';
}

type Family = Exclude<PadModel, 'generic' | 'keyboard'>;

const MODEL_NAMES: Record<Family, string> = {
  ps4: 'PS4 DualShock 4',
  ps5: 'PS5 DualSense',
  f310: 'Logitech F310',
  xbox360: 'Xbox 360',
  xbox: 'Xbox One / Series',
  switch: 'Nintendo Switch',
};

const FAMILY_VENDORS: Record<Family, string> = {
  ps4: SONY, ps5: SONY, f310: LOGITECH, xbox360: MICROSOFT, xbox: MICROSOFT, switch: NINTENDO,
};

/**
 * What a controller is called on screen, from its id: a family's own pads (or a pad that gives no
 * maker) by the family's name, any other pad by its own name — a PS4-style REV gamepad stays "REV …".
 */
export function padName(pad: { id: string }): string {
  const model = detectModel(pad.id);
  const { vendor } = parseIds(pad.id);
  if (model !== 'generic' && model !== 'keyboard' && (!vendor || vendor === FAMILY_VENDORS[model])) return MODEL_NAMES[model];
  const own = ownName(pad.id);
  if (!own) return model === 'generic' || model === 'keyboard' ? t('pad.generic') : MODEL_NAMES[model];
  return own.length > 32 ? `${own.slice(0, 31)}…` : own;
}

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

/**
 * A PlayStation-style pad in its raw HID layout, as a DualShock 4 copy the browser doesn't know
 * reports itself: L2 and R2 on axes 3 and 4 resting at -1, the right stick on axes 2 and 5.
 */
export function looksLikeDs4(raw: RawPad): boolean {
  const a = raw.axes;
  return raw.buttons.length >= 13 && a.length >= 6 && a[3] < -0.9 && a[4] < -0.9 && Math.abs(a[2]) < 0.5 && Math.abs(a[5]) < 0.5;
}

/** A DualShock 4's own button order: □ ✕ ○ △, then the standard eight, then PS and the touchpad. */
const DS4_BUTTONS: Mapping = {
  x: { kind: 'button', index: 0 },
  a: { kind: 'button', index: 1 },
  b: { kind: 'button', index: 2 },
  y: { kind: 'button', index: 3 },
  guide: { kind: 'button', index: 12 },
  touchpad: { kind: 'button', index: 13 },
};

/**
 * A first guess for a pad the browser has no standard layout for, from how it rests when first seen:
 * buttons in the standard order (a PlayStation-style pad's in the DualShock 4's), the left stick on
 * axes 0 and 1, the right stick on the first two other axes resting in the middle (Z and Rz on most
 * DirectInput pads, Rx and Ry on Xbox-like ones), axes resting at an end as the triggers, and a POV
 * hat (an axis resting at 9/7 in Chrome) as the d-pad. "Set up buttons" puts a wrong guess right.
 */
export function guessMapping(raw: RawPad, playstation = looksLikeDs4(raw)): Mapping {
  const mapping: Mapping = {};
  const buttons = Object.entries({ ...STANDARD_MAPPING, ...(playstation ? DS4_BUTTONS : {}) }) as [ControlId, Binding][];
  for (const [control, binding] of buttons) {
    // A DualShock 4's d-pad is a hat (below), never buttons 12–15: those are PS and the touchpad.
    if (playstation && control.startsWith('dpad_')) continue;
    if (binding.kind === 'button' && binding.index < raw.buttons.length) mapping[control] = binding;
  }
  const rest = [...raw.axes];
  const used = new Set<number>();
  const centered = (i: number) => i < rest.length && !used.has(i) && Math.abs(rest[i]) < 0.5;
  const stick = (x: ControlId, y: ControlId, [ix, iy]: number[]) => {
    mapping[x] = { kind: 'axis', index: ix, sign: 1 };
    mapping[y] = { kind: 'axis', index: iy, sign: 1 };
    used.add(ix).add(iy);
  };
  if (centered(0) && centered(1)) stick('left_stick_x', 'left_stick_y', [0, 1]);
  const right = [2, 5, 3, 4].filter(centered).slice(0, 2);
  if (right.length === 2) stick('right_stick_x', 'right_stick_y', right);
  const hat = rest.findIndex(v => v > 1.1 && v < 1.5);
  if (hat >= 0) {
    used.add(hat);
    // Chrome's hat: up -1, then 2/7 a step clockwise.
    mapping.dpad_up = { kind: 'axisValue', index: hat, value: -1 };
    mapping.dpad_right = { kind: 'axisValue', index: hat, value: -3 / 7 };
    mapping.dpad_down = { kind: 'axisValue', index: hat, value: 1 / 7 };
    mapping.dpad_left = { kind: 'axisValue', index: hat, value: 5 / 7 };
  }
  const triggers = rest.flatMap((v, i) => (!used.has(i) && Math.abs(v) > 0.9 && Math.abs(v) <= 1.01 ? [i] : []));
  if (triggers.length >= 2) {
    const [l, r] = triggers;
    mapping.left_trigger = { kind: 'axisRange', index: l, rest: rest[l], full: -rest[l] };
    mapping.right_trigger = { kind: 'axisRange', index: r, rest: rest[r], full: -rest[r] };
  }
  return mapping;
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
