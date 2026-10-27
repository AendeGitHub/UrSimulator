// Tracks connected controllers and exposes them as FTC `gamepad1` / `gamepad2`.

import {
  STANDARD_MAPPING, detectModel, emptyGamepad, mergeGamepads, readGamepad,
  type ButtonId, type ControlId, type FtcGamepad, type Mapping, type PadModel,
} from './gamepad';
import { DEFAULT_BINDINGS, MECHANISM_ACTIONS, type ActionId, type Bindings } from './bindings';
import { KeyboardPad } from './keyboard';

export interface PadInfo {
  /** Index in navigator.getGamepads() */
  index: number;
  id: string;
  model: PadModel;
  /** null when the browser layout is non-standard and the player has not set up buttons yet */
  mapping: Mapping | null;
  customMapping: boolean;
}

const STORAGE_KEY = 'ursim.padMappings';

function loadMappings(): Record<string, Mapping> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function storeMappings(all: Record<string, Mapping>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage may be unavailable (private mode); mappings then last for this session only.
  }
}

export class InputManager {
  readonly keyboard = new KeyboardPad();
  /** What each button and key does (Settings → Управление) */
  bindings: Bindings = DEFAULT_BINDINGS;
  readonly gamepad1 = emptyGamepad();
  readonly gamepad2 = emptyGamepad();
  /** Every connected controller, supported or not. */
  pads: PadInfo[] = [];
  /** Browser gamepad indices driving gamepad1 / gamepad2. */
  slots: [number | null, number | null] = [null, null];

  private readonly prev1 = emptyGamepad();
  private readonly prev2 = emptyGamepad();
  private readonly prevMenu = emptyGamepad();
  private readonly menu = emptyGamepad();
  private mappings = loadMappings();

  update(): void {
    this.keyboard.update();
    Object.assign(this.prev1, this.gamepad1);
    Object.assign(this.prev2, this.gamepad2);
    Object.assign(this.prevMenu, this.menu);

    const raw = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const seen: PadInfo[] = [];
    for (const gp of raw) {
      if (!gp || !gp.connected) continue;
      const model = detectModel(gp.id);
      const custom = this.mappings[gp.id];
      seen.push({
        index: gp.index,
        id: gp.id,
        model,
        mapping: custom ?? (gp.mapping === 'standard' ? STANDARD_MAPPING : null),
        customMapping: !!custom,
      });
    }
    this.pads = seen;

    // Drop slots whose controller went away, then fill empty slots with new supported controllers.
    this.slots = this.slots.map(i => (seen.some(p => p.index === i && p.model !== 'unsupported') ? i : null)) as [number | null, number | null];
    for (const p of seen) {
      if (p.model === 'unsupported' || this.slots.includes(p.index)) continue;
      const free = this.slots.indexOf(null);
      if (free >= 0) this.slots[free] = p.index;
    }

    this.readSlot(0, raw, this.gamepad1);
    this.readSlot(1, raw, this.gamepad2);

    // Menus read controllers only: the keyboard already drives buttons natively (Tab / Enter / Space).
    Object.assign(this.menu, this.gamepad1);
    mergeGamepads(this.menu, this.gamepad2);
  }

  private padDown(pad: FtcGamepad, control: ControlId): boolean {
    const v = pad[control];
    return typeof v === 'number' ? Math.abs(v) > 0.5 : v;
  }

  /** The pads an action listens to: mechanisms both, driving and the rest only gamepad1. */
  private padsFor(action: ActionId): [FtcGamepad, FtcGamepad][] {
    const pads: [FtcGamepad, FtcGamepad][] = [[this.gamepad1, this.prev1]];
    if (MECHANISM_ACTIONS.has(action)) pads.push([this.gamepad2, this.prev2]);
    return pads;
  }

  /** The action's button or key is held. */
  held(action: ActionId): boolean {
    const control = this.bindings.pad[action];
    return this.keyboard.isDown(this.bindings.keys[action]) || this.padsFor(action).some(([now]) => this.padDown(now, control));
  }

  /** The action's button or key went down this frame. */
  triggered(action: ActionId): boolean {
    const control = this.bindings.pad[action];
    return this.keyboard.pressed(this.bindings.keys[action])
      || this.padsFor(action).some(([now, before]) => this.padDown(now, control) && !this.padDown(before, control));
  }

  /** gamepad1's sticks, or the movement keys when they are pressed. */
  driveSticks(): { lx: number; ly: number; rx: number } {
    const k = this.bindings.keys;
    const key = (code: string) => (this.keyboard.isDown(code) ? 1 : 0);
    let lx = key(k.right) - key(k.left);
    let ly = key(k.backward) - key(k.forward);
    // Diagonals on a keyboard would be faster than a stick can go.
    const mag = Math.hypot(lx, ly);
    if (mag > 1) {
      lx /= mag;
      ly /= mag;
    }
    const rx = key(k.turnRight) - key(k.turnLeft);
    const g = this.gamepad1;
    const pick = (stick: number, keys: number) => (Math.abs(keys) > Math.abs(stick) ? keys : stick);
    return { lx: pick(g.left_stick_x, lx), ly: pick(g.left_stick_y, ly), rx: pick(g.right_stick_x, rx) };
  }

  /** First controller button or trigger that went down this frame on any pad (for rebinding). */
  anyControlPressed(): ControlId | null {
    for (const [now, before] of [[this.gamepad1, this.prev1], [this.gamepad2, this.prev2]] as const) {
      for (const control of Object.keys(now) as ControlId[]) {
        if (control.includes('stick_x') || control.includes('stick_y')) continue;
        if (this.padDown(now, control) && !this.padDown(before, control)) return control;
      }
    }
    return null;
  }

  private readSlot(slot: 0 | 1, raw: (Gamepad | null)[], out: FtcGamepad): void {
    Object.assign(out, emptyGamepad());
    const index = this.slots[slot];
    if (index === null) return;
    const info = this.pads.find(p => p.index === index);
    const gp = raw[index];
    if (info?.mapping && gp) readGamepad(gp, info.mapping, out);
  }

  /** Rising edge of a button on gamepad1 or gamepad2. */
  pressed(pad: 1 | 2, button: ButtonId): boolean {
    const [now, before] = pad === 1 ? [this.gamepad1, this.prev1] : [this.gamepad2, this.prev2];
    return now[button] && !before[button];
  }

  /** A trigger pulled past halfway this frame. */
  triggerPressed(pad: 1 | 2, trigger: 'left_trigger' | 'right_trigger'): boolean {
    const [now, before] = pad === 1 ? [this.gamepad1, this.prev1] : [this.gamepad2, this.prev2];
    return now[trigger] > 0.5 && before[trigger] <= 0.5;
  }

  /** Rising edge on any controller (not the keyboard) — for menus. */
  menuPressed(button: ButtonId): boolean {
    return this.menu[button] && !this.prevMenu[button];
  }

  /** Stick flick for menu navigation (treated like a d-pad press). */
  menuDirection(): 'up' | 'down' | 'left' | 'right' | null {
    if (this.menuPressed('dpad_up')) return 'up';
    if (this.menuPressed('dpad_down')) return 'down';
    if (this.menuPressed('dpad_left')) return 'left';
    if (this.menuPressed('dpad_right')) return 'right';
    const flick = (now: number, before: number) => (Math.abs(now) > 0.6 && Math.abs(before) <= 0.6 ? Math.sign(now) : 0);
    const y = flick(this.menu.left_stick_y, this.prevMenu.left_stick_y);
    const x = flick(this.menu.left_stick_x, this.prevMenu.left_stick_x);
    if (y) return y < 0 ? 'up' : 'down';
    if (x) return x < 0 ? 'left' : 'right';
    return null;
  }

  slotInfo(slot: 0 | 1): PadInfo | undefined {
    const index = this.slots[slot];
    return index === null ? undefined : this.pads.find(p => p.index === index);
  }

  /** Controller model that drives gamepad1 (keyboard when none is connected). */
  get model1(): PadModel {
    return this.slotInfo(0)?.model ?? 'keyboard';
  }

  swapSlots(): void {
    this.slots = [this.slots[1], this.slots[0]];
  }

  rawGamepad(index: number): Gamepad | null {
    return navigator.getGamepads?.()[index] ?? null;
  }

  saveMapping(id: string, mapping: Mapping): void {
    this.mappings[id] = mapping;
    storeMappings(this.mappings);
  }

  resetMapping(id: string): void {
    delete this.mappings[id];
    storeMappings(this.mappings);
  }
}
