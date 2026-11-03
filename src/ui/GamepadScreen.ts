// Controller setup: which pad is gamepad1/gamepad2, live button tester, button assignment wizard.

import { padName, type ControlId, type PadModel } from '../input/gamepad';
import type { InputManager, PadInfo } from '../input/InputManager';
import { LABEL_CHOICES, LABEL_NAMES, controlDescription, controlLabel, hasTouchpad } from '../input/labels';
import { RemapWizard } from '../input/remap';
import { h } from './dom';
import { ht, t } from './i18n';
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
      ht('h2', {}, 'pads.title'),
      ht('p', { class: 'muted' }, 'pads.about'),
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
    const key = JSON.stringify([input.slots, input.pads.map(p => [p.index, p.id, p.model, p.guessed, p.customMapping])]);
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
      if (!info) return h('div', { class: 'panel pad-card' }, h('h3', {}, name), h('p', { class: 'muted' }, t('pads.none')));
      const status = t(info.customMapping ? 'pads.readyCustom' : info.guessed ? 'pads.guessed' : 'pads.ready');
      return h('div', { class: 'panel pad-card' },
        h('h3', {}, name, h('span', { class: 'muted' }, ` · ${padName(info)}`)),
        h('p', { class: info.guessed ? 'warn' : 'ok' }, status),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-small', onclick: () => this.startWizard(info) }, t('pads.setup')),
          info.customMapping ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => { input.resetMapping(info.id); this.layoutKey = ''; } }, t('pads.reset')) : '',
        ),
        // PlayStation names for a REV PS4 gamepad that Windows shows as an Xbox pad, and the like.
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => this.nextLabels(info) },
          t('pads.labels', { names: info.labels ? LABEL_NAMES[info.labels]! : t('pads.labelsAuto') })),
      );
    };
    this.body.replaceChildren(
      h('div', { class: 'pad-cards' }, slotCard(0), slotCard(1)),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-secondary', onclick: () => { input.swapSlots(); this.layoutKey = ''; } }, t('pads.swap')),
        h('button', { class: 'btn btn-secondary', onclick: () => this.goBack() }, t('common.back')),
      ),
      this.buildTester(),
    );
  }

  private nextLabels(pad: PadInfo): void {
    const next = LABEL_CHOICES[(LABEL_CHOICES.indexOf(pad.labels) + 1) % LABEL_CHOICES.length];
    this.input.setLabels(pad.id, next);
    this.layoutKey = '';
  }

  private buildTester(): HTMLElement {
    const slot: 0 | 1 = this.input.slotInfo(0) ? 0 : 1;
    const info = this.input.slotInfo(slot);
    if (!info) {
      this.tester = null;
      return h('p', { class: 'muted' }, t('pads.testerHint'));
    }
    const model: PadModel = info.model;
    const cells = new Map<ControlId, HTMLElement>();
    for (const c of TESTER_BUTTONS) {
      if (c === 'touchpad' && !hasTouchpad(model)) continue;
      const label = controlLabel(model, c);
      cells.set(c, h('div', { class: 'tester-btn', style: label.color ? { color: label.color } : undefined }, label.text));
    }
    const stick = () => h('div', { class: 'tester-stick' }, h('div', { class: 'tester-dot' }));
    const trigger = (c: ControlId) => h('div', { class: 'tester-trigger' }, h('span', {}, controlLabel(model, c).text), h('div', { class: 'tester-fill' }));
    const sticks = [stick(), stick()];
    const triggers = [trigger('left_trigger'), trigger('right_trigger')];
    this.tester = { slot, cells, sticks, triggers };
    return h('div', { class: 'panel tester' },
      h('h3', {}, t('pads.tester', { n: slot + 1 })),
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
        h('p', { class: 'muted' }, t('pads.step', { model: padName(w.pad), step: w.wizard.index + 1, count: w.wizard.order.length })),
        h('p', { class: 'wizard-prompt' }, t(control.includes('stick_') && !control.endsWith('button') ? 'pads.move' : 'pads.press'),
          h('span', { class: 'key key-big', style: label.color ? { color: label.color } : undefined }, label.text)),
        h('p', {}, controlDescription(control)),
        h('p', { class: 'muted' }, t('pads.wizardNote')),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-secondary', onclick: () => { w.wizard.skip(); this.renderWizard(); } }, t('pads.skip')),
          h('button', { class: 'btn btn-ghost', onclick: () => this.goBack() }, t('pads.cancel')),
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
