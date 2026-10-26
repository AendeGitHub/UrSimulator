// In-game overlay, kept to what an FTC driver actually sees: the field timer with the scores and
// the robot battery from the Driver Station. Toasts are only for the app itself (controllers,
// connection), not for game events.

import type { ControlId, PadModel } from '../input/gamepad';
import { controlLabel } from '../input/labels';
import type { Alliance } from '../robot/robotConfig';
import { h } from './dom';

export interface HudState {
  alliance: Alliance;
  clock: { text: string; label: string; urgent: boolean };
  score: Record<Alliance, number>;
  /** Worst card each alliance has this match */
  cards: Record<Alliance, 'none' | 'yellow' | 'red'>;
  /** The driven robot's battery; null when watching without a robot */
  battery: { voltage: number; min: number } | null;
}

export function keyChip(model: PadModel, control: ControlId): HTMLElement {
  const label = controlLabel(model, control);
  return h('span', { class: 'key', style: label.color ? { color: label.color } : undefined }, label.text);
}

/** Battery outline with − and + like the Driver Station icon. */
function batteryIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 44 24');
  svg.setAttribute('class', 'battery-icon');
  svg.innerHTML =
    '<rect x="1.5" y="1.5" width="37" height="21" rx="3" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<rect x="39" y="7.5" width="4" height="9" rx="1" fill="currentColor"/>' +
    '<rect x="8" y="11" width="7" height="2.4" fill="currentColor"/>' +
    '<rect x="24" y="11" width="7" height="2.4" fill="currentColor"/><rect x="26.3" y="8.7" width="2.4" height="7" fill="currentColor"/>';
  return svg;
}

/** Driver Station colours: green is fine, yellow is getting low, red is about to brown out. */
const batteryLevel = (v: number) => (v >= 12 ? 'ok' : v >= 11 ? 'low' : 'critical');
const volts = (v: number) => `${v.toFixed(2)} V`;

export class Hud {
  readonly el = h('div', { class: 'hud' });
  private readonly scoreRed = h('div', { class: 'score score-red' });
  private readonly scoreBlue = h('div', { class: 'score score-blue' });
  private readonly clock = h('div', { class: 'clock-time' });
  private readonly clockLabel = h('div', { class: 'clock-label' });
  private readonly battery = h('div', { class: 'battery' });
  private readonly batteryNow = h('div', { class: 'battery-now' });
  private readonly batteryMin = h('div', { class: 'battery-min' });
  private readonly toasts = h('div', { class: 'toasts' });

  constructor() {
    this.battery.append(batteryIcon(), h('div', { class: 'battery-text' }, this.batteryNow, this.batteryMin));
    this.el.append(
      h('div', { class: 'hud-top' },
        h('div', { class: 'scoreboard' }, this.scoreRed, h('div', { class: 'clock' }, this.clock, this.clockLabel), this.scoreBlue)),
      h('div', { class: 'hud-bottom' }, this.battery),
      this.toasts,
    );
  }

  update(s: HudState): void {
    this.scoreRed.textContent = String(s.score.red);
    this.scoreBlue.textContent = String(s.score.blue);
    this.scoreRed.dataset.card = s.cards.red;
    this.scoreBlue.dataset.card = s.cards.blue;
    this.scoreRed.classList.toggle('mine', s.alliance === 'red');
    this.scoreBlue.classList.toggle('mine', s.alliance === 'blue');
    this.clock.textContent = s.clock.text;
    this.clock.classList.toggle('urgent', s.clock.urgent);
    this.clockLabel.textContent = s.clock.label;

    this.battery.hidden = !s.battery;
    if (s.battery) {
      this.battery.dataset.level = batteryLevel(s.battery.voltage);
      this.batteryNow.textContent = volts(s.battery.voltage);
      this.batteryMin.textContent = `( ${volts(s.battery.min)} )`;
    }
  }

  toast(text: string): void {
    const t = h('div', { class: 'toast' }, text);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('toast-out'), 2200);
    setTimeout(() => t.remove(), 2700);
  }
}
