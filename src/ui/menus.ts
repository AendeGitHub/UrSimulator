// Main menu and pause menu.

import { MODEL_NAMES } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { h } from './dom';
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
  online(): void;
  records(): void;
  settings(): void;
}

/** A big white menu entry, outlined when focused (MoSim style). */
function item(text: string, onclick: () => void): HTMLButtonElement {
  return h('button', { class: 'btn menu-item', onclick }, text);
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
        h('p', { class: 'menu-legal' }, `UrSim v${__APP_VERSION__} · Неофициальный фанатский симулятор. Не связан с FIRST®. BIOBUZZ™ — товарный знак FIRST.`)),
    );
    this.nav = new MenuNav(this.el, () => this.page === 'play' && this.open('root'));
    this.open('root');
  }

  /** "Играть" opens a sub-list in place, like MoSim's Play menu. */
  private open(page: 'root' | 'play'): void {
    this.page = page;
    const a = this.actions;
    this.list.replaceChildren(...(page === 'root'
      ? [item('Играть', () => this.open('play')), item('Онлайн 2 на 2', a.online), item('Рекорды', a.records), item('Настройки', a.settings)]
      : [h('div', { class: 'menu-heading' }, 'Играть'), item('Матч 2:30', a.match), item('Тренировка', a.practice), item('Назад', () => this.open('root'))]));
    this.nav.focusFirst();
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
      p1 ? `gamepad1: ${MODEL_NAMES[p1.model]}` : 'Геймпад не найден — нажми любую кнопку на геймпаде или играй с клавиатуры',
      p2 ? h('span', { class: 'muted' }, ` · gamepad2: ${MODEL_NAMES[p2.model]}`) : '',
      unsupported ? h('div', { class: 'warn' }, 'Есть неподдерживаемый геймпад. Подходят только PS4, PS5 и Logitech F310.') : '',
    );
  }
}

export interface PauseActions {
  resume(): void;
  resetRobot(): void;
  settings(): void;
  /** Host only: everyone back to the room lobby */
  stopOnline(): void;
  exit(): void;
}

export class PauseMenu implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly title = h('div', { class: 'menu-heading' }, 'Пауза');
  private readonly reset: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly exit: HTMLButtonElement;

  constructor(actions: PauseActions) {
    this.reset = item('Начать заново', () => actions.resetRobot());
    this.stop = item('Вернуть всех в лобби', () => actions.stopOnline());
    this.exit = item('В главное меню', () => actions.exit());
    this.el = h('div', { class: 'screen menu-pause' },
      h('div', { class: 'menu-list' },
        this.title,
        item('Продолжить', () => actions.resume()),
        this.reset,
        this.stop,
        item('Настройки', () => actions.settings()),
        this.exit,
      ),
    );
    this.nav = new MenuNav(this.el, actions.resume);
  }

  /** Online games keep running behind the menu and cannot be restarted by guests. */
  configure(online: boolean, host: boolean): void {
    this.title.textContent = online ? 'Меню · игра идёт' : 'Пауза';
    this.reset.hidden = online;
    this.stop.hidden = !(online && host);
    this.exit.textContent = online ? 'Выйти из комнаты' : 'В главное меню';
  }
}
