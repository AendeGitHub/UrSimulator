// End-of-match results in the style of the FIRST audience display: alliance panels with teams
// and the winner banner, both scores, and a side-by-side breakdown by period.

import { POINTS, RP_THRESHOLDS, rankingPoints, total, type AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface ResultsActions {
  again(): void;
  practice(): void;
  menu(): void;
}

export interface ResultsTeam {
  name: string;
  logo: string;
}

export interface ResultsInfo {
  score: Record<Alliance, AllianceScore>;
  /** The player's alliance, or null when watching */
  mine: Alliance | null;
  teams: Record<Alliance, ResultsTeam[]>;
  title: string;
  online: boolean;
  /** Set when the player's alliance beat their best solo score */
  highScore: boolean;
}

const NAMES: Record<Alliance, string> = { red: 'КРАСНЫЙ АЛЬЯНС', blue: 'СИНИЙ АЛЬЯНС' };

type Row = { section: string } | { label: string; points: number | string };

/** Points per row of the breakdown, as on the audience display. */
function rows(s: AllianceScore): Row[] {
  const cards = s.redCards ? '🟥' : s.yellowCards ? '🟨' : s.warnings ? '⚠️' : '—';
  return [
    { section: 'АВТОНОМ' },
    { label: 'LEAVE', points: s.leave * POINTS.leave },
    { label: 'PARK', points: s.autoPark * POINTS.autoPark },
    { label: 'HIVE TIP', points: s.autoTips * POINTS.tip },
    { section: 'TELEOP' },
    { label: 'HIVE TIP', points: s.teleopTips * POINTS.tip },
    { label: 'ЯЧЕЙКА', points: s.field.cellElements * POINTS.cellElement },
    { label: 'ЦВЕТЫ', points: s.field.flowerBottom * POINTS.flowerBottomNectar + s.field.ownedFlowerElements * POINTS.ownedFlowerElement },
    { label: 'GARDEN', points: s.field.gardenElements * POINTS.gardenElement },
    { label: 'PARK', points: s.teleopPark * POINTS.teleopPark },
    { section: 'ШТРАФЫ' },
    { label: 'КАРТОЧКИ', points: cards },
  ];
}

/** Ranking points an alliance earns in a qualification match (manual table 10-2). */
export function matchRp(s: AllianceScore, own: number, other: number): { total: number; items: string[] } {
  const rp = rankingPoints(s);
  const items: string[] = [];
  let sum = Number(rp.swarm) + Number(rp.pollinator1) + Number(rp.pollinator2);
  if (own > other) {
    sum += 3;
    items.push('WIN +3');
  } else if (own === other) {
    sum += 1;
    items.push('TIE +1');
  }
  if (rp.swarm) items.push(`SWARM +1`);
  if (rp.pollinator1) items.push(`POLLINATOR ${RP_THRESHOLDS.pollinator1} +1`);
  if (rp.pollinator2) items.push(`POLLINATOR ${RP_THRESHOLDS.pollinator2} +1`);
  return { total: sum, items };
}

export class ResultsScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-results' });
  readonly nav: MenuNav;

  constructor(private readonly actions: ResultsActions) {
    this.nav = new MenuNav(this.el, actions.menu);
  }

  show(info: ResultsInfo): void {
    const totals = { red: total(info.score.red), blue: total(info.score.blue) };
    const winner: Alliance | null = totals.red === totals.blue ? null : totals.red > totals.blue ? 'red' : 'blue';
    const blueRows = rows(info.score.blue);

    const side = (a: Alliance) => {
      const rp = matchRp(info.score[a], totals[a], totals[a === 'red' ? 'blue' : 'red']);
      const teams = info.teams[a].length ? info.teams[a] : [{ name: '—', logo: '' }];
      return h('div', { class: `rb-side rb-${a}` },
        winner === a ? h('div', { class: 'rb-winner' }, '🏆 ПОБЕДА') : winner === null ? h('div', { class: 'rb-winner rb-tie' }, 'НИЧЬЯ') : h('div', { class: 'rb-winner rb-empty' }, '🏆'),
        info.highScore && info.mine === a ? h('div', { class: 'rb-high' }, '★ РЕКОРД ★') : '',
        info.score[a].redCards ? h('div', { class: 'rb-dq' }, '🟥 ДИСКВАЛИФИКАЦИЯ') : '',
        h('div', { class: 'rb-teams' },
          ...teams.map(t => h('div', { class: 'rb-team' }, t.logo ? h('img', { src: t.logo, alt: '' }) : '', h('span', {}, t.name)))),
        h('div', { class: 'rb-rp' }, h('span', { class: 'rb-rp-total' }, `${rp.total} RP`), ...rp.items.map(i => h('span', { class: 'chip' }, i))),
        info.mine === a ? h('div', { class: 'rb-mine' }, 'ТВОЙ АЛЬЯНС') : '',
      );
    };

    const buttons = info.online
      ? [
        h('button', { class: 'btn btn-primary', onclick: this.actions.again }, 'В лобби комнаты'),
        h('button', { class: 'btn btn-ghost', onclick: this.actions.menu }, 'Выйти из комнаты'),
      ]
      : [
        h('button', { class: 'btn btn-primary', onclick: this.actions.again }, 'Ещё матч'),
        h('button', { class: 'btn btn-secondary', onclick: this.actions.practice }, 'Тренировка'),
        h('button', { class: 'btn btn-ghost', onclick: this.actions.menu }, 'В главное меню'),
      ];

    this.el.replaceChildren(
      h('div', { class: 'rb' },
        h('div', { class: 'rb-header' },
          h('div', { class: 'rb-brand' }, h('img', { src: 'assets/logo.svg', alt: 'UrSim' }), h('span', {}, 'FIRST Tech Challenge · 2026–2027')),
          h('div', { class: 'rb-title' }, info.title),
          h('div', { class: 'rb-game' }, 'BIOBUZZ')),
        h('div', { class: 'rb-body' },
          side('red'),
          h('div', { class: 'rb-center' },
            h('div', { class: 'rb-scores' },
              h('div', { class: 'rb-score rb-score-red' }, h('span', {}, NAMES.red), h('strong', {}, String(totals.red))),
              h('div', { class: 'rb-score rb-score-blue' }, h('span', {}, NAMES.blue), h('strong', {}, String(totals.blue)))),
            h('div', { class: 'rb-table' },
              ...rows(info.score.red).map((r, i) => {
                if ('section' in r) return h('div', { class: 'rb-row rb-section' }, r.section);
                const blue = blueRows[i] as { points: number | string };
                return h('div', { class: 'rb-row' }, h('span', { class: 'rb-num' }, String(r.points)), h('span', { class: 'rb-label' }, r.label), h('span', { class: 'rb-num' }, String(blue.points)));
              }))),
          side('blue')),
        h('div', { class: 'rb-footer' }, h('div', { class: 'row' }, ...buttons), h('span', { class: 'muted' }, 'Результаты матча · UrSim'))),
    );
  }
}
