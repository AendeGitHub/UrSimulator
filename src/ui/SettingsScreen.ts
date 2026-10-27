// Settings from the main menu (MoSim style panel): rebind controls, graphics quality and house
// rules. Every change is saved at once; the game applies it on the spot.

import { ACTIONS, ACTION_NAMES, DEFAULT_BINDINGS, MOVES, keyLabel, rebind, type ActionId, type Bindings, type MoveId } from '../input/bindings';
import type { ControlId, PadModel } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { controlLabel } from '../input/labels';
import type { RuleOptions } from '../sim/Referee';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export type QualityPreset = 'auto' | 'high' | 'medium' | 'low';

export interface GraphicsSettings {
  quality: QualityPreset;
  shadows: boolean;
  outlines: boolean;
  fps: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = { quality: 'auto', shadows: true, outlines: true, fps: false };

export interface SettingsValues {
  bindings: Bindings;
  graphics: GraphicsSettings;
  rules: RuleOptions;
}

export interface SettingsActions {
  change(values: SettingsValues): void;
  gamepads(): void;
  back(): void;
}

type Tab = 'controls' | 'graphics' | 'rules';

const TABS: [Tab, string][] = [['controls', 'Управление'], ['graphics', 'Графика'], ['rules', 'Правила']];

const QUALITY_NAMES: Record<QualityPreset, string> = { auto: 'Авто (по FPS)', high: 'Высокое', medium: 'Среднее', low: 'Низкое' };
const QUALITY_ORDER: QualityPreset[] = ['auto', 'high', 'medium', 'low'];

/** What the automatic referee calls during a match (sim/Referee.ts). */
const RULES: [string, string][] = [
  ['G402', 'В AUTO не трогать мячи и робота соперника на его половине — MAJOR FOUL'],
  ['G405', 'Не выбрасывать мячи за поле (промах при броске не считается) — MAJOR FOUL за мяч'],
  ['G408', 'Не брать NECTAR соперника — предупреждение, затем жёлтая карточка'],
  ['G410', 'NECTAR в цветок только в последнюю минуту — MAJOR FOUL за NECTAR'],
  ['G417', 'Не таранить раму улья — предупреждение, затем MAJOR FOUL и жёлтая'],
  ['G421', 'Не прижимать соперника дольше 3 с — MAJOR FOUL и ещё один каждые 3 с'],
];

const onOff = (on: boolean) => (on ? 'Вкл' : 'Выкл');

export class SettingsScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly tabs = h('div', { class: 'settings-tabs' });
  private readonly body = h('div', { class: 'settings-body' });
  private tab: Tab = 'controls';
  private values!: SettingsValues;
  /** Waiting for the player to press the new button or key for an action */
  private waiting: { action: ActionId | MoveId; kind: 'pad' | 'keys' } | null = null;
  private model: PadModel = 'ps4';

  constructor(private readonly actions: SettingsActions) {
    this.el = h('div', { class: 'screen menu-settings' },
      h('button', { class: 'ms-back', onclick: () => this.goBack() }, '← Назад'),
      h('div', { class: 'ms-panel settings-panel' },
        h('div', { class: 'ms-title' }, 'Настройки'),
        this.tabs,
        this.body));
    this.nav = new MenuNav(this.el, () => this.goBack());
    // New key for an action: the next key pressed, before the game sees it. Esc cancels.
    window.addEventListener('keydown', e => {
      if (!this.waiting || this.waiting.kind !== 'keys') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code !== 'Escape') this.set({ bindings: rebind(this.values.bindings, 'keys', this.waiting.action, e.code) });
      this.waiting = null;
      this.render();
    }, { capture: true });
  }

  /** While waiting for a controller button, presses must not move the menu. */
  get blocksNav(): boolean {
    return this.waiting !== null;
  }

  open(values: SettingsValues): void {
    this.values = structuredClone(values);
    this.waiting = null;
    this.render();
  }

  update(input: InputManager): void {
    const model = input.model1 === 'keyboard' ? 'ps4' : input.model1;
    if (model !== this.model) {
      this.model = model;
      if (this.tab === 'controls') this.render();
    }
    if (this.waiting?.kind !== 'pad') return;
    // Esc on the keyboard cancels waiting for a controller button too.
    if (input.keyboard.pressed('Escape')) {
      this.waiting = null;
      this.render();
      return;
    }
    const control = input.anyControlPressed();
    if (!control) return;
    this.set({ bindings: rebind(this.values.bindings, 'pad', this.waiting.action as ActionId, control) });
    this.waiting = null;
    this.render();
  }

  private goBack(): void {
    if (this.waiting) {
      this.waiting = null;
      this.render();
      return;
    }
    this.actions.back();
  }

  private set(patch: Partial<SettingsValues>): void {
    this.values = { ...this.values, ...patch };
    this.actions.change(structuredClone(this.values));
  }

  private render(): void {
    this.tabs.replaceChildren(
      ...TABS.map(([id, name]) => h('button', {
        class: `ms-tab ${id === this.tab ? 'ms-tab-on' : ''}`,
        onclick: () => {
          this.tab = id;
          this.waiting = null;
          this.render();
        },
      }, name)),
      h('button', { class: 'ms-tab', onclick: this.actions.gamepads }, 'Геймпады →'),
    );
    this.body.replaceChildren(...(this.tab === 'controls' ? this.controls() : this.tab === 'graphics' ? this.graphics() : this.rules()));
  }

  /** A settings row: label on the left, a blue button that cycles the value. */
  private row(label: string, value: string, onclick: () => void): HTMLElement {
    return h('div', { class: 'ms-row' }, h('span', { class: 'ms-label' }, label), h('button', { class: 'ms-select', onclick }, value));
  }

  private controls(): HTMLElement[] {
    const b = this.values.bindings;
    const wait = (action: ActionId | MoveId, kind: 'pad' | 'keys') => () => {
      this.waiting = { action, kind };
      this.render();
    };
    const waitingFor = (action: ActionId | MoveId, kind: 'pad' | 'keys') => this.waiting?.action === action && this.waiting.kind === kind;
    const padButton = (action: ActionId) => h('button', { class: `ms-bind ${waitingFor(action, 'pad') ? 'ms-bind-wait' : ''}`, onclick: wait(action, 'pad') },
      waitingFor(action, 'pad') ? 'Нажми кнопку…' : controlLabel(this.model, b.pad[action] as ControlId).text);
    const keyButton = (action: ActionId | MoveId) => h('button', { class: `ms-bind ${waitingFor(action, 'keys') ? 'ms-bind-wait' : ''}`, onclick: wait(action, 'keys') },
      waitingFor(action, 'keys') ? 'Нажми клавишу…' : keyLabel(b.keys[action]));
    const stick = (move: MoveId) => (move === 'turnLeft' || move === 'turnRight' ? 'Правый стик' : 'Левый стик');
    return [
      h('div', { class: 'bind-table' },
        h('div', { class: 'bind-head' }, h('span', {}, 'Действие'), h('span', {}, 'Геймпад'), h('span', {}, 'Клавиатура')),
        ...MOVES.map(m => h('div', { class: 'bind-row' }, h('span', {}, ACTION_NAMES[m]), h('span', { class: 'bind-fixed' }, stick(m)), keyButton(m))),
        ...ACTIONS.map(a => h('div', { class: 'bind-row' }, h('span', {}, ACTION_NAMES[a]), padButton(a), keyButton(a)))),
      h('p', { class: 'muted settings-note' },
        'Нажми на кнопку в таблице, потом нужную кнопку геймпада или клавишу (Esc — отмена). Если она уже занята, действия поменяются местами. ',
        'Механизмы слушаются и gamepad1, и gamepad2, как в FTC. R на клавиатуре — начать заново.'),
      h('button', { class: 'ms-select settings-reset', onclick: () => this.set({ bindings: structuredClone(DEFAULT_BINDINGS) }) }, 'Сбросить управление'),
    ];
  }

  private graphics(): HTMLElement[] {
    const g = this.values.graphics;
    const patch = (p: Partial<GraphicsSettings>) => {
      this.set({ graphics: { ...g, ...p } });
      this.render();
    };
    return [
      this.row('Качество', QUALITY_NAMES[g.quality], () => patch({ quality: QUALITY_ORDER[(QUALITY_ORDER.indexOf(g.quality) + 1) % QUALITY_ORDER.length] })),
      this.row('Тени', onOff(g.shadows), () => patch({ shadows: !g.shadows })),
      this.row('Чёрные контуры', onOff(g.outlines), () => patch({ outlines: !g.outlines })),
      this.row('Счётчик FPS', onOff(g.fps), () => patch({ fps: !g.fps })),
      h('p', { class: 'muted settings-note' },
        '«Авто» само снижает разрешение и затенение, если FPS падает ниже 50, и возвращает, когда запас есть. ',
        'Если игра тормозит, выключи тени и поставь «Низкое».'),
    ];
  }

  private rules(): HTMLElement[] {
    const r = this.values.rules;
    const patch = (p: Partial<RuleOptions>) => {
      this.set({ rules: { ...r, ...p } });
      this.render();
    };
    return [
      this.row('Фолы (очки сопернику)', onOff(r.fouls), () => patch({ fouls: !r.fouls })),
      this.row('Предупреждения и карточки', onOff(r.cards), () => patch({ cards: !r.cards })),
      this.row('Аккумулятор (садится, робот медленнее)', onOff(r.battery), () => patch({ battery: !r.battery })),
      h('div', { class: 'rules-list' },
        ...RULES.map(([id, text]) => h('div', { class: 'rules-item' }, h('span', { class: 'key' }, id), h('span', {}, text)))),
      h('p', { class: 'muted settings-note' },
        'Судья работает в «Матч 2:30» и онлайн-матчах (там действуют настройки хоста). MINOR FOUL — 5 очков сопернику, MAJOR — 20; ',
        'вторая жёлтая карточка становится красной: 0 очков за матч.'),
    ];
  }
}
