// Online screens: connect (name, server, room code) and the room lobby with the four driver slots.

import { normalizeCode, type RoomInfo } from '../net/protocol';
import { SLOT_NAMES, type Slot } from '../sim/types';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface ConnectActions {
  create(name: string, server: string): void;
  join(name: string, server: string, code: string): void;
  back(): void;
}

export class ConnectScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly name: HTMLInputElement;
  private readonly server: HTMLInputElement;
  private readonly code: HTMLInputElement;
  private readonly status = h('p', { class: 'muted status' });

  constructor(defaults: { name: string; server: string }, actions: ConnectActions) {
    this.name = h('input', { class: 'field', maxlength: '16', placeholder: 'Например: Max', value: defaults.name });
    this.server = h('input', { class: 'field', value: defaults.server, spellcheck: 'false' });
    this.code = h('input', { class: 'field field-code', maxlength: '4', placeholder: 'ABCD', autocapitalize: 'characters' });
    this.code.addEventListener('input', () => (this.code.value = normalizeCode(this.code.value)));
    this.el = h('div', { class: 'screen menu-online' },
      h('h2', {}, 'Онлайн 2 на 2'),
      h('label', { class: 'field-label' }, 'Твоё имя (будет на табличке робота)', this.name),
      h('div', { class: 'online-actions' },
        h('div', { class: 'panel' },
          h('h3', {}, 'Новая комната'),
          h('p', { class: 'muted' }, 'Получишь код из 4 букв и скажешь его друзьям.'),
          h('button', { class: 'btn btn-primary', onclick: () => this.go(() => actions.create(this.nameValue, this.server.value.trim())) }, 'Создать комнату')),
        h('div', { class: 'panel' },
          h('h3', {}, 'Войти по коду'),
          this.code,
          h('button', { class: 'btn btn-secondary', onclick: () => this.join(actions) }, 'Войти'))),
      h('details', { class: 'server-details' }, h('summary', {}, 'Адрес сервера'), this.server,
        h('p', { class: 'muted' }, 'Все игроки должны подключаться к одному серверу.')),
      this.status,
      h('div', { class: 'menu-buttons' }, h('button', { class: 'btn btn-ghost', onclick: actions.back }, 'Назад')),
    );
    this.nav = new MenuNav(this.el, actions.back);
  }

  private get nameValue(): string {
    return this.name.value;
  }

  private join(actions: ConnectActions): void {
    const code = normalizeCode(this.code.value);
    if (code.length !== 4) return this.setStatus('Введи код комнаты из 4 букв', true);
    this.go(() => actions.join(this.nameValue, this.server.value.trim(), code));
  }

  private go(action: () => void): void {
    this.setStatus('Подключение…', false);
    action();
  }

  setStatus(text: string, error: boolean): void {
    this.status.textContent = text;
    this.status.classList.toggle('warn', error);
  }
}

export interface LobbyActions {
  takeSlot(slot: Slot | null): void;
  start(mode: 'match' | 'practice'): void;
  leave(): void;
}

export class LobbyScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-lobby' });
  readonly nav: MenuNav;

  constructor(private readonly actions: LobbyActions) {
    this.nav = new MenuNav(this.el, actions.leave);
  }

  show(room: RoomInfo, myId: number, serverUrl: string): void {
    const me = room.players.find(p => p.id === myId);
    const isHost = room.hostId === myId;
    const card = (slot: Slot) => {
      const p = room.players.find(pl => pl.slot === slot);
      const mine = p?.id === myId;
      return h('button', {
        class: `slot-card slot-${slot.startsWith('red') ? 'red' : 'blue'} ${mine ? 'slot-mine' : ''}`,
        disabled: !!p && !mine,
        onclick: () => !p && this.actions.takeSlot(slot),
      },
      h('span', { class: 'slot-name' }, SLOT_NAMES[slot]),
      h('span', { class: 'slot-player' }, p ? `${p.name}${p.id === room.hostId ? ' ★' : ''}${mine ? ' (ты)' : ''}` : 'Свободно — занять'));
    };
    const watchers = room.players.filter(p => !p.slot);
    this.el.replaceChildren(
      h('h2', {}, 'Комната'),
      h('div', { class: 'room-code' }, room.code),
      h('p', { class: 'muted' }, 'Скажи код друзьям: «Онлайн 2 на 2 → Войти по коду». ', `Сервер: ${serverUrl}`),
      h('div', { class: 'slots' },
        h('div', { class: 'slot-col' }, card('red1'), card('red2')),
        h('div', { class: 'slot-col' }, card('blue1'), card('blue2'))),
      watchers.length ? h('p', { class: 'muted' }, `Смотрят: ${watchers.map(p => p.name).join(', ')}`) : '',
      room.running ? h('p', { class: 'warn' }, 'Идёт игра — ты присоединишься со следующего старта') : '',
      h('div', { class: 'menu-buttons' },
        isHost ? h('button', { class: 'btn btn-primary', onclick: () => this.actions.start('match') }, 'Начать матч 2:30') : '',
        isHost ? h('button', { class: 'btn btn-secondary', onclick: () => this.actions.start('practice') }, 'Тренировка вместе') : '',
        isHost ? '' : h('p', { class: 'muted' }, 'Ждём, пока хост ★ начнёт игру'),
        me?.slot ? h('button', { class: 'btn btn-ghost', onclick: () => this.actions.takeSlot(null) }, 'Смотреть без робота') : '',
        h('button', { class: 'btn btn-ghost', onclick: this.actions.leave }, 'Выйти из комнаты')),
    );
  }
}
