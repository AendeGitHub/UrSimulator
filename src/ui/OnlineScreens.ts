// Online screens: the room list (quick play, and rooms that still need players; a closed one asks
// for its password) and the room itself, where players pick their driver station, robot, camera
// and drive mode, and the admin opens or closes the room, sets its rules and starts the match.

import { AI_LEVELS, cleanAiLevel, type AiLevel } from '../ai/level';
import { CAMERA_MODES, cameraName, type CameraMode } from '../camera/CameraRig';
import { SCORE_DISPLAYS, type ScoreDisplay } from '../game/scoreDisplay';
import { FORMAT_SLOTS, PASSWORD_LENGTH, normalizePassword, type LobbyError, type RoomFormat, type RoomInfo, type RoomSummary } from '../net/lobbyProtocol';
import type { LinkState } from '../net/peer';
import { cleanName } from '../net/records';
import { memberRobot } from '../net/OnlineSession';
import { playableRobots } from '../robot/customStore';
import { ROBOTS, robotById, robotTitle } from '../robot/robots';
import type { RuleOptions } from '../sim/Referee';
import { SLOT_NAMES, type GameMode, type Slot } from '../sim/types';
import { h } from './dom';
import { ht, t, type TextKey } from './i18n';
import type { InputManager } from '../input/InputManager';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';
import { aiLevelName } from './RobotSelect';

export const lobbyErrorText = (code: LobbyError) => t(`online.error.${code}` as TextKey);

/** 0:07 */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const now = () => performance.now() / 1000;

/** A 4-letter password field: English letters only, shown in capitals. */
function passwordField(): HTMLInputElement {
  const input = h('input', { class: 'field field-code', maxlength: String(PASSWORD_LENGTH), placeholder: 'ABCD', autocapitalize: 'characters', spellcheck: 'false' });
  input.addEventListener('input', () => (input.value = normalizePassword(input.value)));
  return input;
}

export interface RoomListActions {
  rename(name: string): void;
  /** Quick play: any open room, or one made for whoever is looking */
  quick(): void;
  cancelQuick(): void;
  create(format: RoomFormat): void;
  join(room: string, password?: string): void;
  back(): void;
}

export class RoomListScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly name: HTMLInputElement;
  private readonly list = h('div', { class: 'room-list' });
  private readonly status = h('p', { class: 'muted status' });
  private readonly quick = h('div', { class: 'online-quick' });
  private readonly quickTime = h('b', {});
  private rooms: RoomSummary[] = [];
  /** The closed room whose password is being typed */
  private asking: string | null = null;
  /** Quick play is looking for a room: since when (performance time, s) */
  private searching: number | null = null;

  constructor(private readonly actions: RoomListActions) {
    this.name = ht('input', { class: 'field', maxlength: '16' }, 'common.namePlaceholder');
    this.name.addEventListener('change', () => {
      this.name.value = this.name.value.trim() ? cleanName(this.name.value) : '';
      actions.rename(this.name.value);
    });
    this.el = h('div', { class: 'screen menu-online' },
      ht('h2', {}, 'menu.online'),
      ht('p', { class: 'muted' }, 'online.about'),
      h('label', { class: 'field-label' }, ht('span', {}, 'online.name'), this.name),
      this.quick,
      h('div', { class: 'online-create' },
        ht('button', { class: 'btn btn-primary', onclick: () => actions.create('1v1') }, 'online.create1v1'),
        ht('button', { class: 'btn btn-primary', onclick: () => actions.create('2v2') }, 'online.create2v2')),
      ht('h3', { class: 'room-list-title' }, 'online.rooms'),
      this.list,
      this.status,
      h('div', { class: 'menu-buttons' }, ht('button', { class: 'btn btn-ghost', onclick: actions.back }, 'common.back')),
    );
    this.nav = new MenuNav(this.el, () => (this.asking ? this.ask(null) : actions.back()));
  }

  open(name: string): void {
    this.name.value = name;
    this.asking = null;
    this.searching = null;
    this.rooms = [];
    this.setStatus(t('online.connecting'), false);
    this.render();
  }

  /** The server started or stopped looking for a room for this player. */
  setSearching(on: boolean): void {
    if (on === (this.searching !== null)) return;
    this.searching = on ? now() : null;
    this.renderQuick();
    this.nav.focusFirst();
  }

  /** The time spent looking, once a second. */
  update(_input: InputManager): void {
    if (this.searching === null) return;
    const text = clock(now() - this.searching);
    if (this.quickTime.textContent !== text) this.quickTime.textContent = text;
  }

  private renderQuick(): void {
    if (this.searching === null) {
      this.quick.replaceChildren(
        ht('button', { class: 'btn btn-primary btn-quick', onclick: this.actions.quick }, 'online.quick'),
        ht('p', { class: 'muted room-note' }, 'online.quickAbout'));
      return;
    }
    this.quickTime.textContent = clock(now() - this.searching);
    this.quick.replaceChildren(h('div', { class: 'room-ask panel online-searching' },
      h('p', {}, h('span', { class: 'spinner' }), t('online.searching'), ' ', this.quickTime),
      ht('p', { class: 'muted room-note' }, 'online.searchingNote'),
      ht('button', { class: 'btn btn-ghost', onclick: this.actions.cancelQuick }, 'online.cancel')));
  }

  setRooms(rooms: RoomSummary[]): void {
    this.rooms = rooms;
    if (this.asking && !rooms.some(r => r.id === this.asking)) this.asking = null;
    this.setStatus('', false);
    this.render();
  }

  setStatus(text: string, error: boolean): void {
    this.status.textContent = text;
    this.status.classList.toggle('warn', error);
  }

  private ask(room: string | null): void {
    this.asking = room;
    this.render();
    this.nav.focusFirst();
  }

  private render(): void {
    this.renderQuick();
    if (!this.rooms.length) {
      this.list.replaceChildren(ht('p', { class: 'muted' }, 'online.noRooms'));
      return;
    }
    this.list.replaceChildren(...this.rooms.map(r => {
      const max = FORMAT_SLOTS[r.format].length;
      const full = r.players >= max;
      const tags = [t(r.format === '1v1' ? 'online.1v1' : 'online.2v2'), `${r.players}/${max}`];
      if (r.quick) tags.push(t('online.quickTag'));
      if (r.locked) tags.push(`🔒 ${t('online.locked')}`);
      if (r.mode === 'practice') tags.push(t('menu.practice'));
      if (r.running) tags.push(t('online.playing'));
      else if (full) tags.push(t('online.full'));
      const row = h('button', {
        class: 'room-row',
        disabled: r.running || full,
        onclick: () => (r.locked ? this.ask(r.id) : this.actions.join(r.id)),
      }, h('span', { class: 'room-row-name' }, t('online.room', { name: r.name })), h('span', { class: 'room-row-tags' }, tags.join(' · ')));
      if (this.asking !== r.id) return row;
      const password = passwordField();
      const enter = () => {
        if (password.value.length !== PASSWORD_LENGTH) return this.setStatus(t('online.passwordShort'), true);
        this.actions.join(r.id, password.value);
      };
      password.addEventListener('keydown', e => e.key === 'Enter' && enter());
      queueMicrotask(() => password.focus());
      return h('div', { class: 'room-ask panel' },
        row,
        h('label', { class: 'field-label' }, ht('span', {}, 'online.password'), password),
        h('div', { class: 'online-create' },
          ht('button', { class: 'btn btn-primary', onclick: enter }, 'online.join'),
          ht('button', { class: 'btn btn-ghost', onclick: () => this.ask(null) }, 'online.cancel')));
    }));
  }
}

export interface RoomActions {
  slot(slot: Slot): void;
  robot(robot: string): void;
  /** Pick where this player's robot starts */
  startPosition(): void;
  /** This player's own camera and drive mode (not the room's) */
  local(): { camera: CameraMode; fieldCentric: boolean };
  camera(mode: CameraMode): void;
  fieldCentric(on: boolean): void;
  /** Controls, graphics, sound and language */
  settings(): void;
  /** Admin: the AI on a station with this robot, or null to take it off */
  ai(slot: Slot, robot: string | null): void;
  /** Admin: how well every AI in the room drives */
  aiLevel(level: AiLevel): void;
  rules(rules: RuleOptions): void;
  mode(mode: GameMode): void;
  scoreDisplay(display: ScoreDisplay): void;
  lock(password: string | null): void;
  start(): void;
  leave(): void;
}

/** The robot after `id`: for the AI a team's, for the player also one of their own (after the teams'). */
function nextRobot(id: string, own = false): string {
  const robots = own ? playableRobots(ROBOTS) : ROBOTS;
  return robots[(robots.indexOf(robotById(id)) + 1) % robots.length].id;
}

export class RoomScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-lobby' });
  readonly nav: MenuNav;
  private room: RoomInfo | null = null;
  private myId = -1;
  private links: (id: number) => LinkState | null = () => null;
  /** The robot the admin's AI gets first */
  private aiRobot = ROBOTS[0].id;
  /** The admin is typing a password to close the room */
  private closing = false;
  private status = '';
  /** A quick-play room's match starts by itself then (performance time, s) */
  private autoStartAt: number | null = null;
  private readonly countdown = h('p', { class: 'room-auto' });

  constructor(private readonly actions: RoomActions) {
    this.nav = new MenuNav(this.el, actions.leave);
  }

  show(room: RoomInfo, myId: number, links: (id: number) => LinkState | null, aiRobot: string): void {
    this.room = room;
    this.myId = myId;
    this.links = links;
    this.aiRobot = aiRobot;
    this.status = '';
    if (room.locked) this.closing = false;
    this.autoStartAt = room.autoStartIn === null || room.running ? null : now() + room.autoStartIn;
    this.render();
  }

  update(_input: InputManager): void {
    this.tickCountdown();
  }

  /** The seconds until a quick-play room starts by itself. */
  private tickCountdown(): void {
    if (this.autoStartAt === null) return;
    const text = t('online.autoStart', { s: Math.max(0, Math.ceil(this.autoStartAt - now())) });
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
  }

  setStatus(text: string): void {
    this.status = text;
    this.render();
  }

  render(): void {
    const room = this.room;
    if (!room) return;
    const me = room.members.find(m => m.id === this.myId);
    const isAdmin = room.adminId === this.myId;
    const a = this.actions;
    const linkText = (id: number) => {
      const state = id === this.myId ? null : this.links(id);
      return state ? t(state === 'direct' ? 'online.direct' : state === 'relay' ? 'online.relay' : 'online.linking') : '';
    };
    const button = (label: string, onclick: () => void, cls = '') => h('button', { class: `btn btn-small slot-btn ${cls}`, onclick }, label);
    const aiLevel = cleanAiLevel(room.aiLevel);
    const card = (slot: Slot) => {
      const p = room.members.find(m => m.slot === slot);
      const ai = p ? undefined : room.ai[slot];
      const mine = p?.id === this.myId;
      const robot = p ? robotById(memberRobot(p)) : ai ? robotById(ai) : null;
      const controls: HTMLElement[] = [];
      // A free station or the AI's: anyone can take it (the AI steps aside).
      if (!p && !room.running) controls.push(button(t('online.takeSlot'), () => a.slot(slot)));
      if (isAdmin && !p && !room.running) {
        if (ai) {
          controls.push(button(`${t('online.aiRobot')} ›`, () => a.ai(slot, nextRobot(ai))));
          controls.push(button(t('online.removeAi'), () => a.ai(slot, null), 'slot-btn-off'));
        } else {
          controls.push(button(t('online.addAi'), () => a.ai(slot, this.aiRobot)));
        }
      }
      return h('div', { class: `slot-card slot-${slot.startsWith('red') ? 'red' : 'blue'} ${mine ? 'slot-mine' : ''}` },
        h('span', { class: 'slot-name' }, SLOT_NAMES[slot]),
        h('span', { class: `slot-player ${p || ai ? 'slot-taken' : ''}` }, p
          ? `${p.name}${p.id === room.adminId ? ` ★ ${t('online.admin')}` : ''}${mine ? t('online.you') : ''}`
          : ai ? `${t('online.ai')} · ${aiLevelName(aiLevel)}` : t('online.free')),
        robot ? h('span', { class: 'slot-robot' }, h('img', { src: robot.teamLogo, alt: '', style: robot.logoBackground ? `background: ${robot.logoBackground}` : '' }), robotTitle(robot)) : '',
        p && !mine ? h('span', { class: 'slot-link' }, linkText(p.id)) : '',
        controls.length ? h('div', { class: 'slot-controls' }, ...controls) : '');
    };
    const slots = FORMAT_SLOTS[room.format];
    const myRobot = robotById(me?.robot);
    // The room's rules: the admin switches them, everyone else sees them.
    const option = (label: TextKey, value: string, change: () => void) =>
      h('div', { class: 'ms-row room-option' }, ht('span', { class: 'ms-label' }, label),
        h('button', { class: 'ms-select', disabled: !isAdmin || room.running, onclick: change }, value));
    const onOff = (on: boolean) => t(on ? 'common.on' : 'common.off');
    const rules = room.rules;
    const local = a.local();
    const mine = (label: TextKey, value: string, change: () => void) =>
      h('div', { class: 'ms-row room-option' }, ht('span', { class: 'ms-label' }, label), h('button', { class: 'ms-select', onclick: change }, value));
    const nextDisplay = SCORE_DISPLAYS[(SCORE_DISPLAYS.indexOf(room.scoreDisplay) + 1) % SCORE_DISPLAYS.length];
    // A quick-play room: when its match starts by itself.
    this.tickCountdown();
    const quickLine = !room.quick ? '' : this.autoStartAt !== null ? this.countdown : ht('p', { class: 'muted room-note' }, 'online.quickWaiting');
    const password = passwordField();
    const close = () => {
      if (password.value.length !== PASSWORD_LENGTH) return this.setStatus(t('online.passwordShort'));
      a.lock(password.value);
    };
    password.addEventListener('keydown', e => e.key === 'Enter' && close());
    if (this.closing) queueMicrotask(() => password.focus());

    this.el.replaceChildren(
      h('h2', {}, `${t('online.room', { name: room.name })} · ${t(room.format === '1v1' ? 'online.1v1' : 'online.2v2')}`),
      h('p', { class: room.locked ? 'warn' : 'muted' }, room.locked ? t('online.closed', { password: room.password ?? '····' }) : t('online.open')),
      quickLine,
      h('div', { class: 'slots' },
        h('div', { class: 'slot-col' }, ...slots.filter(s => s.startsWith('red')).map(card)),
        h('div', { class: 'slot-col' }, ...slots.filter(s => s.startsWith('blue')).map(card))),
      h('div', { class: 'ms-row room-option' }, ht('span', { class: 'ms-label' }, 'online.myRobot'),
        h('button', { class: 'ms-select', disabled: room.running, onclick: () => a.robot(nextRobot(myRobot.id, true)) }, robotTitle(myRobot))),
      h('div', { class: 'ms-row room-option' }, ht('span', { class: 'ms-label' }, 'select.startPos'),
        h('button', { class: 'ms-select', disabled: room.running, onclick: a.startPosition }, t(me?.start ? 'start.own' : 'start.standard'))),
      mine('select.camera', cameraName(local.camera), () => a.camera(CAMERA_MODES[(CAMERA_MODES.indexOf(local.camera) + 1) % CAMERA_MODES.length])),
      mine('select.drive', local.fieldCentric ? 'Field-centric' : 'Robot-centric', () => a.fieldCentric(!local.fieldCentric)),
      ht('h3', { class: 'room-rules-title' }, 'online.rules'),
      option('online.mode', t(room.mode === 'match' ? 'menu.match' : 'menu.practice'), () => a.mode(room.mode === 'match' ? 'practice' : 'match')),
      option('select.aiLevel', aiLevelName(aiLevel), () => a.aiLevel(AI_LEVELS[(AI_LEVELS.indexOf(aiLevel) + 1) % AI_LEVELS.length])),
      option('settings.cards', onOff(rules.cards), () => a.rules({ ...rules, cards: !rules.cards })),
      option('settings.fouls', onOff(rules.fouls), () => a.rules({ ...rules, fouls: !rules.fouls })),
      option('settings.battery', onOff(rules.battery), () => a.rules({ ...rules, battery: !rules.battery })),
      option('settings.scoreDisplay', t(`settings.scoreDisplay.${room.scoreDisplay}`), () => a.scoreDisplay(nextDisplay)),
      ht('p', { class: 'muted room-note' }, isAdmin ? 'online.rulesNote' : 'online.rulesByAdmin'),
      isAdmin && this.closing
        ? h('div', { class: 'room-ask panel' },
          h('label', { class: 'field-label' }, ht('span', {}, 'online.password'), password),
          h('div', { class: 'online-create' },
            ht('button', { class: 'btn btn-primary', onclick: close }, 'online.close'),
            ht('button', { class: 'btn btn-ghost', onclick: () => { this.closing = false; this.render(); } }, 'online.cancel')))
        : '',
      this.status ? h('p', { class: 'warn status' }, this.status) : '',
      h('div', { class: 'menu-buttons' },
        isAdmin ? ht('button', { class: 'btn btn-primary', onclick: a.start }, 'online.start') : ht('p', { class: 'muted' }, room.quick ? 'online.waitQuick' : 'online.waitAdmin'),
        isAdmin && !this.closing
          ? ht('button', { class: 'btn btn-secondary', onclick: () => (room.locked ? a.lock(null) : ((this.closing = true), this.render())) }, room.locked ? 'online.openIt' : 'online.close')
          : '',
        ht('button', { class: 'btn btn-secondary', onclick: a.settings }, 'menu.settings'),
        ht('button', { class: 'btn btn-ghost', onclick: a.leave }, 'online.leave')),
    );
  }
}
