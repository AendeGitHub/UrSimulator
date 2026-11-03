// End-of-match results laid out like the FIRST Tech Challenge audience display: red alliance on
// the left, blue on the right, the WINNER box on the winning side, both scores over the five
// scoring rows, each team with its place in the qualification ranking, the RANKING POINTS earned
// and the event bar along the bottom. No buttons: R (✕ / A) plays again, Esc (○ / B) goes back to
// the menu.
//
// The display is a 16:9 stage letterboxed into the window; its sizes (styles.css) are in cqw as
// measured on a 2000 px wide display, 1cqw = 20 px of it.

import type { PadModel } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import type { RankMove } from '../game/ranking';
import { POINTS, RP_THRESHOLDS, matchRankingPoints, matchWinner, scoreRows, total, type AllianceScore, type MatchRankingPoints, type ScoreRows } from '../game/scoring';
import type { Alliance } from '../robot/robotConfig';
import { SLOT_NAMES, type Slot } from '../sim/types';
import { asset } from '../view/assets';
import { h } from './dom';
import { keyChip } from './Hud';
import { t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface ResultsActions {
  /** The same match again */
  again(): void;
  /** Back to the main menu */
  menu(): void;
  /** The match again, from any angle (ui/ReplayStudio.ts) */
  replay(): void;
}

export interface ResultsTeam {
  /** FTC team number, the big text of the team's row */
  number: string;
  /** Small under the number: the AI or a player's name ('' for a team on its own, as at FTC) */
  name: string;
  logo: string;
  /** Place in the qualification ranking after this match, and how it moved */
  rank: number;
  move: RankMove;
}

export interface ResultsInfo {
  score: Record<Alliance, AllianceScore>;
  teams: Record<Alliance, ResultsTeam[]>;
  /** Bottom bar: the event's name */
  event: string;
  /** What R does, if not "again" (online: back to the room) */
  again?: TextKey;
  /** The match was recorded: V (Y on a gamepad) watches it again */
  replay?: boolean;
}

/** The display is in English, like FTC's own; the notes under the teams follow the interface language. */
const NAMES: Record<Alliance, string> = { red: 'Red', blue: 'Blue' };
const SIDES: Alliance[] = ['red', 'blue'];
const ROWS: [keyof ScoreRows, string][] = [['leavePark', 'LEAVE & PARK'], ['hive', 'HIVE'], ['flower', 'FLOWER'], ['garden', 'GARDEN'], ['foul', 'FOUL']];
const MOVES: Record<RankMove, string> = { up: '▲', down: '▼', same: '-' };
/** Countdown to the next match shown in the bottom bar, s */
const NEXT_MATCH = 60;

/** One of the display's icons (public/assets/results), drawn in the text colour. */
function icon(name: string, cls: string): HTMLElement {
  const url = `url(${asset(`assets/results/${name}.svg`)})`;
  return h('span', { class: `fr-icon ${cls}`, style: { maskImage: url, webkitMaskImage: url } });
}

/** "Ranking Points" with a lit box for each one earned: WIN (3 trophies, a tie lights 1), SWARM, POLLINATOR 1 and 2. */
function rankingPoints(alliance: Alliance, rp: MatchRankingPoints): HTMLElement {
  const won = rp.result === 'win' ? 3 : rp.result === 'tie' ? 1 : 0;
  const items: [string, boolean, string][] = [
    ['trophy', won >= 1, rp.result === 'tie' ? 'TIE · 1 RP' : 'WIN · 3 RP'],
    ['trophy', won >= 2, 'WIN · 3 RP'],
    ['trophy', won >= 3, 'WIN · 3 RP'],
    ['robot', rp.swarm, `SWARM RP · LEAVE + PARK ≥ ${RP_THRESHOLDS.swarm}`],
    ['rp1', rp.pollinator1, `POLLINATOR 1 RP · ${RP_THRESHOLDS.pollinator1} TIPS`],
    ['rp2', rp.pollinator2, `POLLINATOR 2 RP · ${RP_THRESHOLDS.pollinator2} TIPS`],
  ];
  return h('div', { class: `fr-rp fr-rp-${alliance}` },
    h('div', { class: 'fr-rp-title' }, 'Ranking Points'),
    h('div', { class: 'fr-rp-icons' },
      ...items.map(([name, on, title]) => h('span', { class: `fr-rp-item${on ? ' fr-rp-on' : ''}`, title }, icon(name, 'fr-rp-icon')))));
}

/** Where each alliance PARKED: which robots stood in its LOADING ZONE at the end of AUTO and of the match. */
function parking(s: AllianceScore): HTMLElement {
  const line = (key: TextKey, slots: readonly Slot[], points: number) =>
    h('div', { class: 'fr-note-line' },
      h('span', {}, `${t(key)}:`),
      h('span', { class: 'fr-note-what' }, slots.length ? slots.map(slot => SLOT_NAMES[slot]).join(', ') : t('results.parkNone')),
      h('strong', {}, `+${slots.length * points}`));
  return h('div', {},
    h('div', { class: 'fr-note-title' }, t('results.park')),
    line('results.parkAuto', s.autoParked ?? [], POINTS.autoPark),
    line('results.parkEnd', s.teleopParked ?? [], POINTS.teleopPark));
}

/** Calls that have words for them in the interface language (the rest are FTC terms like MAJOR FOUL). */
const CALL_WORDS: Record<string, TextKey> = { 'VERBAL WARNING': 'call.VERBAL WARNING', 'YELLOW CARD': 'call.YELLOW CARD', 'RED CARD': 'call.RED CARD' };

/** "G417 · VERBAL WARNING · Red 1" from the referee (sim/Referee.ts), in the interface language. */
function callText(call: string): string {
  return call.split(' · ').map(part => (CALL_WORDS[part] ? t(CALL_WORDS[part]) : part)).join(' · ');
}

/** Referee calls against an alliance, the same call counted once with ×N. */
function calls(list: string[]): HTMLElement | '' {
  if (!list.length) return '';
  const counts = new Map<string, number>();
  for (const c of list) counts.set(c, (counts.get(c) ?? 0) + 1);
  return h('div', {},
    h('div', { class: 'fr-note-title' }, t('results.calls')),
    ...[...counts].map(([c, n]) => h('div', { class: 'fr-note-line' }, n > 1 ? `${callText(c)} ×${n}` : callText(c))));
}

const clockText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class ResultsScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-results' });
  readonly nav: MenuNav;
  private readonly hint = h('span', { class: 'fr-hint' });
  private readonly clock = h('div', { class: 'fr-clock' });
  private readonly record: Record<Alliance, HTMLElement> = { red: h('div', { class: 'fr-record' }), blue: h('div', { class: 'fr-record' }) };
  private model: PadModel | null = null;
  private againKey: TextKey = 'results.again';
  private replay = false;
  private shownAt = 0;

  constructor(private readonly actions: ResultsActions) {
    this.nav = new MenuNav(this.el, actions.menu);
  }

  /** The countdown in the bottom bar starts when the results appear, after the win animation. */
  onShow(): void {
    this.shownAt = performance.now();
  }

  update(input: InputManager): void {
    if (input.model1 !== this.model) this.renderHint(input.model1);
    this.clock.textContent = clockText(Math.max(0, NEXT_MATCH - (performance.now() - this.shownAt) / 1000));
    if (this.replay && (input.keyboard.pressed('KeyV') || input.menuPressed('y'))) this.actions.replay();
    else if (input.keyboard.pressed('KeyR') || input.menuPressed('a')) this.actions.again();
    else if (input.keyboard.pressed('Escape') || input.triggered('pause')) this.actions.menu();
  }

  private renderHint(model: PadModel): void {
    this.model = model;
    const pad = model !== 'keyboard';
    this.hint.replaceChildren(
      h('span', {}, h('span', { class: 'key' }, 'R'), pad ? keyChip(model, 'a') : '', t(this.againKey)),
      h('span', {}, keyChip('keyboard', 'guide'), pad ? keyChip(model, 'b') : '', t('results.menu')),
      this.replay ? h('span', { class: 'fr-hint-click', onclick: () => this.actions.replay() }, h('span', { class: 'key' }, 'V'), pad ? keyChip(model, 'y') : '', `▶ ${t('results.studio')}`) : '',
    );
  }

  /** "★ Personal best ★" tab over an alliance score, like "Event High Score" (set once the server answers). */
  setRecord(alliance: Alliance, text: string): void {
    this.record[alliance].textContent = `★ ${text} ★`;
    this.record[alliance].classList.add('fr-record-on');
  }

  show(info: ResultsInfo): void {
    this.model = null;
    this.againKey = info.again ?? 'results.again';
    this.replay = !!info.replay;
    this.shownAt = performance.now();
    this.clock.textContent = clockText(NEXT_MATCH);
    for (const a of SIDES) {
      this.record[a].textContent = '';
      this.record[a].classList.remove('fr-record-on');
    }
    const winner = matchWinner(info.score);
    const rp = matchRankingPoints(info.score);
    const rows = { red: scoreRows(info.score.red), blue: scoreRows(info.score.blue) };

    const card = (a: Alliance) => {
      const s = info.score[a];
      return s.redCards ? 'red' : s.yellowCards ? 'yellow' : '';
    };
    const teams = (a: Alliance) => h('div', { class: `fr-teams fr-teams-${a}` },
      ...info.teams[a].map(team =>
        h('div', { class: 'fr-team' },
          h('div', { class: 'fr-team-bar' },
            h('span', { class: 'fr-team-logo' }, team.logo ? h('img', { src: team.logo, alt: '' }) : ''),
            h('span', { class: 'fr-team-id' }, h('span', { class: 'fr-team-number' }, team.number), team.name ? h('span', { class: 'fr-team-name' }, team.name) : ''),
            card(a) ? h('span', { class: `fr-card fr-card-${card(a)}` }) : ''),
          h('div', { class: 'fr-team-rank' }, h('span', {}, String(team.rank)), h('span', { class: `fr-move fr-move-${team.move}` }, MOVES[team.move])))));
    const notes = (a: Alliance) => h('div', { class: `fr-notes fr-notes-${a}` },
      info.score[a].redCards ? h('div', { class: 'fr-dq' }, t('results.dq')) : '',
      parking(info.score[a]),
      calls(info.score[a].calls));
    const winnerBox = (a: Alliance) => winner === a
      ? h('div', { class: `fr-winner fr-winner-${a}` }, icon('trophy', 'fr-cup'), h('span', {}, 'WINNER'))
      : winner === null ? h('div', { class: `fr-winner fr-winner-${a} fr-tie` }, h('span', {}, 'TIE')) : '';

    this.el.replaceChildren(
      h('div', { class: 'fr' },
        h('div', { class: 'fr-stage' },
          ...SIDES.map(a => h('div', { class: `fr-half fr-half-${a}` })),
          h('div', { class: 'fr-top' },
            h('div', { class: 'fr-top-logo fr-top-canopy' }, h('img', { src: asset('assets/results/first-canopy.webp'), alt: 'FIRST CANOPY' })),
            h('div', { class: 'fr-top-logo fr-top-biobuzz' }, h('img', { src: asset('assets/results/biobuzz-wordmark.png'), alt: 'BIOBUZZ presented by RTX' }))),
          ...SIDES.map(winnerBox),
          ...SIDES.map(a => h('div', { class: `fr-score fr-score-${a}` },
            this.record[a],
            h('span', { class: 'fr-score-name' }, NAMES[a]),
            h('strong', {}, String(total(info.score[a]))))),
          h('div', { class: 'fr-table' },
            ...ROWS.map(([key, label]) =>
              h('div', { class: 'fr-row' },
                h('span', { class: 'fr-num' }, String(rows.red[key])),
                h('span', { class: 'fr-label' }, label),
                h('span', { class: 'fr-num' }, String(rows.blue[key]))))),
          ...SIDES.map(teams),
          ...SIDES.map(notes),
          ...SIDES.map(a => rankingPoints(a, rp[a])),
          h('div', { class: 'fr-bottom' },
            h('div', { class: 'fr-ftc' }, h('img', { src: asset('assets/results/ftc-color.png'), alt: 'FIRST Tech Challenge' })),
            this.clock,
            h('div', { class: 'fr-event' }, h('span', {}, info.event), this.hint)))),
    );
  }
}
