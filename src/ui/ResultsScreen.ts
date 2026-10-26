// End-of-match results over the whole screen, in the style of the FIRST audience display:
// alliance panels with teams and the winner banner, both scores and a side-by-side breakdown.
// No buttons: R (✕ / A) plays again, Esc (○ / B) goes back to the menu.

import type { PadModel } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { POINTS, total, type AllianceScore } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import { h } from './dom';
import { keyChip } from './Hud';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface ResultsActions {
  /** Solo: the same match again · online: back to the room lobby */
  again(): void;
  /** Solo: main menu · online: leave the room */
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

export class ResultsScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-results' });
  readonly nav: MenuNav;
  private readonly hint = h('div', { class: 'rb-hint' });
  private online = false;
  private model: PadModel | null = null;
  /** R must be pressed after the board appears, not still held from the match. */
  private rWasDown = true;

  constructor(private readonly actions: ResultsActions) {
    this.nav = new MenuNav(this.el, actions.menu);
  }

  update(input: InputManager): void {
    if (input.model1 !== this.model) this.renderHint(input.model1);
    const rDown = input.keyboard.isDown('KeyR');
    const again = (rDown && !this.rWasDown) || input.menuPressed('a');
    this.rWasDown = rDown;
    if (again) this.actions.again();
    else if (input.pressed(1, 'guide')) this.actions.menu();
  }

  private renderHint(model: PadModel): void {
    this.model = model;
    const pad = model !== 'keyboard';
    this.hint.replaceChildren(
      h('span', {}, h('span', { class: 'key' }, 'R'), pad ? keyChip(model, 'a') : '', this.online ? 'в лобби комнаты' : 'ещё раз'),
      h('span', {}, keyChip('keyboard', 'guide'), pad ? keyChip(model, 'b') : '', this.online ? 'выйти из комнаты' : 'в меню'),
    );
  }

  show(info: ResultsInfo): void {
    this.online = info.online;
    this.model = null;
    this.rWasDown = true;
    const totals = { red: total(info.score.red), blue: total(info.score.blue) };
    const winner: Alliance | null = totals.red === totals.blue ? null : totals.red > totals.blue ? 'red' : 'blue';
    const blueRows = rows(info.score.blue);

    const side = (a: Alliance) => {
      const teams = info.teams[a].length ? info.teams[a] : [{ name: '—', logo: '' }];
      return h('div', { class: `rb-side rb-${a}` },
        winner === a ? h('div', { class: 'rb-winner' }, '🏆 ПОБЕДА') : winner === null ? h('div', { class: 'rb-winner rb-tie' }, 'НИЧЬЯ') : h('div', { class: 'rb-winner rb-empty' }, '🏆'),
        info.highScore && info.mine === a ? h('div', { class: 'rb-high' }, '★ РЕКОРД ★') : '',
        info.score[a].redCards ? h('div', { class: 'rb-dq' }, '🟥 ДИСКВАЛИФИКАЦИЯ') : '',
        h('div', { class: 'rb-teams' },
          ...teams.map(t => h('div', { class: 'rb-team' }, t.logo ? h('img', { src: t.logo, alt: '' }) : '', h('span', {}, t.name)))),
      );
    };

    this.el.replaceChildren(
      h('div', { class: 'rb' },
        h('div', { class: 'rb-header' },
          h('div', { class: 'rb-brand' }, h('img', { src: 'assets/logo.svg', alt: 'UrSim' }), h('span', {}, 'FIRST Tech Challenge · 2026–2027')),
          h('div', { class: 'rb-title' }, info.title),
          h('img', { class: 'rb-season', src: 'assets/biobuzz.webp', alt: 'BIOBUZZ' })),
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
        this.hint),
    );
  }
}
