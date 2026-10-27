// High score tables: the top 100 solo match scores for each robot, one line per player.

import { fetchRecords, type RecordEntry } from '../net/records';
import { cleanName } from '../net/protocol';
import { ROBOTS, robotById } from '../robot/robots';
import { h } from './dom';
import { ht, language, t } from './i18n';
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
    this.nameInput = ht('input', { class: 'field', maxlength: '16' }, 'common.namePlaceholder');
    this.nameInput.addEventListener('change', () => {
      const name = this.nameInput.value.trim() ? cleanName(this.nameInput.value) : '';
      this.nameInput.value = name;
      ctx.rename(name);
      this.load();
    });
    this.el = h('div', { class: 'screen menu-records' },
      ht('h2', {}, 'menu.records'),
      ht('p', { class: 'muted' }, 'records.about'),
      this.tabs,
      h('label', { class: 'field-label records-name' }, ht('span', {}, 'records.name'), this.nameInput),
      this.body,
      h('div', { class: 'menu-buttons' }, ht('button', { class: 'btn btn-ghost', onclick: ctx.back }, 'common.back')),
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
    this.body.replaceChildren(h('p', { class: 'muted' }, t('records.loading')));
    let entries: RecordEntry[];
    try {
      entries = await fetchRecords(this.ctx.server(), this.robot);
    } catch {
      if (id === this.request) this.body.replaceChildren(h('p', { class: 'warn' }, t('records.offline')));
      return;
    }
    if (id !== this.request) return;
    if (!entries.length) {
      this.body.replaceChildren(h('p', { class: 'muted' }, t('records.empty')));
      return;
    }
    const me = this.ctx.name().toLowerCase();
    const date = (iso: string) => new Date(iso).toLocaleDateString(language());
    this.body.replaceChildren(h('div', { class: 'panel records-table-wrap' },
      h('table', { class: 'records-table' },
        h('tr', {}, h('th', {}, '#'), h('th', {}, t('common.player')), h('th', { class: 'num' }, t('records.points')), h('th', { class: 'num' }, t('records.date'))),
        ...entries.map((e, i) => h('tr', { class: e.name.toLowerCase() === me ? 'records-me' : '' },
          h('td', { class: 'records-place' }, String(i + 1)),
          h('td', {}, e.name),
          h('td', { class: 'num' }, String(e.score)),
          h('td', { class: 'num muted' }, date(e.date)))))));
  }
}
