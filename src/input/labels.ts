// On-screen names and colors of controls for each supported controller.

import { t, type TextKey } from '../ui/i18n';
import type { ControlId, PadModel } from './gamepad';

export interface ControlLabel {
  text: string;
  color?: string;
}

const DPAD: Partial<Record<ControlId, ControlLabel>> = {
  dpad_up: { text: '↑' },
  dpad_down: { text: '↓' },
  dpad_left: { text: '←' },
  dpad_right: { text: '→' },
};

const PLAYSTATION: Partial<Record<ControlId, ControlLabel>> = {
  ...DPAD,
  a: { text: '✕', color: '#7aa7ff' },
  b: { text: '○', color: '#ff6b6b' },
  x: { text: '□', color: '#f59ad6' },
  y: { text: '△', color: '#4fd1a5' },
  left_bumper: { text: 'L1' },
  right_bumper: { text: 'R1' },
  left_trigger: { text: 'L2' },
  right_trigger: { text: 'R2' },
  left_stick_button: { text: 'L3' },
  right_stick_button: { text: 'R3' },
  back: { text: 'Share' },
  start: { text: 'Options' },
  guide: { text: 'PS' },
};

const F310: Partial<Record<ControlId, ControlLabel>> = {
  ...DPAD,
  a: { text: 'A', color: '#5fd068' },
  b: { text: 'B', color: '#ff6b6b' },
  x: { text: 'X', color: '#6ea8ff' },
  y: { text: 'Y', color: '#ffd84d' },
  left_bumper: { text: 'LB' },
  right_bumper: { text: 'RB' },
  left_trigger: { text: 'LT' },
  right_trigger: { text: 'RT' },
  left_stick_button: { text: 'L3' },
  right_stick_button: { text: 'R3' },
  back: { text: 'Back' },
  start: { text: 'Start' },
  guide: { text: 'Logitech' },
  touchpad: { text: '—' },
};

/** Controls a controller has no printed name for: named in words, in the interface language. */
const SPOKEN: Partial<Record<ControlId, TextKey>> = {
  touchpad: 'label.touchpad',
  left_stick_x: 'label.leftStick',
  left_stick_y: 'label.leftStick',
  right_stick_x: 'label.rightStick',
  right_stick_y: 'label.rightStick',
};

const KEYBOARD: Partial<Record<ControlId, ControlLabel>> = {
  a: { text: '1' },
  b: { text: '2' },
  x: { text: '3' },
  y: { text: '4' },
  dpad_up: { text: 'I' },
  dpad_down: { text: 'K' },
  dpad_left: { text: 'J' },
  dpad_right: { text: 'L' },
  left_bumper: { text: 'F' },
  right_bumper: { text: 'Space' },
  left_trigger: { text: 'Z' },
  right_trigger: { text: 'V' },
  left_stick_button: { text: 'Shift' },
  right_stick_button: { text: 'C' },
  back: { text: 'Tab' },
  start: { text: 'Enter' },
  guide: { text: 'Esc' },
  touchpad: { text: 'C' },
  left_stick_x: { text: 'A / D' },
  left_stick_y: { text: 'W / S' },
  right_stick_x: { text: 'Q / E' },
  right_stick_y: { text: '↑ / ↓' },
};

export function controlLabel(model: PadModel, control: ControlId): ControlLabel {
  const table = model === 'ps4' || model === 'ps5' ? PLAYSTATION : model === 'f310' ? F310 : KEYBOARD;
  const spoken = SPOKEN[control];
  const label = table[control] ?? { text: spoken ? t(spoken) : control };
  if (model === 'ps5' && control === 'back') return { text: 'Create' };
  return label;
}

/** Human-readable name of an FTC control, used in the remap wizard. */
export const controlDescription = (control: ControlId): string => t(`control.${control}`);
