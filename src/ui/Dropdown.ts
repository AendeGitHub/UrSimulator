// A drop-down list made of buttons, so the controller can pick from it too (MenuNav only moves
// between buttons): the current choice, and under it the list while open.

import { h } from './dom';

export interface Choice<T> {
  value: T;
  label: string;
}

export class Dropdown<T> {
  readonly el: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly list = h('div', { class: 'dd-list', role: 'listbox' });
  private choices: Choice<T>[] = [];
  value!: T;

  constructor(private readonly onChange: (value: T) => void, className = '') {
    this.button = h('button', { class: 'dd-button', 'aria-haspopup': 'listbox', onclick: () => this.toggle() });
    this.el = h('div', { class: `dd ${className}` }, this.button, this.list);
    this.list.hidden = true;
    document.addEventListener('pointerdown', e => {
      if (!this.list.hidden && !this.el.contains(e.target as Node)) this.close();
    });
  }

  /** The choices and the selected one (the first when `value` is not among them). */
  set(choices: Choice<T>[], value: T): void {
    this.choices = choices;
    this.value = choices.some(c => c.value === value) ? value : choices[0]?.value;
    this.button.textContent = choices.find(c => c.value === this.value)?.label ?? '';
    this.close();
  }

  private toggle(): void {
    if (!this.list.hidden) return this.close();
    this.list.replaceChildren(...this.choices.map(c => h('button', {
      class: `dd-item ${c.value === this.value ? 'dd-item-on' : ''}`,
      role: 'option',
      onclick: () => {
        const changed = c.value !== this.value;
        this.set(this.choices, c.value);
        this.button.focus({ preventScroll: true });
        if (changed) this.onChange(c.value);
      },
    }, c.label)));
    this.list.hidden = false;
    this.el.classList.add('dd-open');
    (this.list.querySelector('.dd-item-on') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    this.list.hidden = true;
    this.el.classList.remove('dd-open');
  }
}
