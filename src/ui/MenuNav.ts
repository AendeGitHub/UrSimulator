// Gamepad navigation for menus: d-pad / left stick moves focus, a (✕ / A) clicks, b (○ / B) goes back.
// The selected item is only highlighted for controller players (body.pad-nav); with a mouse,
// menus stay plain white text until hovered.

import type { InputManager } from '../input/InputManager';

function setPadNav(on: boolean): void {
  document.body.classList.toggle('pad-nav', on);
}

if (typeof window !== 'undefined') window.addEventListener('pointermove', () => setPadNav(false));

export class MenuNav {
  constructor(private readonly container: HTMLElement, private readonly onBack?: () => void) {}

  private items(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>('button:not([disabled])')].filter(el => el.offsetParent !== null);
  }

  /** Puts the controller cursor on the first item (only while a controller is driving the menus). */
  focusFirst(): void {
    if (document.body.classList.contains('pad-nav')) this.items()[0]?.focus({ preventScroll: true });
  }

  update(input: InputManager): void {
    const dir = input.menuDirection();
    const a = input.menuPressed('a');
    const b = input.menuPressed('b');
    if (!dir && !a && !b) return;
    setPadNav(true);
    const items = this.items();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (dir && items.length) {
      const step = dir === 'up' || dir === 'left' ? -1 : 1;
      const next = current < 0 ? 0 : (current + step + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }
    if (a && items.length) {
      if (current >= 0) items[current].click();
      else items[0].focus({ preventScroll: true });
    }
    if (b) this.onBack?.();
  }
}
