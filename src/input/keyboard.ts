// Keyboard as a virtual FTC gamepad — for testing without a controller.

import { emptyGamepad, type FtcGamepad } from './gamepad';

export class KeyboardPad {
  private readonly down = new Set<string>();
  /** True once any key has been pressed, so the HUD can show keyboard hints. */
  used = false;

  constructor(target: Window = window) {
    target.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement) return;
      this.down.add(e.code);
      this.used = true;
      if (e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', e => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  read(out: FtcGamepad = emptyGamepad()): FtcGamepad {
    const k = (code: string) => this.down.has(code);
    const axis = (neg: boolean, pos: boolean) => (pos ? 1 : 0) - (neg ? 1 : 0);
    out.left_stick_x = axis(k('KeyA'), k('KeyD'));
    out.left_stick_y = axis(k('KeyW'), k('KeyS'));
    out.right_stick_x = axis(k('KeyQ') || k('ArrowLeft'), k('KeyE') || k('ArrowRight'));
    out.right_stick_y = axis(k('ArrowUp'), k('ArrowDown'));
    // Diagonals on a keyboard would be faster than a stick can go.
    const mag = Math.hypot(out.left_stick_x, out.left_stick_y);
    if (mag > 1) {
      out.left_stick_x /= mag;
      out.left_stick_y /= mag;
    }
    out.a = k('Digit1');
    out.b = k('Digit2');
    out.x = k('Digit3');
    out.y = k('Digit4');
    out.dpad_up = k('KeyI');
    out.dpad_down = k('KeyK');
    out.dpad_left = k('KeyJ');
    out.dpad_right = k('KeyL');
    out.left_bumper = k('KeyF');
    out.right_bumper = k('Space');
    out.left_trigger = k('KeyZ') ? 1 : 0;
    out.right_trigger = k('KeyV') ? 1 : 0;
    out.left_stick_button = k('ShiftLeft') || k('ShiftRight');
    out.right_stick_button = k('KeyC');
    out.back = k('Tab');
    out.start = k('Enter');
    out.guide = k('Escape');
    out.touchpad = false;
    return out;
  }
}
