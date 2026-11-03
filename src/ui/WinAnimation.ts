// End of a match, as at a real event: the season's "RED WINS!" / "BLUE WINS!" animation fades in
// over the field, and when it ends the results fade in over its last frame (Game.ts). A tie has
// no animation, so the results fade in over the field at once. The animations have no sound.
// Slow computers get a 720p 30 fps copy, and the field isn't drawn while the animation hides it,
// so even with Low graphics the video has the computer to itself.

import type { Alliance } from '../robot/robotConfig';
import { asset } from '../view/assets';
import { h } from './dom';

/** How long the results take to fade in over the animation (styles.css .fr-reveal), ms */
export const REVEAL_MS = 500;
/** An animation that has not started by then (still downloading) is skipped, ms */
const START_TIMEOUT_MS = 8000;
/** The fade-in (styles.css .win-anim), after which the animation hides the whole field, ms */
const FADE_MS = 1000;
/** Presses this soon after the buzzer are still the drivers': they don't skip the animation, ms */
const SKIP_GRACE_MS = 1500;
const ALLIANCES: Alliance[] = ['red', 'blue'];

export class WinAnimation {
  readonly el = h('div', { class: 'win-anim' });
  private readonly videos = {} as Record<Alliance, HTMLVideoElement>;
  private video: HTMLVideoElement | null = null;
  private done: (() => void) | null = null;
  private timer = 0;
  /** When it started, and when its fade-in ends (performance time, ms; 0: not playing yet) */
  private startedAt = 0;
  private coveredAt = 0;
  /** The light 720p 30 fps copy, for computers that step graphics down (Game.ts setQuality) */
  light = false;

  constructor() {
    this.el.hidden = true;
    for (const a of ALLIANCES) {
      const v = h('video', { playsinline: true, muted: true, preload: 'none' });
      v.muted = true;
      v.hidden = true;
      // Fades in once it really plays, so a slow start never shows a black screen.
      v.addEventListener('playing', () => {
        if (this.video !== v) return;
        this.el.classList.add('win-anim-on');
        this.coveredAt ||= performance.now() + FADE_MS;
      });
      v.addEventListener('ended', () => this.video === v && this.finish());
      v.addEventListener('error', () => this.video === v && this.finish());
      this.videos[a] = v;
      this.el.append(v);
    }
  }

  /** Starts downloading both animations; a match is long enough for them to arrive. */
  preload(): void {
    for (const a of ALLIANCES) {
      const v = this.videos[a];
      const src = asset(`assets/results/${a}-win${this.light ? '-light' : ''}.mp4`);
      if (v.getAttribute('src') === src) continue;
      v.preload = 'auto';
      v.src = src;
    }
  }

  /** Between the end of the match and the results. */
  get playing(): boolean {
    return this.done !== null;
  }

  /** Faded in over the whole field: the field needn't be drawn until the results. */
  get covering(): boolean {
    return this.done !== null && this.coveredAt > 0 && performance.now() >= this.coveredAt;
  }

  /** The winner's animation; `done` when it ends (at once after a tie or if it can't play). */
  play(winner: Alliance | null, done: () => void): void {
    this.stop();
    if (!winner) return done();
    this.preload();
    this.done = done;
    this.startedAt = performance.now();
    const v = (this.video = this.videos[winner]);
    v.currentTime = 0;
    v.hidden = false;
    this.el.hidden = false;
    this.timer = window.setTimeout(() => this.video === v && !this.el.classList.contains('win-anim-on') && this.finish(), START_TIMEOUT_MS);
    v.play().catch(() => this.video === v && this.finish());
  }

  /** Straight to the results (not on a press that was still driving at the buzzer). */
  skip(): void {
    if (this.done && performance.now() - this.startedAt >= SKIP_GRACE_MS) this.finish();
  }

  /** The results fade in over the last frame, then the animation goes away. */
  private finish(): void {
    const done = this.done;
    if (!done) return;
    this.done = null;
    clearTimeout(this.timer);
    done();
    this.timer = window.setTimeout(() => this.stop(), REVEAL_MS);
  }

  /** Gone at once: a new game or the menu. */
  stop(): void {
    clearTimeout(this.timer);
    this.done = null;
    this.coveredAt = 0;
    this.el.classList.remove('win-anim-on');
    this.el.hidden = true;
    if (this.video) {
      this.video.pause();
      this.video.hidden = true;
      this.video = null;
    }
  }
}
