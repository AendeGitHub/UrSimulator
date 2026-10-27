// Robot selection before a match, laid out like MoSim: Back button top left, the robot on the
// field in the open area, "Match settings" down the right with the Start button, robot cards
// along the bottom. The page is built once; changes only update texts and classes, so logos are
// never re-created. With a second gamepad connected, its player picks a robot and an alliance in
// extra rows and the game is played on a split screen.

import { CAMERA_MODES, cameraName, type CameraMode } from '../camera/CameraRig';
import type { InputManager } from '../input/InputManager';
import { cleanName } from '../net/records';
import type { Alliance } from '../robot/robotConfig';
import { ROBOTS, robotById, wheelSpeed, type RobotDefinition } from '../robot/robots';
import { clear, h } from './dom';
import { ht, language, t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export type SelectPurpose = 'match' | 'practice';

/** With two gamepads: its own robot on a split screen, or the mechanisms of gamepad1's robot (FTC). */
export type Pad2Role = 'robot' | 'operator';

export interface SelectSettings {
  robot: string;
  alliance: Alliance;
  camera: CameraMode;
  fieldCentric: boolean;
  /** Player name for the high score table */
  name: string;
  /** gamepad2's robot and alliance on a split screen */
  robot2: string;
  alliance2: Alliance;
  pad2: Pad2Role;
}

/** Two gamepads are connected and gamepad2 drives a robot of its own. */
export const isSplit = (input: InputManager, settings: Pick<SelectSettings, 'pad2'>): boolean =>
  !!input.slotInfo(1) && settings.pad2 === 'robot';

export interface SelectActions {
  /** Settings changed (also used to update the 3D preview) */
  change(settings: SelectSettings): void;
  start(purpose: SelectPurpose): void;
  back(): void;
}

const TITLES: Record<SelectPurpose, TextKey> = { match: 'menu.match', practice: 'menu.practice' };
const allianceText = (a: Alliance) => t(a === 'red' ? 'select.red' : 'select.blue');

export class RobotSelectScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private purpose: SelectPurpose = 'practice';
  /** gamepad2 is connected */
  private twoPads = false;

  private readonly mode = h('div', { class: 'ms-mode' });
  private readonly alliance: HTMLButtonElement;
  private readonly pad2: HTMLButtonElement;
  private readonly pad2Row: HTMLElement;
  private readonly robot2: HTMLButtonElement;
  private readonly robot2Row: HTMLElement;
  private readonly alliance2: HTMLButtonElement;
  private readonly alliance2Row: HTMLElement;
  private readonly robotsTitle = h('div', { class: 'ms-title ms-title-left' });
  private readonly camera: HTMLButtonElement;
  private readonly drive: HTMLButtonElement;
  private readonly nameRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly start: HTMLButtonElement;
  /** What the picked robot can do: the team's figures */
  private readonly info = h('div', { class: 'ms-info' });
  private readonly cards = new Map<string, HTMLButtonElement>();

  constructor(private settings: SelectSettings, private readonly actions: SelectActions) {
    /** A settings row: label on the left, a blue drop-down-style button that cycles the value. */
    const row = (label: TextKey, control: HTMLElement) => h('div', { class: 'ms-row' }, ht('span', { class: 'ms-label' }, label), control);
    const choice = (onclick: () => void) => h('button', { class: 'ms-select', onclick });
    this.alliance = choice(() => this.set({ alliance: this.settings.alliance === 'red' ? 'blue' : 'red' }));
    this.camera = choice(() => this.set({ camera: CAMERA_MODES[(CAMERA_MODES.indexOf(this.settings.camera) + 1) % CAMERA_MODES.length] }));
    this.drive = choice(() => this.set({ fieldCentric: !this.settings.fieldCentric }));
    this.pad2 = choice(() => this.set({ pad2: this.settings.pad2 === 'robot' ? 'operator' : 'robot' }));
    this.robot2 = choice(() => {
      const i = ROBOTS.indexOf(robotById(this.settings.robot2));
      this.set({ robot2: ROBOTS[(i + 1) % ROBOTS.length].id });
    });
    this.alliance2 = choice(() => this.set({ alliance2: this.settings.alliance2 === 'red' ? 'blue' : 'red' }));
    this.pad2Row = row('select.pad2', this.pad2);
    this.robot2Row = row('select.robot2', this.robot2);
    this.alliance2Row = row('select.alliance2', this.alliance2);

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
        h('img', { src: r.teamLogo, alt: r.team, style: r.logoBackground ? `background: ${r.logoBackground}` : '' }),
        // The robot's name: a team can bring more than one.
        h('span', {}, r.name)));
    }

    this.el = h('div', { class: 'screen menu-select' },
      ht('button', { class: 'ms-back', onclick: this.actions.back }, 'common.backArrow'),
      h('div', { class: 'ms-panel ms-settings' },
        ht('div', { class: 'ms-title' }, 'select.title'),
        this.mode,
        row('select.alliance', this.alliance),
        row('select.camera', this.camera),
        row('select.drive', this.drive),
        this.pad2Row,
        this.robot2Row,
        this.alliance2Row,
        this.nameRow,
        this.info,
        this.start),
      h('div', { class: 'ms-panel ms-robots' },
        this.robotsTitle,
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

  /** Shows or hides gamepad2's rows as it connects and disconnects. */
  update(input: InputManager): void {
    const twoPads = !!input.slotInfo(1);
    if (twoPads === this.twoPads) return;
    this.twoPads = twoPads;
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
    const split = this.twoPads && s.pad2 === 'robot';
    this.mode.textContent = split ? `${t(TITLES[this.purpose])} · ${t('select.splitNote')}` : t(TITLES[this.purpose]);
    this.alliance.textContent = allianceText(s.alliance);
    this.camera.textContent = cameraName(s.camera);
    this.drive.textContent = s.fieldCentric ? 'Field-centric' : 'Robot-centric';
    this.pad2Row.hidden = !this.twoPads;
    this.pad2.textContent = t(s.pad2 === 'robot' ? 'select.pad2Robot' : 'select.pad2Operator');
    this.robot2Row.hidden = this.alliance2Row.hidden = !split;
    this.robot2.textContent = robotById(s.robot2).name;
    this.alliance2.textContent = allianceText(s.alliance2);
    // The cards pick gamepad1's robot.
    this.robotsTitle.textContent = split ? `${t('select.robots')} · gamepad1` : t('select.robots');
    // Only full solo matches go into the high score table.
    this.nameRow.hidden = this.purpose !== 'match' || split;
    this.start.textContent = t('select.start');
    for (const [id, card] of this.cards) card.classList.toggle('ms-card-on', id === def.id);
    this.showInfo(def);
  }

  private showInfo(def: RobotDefinition): void {
    const num = (v: number, digits = 0) => v.toLocaleString(language(), { maximumFractionDigits: digits });
    const rows: [TextKey, string][] = [
      ['robot.rapidFire', t('robot.rapidFireValue', { s: num(def.shooter.rapidFire, 2) })],
      ['robot.mass', t('robot.massValue', { kg: num(def.config.mass, 1) })],
      ['robot.drive', t('robot.driveValue', { rpm: def.drive.rpm, mm: num(def.drive.wheel * 1000) })],
      ['robot.speed', t('robot.speedValue', { v: num(wheelSpeed(def.drive), 1) })],
      def.second
        ? ['robot.turrets', t('robot.turretsValue', { deg: num((def.shooter.turretLimit * 180) / Math.PI) })]
        : ['robot.turret', t('robot.turretValue', { deg: num((def.shooter.turretLimit * 180) / Math.PI) })],
      ['robot.intakes', def.intakes.length > 1 ? t('robot.bothKinds') : def.intakes[0].toUpperCase()],
      ['robot.flowerMode', t(def.arm ? 'robot.flowerModeYes' : 'robot.flowerModeNo')],
    ];
    clear(this.info);
    this.info.append(
      h('div', { class: 'ms-info-name' }, def.name, h('span', {}, ` · ${def.team} ${def.number}`)),
      h('dl', {}, ...rows.flatMap(([label, value]) => [h('dt', {}, t(label)), h('dd', {}, value)])),
    );
  }
}
