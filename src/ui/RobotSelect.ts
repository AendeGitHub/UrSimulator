// Robot selection before a match, laid out like MoSim: Back button top left, the robot on the
// field in the open area, "Match settings" down the right with the Start button, robot cards
// along the bottom. The page is built once; changes only update texts and classes, so logos are
// never re-created. With a second gamepad connected, its player picks a robot and an alliance in
// extra rows and the game is played on a split screen. The AI can play too, 1 vs 1 or 2 vs 2, at
// the level picked here.

import { AI_LEVELS, type AiLevel } from '../ai/level';
import { CAMERA_MODES, cameraName, type CameraMode } from '../camera/CameraRig';
import type { InputManager } from '../input/InputManager';
import { cleanName } from '../net/records';
import type { Alliance } from '../robot/robotConfig';
import { playableRobots } from '../robot/customStore';
import { ROBOTS, robotById, turretsOf, wheelSpeed, type RobotDefinition } from '../robot/robots';
import type { BallKind } from '../sim/BallSim';
import { clear, h } from './dom';
import { ht, language, t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

export type SelectPurpose = 'match' | 'practice';

/** With two gamepads: its own robot on a split screen, or the mechanisms of gamepad1's robot (FTC). */
export type Pad2Role = 'robot' | 'operator';

/**
 * The AI in a game at this computer: none; a robot against gamepad1's (1 vs 1); or one on every
 * free driver station for a 2 vs 2 (alone: a partner and two opponents; two players in one
 * alliance: two opponents; in different ones: a partner each).
 */
export type Opponent = 'none' | 'ai' | 'ai2v2';

/** The AI that plays: two players on a split screen get the 2 vs 2 instead of a 1 vs 1. */
export const opponentIn = (opponent: Opponent, split: boolean): Opponent => (split && opponent === 'ai' ? 'ai2v2' : opponent);

const LEVEL_NAMES: Record<AiLevel, TextKey> = { easy: 'ai.easy', medium: 'ai.medium', hard: 'ai.hard' };
/** An AI level in the interface language. */
export const aiLevelName = (level: AiLevel): string => t(LEVEL_NAMES[level]);

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
  opponent: Opponent;
  /** The AI's robot (every AI robot in a 2 vs 2) */
  aiRobot: string;
  /** How well the AI drives */
  aiLevel: AiLevel;
}

/** Two gamepads are connected and gamepad2 drives a robot of its own. */
export const isSplit = (input: InputManager, settings: Pick<SelectSettings, 'pad2'>): boolean =>
  !!input.slotInfo(1) && settings.pad2 === 'robot';

export interface SelectActions {
  /** Settings changed (also used to update the 3D preview) */
  change(settings: SelectSettings): void;
  start(purpose: SelectPurpose): void;
  /** Pick where gamepad1's robot starts */
  startPosition(): void;
  /** The robot has a start of its own */
  hasStart(robot: string): boolean;
  /** The Workshop: a robot of the player's own to edit, or the list to make one */
  workshop(robot: string | null): void;
  back(): void;
}

const TITLES: Record<SelectPurpose, TextKey> = { match: 'menu.match', practice: 'menu.practice' };
const allianceText = (a: Alliance) => t(a === 'red' ? 'select.red' : 'select.blue');
const DRIVE_TEXT: Record<'mecanum' | 'swerve' | 'tank', TextKey> = { mecanum: 'robot.driveValue', swerve: 'robot.driveSwerve', tank: 'robot.driveTank' };
/** How a robot's shots spin (ShooterSpec.spin), for its card. */
export const spinName = (spin: number): TextKey => (spin < 0 ? 'robot.spinBack' : spin === 0 ? 'robot.spinNone' : spin < 0.5 ? 'robot.spinWeak' : 'robot.spinFront');

/** The robot after `id` among those a player here can pick (their own after the teams'). */
function nextRobot(id: string): string {
  const robots = playableRobots(ROBOTS);
  return robots[(robots.indexOf(robotById(id)) + 1) % robots.length].id;
}

/** The card a robot is on: one built from another's CAD shares that robot's card. */
const cardOf = (def: RobotDefinition): string => def.basedOn ?? def.id;

/** A card's robots: the one whose CAD it is, then those built from it (the switch goes through them). */
const builds = (card: string): RobotDefinition[] => [...ROBOTS.filter(r => r.id === card), ...ROBOTS.filter(r => r.basedOn === card)];

/** What a robot can do, for its card: its name and team, then the team's figures. */
export function robotInfo(def: RobotDefinition): HTMLElement[] {
  const num = (v: number, digits = 0) => v.toLocaleString(language(), { maximumFractionDigits: digits });
  // A player's robot is no faster than the Workshop allows, whatever its motors.
  const speed = def.custom ? def.config.drive.maxWheelSpeed : wheelSpeed(def.drive);
  const turrets = turretsOf(def);
  const degrees = (rad: number) => num((rad * 180) / Math.PI);
  const widest = Math.max(...turrets.map(tr => tr.shooter.turretLimit));
  // Two turrets with a lane each, for POLLEN and for NECTAR (Silver Bullet Blaster, Sirius Shadow).
  const sorted = turrets.length === 2 && turrets[0].kinds?.join() === 'pollen' && turrets[1].kinds?.join() === 'nectar';
  const kinds = (k: readonly BallKind[]) => (k.length > 1 ? t('robot.bothKinds') : k[0].toUpperCase());
  const flywheel = def.shooter.flywheelMass;
  const rows: [TextKey, string][] = [
    ['robot.rapidFire', t('robot.rapidFireValue', { s: num(def.shooter.rapidFire, 2) })],
    ['robot.mass', t('robot.massValue', { kg: num(def.config.mass, 1) })],
    ['robot.drive', t(DRIVE_TEXT[def.config.drive.type ?? 'mecanum'], { rpm: def.drive.rpm, mm: num(def.drive.wheel * 1000) })],
    ['robot.speed', t('robot.speedValue', { v: num(speed, 1) })],
    turrets.length > 1
      ? ['robot.turrets', t(sorted ? 'robot.turretsValue' : widest ? 'robot.turretsCount' : 'robot.turretsFixed', { n: turrets.length, deg: degrees(widest) })]
      : ['robot.turret', widest ? t('robot.turretValue', { deg: degrees(widest) }) : t('robot.turretFixed')],
    // The team's figures where they gave them: the flywheel's weight, the intake motor's speed.
    ...(flywheel ? [['robot.flywheel', t('robot.flywheelValue', { g: num(flywheel * 1000) })] as [TextKey, string]] : []),
    ['robot.intakes', def.backIntake ? t('robot.intakesTwo', { front: kinds(def.intakes), back: kinds(def.backIntake.kinds) }) : `${kinds(def.intakes)}${def.intakeRpm ? ` · ${def.intakeRpm} RPM` : ''}`],
    ['robot.flowerMode', t(def.arm ? 'robot.flowerModeYes' : 'robot.flowerModeNo')],
    ['robot.spin', t(spinName(def.shooter.spin))],
  ];
  // A team robot's team and number; a player's own robot, what they gave. A robot named after its
  // team (Mechatronics') shows just the number, a company's (Offset's) just the company.
  const team = def.custom ? def.custom.team || t('workshop.customRobot') : def.team;
  const number = def.custom ? def.custom.number : def.number;
  const who = team === def.name ? number : def.by ? team : `${team}${number ? ` ${number}` : ''}`;
  return [
    h('div', { class: 'ms-info-name' }, def.name, h('span', {}, who ? ` · ${who}` : '')),
    h('dl', {}, ...rows.flatMap(([label, value]) => [h('dt', {}, t(label)), h('dd', {}, value)])),
  ];
}

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
  private readonly opponent: HTMLButtonElement;
  private readonly opponentRow: HTMLElement;
  private readonly aiRobot: HTMLButtonElement;
  private readonly aiRobotRow: HTMLElement;
  private readonly aiLevel: HTMLButtonElement;
  private readonly aiLevelRow: HTMLElement;
  private readonly robotsTitle = h('div', { class: 'ms-title ms-title-left' });
  private readonly camera: HTMLButtonElement;
  private readonly drive: HTMLButtonElement;
  private readonly startPos: HTMLButtonElement;
  private readonly nameRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly start: HTMLButtonElement;
  /** What the picked robot can do: the team's figures */
  private readonly info = h('div', { class: 'ms-info' });
  /** Changes a robot of the player's own in the Workshop */
  private readonly edit: HTMLButtonElement;
  /** Switches a robot built from one CAD by two teams to the other team's build (WXYZ ⇄ RoboRangers) */
  private readonly switchCad: HTMLButtonElement;
  /** "Robot by" and the logo of the company that designed the picked robot, a link to its page */
  private readonly by: HTMLButtonElement;
  private readonly byLogo = h('img', { alt: '' });
  private readonly cards = new Map<string, HTMLButtonElement>();
  /** The robot name under each card's logo */
  private readonly cardNames = new Map<string, HTMLElement>();
  /** The corner logo of each robot built from another's CAD, on that robot's card */
  private readonly badges = new Map<string, HTMLElement>();
  /** The build last picked on each card, which the card picks again */
  private readonly picked = new Map<string, string>();
  private readonly cardRow = h('div', { class: 'ms-cards' });
  /** The robots the cards were made for (the player's own come and go in the Workshop) */
  private cardKey = '';

  constructor(private settings: SelectSettings, private readonly actions: SelectActions) {
    /** A settings row: label on the left, a blue drop-down-style button that cycles the value. */
    const row = (label: TextKey, control: HTMLElement) => h('div', { class: 'ms-row' }, ht('span', { class: 'ms-label' }, label), control);
    const choice = (onclick: () => void) => h('button', { class: 'ms-select', onclick });
    this.alliance = choice(() => this.set({ alliance: this.settings.alliance === 'red' ? 'blue' : 'red' }));
    this.camera = choice(() => this.set({ camera: CAMERA_MODES[(CAMERA_MODES.indexOf(this.settings.camera) + 1) % CAMERA_MODES.length] }));
    this.drive = choice(() => this.set({ fieldCentric: !this.settings.fieldCentric }));
    this.startPos = choice(() => this.actions.startPosition());
    this.pad2 = choice(() => this.set({ pad2: this.settings.pad2 === 'robot' ? 'operator' : 'robot' }));
    this.robot2 = choice(() => this.set({ robot2: nextRobot(this.settings.robot2) }));
    this.alliance2 = choice(() => this.set({ alliance2: this.settings.alliance2 === 'red' ? 'blue' : 'red' }));
    this.opponent = choice(() => this.set({ opponent: this.nextOpponent() }));
    this.aiLevel = choice(() => this.set({ aiLevel: AI_LEVELS[(AI_LEVELS.indexOf(this.settings.aiLevel) + 1) % AI_LEVELS.length] }));
    this.aiRobot = choice(() => this.set({ aiRobot: nextRobot(this.settings.aiRobot) }));
    this.opponentRow = row('select.opponent', this.opponent);
    this.aiLevelRow = row('select.aiLevel', this.aiLevel);
    this.aiRobotRow = row('select.aiRobot', this.aiRobot);
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
    this.edit = ht('button', { class: 'ms-edit', onclick: () => this.actions.workshop(this.settings.robot) }, 'select.editRobot');
    this.switchCad = h('button', { class: 'ms-edit', onclick: () => this.switchBuild() });
    // A brand line like the main menu's "Presented by": the same words in every language.
    this.by = h('button', { class: 'ms-by', onclick: () => this.openMaker() }, h('span', {}, 'Robot by'), this.byLogo);
    this.makeCards();

    this.el = h('div', { class: 'screen menu-select' },
      ht('button', { class: 'ms-back', onclick: this.actions.back }, 'common.backArrow'),
      h('div', { class: 'ms-panel ms-settings' },
        ht('div', { class: 'ms-title' }, 'select.title'),
        h('div', { class: 'ms-mode-row' }, this.mode, this.by),
        row('select.alliance', this.alliance),
        row('select.camera', this.camera),
        row('select.drive', this.drive),
        row('select.startPos', this.startPos),
        this.opponentRow,
        this.aiLevelRow,
        this.aiRobotRow,
        this.pad2Row,
        this.robot2Row,
        this.alliance2Row,
        this.nameRow,
        this.info,
        this.start),
      h('div', { class: 'ms-panel ms-robots' },
        this.robotsTitle,
        this.cardRow),
    );
    this.nav = new MenuNav(this.el, actions.back);
  }

  /** A card for every robot (the player's own after the teams'), and one that makes a new robot. */
  private makeCards(): void {
    const robots = playableRobots(ROBOTS);
    const key = robots.map(r => `${r.id}#${r.model}#${r.teamLogo.length}`).join('|');
    if (key === this.cardKey) return;
    this.cardKey = key;
    this.cards.clear();
    this.cardNames.clear();
    this.badges.clear();
    const logo = (r: RobotDefinition, cls = '') => h('img', { class: cls, src: r.teamLogo, alt: r.team, style: r.logoBackground ? `background: ${r.logoBackground}` : '' });
    // A robot built from another's CAD is on that robot's card, with its team's logo in the corner.
    for (const r of robots.filter(x => !x.basedOn)) {
      const corner = builds(r.id).slice(1).map(b => {
        const badge = logo(b, 'ms-card-badge');
        this.badges.set(b.id, badge);
        return badge;
      });
      // The robot's name: a team can bring more than one.
      const name = h('span', {}, r.name);
      this.cardNames.set(r.id, name);
      this.cards.set(r.id, h('button', { class: `ms-card ${r.custom ? 'ms-card-own' : ''}`, onclick: () => this.set({ robot: this.picked.get(r.id) ?? r.id }) },
        logo(r), ...corner, name));
    }
    const create = h('button', { class: 'ms-card ms-card-new', onclick: () => this.actions.workshop(null) },
      h('span', { class: 'ms-card-plus' }, '+'), ht('span', {}, 'select.newRobot'));
    this.cardRow.replaceChildren(...this.cards.values(), create);
  }

  open(purpose: SelectPurpose, settings: SelectSettings): void {
    this.purpose = purpose;
    this.settings = { ...settings };
    this.picked.set(cardOf(robotById(settings.robot)), settings.robot);
    this.nameInput.value = settings.name;
    this.makeCards();
    this.refresh();
  }

  /** Back from picking the start (or from the Workshop): its row and the cards show what changed. */
  onShow(): void {
    this.makeCards();
    this.refresh();
  }

  /** Shows or hides gamepad2's rows as it connects and disconnects. */
  update(input: InputManager): void {
    const twoPads = !!input.slotInfo(1);
    if (twoPads === this.twoPads) return;
    this.twoPads = twoPads;
    this.refresh();
  }

  /** Two players on a split screen */
  private get split(): boolean {
    return this.twoPads && this.settings.pad2 === 'robot';
  }

  /** The AI row's next choice: alone none, 1 vs 1 or 2 vs 2; two players, none or 2 vs 2. */
  private nextOpponent(): Opponent {
    const choices: Opponent[] = this.split ? ['none', 'ai2v2'] : ['none', 'ai', 'ai2v2'];
    return choices[(choices.indexOf(opponentIn(this.settings.opponent, this.split)) + 1) % choices.length];
  }

  private set(patch: Partial<SelectSettings>): void {
    this.settings = { ...this.settings, ...patch };
    if (patch.robot) this.picked.set(cardOf(robotById(patch.robot)), patch.robot);
    this.actions.change(this.settings);
    this.refresh();
  }

  /** The next team's build of the picked robot's CAD. */
  private switchBuild(): void {
    const list = builds(cardOf(robotById(this.settings.robot)));
    const focused = document.activeElement === this.switchCad;
    this.set({ robot: list[(list.findIndex(r => r.id === this.settings.robot) + 1) % list.length].id });
    // The panel was rebuilt around the button: a controller's cursor stays on it.
    if (focused) this.switchCad.focus({ preventScroll: true });
  }

  /** The page of the company that designed the picked robot, in the browser (from the desktop app too). */
  private openMaker(): void {
    const by = robotById(this.settings.robot).by;
    if (by) window.open(by.url, '_blank', 'noopener');
  }

  private refresh(): void {
    const def = robotById(this.settings.robot);
    const s = this.settings;
    const split = this.split;
    const opponent = opponentIn(s.opponent, split);
    const vsAi = opponent !== 'none';
    const aiNote = vsAi ? ` · ${t(opponent === 'ai' ? 'select.vsAi' : 'select.vsAi2v2')} · ${aiLevelName(s.aiLevel)}` : '';
    this.mode.textContent = `${t(TITLES[this.purpose])}${split ? ` · ${t('select.splitNote')}` : ''}${aiNote}`;
    this.alliance.textContent = allianceText(s.alliance);
    this.camera.textContent = cameraName(s.camera);
    this.drive.textContent = s.fieldCentric ? 'Field-centric' : 'Robot-centric';
    this.startPos.textContent = t(this.actions.hasStart(s.robot) ? 'start.own' : 'start.standard');
    // Two players: the AI takes the other alliance's stations, or partners one each.
    this.opponent.textContent = t(opponent === 'none' ? 'select.opponentNone' : opponent === 'ai' ? 'select.opponentAi'
      : !split ? 'select.opponentAi2v2' : s.alliance2 === s.alliance ? 'select.opponentAiRivals' : 'select.opponentAiPartners');
    this.aiLevelRow.hidden = this.aiRobotRow.hidden = !vsAi;
    this.aiLevel.textContent = aiLevelName(s.aiLevel);
    this.aiRobot.textContent = robotById(s.aiRobot).name;
    this.pad2Row.hidden = !this.twoPads;
    this.pad2.textContent = t(s.pad2 === 'robot' ? 'select.pad2Robot' : 'select.pad2Operator');
    this.robot2Row.hidden = this.alliance2Row.hidden = !split;
    this.robot2.textContent = robotById(s.robot2).name;
    this.alliance2.textContent = allianceText(s.alliance2);
    // The cards pick gamepad1's robot.
    this.robotsTitle.textContent = split ? `${t('select.robots')} · gamepad1` : t('select.robots');
    // Only full solo matches go into the high score table.
    this.nameRow.hidden = this.purpose !== 'match' || split || vsAi;
    this.start.textContent = t('select.start');
    const card = cardOf(def);
    for (const [id, el] of this.cards) el.classList.toggle('ms-card-on', id === card);
    // A card shows the build last picked on it: its name, and its team's corner logo lit.
    for (const [id, name] of this.cardNames) name.textContent = robotById(this.picked.get(id) ?? id).name;
    for (const [id, badge] of this.badges) badge.classList.toggle('ms-card-badge-on', this.picked.get(cardOf(robotById(id))) === id);
    this.cards.get(card)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    clear(this.info);
    const [name, figures] = robotInfo(def);
    // A robot of the player's own can be changed from here, next to its name.
    if (def.custom) name.append(this.edit);
    // One CAD built by two teams: the other team's build is a press away.
    const list = builds(card);
    if (list.length > 1) {
      this.switchCad.textContent = t('select.switchCad', { team: list[(list.findIndex(r => r.id === def.id) + 1) % list.length].team });
      name.append(this.switchCad);
    }
    this.info.append(name, figures);
    // A company's robot: who designed it, with their page a press away (Offset's CAD licence asks
    // for both).
    this.by.hidden = !def.by;
    if (def.by && this.byLogo.getAttribute('src') !== def.by.logo) {
      this.byLogo.src = def.by.logo;
      this.byLogo.alt = def.by.name;
      this.by.title = new URL(def.by.url).hostname;
    }
  }
}
