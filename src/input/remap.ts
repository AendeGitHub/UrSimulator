// Step-by-step button assignment ("press ✕", "move left stick right", ...) for controllers
// whose browser layout is not the standard one (e.g. F310 in D mode in some browsers).

import type { Binding, ControlId, Mapping, RawPad } from './gamepad';

export const REMAP_ORDER: ControlId[] = [
  'a', 'b', 'x', 'y',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
  'left_bumper', 'right_bumper', 'left_trigger', 'right_trigger',
  'back', 'start', 'left_stick_button', 'right_stick_button',
  'left_stick_x', 'left_stick_y', 'right_stick_x', 'right_stick_y',
  'guide', 'touchpad',
];

const PRESS = 0.6;
// POV-hat d-pads move the axis in steps of 2/7 (≈0.29) from the neutral value 9/7, so
// e.g. F310 "left" is only 0.57 away from neutral — axes need a lower threshold than buttons.
const AXIS_PRESS = 0.4;
const BUTTON_RELEASE = 0.3;
const AXIS_RELEASE = 0.2;

const isStick = (c: ControlId) => c.endsWith('_stick_x') || c.endsWith('_stick_y');
const isTrigger = (c: ControlId) => c.endsWith('_trigger');

export class RemapWizard {
  readonly mapping: Mapping = {};
  private step = 0;
  private baseline: { buttons: number[]; axes: number[] } | null = null;
  private waitForRelease = false;

  constructor(readonly order: ControlId[] = REMAP_ORDER) {}

  get current(): ControlId | undefined {
    return this.order[this.step];
  }

  get index(): number {
    return this.step;
  }

  get done(): boolean {
    return this.step >= this.order.length;
  }

  skip(): void {
    if (!this.done) this.step++;
  }

  /** Feed the raw controller state every frame. Returns the control that was just assigned, if any. */
  update(raw: RawPad): ControlId | undefined {
    const buttons = raw.buttons.map(b => Math.max(b.value, b.pressed ? 1 : 0));
    const axes = [...raw.axes];
    // The first frame is taken as "nothing pressed" so triggers resting at -1 are handled.
    if (!this.baseline) {
      this.baseline = { buttons, axes };
      return undefined;
    }
    const base = this.baseline;
    if (this.waitForRelease) {
      const idle = buttons.every((v, i) => v < BUTTON_RELEASE || (base.buttons[i] ?? 0) >= BUTTON_RELEASE)
        && axes.every((v, i) => Math.abs(v - (base.axes[i] ?? 0)) < AXIS_RELEASE);
      if (idle) this.waitForRelease = false;
      return undefined;
    }
    const control = this.current;
    if (!control) return undefined;

    const pressedButton = buttons.findIndex((v, i) => v > PRESS && (base.buttons[i] ?? 0) < BUTTON_RELEASE);
    let movedAxis = -1;
    let bestDelta = AXIS_PRESS;
    axes.forEach((v, i) => {
      const d = Math.abs(v - (base.axes[i] ?? 0));
      if (d > bestDelta) {
        bestDelta = d;
        movedAxis = i;
      }
    });

    let binding: Binding | undefined;
    if (isStick(control)) {
      if (movedAxis >= 0) {
        const delta = axes[movedAxis] - (base.axes[movedAxis] ?? 0);
        const expected = control.endsWith('_x') ? 1 : -1; // FTC: right = +1, up = -1
        binding = { kind: 'axis', index: movedAxis, sign: (expected * Math.sign(delta)) as 1 | -1 };
      }
    } else if (pressedButton >= 0) {
      binding = { kind: 'button', index: pressedButton };
    } else if (movedAxis >= 0) {
      const rest = base.axes[movedAxis] ?? 0;
      const value = axes[movedAxis];
      binding = isTrigger(control)
        ? { kind: 'axisRange', index: movedAxis, rest, full: Math.max(-1, Math.min(1, rest + 2 * Math.sign(value - rest))) }
        : { kind: 'axisValue', index: movedAxis, value: Math.round(value * 100) / 100 };
    }
    if (!binding) return undefined;

    this.mapping[control] = binding;
    this.step++;
    this.waitForRelease = true;
    return control;
  }
}
