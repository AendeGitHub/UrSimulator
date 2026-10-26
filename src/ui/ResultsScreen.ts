// End-of-match results over the whole screen, laid out like the FIRST Tech Challenge audience
// display: blue alliance on the left, red on the right, both scores with the point breakdown in
// the middle, the WINNER box on the winning side and the event bar along the bottom.
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
  teams: Record<Alliance, ResultsTeam[]>;
  /** Top bar, e.g. "Матч 3" */
  title: string;
  /** Bottom bar, e.g. "UrSim · одиночная игра" */
  event: string;
  online: boolean;
}

const NAMES: Record<Alliance, string> = { red: 'Красный альянс', blue: 'Синий альянс' };
/** The audience display puts blue on the left. */
const SIDES: Alliance[] = ['blue', 'red'];
/** Countdown to the next match shown in the bottom bar, s */
const NEXT_MATCH = 60;

/** Breakdown rows of the audience display. FOUL is points credited for the opponent's fouls. */
function rows(s: AllianceScore): [string, number][] {
  const f = s.field;
  return [
    ['AUTO', s.leave * POINTS.leave + s.autoPark * POINTS.autoPark + s.autoTips * POINTS.tip],
    ['TELEOP HIVE', s.teleopTips * POINTS.tip],
    ['Other TELEOP', f.cellElements * POINTS.cellElement + f.flowerBottom * POINTS.flowerBottomNectar
      + f.ownedFlowerElements * POINTS.ownedFlowerElement + f.gardenElements * POINTS.gardenElement + s.teleopPark * POINTS.teleopPark],
    // G408 / G409 give cards, not foul points, so no alliance is credited points yet.
    ['FOUL', 0],
  ];
}

const clockText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class ResultsScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-results' });
  readonly nav: MenuNav;
  private readonly hint = h('span', { class: 'fr-hint' });
  private readonly clock = h('div', { class: 'fr-clock' });
  private readonly record: Record<Alliance, HTMLElement> = { red: h('div', { class: 'fr-record' }), blue: h('div', { class: 'fr-record' }) };
  private online = false;
  private model: PadModel | null = null;
  private shownAt = 0;
  /** R must be pressed after the board appears, not still held from the match. */
  private rWasDown = true;

  constructor(private readonly actions: ResultsActions) {
    this.nav = new MenuNav(this.el, actions.menu);
  }

  update(input: InputManager): void {
    if (input.model1 !== this.model) this.renderHint(input.model1);
    this.clock.textContent = clockText(Math.max(0, NEXT_MATCH - (performance.now() - this.shownAt) / 1000));
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
      h('span', {}, h('span', { class: 'key' }, 'R'), pad ? keyChip(model, 'a') : '', this.online ? 'в лобби' : 'ещё раз'),
      h('span', {}, keyChip('keyboard', 'guide'), pad ? keyChip(model, 'b') : '', this.online ? 'выйти' : 'меню'),
    );
  }

  /** "★ Рекорд ★" tab over an alliance score, like "Event High Score" (set once the server answers). */
  setRecord(alliance: Alliance, text: string): void {
    this.record[alliance].textContent = `★ ${text} ★`;
    this.record[alliance].classList.add('fr-record-on');
  }

  show(info: ResultsInfo): void {
    this.online = info.online;
    this.model = null;
    this.rWasDown = true;
    this.shownAt = performance.now();
    this.clock.textContent = clockText(NEXT_MATCH);
    for (const a of SIDES) {
      this.record[a].textContent = '';
      this.record[a].classList.remove('fr-record-on');
    }
    const totals = { red: total(info.score.red), blue: total(info.score.blue) };
    const winner: Alliance | null = totals.red === totals.blue ? null : totals.red > totals.blue ? 'red' : 'blue';
    const table = { red: rows(info.score.red), blue: rows(info.score.blue) };

    const card = (a: Alliance) => {
      const s = info.score[a];
      return s.redCards ? 'red' : s.yellowCards ? 'yellow' : '';
    };
    const side = (a: Alliance) => h('div', { class: `fr-side fr-side-${a}` },
      winner === a
        ? h('div', { class: 'fr-winner' }, h('span', {}, 'ПОБЕДА'), h('span', { class: 'fr-cup' }, '🏆'))
        : winner === null ? h('div', { class: 'fr-winner fr-tie' }, h('span', {}, 'НИЧЬЯ')) : '',
      h('div', { class: 'fr-teams' },
        ...(info.teams[a].length ? info.teams[a] : [{ name: '—', logo: '' }]).map(t =>
          h('div', { class: `fr-team fr-team-${a}` },
            h('span', { class: 'fr-team-logo' }, t.logo ? h('img', { src: t.logo, alt: '' }) : ''),
            h('span', { class: 'fr-team-name' }, t.name),
            card(a) ? h('span', { class: `fr-card fr-card-${card(a)}` }) : ''))),
      info.score[a].redCards ? h('div', { class: 'fr-dq' }, 'Дисквалификация: красная карточка') : '',
    );

    this.el.replaceChildren(
      h('div', { class: 'fr' },
        h('div', { class: 'fr-top' },
          h('div', { class: 'fr-top-left' }, 'Результаты матча'),
          h('div', { class: 'fr-top-title' }, info.title),
          h('div', { class: 'fr-top-logo' }, h('img', { src: 'assets/biobuzz.webp', alt: 'BIOBUZZ' }))),
        h('div', { class: 'fr-main' },
          side('blue'),
          h('div', { class: 'fr-center' },
            h('div', { class: 'fr-scores' },
              ...SIDES.map(a => h('div', { class: `fr-score fr-score-${a}` },
                this.record[a],
                h('span', { class: 'fr-score-name' }, NAMES[a]),
                h('strong', {}, String(totals[a]))))),
            h('div', { class: 'fr-table' },
              ...table.blue.map(([label, blue], i) =>
                h('div', { class: 'fr-row' },
                  h('span', { class: 'fr-num' }, String(blue)),
                  h('span', { class: 'fr-label' }, label),
                  h('span', { class: 'fr-num' }, String(table.red[i][1])))))),
          side('red')),
        h('div', { class: 'fr-bottom' },
          h('div', { class: 'fr-ftc' }, h('img', { src: 'assets/ftc.webp', alt: 'FIRST Tech Challenge' })),
          this.clock,
          h('div', { class: 'fr-event' }, h('span', {}, info.event), this.hint))),
    );
  }
}
