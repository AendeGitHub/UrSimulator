// High score tables: the top 100 solo match scores for each robot, one line per player.

import { fetchRecords, type RecordEntry } from '../net/records';
import { cleanName } from '../net/protocol';
import { ROBOTS, robotById } from '../robot/robots';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface RecordsContext {
  /** Game server address (the records live next to the online rooms) */
  server(): string;
  /** The player's name as saved in the settings */
  name(): string;
  rename(name: string): void;
  back(): void;
}

export class RecordsScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly tabs = h('div', { class: 'records-tabs' });
  private readonly body = h('div', { class: 'records-body' });
  private readonly nameInput: HTMLInputElement;
  private robot = ROBOTS[0].id;
  /** Ignores answers to requests made before the latest one. */
  private request = 0;

  constructor(private readonly ctx: RecordsContext) {
    this.nameInput = h('input', { class: 'field', maxlength: '16', placeholder: 'Например: Max' });
    this.nameInput.addEventListener('change', () => {
      const name = this.nameInput.value.trim() ? cleanName(this.nameInput.value) : '';
      this.nameInput.value = name;
      ctx.rename(name);
      this.load();
    });
    this.el = h('div', { class: 'screen menu-records' },
      h('h2', {}, 'Рекорды'),
      h('p', { class: 'muted' }, 'Лучшие результаты одиночных матчей 2:30 — топ 100 для каждого робота. У каждого игрока одна строчка: его лучший счёт.'),
      this.tabs,
      h('label', { class: 'field-label records-name' }, 'Твоё имя в таблице', this.nameInput),
      this.body,
      h('div', { class: 'menu-buttons' }, h('button', { class: 'btn btn-ghost', onclick: ctx.back }, 'Назад')),
    );
    this.nav = new MenuNav(this.el, ctx.back);
  }

  /** Opens on the given robot's table. */
  open(robot: string): void {
    this.robot = robotById(robot).id;
  }

  onShow(): void {
    this.nameInput.value = this.ctx.name();
    this.renderTabs();
    this.load();
  }

  private renderTabs(): void {
    this.tabs.replaceChildren(...ROBOTS.map(r => h('button', {
      class: `btn btn-small records-tab ${r.id === this.robot ? 'records-tab-on' : ''}`,
      onclick: () => {
        this.robot = r.id;
        this.renderTabs();
        this.load();
      },
    }, h('img', { src: r.teamLogo, alt: '' }), `${r.team} · ${r.name}`)));
  }

  private async load(): Promise<void> {
    const id = ++this.request;
    this.body.replaceChildren(h('p', { class: 'muted' }, 'Загрузка…'));
    let entries: RecordEntry[];
    try {
      entries = await fetchRecords(this.ctx.server(), this.robot);
    } catch {
      if (id === this.request) this.body.replaceChildren(h('p', { class: 'warn' }, 'Сервер рекордов недоступен. Попробуй позже.'));
      return;
    }
    if (id !== this.request) return;
    if (!entries.length) {
      this.body.replaceChildren(h('p', { class: 'muted' }, 'Пока пусто — сыграй «Матч 2:30» и стань первым!'));
      return;
    }
    const me = this.ctx.name().toLowerCase();
    const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');
    this.body.replaceChildren(h('div', { class: 'panel records-table-wrap' },
      h('table', { class: 'records-table' },
        h('tr', {}, h('th', {}, '#'), h('th', {}, 'Игрок'), h('th', { class: 'num' }, 'Очки'), h('th', { class: 'num' }, 'Дата')),
        ...entries.map((e, i) => h('tr', { class: e.name.toLowerCase() === me ? 'records-me' : '' },
          h('td', { class: 'records-place' }, String(i + 1)),
          h('td', {}, e.name),
          h('td', { class: 'num' }, String(e.score)),
          h('td', { class: 'num muted' }, date(e.date)))))));
  }
}
