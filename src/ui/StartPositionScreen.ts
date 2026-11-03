// Picking where the robot starts (manual G304), with the field seen from above and the driver's
// wall at the bottom. The left stick (or the movement keys) moves the robot, the right stick (or
// the turn keys) turns it; the mouse drags it and its wheel turns it. The walls and the center line
// stop the robot; the tint over it is green where it may start and red where it may not, with the
// rule it breaks. Save keeps the start for this robot, Standard puts it back on its usual spot
// (Save then forgets the start of its own), Cancel leaves the old start as it was.

import { checkStart, clampStart, keepOnWalls, type Outline, type StartField, type StartPose, type StartProblem } from '../field/startPose';
import type { InputManager } from '../input/InputManager';
import { keyLabel } from '../input/bindings';
import type { PadModel } from '../input/gamepad';
import { controlLabel } from '../input/labels';
import type { RobotConfig } from '../robot/robotConfig';
import { h } from './dom';
import { ht, t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';

/** Full stick: m/s and rad/s */
const SPEED = 0.6;
const TURN = 1.6;
const DEAD_ZONE = 0.12;
/** Turned to within this of a multiple of 45°, the robot snaps square to it, rad */
const SNAP = (3 * Math.PI) / 180;
/** One notch of the mouse wheel turns this much, rad */
const WHEEL_STEP = Math.PI / 12;

const PROBLEM_TEXT: Record<StartProblem, TextKey> = {
  side: 'start.side',
  wall: 'start.wall',
  flower: 'start.flower',
  loading: 'start.loading',
  garden: 'start.garden',
  robot: 'start.robot',
};

export interface StartPositionSetup {
  /** Shown in the title */
  robotName: string;
  cfg: RobotConfig;
  field: StartField;
  /** Where the robot starts now (red side) */
  current: StartPose;
  /** Its usual spot (red side) */
  standard: StartPose;
  /** Robots of its own alliance that are already placed (red side) */
  others: Outline[];
}

export interface StartPositionActions {
  /** The robot moved: draw it there (red side) */
  moved(pose: StartPose, problem: StartProblem | null): void;
  /** The floor under the mouse (red side), null off the floor */
  floorPoint(clientX: number, clientY: number): [number, number] | null;
  /** null: the usual spot */
  save(pose: StartPose | null): void;
  cancel(): void;
}

const same = (a: StartPose, b: StartPose) => Math.hypot(a.x - b.x, a.z - b.z) < 0.002 && Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw))) < 0.002;

export class StartPositionScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  /** Sticks and buttons are read here, not by the menu navigation */
  readonly blocksNav = true;
  private setup: StartPositionSetup | null = null;
  private pose: StartPose = { x: 0, z: 0, yaw: 0 };
  private problem: StartProblem | null = null;
  private lastTime = 0;
  private turning = false;
  /** The frame that opened the screen still has the key or button that opened it */
  private fresh = true;
  /** Dragging with the mouse: the grab point's offset from the robot center */
  private grab: [number, number] | null = null;
  private model: PadModel | null = null;
  private moveKeys = '';
  private turnKeys = '';

  private readonly panel: HTMLElement;
  private readonly robotName = h('div', { class: 'ms-mode' });
  private readonly status = h('div', { class: 'sp-status' });
  private readonly hintMove = h('li', {});
  private readonly hintTurn = h('li', {});
  private readonly buttons: Record<'save' | 'standard' | 'cancel', { el: HTMLButtonElement; key: HTMLElement }>;

  constructor(private readonly actions: StartPositionActions) {
    const button = (label: TextKey, cls: string, onclick: () => void) => {
      const key = h('kbd', {});
      // No focus from a click: Enter and Space belong to the shortcuts.
      const el = h('button', { class: `sp-btn ${cls}`, tabindex: '-1', onclick, onmousedown: (e: MouseEvent) => e.preventDefault() }, key, ht('span', {}, label));
      return { el, key };
    };
    this.buttons = {
      save: button('start.save', 'sp-save', () => this.save()),
      standard: button('start.standard', '', () => this.toStandard()),
      cancel: button('start.cancel', '', () => this.actions.cancel()),
    };
    const panel = (this.panel = h('div', { class: 'ms-panel sp-panel' },
      ht('div', { class: 'ms-title' }, 'start.title'),
      this.robotName,
      ht('div', { class: 'sp-rule' }, 'start.rule'),
      this.status,
      h('ul', { class: 'sp-hints' }, this.hintMove, this.hintTurn),
      h('div', { class: 'sp-buttons' }, this.buttons.save.el, this.buttons.standard.el, this.buttons.cancel.el)));
    this.el = h('div', { class: 'screen menu-start' }, panel);
    this.nav = new MenuNav(this.el, () => this.actions.cancel());

    this.el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || panel.contains(e.target as Node) || !this.setup) return;
      const p = this.actions.floorPoint(e.clientX, e.clientY);
      if (!p) return;
      // Grabbed by its body it keeps the grip; anywhere else it jumps under the mouse.
      this.grab = this.inside(p) ? [this.pose.x - p[0], this.pose.z - p[1]] : [0, 0];
      this.el.setPointerCapture(e.pointerId);
      this.dragTo(e);
    });
    this.el.addEventListener('pointermove', e => this.grab && this.dragTo(e));
    const drop = () => (this.grab = null);
    this.el.addEventListener('pointerup', drop);
    this.el.addEventListener('pointercancel', drop);
    this.el.addEventListener('wheel', e => {
      if (!this.setup || panel.contains(e.target as Node)) return;
      e.preventDefault();
      // Wheel down turns right (clockwise from above), in whole steps.
      this.turnTo((Math.round(this.pose.yaw / WHEEL_STEP) - Math.sign(e.deltaY)) * WHEEL_STEP);
    }, { passive: false });
  }

  open(setup: StartPositionSetup, moveKeys: string, turnKeys: string): void {
    this.setup = setup;
    this.moveKeys = moveKeys;
    this.turnKeys = turnKeys;
    this.robotName.textContent = setup.robotName;
    this.fresh = true;
    this.grab = null;
    this.model = null;
    this.lastTime = performance.now();
    (document.activeElement as HTMLElement | null)?.blur();
    this.place(setup.current);
  }

  /** Where the panel is in the window: the field is shown in the rest. */
  panelRect(): DOMRect {
    return this.panel.getBoundingClientRect();
  }

  update(input: InputManager): void {
    const setup = this.setup;
    if (!setup) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (input.model1 !== this.model) this.showKeys(input.model1);
    if (this.fresh) {
      this.fresh = false;
      return;
    }
    const keys = input.keyboard;
    if (input.menuPressed('a') || keys.pressed('Enter') || keys.pressed('NumpadEnter')) return this.save();
    if (input.menuPressed('b') || keys.pressed('Escape')) return this.actions.cancel();
    if (input.menuPressed('y') || keys.pressed('KeyR')) return this.toStandard();

    const { lx, ly, rx } = input.driveSticks();
    const live = (v: number) => (Math.abs(v) > DEAD_ZONE ? v : 0);
    const [forward, right, turn] = [-live(ly), live(lx), live(rx)];
    if (!forward && !right && !turn) {
      // Let go of the turn: square to the nearest 45° if it is that close.
      if (this.turning) {
        this.turning = false;
        const square = Math.round(this.pose.yaw / (Math.PI / 4)) * (Math.PI / 4);
        if (Math.abs(square - this.pose.yaw) < SNAP) this.turnTo(square);
      }
      return;
    }
    this.turning = !!turn;
    // A right turn lowers the yaw; on the red side forward is +X (away from the drivers) and right is +Z.
    const turned = turn ? keepOnWalls(this.pose, { ...this.pose, yaw: this.pose.yaw - turn * TURN * dt }, setup.cfg, setup.field.wall) : this.pose;
    this.place({ x: turned.x + forward * SPEED * dt, z: turned.z + right * SPEED * dt, yaw: turned.yaw });
  }

  /** Turned in place, still touching the walls it touched. */
  private turnTo(yaw: number): void {
    const setup = this.setup!;
    this.place(keepOnWalls(this.pose, { ...this.pose, yaw }, setup.cfg, setup.field.wall));
  }

  private place(pose: StartPose): void {
    const setup = this.setup!;
    this.pose = clampStart(pose, setup.cfg, setup.field.wall);
    const problem = checkStart(this.pose, setup.cfg, setup.field, setup.others);
    this.problem = problem;
    this.status.textContent = t(problem ? PROBLEM_TEXT[problem] : 'start.ok');
    this.status.classList.toggle('sp-bad', !!problem);
    this.status.classList.remove('sp-shake');
    this.buttons.save.el.classList.toggle('sp-off', !!problem);
    this.actions.moved(this.pose, problem);
  }

  private save(): void {
    const setup = this.setup;
    if (!setup) return;
    if (this.problem) {
      // Not allowed there: the reason shakes instead.
      this.status.classList.remove('sp-shake');
      void this.status.offsetWidth;
      this.status.classList.add('sp-shake');
      return;
    }
    this.actions.save(same(this.pose, setup.standard) ? null : this.pose);
  }

  private toStandard(): void {
    if (this.setup) this.place(this.setup.standard);
  }

  private dragTo(e: PointerEvent): void {
    const p = this.actions.floorPoint(e.clientX, e.clientY);
    if (p && this.grab) this.place({ ...this.pose, x: p[0] + this.grab[0], z: p[1] + this.grab[1] });
  }

  /** The point is on the robot's footprint (an oriented box around its center). */
  private inside([x, z]: [number, number]): boolean {
    const { cfg } = this.setup!;
    const dx = x - this.pose.x;
    const dz = z - this.pose.z;
    const along = dx * Math.cos(this.pose.yaw) - dz * Math.sin(this.pose.yaw);
    const across = dx * Math.sin(this.pose.yaw) + dz * Math.cos(this.pose.yaw);
    return Math.abs(along) <= cfg.length / 2 && Math.abs(across) <= cfg.width / 2;
  }

  /** The keys and buttons of whatever drives the menus now. */
  private showKeys(model: PadModel): void {
    this.model = model;
    const pad = model !== 'keyboard';
    const b = this.buttons;
    b.save.key.textContent = pad ? controlLabel(model, 'a').text : 'Enter';
    b.standard.key.textContent = pad ? controlLabel(model, 'y').text : 'R';
    b.cancel.key.textContent = pad ? controlLabel(model, 'b').text : 'Esc';
    this.hintMove.textContent = t('start.hintMove', { keys: pad ? t('start.leftStick') : this.moveKeys });
    this.hintTurn.textContent = t('start.hintTurn', { keys: pad ? t('start.rightStick') : this.turnKeys });
  }
}

/** The movement and turn keys as the hints show them ("W A S D", "Q / E"). */
export function startKeys(keys: Record<'forward' | 'left' | 'backward' | 'right' | 'turnLeft' | 'turnRight', string>): [string, string] {
  return [
    [keys.forward, keys.left, keys.backward, keys.right].map(keyLabel).join(' '),
    `${keyLabel(keys.turnLeft)} / ${keyLabel(keys.turnRight)}`,
  ];
}
