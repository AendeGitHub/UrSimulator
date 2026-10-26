// Main menu, pause menu and controls help.

import type { ControlId, PadModel } from '../input/gamepad';
import { MODEL_NAMES } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { h } from './dom';
import { keyChip } from './Hud';
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
  gamepads(): void;
  help(): void;
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
        h('p', { class: 'menu-legal' }, 'Неофициальный фанатский симулятор. Не связан с FIRST®. BIOBUZZ™ — товарный знак FIRST.')),
    );
    this.nav = new MenuNav(this.el, () => this.page === 'play' && this.open('root'));
    this.open('root');
  }

  /** "Играть" opens a sub-list in place, like MoSim's Play menu. */
  private open(page: 'root' | 'play'): void {
    this.page = page;
    const a = this.actions;
    this.list.replaceChildren(...(page === 'root'
      ? [item('Играть', () => this.open('play')), item('Онлайн 2 на 2', a.online), item('Рекорды', a.records), item('Геймпады', a.gamepads), item('Управление', a.help)]
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
  gamepads(): void;
  help(): void;
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
        item('Геймпады', () => actions.gamepads()),
        item('Управление', () => actions.help()),
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

const CONTROLS: [ControlId, string][] = [
  ['left_stick_y', 'Езда вперёд / назад и вбок (левый стик)'],
  ['right_stick_x', 'Поворот (правый стик)'],
  ['left_bumper', 'Захват: забрать мячи спереди (держать, до 4)'],
  ['dpad_down', 'Выкинуть мячи обратно (держать)'],
  ['left_trigger', 'Шутер включить'],
  ['right_trigger', 'Шутер выключить (маховик садит аккумулятор)'],
  ['right_bumper', 'Трансфер: мячи в шутер (держать); интейк тоже крутится и подбирает мячи прямо в шутер'],
  ['left_stick_button', 'Медленный режим вкл / выкл'],
  ['back', 'Field-centric ↔ Robot-centric'],
  ['start', 'Сброс курса (IMU) для field-centric'],
  ['right_stick_button', 'Камера «За роботом»: смотреть вперёд / назад'],
  ['guide', 'Пауза'],
];

export class HelpScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-help' });
  readonly nav: MenuNav;
  private model: PadModel | null = null;

  constructor(private readonly input: InputManager, private readonly back: () => void) {
    this.nav = new MenuNav(this.el, back);
  }

  onShow(): void {
    this.model = null;
    this.update();
  }

  update(): void {
    const model = this.input.model1;
    if (model === this.model) return;
    this.model = model;
    const rows = (m: PadModel) => CONTROLS.map(([c, text]) =>
      h('tr', {}, h('td', {}, keyChip(m, c), c === 'right_stick_button' && (m === 'ps4' || m === 'ps5') ? keyChip(m, 'touchpad') : ''), h('td', {}, text)));
    this.el.replaceChildren(
      h('h2', {}, 'Управление'),
      h('div', { class: 'help-cols' },
        model !== 'keyboard'
          ? h('div', { class: 'panel' }, h('h3', {}, MODEL_NAMES[model]), h('table', { class: 'controls' }, ...rows(model)))
          : '',
        h('div', { class: 'panel' }, h('h3', {}, 'Клавиатура'), h('table', { class: 'controls' }, ...rows('keyboard'),
          h('tr', {}, h('td', {}, h('span', { class: 'key' }, 'R')), h('td', {}, 'Сбросить робота на старт'))))),
      h('p', { class: 'muted' }, 'Турель сама наводится на верхнюю ячейку своего улья и подбирает скорость. Твоя задача — встать там, куда смотрит отверстие ячейки. ',
        'Механизмы слушаются и gamepad1, и gamepad2 — можно играть вдвоём, как в FTC.'),
      h('div', { class: 'menu-buttons' }, h('button', { class: 'btn btn-secondary', onclick: this.back }, 'Назад')),
    );
  }
}
