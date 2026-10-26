// Controller setup: which pad is gamepad1/gamepad2, live button tester, button assignment wizard.

import { MODEL_NAMES, type ControlId, type PadModel } from '../input/gamepad';
import type { InputManager, PadInfo } from '../input/InputManager';
import { CONTROL_DESCRIPTIONS, controlLabel } from '../input/labels';
import { RemapWizard } from '../input/remap';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

const TESTER_BUTTONS: ControlId[] = [
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'y', 'b', 'a', 'x',
  'left_bumper', 'right_bumper', 'back', 'start', 'left_stick_button', 'right_stick_button', 'guide', 'touchpad',
];

export class GamepadScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-pads' });
  readonly nav: MenuNav;
  private readonly body = h('div', { class: 'pads-body' });
  private layoutKey = '';
  private wizard: { pad: PadInfo; wizard: RemapWizard } | null = null;
  private tester: { slot: 0 | 1; cells: Map<ControlId, HTMLElement>; sticks: HTMLElement[]; triggers: HTMLElement[] } | null = null;

  constructor(private readonly input: InputManager, private readonly back: () => void) {
    this.el.append(
      h('h2', {}, 'Геймпады'),
      h('p', { class: 'muted' }, 'Поддерживаются PS4 DualShock 4, PS5 DualSense и Logitech F310 — как на FTC Driver Station. ',
        'У F310 сзади есть переключатель: «X» на Windows, «D» на Mac.'),
      this.body,
    );
    this.nav = new MenuNav(this.el, () => this.goBack());
  }

  private goBack(): void {
    if (this.wizard) {
      this.wizard = null;
      this.layoutKey = '';
      return;
    }
    this.back();
  }

  onShow(): void {
    this.layoutKey = '';
    this.wizard = null;
  }

  /** While assigning buttons, controller presses must not drive the menu. */
  get blocksNav(): boolean {
    return this.wizard !== null;
  }

  update(input: InputManager): void {
    if (this.wizard) return this.updateWizard();
    const key = JSON.stringify([input.slots, input.pads.map(p => [p.index, p.model, !!p.mapping, p.customMapping])]);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.render();
    }
    this.updateTester();
  }

  private render(): void {
    const input = this.input;
    const slotCard = (slot: 0 | 1) => {
      const info = input.slotInfo(slot);
      const name = `gamepad${slot + 1}`;
      if (!info) return h('div', { class: 'panel pad-card' }, h('h3', {}, name), h('p', { class: 'muted' }, 'Не подключён'));
      const status = info.mapping ? (info.customMapping ? 'Готов · свои настройки кнопок' : 'Готов') : 'Нужно настроить кнопки';
      return h('div', { class: 'panel pad-card' },
        h('h3', {}, name, h('span', { class: 'muted' }, ` · ${MODEL_NAMES[info.model]}`)),
        h('p', { class: info.mapping ? 'ok' : 'warn' }, status),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-small', onclick: () => this.startWizard(info) }, 'Настроить кнопки'),
          info.customMapping ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => { input.resetMapping(info.id); this.layoutKey = ''; } }, 'Сбросить') : '',
        ),
      );
    };
    const unsupported = input.pads.filter(p => p.model === 'unsupported');
    this.body.replaceChildren(
      h('div', { class: 'pad-cards' }, slotCard(0), slotCard(1)),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-secondary', onclick: () => { input.swapSlots(); this.layoutKey = ''; } }, 'Поменять gamepad1 ↔ gamepad2'),
        h('button', { class: 'btn btn-secondary', onclick: () => this.goBack() }, 'Назад'),
      ),
      ...unsupported.map(p => h('p', { class: 'warn' }, `Не поддерживается: ${p.id}`)),
      this.buildTester(),
    );
  }

  private buildTester(): HTMLElement {
    const slot: 0 | 1 = this.input.slotInfo(0) ? 0 : 1;
    const info = this.input.slotInfo(slot);
    if (!info?.mapping) {
      this.tester = null;
      return h('p', { class: 'muted' }, 'Подключи геймпад и нажми любую кнопку — здесь появится проверка кнопок.');
    }
    const model: PadModel = info.model;
    const cells = new Map<ControlId, HTMLElement>();
    for (const c of TESTER_BUTTONS) {
      if (c === 'touchpad' && model === 'f310') continue;
      const label = controlLabel(model, c);
      cells.set(c, h('div', { class: 'tester-btn', style: label.color ? { color: label.color } : undefined }, label.text));
    }
    const stick = () => h('div', { class: 'tester-stick' }, h('div', { class: 'tester-dot' }));
    const trigger = (c: ControlId) => h('div', { class: 'tester-trigger' }, h('span', {}, controlLabel(model, c).text), h('div', { class: 'tester-fill' }));
    const sticks = [stick(), stick()];
    const triggers = [trigger('left_trigger'), trigger('right_trigger')];
    this.tester = { slot, cells, sticks, triggers };
    return h('div', { class: 'panel tester' },
      h('h3', {}, `Проверка: gamepad${slot + 1}`),
      h('div', { class: 'tester-row' }, triggers[0], sticks[0], h('div', { class: 'tester-grid' }, ...cells.values()), sticks[1], triggers[1]),
    );
  }

  private updateTester(): void {
    if (!this.tester) return;
    const pad = this.tester.slot === 0 ? this.input.gamepad1 : this.input.gamepad2;
    for (const [c, el] of this.tester.cells) el.classList.toggle('on', !!pad[c]);
    const sticks: [number, number][] = [[pad.left_stick_x, pad.left_stick_y], [pad.right_stick_x, pad.right_stick_y]];
    sticks.forEach(([x, y], i) => {
      (this.tester!.sticks[i].firstChild as HTMLElement).style.transform = `translate(${x * 26}px, ${y * 26}px)`;
    });
    [pad.left_trigger, pad.right_trigger].forEach((v, i) => {
      (this.tester!.triggers[i].lastChild as HTMLElement).style.height = `${v * 100}%`;
    });
  }

  private startWizard(pad: PadInfo): void {
    this.wizard = { pad, wizard: new RemapWizard() };
    this.tester = null;
    this.renderWizard();
  }

  private renderWizard(): void {
    const w = this.wizard!;
    const control = w.wizard.current;
    if (!control) {
      this.input.saveMapping(w.pad.id, w.wizard.mapping);
      this.wizard = null;
      this.layoutKey = '';
      return;
    }
    const label = controlLabel(w.pad.model, control);
    this.body.replaceChildren(
      h('div', { class: 'panel wizard' },
        h('p', { class: 'muted' }, `${MODEL_NAMES[w.pad.model]} · шаг ${w.wizard.index + 1} из ${w.wizard.order.length}`),
        h('p', { class: 'wizard-prompt' }, control.includes('stick_') && !control.endsWith('button') ? 'Отклони ' : 'Нажми ',
          h('span', { class: 'key key-big', style: label.color ? { color: label.color } : undefined }, label.text)),
        h('p', {}, CONTROL_DESCRIPTIONS[control]),
        h('p', { class: 'muted' }, 'Пока идёт настройка, геймпад не управляет меню — используй мышь или клавиатуру.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-secondary', onclick: () => { w.wizard.skip(); this.renderWizard(); } }, 'Пропустить'),
          h('button', { class: 'btn btn-ghost', onclick: () => this.goBack() }, 'Отмена'),
        ),
      ),
    );
  }

  private updateWizard(): void {
    const w = this.wizard!;
    const raw = this.input.rawGamepad(w.pad.index);
    if (!raw) return;
    if (w.wizard.update(raw)) this.renderWizard();
  }
}
