// In-game overlay: scoreboard and timer, controller status, mechanisms, hints, toasts.

import { MODEL_NAMES, type ControlId, type PadModel } from '../input/gamepad';
import { controlLabel } from '../input/labels';
import type { Alliance } from '../robot/robotConfig';
import type { BallColor } from '../sim/BallSim';
import type { ShooterStatus } from '../sim/Mechanisms';
import { h } from './dom';

export interface HudState {
  /** Watching an online game without a robot */
  spectator: boolean;
  model: PadModel;
  gamepad2: PadModel | null;
  fieldCentric: boolean;
  slow: boolean;
  headingDeg: number;
  speed: number;
  camera: string;
  alliance: Alliance;
  fps: number;
  clock: { text: string; label: string; urgent: boolean };
  score: Record<Alliance, number>;
  tips: Record<Alliance, number>;
  stored: BallColor[];
  capacity: number;
  shooter: ShooterStatus;
  shotSpeed: number;
  targetDistance: number;
}

export function keyChip(model: PadModel, control: ControlId): HTMLElement {
  const label = controlLabel(model, control);
  return h('span', { class: 'key', style: label.color ? { color: label.color } : undefined }, label.text);
}

const SHOOTER_TEXT: Record<ShooterStatus, string> = {
  off: 'выключен',
  spinning: 'разгон…',
  ready: 'готов',
  tooFar: 'слишком далеко',
};

export class Hud {
  readonly el = h('div', { class: 'hud' });
  private readonly pad = h('div', { class: 'hud-pad' });
  private readonly mode = h('div', { class: 'hud-mode' });
  private readonly stats = h('div', { class: 'hud-stats' });
  private readonly storage = h('div', { class: 'hud-storage' });
  private readonly shooter = h('div', { class: 'hud-shooter' });
  private readonly camera = h('div', { class: 'hud-camera' });
  private readonly hints = h('div', { class: 'hud-hints' });
  private readonly fps = h('div', { class: 'hud-fps' });
  private readonly scoreRed = h('div', { class: 'score score-red' });
  private readonly scoreBlue = h('div', { class: 'score score-blue' });
  private readonly clock = h('div', { class: 'clock-time' });
  private readonly clockLabel = h('div', { class: 'clock-label' });
  private readonly toasts = h('div', { class: 'toasts' });
  private lastKey = '';
  private mechKey = '';

  constructor() {
    this.el.append(
      h('div', { class: 'hud-top' },
        h('img', { src: 'assets/logo.svg', alt: 'UrSim', class: 'hud-logo' }),
        h('div', { class: 'scoreboard' }, this.scoreRed, h('div', { class: 'clock' }, this.clock, this.clockLabel), this.scoreBlue),
        this.fps),
      h('div', { class: 'hud-bottom' },
        h('div', { class: 'panel hud-left' }, this.pad, this.mode, this.storage, this.shooter, this.stats),
        h('div', { class: 'panel hud-right' }, this.camera, this.hints)),
      this.toasts,
    );
  }

  update(s: HudState): void {
    this.stats.textContent = `Курс ${s.headingDeg.toFixed(0)}° · ${s.speed.toFixed(2)} м/с`;
    this.fps.textContent = `${s.fps.toFixed(0)} FPS`;
    this.scoreRed.textContent = String(s.score.red);
    this.scoreBlue.textContent = String(s.score.blue);
    this.scoreRed.classList.toggle('mine', s.alliance === 'red');
    this.scoreBlue.classList.toggle('mine', s.alliance === 'blue');
    this.clock.textContent = s.clock.text;
    this.clock.classList.toggle('urgent', s.clock.urgent);
    this.clockLabel.textContent = `${s.clock.label} · перевороты ${s.tips.red}:${s.tips.blue}`;

    const detail = s.shooter === 'off' ? '' : ` · ${s.shotSpeed.toFixed(1)} м/с · до цели ${s.targetDistance.toFixed(1)} м`;
    for (const el of [this.storage, this.shooter, this.stats, this.mode]) el.hidden = s.spectator;
    const mechKey = `${s.stored.join()}|${s.shooter}|${detail}`;
    if (mechKey !== this.mechKey) {
      this.mechKey = mechKey;
      const dots = Array.from({ length: s.capacity }, (_, i) =>
        h('span', { class: `ball-dot ${s.stored[i] ? `ball-${s.stored[i]}` : 'ball-empty'}` }));
      this.storage.replaceChildren(h('span', { class: 'muted' }, 'Мячи '), ...dots, h('span', { class: 'muted' }, ` ${s.stored.length}/${s.capacity}`));
      this.shooter.replaceChildren(h('span', { class: 'muted' }, 'Шутер '), h('span', { class: `shooter-${s.shooter}` }, SHOOTER_TEXT[s.shooter]), detail);
    }

    // Rebuild the rest only when something visible changed.
    const key = [s.spectator, s.model, s.gamepad2, s.fieldCentric, s.slow, s.camera].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.pad.replaceChildren(
      ...(s.spectator
        ? ['Наблюдение без робота']
        : [
          h('span', { class: `dot ${s.model === 'keyboard' ? 'dot-off' : 'dot-on'}` }),
          `gamepad1: ${MODEL_NAMES[s.model]}`,
          s.gamepad2 ? h('span', { class: 'muted' }, ` · gamepad2: ${MODEL_NAMES[s.gamepad2]}`) : '',
        ]),
    );
    this.mode.replaceChildren(
      h('span', { class: 'chip' }, s.fieldCentric ? 'Field-centric' : 'Robot-centric'),
      s.slow ? h('span', { class: 'chip chip-warn' }, 'Медленно') : '',
    );
    this.camera.textContent = `Камера: ${s.camera}`;
    const m = s.model;
    const hint = (control: ControlId, text: string) => h('span', { class: 'hint' }, keyChip(m, control), text);
    this.hints.replaceChildren(
      hint('left_bumper', 'забрать'),
      hint('dpad_down', 'выкинуть'),
      hint('right_trigger', 'шутер вкл'),
      hint('left_trigger', 'выкл'),
      hint('right_bumper', 'бросок'),
      hint('left_stick_button', 'медленно'),
      hint('right_stick_button', 'камера'),
      hint('guide', 'пауза'),
    );
  }

  toast(text: string): void {
    const t = h('div', { class: 'toast' }, text);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('toast-out'), 2200);
    setTimeout(() => t.remove(), 2700);
  }
}
