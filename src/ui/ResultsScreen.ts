// End-of-match results: final score, point breakdown and ranking points.

import { RP_THRESHOLDS, breakdown, rankingPoints, total, type AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface ResultsActions {
  again(): void;
  practice(): void;
  menu(): void;
}

export class ResultsScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-results' });
  readonly nav: MenuNav;

  constructor(private readonly actions: ResultsActions) {
    this.nav = new MenuNav(this.el, actions.menu);
  }

  show(score: Record<Alliance, AllianceScore>, mine: Alliance, online: boolean): void {
    const red = total(score.red);
    const blue = total(score.blue);
    const result = red === blue ? 'Ничья' : (red > blue) === (mine === 'red') ? 'Победа!' : 'Поражение';
    const rows = breakdown(score[mine]).filter(r => r.count > 0);
    const rp = rankingPoints(score[mine]);
    const chip = (ok: boolean, text: string) => h('span', { class: `chip ${ok ? 'chip-ok' : ''}` }, `${ok ? '✓' : '✗'} ${text}`);
    this.el.replaceChildren(
      h('h2', {}, `Матч окончен · ${result}`),
      h('div', { class: 'final-score' },
        h('div', { class: `score score-red ${mine === 'red' ? 'mine' : ''}` }, String(red)),
        h('div', { class: 'muted' }, ':'),
        h('div', { class: `score score-blue ${mine === 'blue' ? 'mine' : ''}` }, String(blue))),
      h('div', { class: 'panel results-table' },
        h('h3', {}, mine === 'red' ? 'Твой альянс — красный' : 'Твой альянс — синий'),
        rows.length
          ? h('table', { class: 'controls' }, ...rows.map(r => h('tr', {}, h('td', {}, r.label), h('td', { class: 'num' }, `×${r.count}`), h('td', { class: 'num' }, `+${r.points}`))))
          : h('p', { class: 'muted' }, 'Очков нет — попробуй перевернуть улей!'),
        h('div', { class: 'row rp' },
          chip(rp.pollinator1, `POLLINATOR 1 (${RP_THRESHOLDS.pollinator1} переворота)`),
          chip(rp.pollinator2, `POLLINATOR 2 (${RP_THRESHOLDS.pollinator2} переворотов)`),
          chip(rp.swarm, `SWARM (LEAVE + PARK ≥ ${RP_THRESHOLDS.swarm})`))),
      online
        ? h('div', { class: 'menu-buttons' },
          h('button', { class: 'btn btn-primary', onclick: this.actions.again }, 'В лобби комнаты'),
          h('button', { class: 'btn btn-ghost', onclick: this.actions.menu }, 'Выйти из комнаты'))
        : h('div', { class: 'menu-buttons' },
          h('button', { class: 'btn btn-primary', onclick: this.actions.again }, 'Ещё матч'),
          h('button', { class: 'btn btn-secondary', onclick: this.actions.practice }, 'Тренировка'),
          h('button', { class: 'btn btn-ghost', onclick: this.actions.menu }, 'В главное меню')),
    );
  }
}
