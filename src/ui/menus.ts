// Main menu and pause menu.

import { modelName } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { h } from './dom';
import { ht, t, type TextKey } from './i18n';
import { MenuNav } from './MenuNav';

export interface Screen {
  el: HTMLElement;
  nav: MenuNav;
  /** Called every frame while the screen is shown. */
  update?(input: InputManager): void;
  onShow?(): void;
  /** True while the screen reads the controller itself (e.g. button assignment). */
  readonly blocksNav?: boolean;
}

export interface MainMenuActions {
  match(): void;
  practice(): void;
  records(): void;
  settings(): void;
}

/** A big white menu entry, outlined when focused (MoSim style). */
function item(key: TextKey, onclick: () => void): HTMLButtonElement {
  return ht('button', { class: 'btn menu-item', onclick }, key);
}

export class MainMenu implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly list = h('div', { class: 'menu-list' });
  private readonly pads = h('div', { class: 'pad-status' });
  private padKey = '';
  private page: 'root' | 'play' = 'root';

  constructor(private readonly actions: MainMenuActions) {
    this.el = h('div', { class: 'screen menu-main' },
      h('img', { src: 'assets/logo.svg', alt: 'UrSim', class: 'menu-logo' }),
      h('img', { src: 'assets/biobuzz.webp', alt: 'FIRST Tech Challenge · BIOBUZZ', class: 'menu-season' }),
      this.list,
      h('div', { class: 'menu-foot' },
        this.pads,
        h('p', { class: 'menu-legal' }, `UrSim v${__APP_VERSION__} · `, ht('span', {}, 'menu.legal'))),
    );
    this.nav = new MenuNav(this.el, () => this.page === 'play' && this.open('root'));
    this.open('root');
  }

  /** "Play" opens a sub-list in place, like MoSim's Play menu. */
  private open(page: 'root' | 'play'): void {
    this.page = page;
    const a = this.actions;
    this.list.replaceChildren(...(page === 'root'
      ? [item('menu.play', () => this.open('play')), item('menu.records', a.records), item('menu.settings', a.settings)]
      : [ht('div', { class: 'menu-heading' }, 'menu.play'), item('menu.match', a.match), item('menu.practice', a.practice), item('common.back', () => this.open('root'))]));
    this.nav.focusFirst();
  }

  /** Redraws the controller line too, in case the language changed in the settings. */
  onShow(): void {
    this.padKey = '';
  }

  update(input: InputManager): void {
    const p1 = input.slotInfo(0);
    const p2 = input.slotInfo(1);
    const key = `${p1?.model}|${p2?.model}|${input.pads.length}`;
    if (key === this.padKey) return;
    this.padKey = key;
    const unsupported = input.pads.filter(p => p.model === 'unsupported').length;
    this.pads.replaceChildren(
      h('span', { class: `dot ${p1 ? 'dot-on' : 'dot-off'}` }),
      p1 ? `gamepad1: ${modelName(p1.model)}` : t('menu.noPad'),
      p2 ? h('span', { class: 'muted' }, ` · gamepad2: ${modelName(p2.model)}`) : '',
      unsupported ? h('div', { class: 'warn' }, t('menu.unsupportedPad')) : '',
    );
  }
}

export interface PauseActions {
  resume(): void;
  resetRobot(): void;
  settings(): void;
  exit(): void;
}

export class PauseMenu implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;

  constructor(actions: PauseActions) {
    this.el = h('div', { class: 'screen menu-pause' },
      h('div', { class: 'menu-list' },
        ht('div', { class: 'menu-heading' }, 'pause.title'),
        item('pause.resume', () => actions.resume()),
        item('pause.restart', () => actions.resetRobot()),
        item('menu.settings', () => actions.settings()),
        item('pause.toMenu', () => actions.exit()),
      ),
    );
    this.nav = new MenuNav(this.el, actions.resume);
  }
}
