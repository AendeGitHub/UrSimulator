// Robot selection before a match, laid out like MoSim: Back button top left, the robot on the
// field in the open area, "Match settings" down the right with the Start button, robot cards
// along the bottom. The page is built once; changes only update texts and classes, so logos are
// never re-created.

import { CAMERA_MODES, cameraName, type CameraMode } from '../camera/CameraRig';
import { cleanName } from '../net/protocol';
import type { Alliance } from '../robot/robotConfig';
import { ROBOTS, robotById } from '../robot/robots';
import { h } from './dom';
import { ht, t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export type SelectPurpose = 'match' | 'practice' | 'online';

export interface SelectSettings {
  robot: string;
  alliance: Alliance;
  camera: CameraMode;
  fieldCentric: boolean;
  /** Player name for the high score table */
  name: string;
}

export interface SelectActions {
  /** Settings changed (also used to update the 3D preview) */
  change(settings: SelectSettings): void;
  start(purpose: SelectPurpose): void;
  back(): void;
}

const TITLES: Record<SelectPurpose, TextKey> = { match: 'menu.match', practice: 'menu.practice', online: 'menu.online' };

export class RobotSelectScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private purpose: SelectPurpose = 'practice';

  private readonly mode = h('div', { class: 'ms-mode' });
  private readonly alliance: HTMLButtonElement;
  private readonly allianceRow: HTMLElement;
  private readonly camera: HTMLButtonElement;
  private readonly drive: HTMLButtonElement;
  private readonly nameRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly start: HTMLButtonElement;
  private readonly cards = new Map<string, HTMLButtonElement>();

  constructor(private settings: SelectSettings, private readonly actions: SelectActions) {
    /** A settings row: label on the left, a blue drop-down-style button that cycles the value. */
    const row = (label: TextKey, control: HTMLElement) => h('div', { class: 'ms-row' }, ht('span', { class: 'ms-label' }, label), control);
    const choice = (onclick: () => void) => h('button', { class: 'ms-select', onclick });
    this.alliance = choice(() => this.set({ alliance: this.settings.alliance === 'red' ? 'blue' : 'red' }));
    this.camera = choice(() => this.set({ camera: CAMERA_MODES[(CAMERA_MODES.indexOf(this.settings.camera) + 1) % CAMERA_MODES.length] }));
    this.drive = choice(() => this.set({ fieldCentric: !this.settings.fieldCentric }));
    this.allianceRow = row('select.alliance', this.alliance);

    // Typing must not rebuild anything, or the field would lose focus.
    this.nameInput = ht('input', { class: 'ms-input', maxlength: '16' }, 'select.namePlaceholder');
    this.nameInput.addEventListener('input', () => {
      this.settings = { ...this.settings, name: this.nameInput.value.trim() ? cleanName(this.nameInput.value) : '' };
      this.actions.change(this.settings);
    });
    this.nameRow = row('select.name', this.nameInput);
    this.start = h('button', { class: 'ms-start', onclick: () => this.actions.start(this.purpose) });

    for (const r of ROBOTS) {
      this.cards.set(r.id, h('button', { class: 'ms-card', onclick: () => this.set({ robot: r.id }) },
        h('img', { src: r.teamLogo, alt: r.team }),
        h('span', {}, r.team)));
    }

    this.el = h('div', { class: 'screen menu-select' },
      ht('button', { class: 'ms-back', onclick: this.actions.back }, 'common.backArrow'),
      h('div', { class: 'ms-panel ms-settings' },
        ht('div', { class: 'ms-title' }, 'select.title'),
        this.mode,
        this.allianceRow,
        row('select.camera', this.camera),
        row('select.drive', this.drive),
        this.nameRow,
        this.start),
      h('div', { class: 'ms-panel ms-robots' },
        ht('div', { class: 'ms-title ms-title-left' }, 'select.robots'),
        h('div', { class: 'ms-cards' }, ...this.cards.values())),
    );
    this.nav = new MenuNav(this.el, actions.back);
  }

  open(purpose: SelectPurpose, settings: SelectSettings): void {
    this.purpose = purpose;
    this.settings = { ...settings };
    this.nameInput.value = settings.name;
    this.refresh();
  }

  private set(patch: Partial<SelectSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.actions.change(this.settings);
    this.refresh();
  }

  private refresh(): void {
    const def = robotById(this.settings.robot);
    const s = this.settings;
    const online = this.purpose === 'online';
    this.mode.textContent = online ? `${t(TITLES.online)} · ${t('select.onlineNote')}` : t(TITLES[this.purpose]);
    this.allianceRow.hidden = online;
    this.alliance.textContent = t(s.alliance === 'red' ? 'select.red' : 'select.blue');
    this.camera.textContent = cameraName(s.camera);
    this.drive.textContent = s.fieldCentric ? 'Field-centric' : 'Robot-centric';
    // Only full solo matches go into the high score table.
    this.nameRow.hidden = this.purpose !== 'match';
    this.start.textContent = t(online ? 'select.next' : 'select.start');
    for (const [id, card] of this.cards) card.classList.toggle('ms-card-on', id === def.id);
  }
}
