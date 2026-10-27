// Which controller button and which key does what. Players change both in Settings → Controls;
// the sticks always drive (left: move, right: turn), as on an FTC Driver Station.

import { t } from '../ui/i18n';
import type { ControlId } from './gamepad';

export type ActionId = 'intake' | 'eject' | 'transfer' | 'shooterOn' | 'shooterOff' | 'armUp' | 'armDown' | 'slow' | 'fieldCentric' | 'imuReset' | 'camera' | 'pause';
/** Keyboard stand-ins for the sticks */
export type MoveId = 'forward' | 'backward' | 'left' | 'right' | 'turnLeft' | 'turnRight';

export const ACTIONS: ActionId[] = ['intake', 'eject', 'transfer', 'shooterOn', 'shooterOff', 'armUp', 'armDown', 'slow', 'fieldCentric', 'imuReset', 'camera', 'pause'];
export const MOVES: MoveId[] = ['forward', 'backward', 'left', 'right', 'turnLeft', 'turnRight'];
/** Mechanisms listen to gamepad1 and gamepad2, as in FTC; the rest is the driver's (gamepad1). */
export const MECHANISM_ACTIONS = new Set<ActionId>(['intake', 'eject', 'transfer', 'shooterOn', 'shooterOff', 'armUp', 'armDown']);

/** What an action is called in Settings → Controls, in the interface language (ui/i18n.ts). */
export const actionName = (id: ActionId | MoveId): string => t(`action.${id}`);

export interface Bindings {
  /** Controller button or trigger for each action */
  pad: Record<ActionId, ControlId>;
  /** Keyboard key (KeyboardEvent.code) for each action and stick direction */
  keys: Record<ActionId | MoveId, string>;
}

export const DEFAULT_BINDINGS: Bindings = {
  pad: {
    intake: 'left_bumper',
    eject: 'dpad_down',
    transfer: 'right_bumper',
    shooterOn: 'left_trigger',
    shooterOff: 'right_trigger',
    // Triangle / cross on PlayStation pads
    armUp: 'y',
    armDown: 'a',
    slow: 'left_stick_button',
    fieldCentric: 'back',
    imuReset: 'start',
    camera: 'right_stick_button',
    pause: 'guide',
  },
  keys: {
    forward: 'KeyW',
    backward: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    turnLeft: 'KeyQ',
    turnRight: 'KeyE',
    intake: 'KeyF',
    eject: 'KeyK',
    transfer: 'Space',
    shooterOn: 'KeyZ',
    shooterOff: 'KeyV',
    armUp: 'KeyY',
    armDown: 'KeyX',
    slow: 'ShiftLeft',
    fieldCentric: 'Tab',
    imuReset: 'Enter',
    camera: 'KeyC',
    pause: 'Escape',
  },
};

/** Saved bindings with anything missing (e.g. an action added later) taken from the defaults. */
export function withDefaults(saved: Partial<Bindings> | undefined): Bindings {
  return {
    pad: { ...DEFAULT_BINDINGS.pad, ...saved?.pad },
    keys: { ...DEFAULT_BINDINGS.keys, ...saved?.keys },
  };
}

/**
 * Binds `action` to `value`; an action that already used it takes the old binding instead, so
 * no two actions share a button.
 */
export function rebind<K extends 'pad' | 'keys'>(bindings: Bindings, kind: K, action: keyof Bindings[K], value: string): Bindings {
  const table = { ...bindings[kind] } as Record<string, string>;
  const old = table[action as string];
  for (const [other, v] of Object.entries(table)) if (v === value && other !== action) table[other] = old;
  table[action as string] = value;
  return { ...bindings, [kind]: table };
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: '⌫',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift →',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl →',
  AltLeft: 'Alt',
  AltRight: 'Alt →',
  MetaLeft: '⌘',
  MetaRight: '⌘ →',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  CapsLock: 'Caps',
};

/** Short name of a key for the screen: "KeyF" → "F", "Digit1" → "1". */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
