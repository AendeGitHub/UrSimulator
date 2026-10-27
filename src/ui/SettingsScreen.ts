// Settings from the main menu (MoSim style panel): rebind controls, graphics quality, house
// rules and the interface language. Every change is saved at once; the game applies it on the spot.

import { ACTIONS, DEFAULT_BINDINGS, MOVES, actionName, keyLabel, rebind, type ActionId, type Bindings, type MoveId } from '../input/bindings';
import type { ControlId, PadModel } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { controlLabel } from '../input/labels';
import type { RuleId, RuleOptions } from '../sim/Referee';
import { h } from './dom';
import { LANGUAGES, LANGUAGE_NAMES, ht, localize, t, type Language, type TextKey } from './i18n';
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
  language: Language;
}

export interface SettingsActions {
  change(values: SettingsValues): void;
  gamepads(): void;
  back(): void;
}

type Tab = 'controls' | 'graphics' | 'rules' | 'language';

const TABS: Tab[] = ['controls', 'graphics', 'rules', 'language'];

const QUALITY_ORDER: QualityPreset[] = ['auto', 'high', 'medium', 'low'];

/** What the automatic referee calls during a match (sim/Referee.ts). */
const RULES: RuleId[] = ['G402', 'G405', 'G408', 'G410', 'G417', 'G421'];

const onOff = (on: boolean) => t(on ? 'common.on' : 'common.off');

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
      ht('button', { class: 'ms-back', onclick: () => this.goBack() }, 'common.backArrow'),
      h('div', { class: 'ms-panel settings-panel' },
        ht('div', { class: 'ms-title' }, 'menu.settings'),
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
      ...TABS.map(id => ht('button', {
        class: `ms-tab ${id === this.tab ? 'ms-tab-on' : ''}`,
        onclick: () => {
          this.tab = id;
          this.waiting = null;
          this.render();
        },
      }, `settings.tab.${id}`)),
      ht('button', { class: 'ms-tab', onclick: this.actions.gamepads }, 'settings.gamepads'),
    );
    const pages = { controls: () => this.controls(), graphics: () => this.graphics(), rules: () => this.rules(), language: () => this.language() };
    this.body.replaceChildren(...pages[this.tab]());
    // The title and Back button, after a language switch
    localize(this.el);
  }

  /** A settings row: label on the left, a blue button that cycles the value. */
  private row(label: TextKey, value: string, onclick: () => void): HTMLElement {
    return h('div', { class: 'ms-row' }, ht('span', { class: 'ms-label' }, label), h('button', { class: 'ms-select', onclick }, value));
  }

  private controls(): HTMLElement[] {
    const b = this.values.bindings;
    const wait = (action: ActionId | MoveId, kind: 'pad' | 'keys') => () => {
      this.waiting = { action, kind };
      this.render();
    };
    const waitingFor = (action: ActionId | MoveId, kind: 'pad' | 'keys') => this.waiting?.action === action && this.waiting.kind === kind;
    const padButton = (action: ActionId) => h('button', { class: `ms-bind ${waitingFor(action, 'pad') ? 'ms-bind-wait' : ''}`, onclick: wait(action, 'pad') },
      waitingFor(action, 'pad') ? t('settings.pressButton') : controlLabel(this.model, b.pad[action] as ControlId).text);
    const keyButton = (action: ActionId | MoveId) => h('button', { class: `ms-bind ${waitingFor(action, 'keys') ? 'ms-bind-wait' : ''}`, onclick: wait(action, 'keys') },
      waitingFor(action, 'keys') ? t('settings.pressKey') : keyLabel(b.keys[action]));
    const stick = (move: MoveId) => t(move === 'turnLeft' || move === 'turnRight' ? 'label.rightStick' : 'label.leftStick');
    return [
      h('div', { class: 'bind-table' },
        h('div', { class: 'bind-head' }, h('span', {}, t('settings.action')), h('span', {}, t('settings.gamepad')), h('span', {}, t('pad.keyboard'))),
        ...MOVES.map(m => h('div', { class: 'bind-row' }, h('span', {}, actionName(m)), h('span', { class: 'bind-fixed' }, stick(m)), keyButton(m))),
        ...ACTIONS.map(a => h('div', { class: 'bind-row' }, h('span', {}, actionName(a)), padButton(a), keyButton(a)))),
      h('p', { class: 'muted settings-note' }, t('settings.controlsNote')),
      h('button', { class: 'ms-select settings-reset', onclick: () => this.set({ bindings: structuredClone(DEFAULT_BINDINGS) }) }, t('settings.resetControls')),
    ];
  }

  private graphics(): HTMLElement[] {
    const g = this.values.graphics;
    const patch = (p: Partial<GraphicsSettings>) => {
      this.set({ graphics: { ...g, ...p } });
      this.render();
    };
    return [
      this.row('settings.quality', t(`settings.quality.${g.quality}`), () => patch({ quality: QUALITY_ORDER[(QUALITY_ORDER.indexOf(g.quality) + 1) % QUALITY_ORDER.length] })),
      this.row('settings.shadows', onOff(g.shadows), () => patch({ shadows: !g.shadows })),
      this.row('settings.outlines', onOff(g.outlines), () => patch({ outlines: !g.outlines })),
      this.row('settings.fps', onOff(g.fps), () => patch({ fps: !g.fps })),
      h('p', { class: 'muted settings-note' }, t('settings.graphicsNote')),
    ];
  }

  private rules(): HTMLElement[] {
    const r = this.values.rules;
    const patch = (p: Partial<RuleOptions>) => {
      this.set({ rules: { ...r, ...p } });
      this.render();
    };
    return [
      this.row('settings.fouls', onOff(r.fouls), () => patch({ fouls: !r.fouls })),
      this.row('settings.cards', onOff(r.cards), () => patch({ cards: !r.cards })),
      this.row('settings.battery', onOff(r.battery), () => patch({ battery: !r.battery })),
      h('div', { class: 'rules-list' },
        ...RULES.map(id => h('div', { class: 'rules-item' }, h('span', { class: 'key' }, id), h('span', {}, t(`settings.rule.${id}`))))),
      h('p', { class: 'muted settings-note' }, t('settings.rulesNote')),
    ];
  }

  private language(): HTMLElement[] {
    const lang = this.values.language;
    return [
      this.row('settings.language', LANGUAGE_NAMES[lang], () => {
        this.set({ language: LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length] });
        this.render();
      }),
      h('p', { class: 'muted settings-note' }, t('settings.languageNote')),
    ];
  }
}
