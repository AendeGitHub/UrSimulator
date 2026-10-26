// Robot selection before a match (like MoSim): team cards, robot specs and match settings.

import { CAMERA_MODES, CAMERA_NAMES, type CameraMode } from '../camera/CameraRig';
import type { Alliance } from '../robot/robotConfig';
import { ROBOTS, robotById, type RobotDefinition } from '../robot/robots';
import { h } from './dom';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export type SelectPurpose = 'match' | 'practice' | 'online';

export interface SelectSettings {
  robot: string;
  alliance: Alliance;
  camera: CameraMode;
  fieldCentric: boolean;
}

export interface SelectActions {
  /** Settings changed (also used to update the 3D preview) */
  change(settings: SelectSettings): void;
  start(purpose: SelectPurpose): void;
  back(): void;
}

const TITLES: Record<SelectPurpose, string> = { match: 'Матч 2:30', practice: 'Тренировка', online: 'Онлайн 2 на 2' };

function specs(def: RobotDefinition): [string, string][] {
  const c = def.config;
  return [
    ['Шасси', 'Mecanum'],
    ['Скорость', `${c.drive.maxWheelSpeed.toFixed(1)} м/с`],
    ['Вес', `${c.mass} кг`],
    ['Размер', `${Math.round(c.length * 100)} × ${Math.round(c.width * 100)} см`],
    ['Точный бросок', `до ${def.shooter.sweetSpot.toFixed(1)} м`],
  ];
}

export class RobotSelectScreen implements Screen {
  readonly el = h('div', { class: 'screen menu-select' });
  readonly nav: MenuNav;
  private purpose: SelectPurpose = 'practice';

  constructor(private settings: SelectSettings, private readonly actions: SelectActions) {
    this.nav = new MenuNav(this.el, actions.back);
  }

  open(purpose: SelectPurpose, settings: SelectSettings): void {
    this.purpose = purpose;
    this.settings = { ...settings };
    this.render();
  }

  private set(patch: Partial<SelectSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.actions.change(this.settings);
    this.render();
  }

  private render(): void {
    const def = robotById(this.settings.robot);
    const s = this.settings;
    const option = (label: string, value: string, next: () => void) =>
      h('div', { class: 'setting' }, h('span', {}, label), h('button', { class: 'btn btn-small setting-value', onclick: next }, value, ' ›'));
    const nextCamera = CAMERA_MODES[(CAMERA_MODES.indexOf(s.camera) + 1) % CAMERA_MODES.length];

    this.el.replaceChildren(
      h('div', { class: 'select-top' },
        h('button', { class: 'btn btn-ghost btn-small', onclick: this.actions.back }, '← Назад'),
        h('h2', {}, TITLES[this.purpose])),
      h('div', { class: 'select-main' },
        h('div', { class: 'panel robot-info' },
          h('img', { class: 'team-logo-big', src: def.teamLogo, alt: def.team }),
          h('div', {},
            h('div', { class: 'robot-team' }, def.team),
            h('div', { class: 'robot-name' }, def.name),
            h('table', { class: 'controls specs' }, ...specs(def).map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', {}, v)))))),
        h('div', { class: 'panel match-settings' },
          h('h3', {}, 'Настройки'),
          this.purpose === 'online' ? h('p', { class: 'muted' }, 'Альянс выбирается в комнате') : option('Альянс', s.alliance === 'red' ? 'Красный' : 'Синий', () => this.set({ alliance: s.alliance === 'red' ? 'blue' : 'red' })),
          option('Камера', CAMERA_NAMES[s.camera], () => this.set({ camera: nextCamera })),
          option('Управление', s.fieldCentric ? 'Field-centric' : 'Robot-centric', () => this.set({ fieldCentric: !s.fieldCentric })),
          h('button', { class: 'btn btn-primary btn-start', onclick: () => this.actions.start(this.purpose) }, this.purpose === 'online' ? 'Дальше' : 'Старт'))),
      h('div', { class: 'panel robot-cards' },
        h('h3', {}, 'Роботы'),
        h('div', { class: 'cards' },
          ...ROBOTS.map(r => h('button', {
            class: `robot-card ${r.id === def.id ? 'robot-card-active' : ''}`,
            onclick: () => this.set({ robot: r.id }),
          }, h('div', { class: 'robot-card-logo' }, h('img', { src: r.teamLogo, alt: r.team })), h('span', {}, r.team), h('span', { class: 'muted' }, r.name))))),
    );
  }
}
