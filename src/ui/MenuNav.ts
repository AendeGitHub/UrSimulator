// Gamepad navigation for menus: d-pad / left stick moves focus, a (✕ / A) clicks, b (○ / B) goes back.

import type { InputManager } from '../input/InputManager';

export class MenuNav {
  constructor(private readonly container: HTMLElement, private readonly onBack?: () => void) {}

  private items(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>('button:not([disabled])')].filter(el => el.offsetParent !== null);
  }

  focusFirst(): void {
    this.items()[0]?.focus({ preventScroll: true });
  }

  update(input: InputManager): void {
    const items = this.items();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const dir = input.menuDirection();
    if (dir === 'up' || dir === 'left' || dir === 'down' || dir === 'right') {
      const step = dir === 'up' || dir === 'left' ? -1 : 1;
      const next = current < 0 ? 0 : (current + step + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }
    if (input.menuPressed('a')) {
      if (current >= 0) items[current].click();
      else items[0].focus({ preventScroll: true });
    }
    if (input.menuPressed('b')) this.onBack?.();
  }
}
