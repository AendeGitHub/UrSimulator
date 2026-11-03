// Match replays for the replay studio (ui/ReplayStudio.ts): the world 30 times a second in the
// compact snapshot form (about 6 MB for a whole match), played back smoothly in between, and the
// moments worth a clip found by themselves (HIVE tips, volleys, the start and the finish).

import { lerpState } from '../net/interpolate';
import type { Alliance } from '../robot/robotConfig';
import { decodeState, encodeState } from '../sim/stateCodec';
import type { WorldState } from '../sim/state';

const CAPTURE_RATE = 30;
/** Practice has no end: only the last 10 minutes are kept (about 25 MB). */
const MAX_FRAMES = CAPTURE_RATE * 600;

export interface ReplayFrame {
  /** Seconds since the recording started (the 3-2-1 included) */
  t: number;
  /** The countdown at that moment (game/matchTimer.ts), below zero once under way */
  startIn: number;
  data: ArrayBuffer;
}

export type HighlightKind = 'start' | 'tip' | 'volley' | 'finish';

export interface Highlight {
  kind: HighlightKind;
  start: number;
  end: number;
  /** The alliance that tipped its HIVE or fired */
  alliance?: Alliance;
}

/** Records a game as it is played. */
export class ReplayRecorder {
  readonly frames: ReplayFrame[] = [];
  private time = 0;
  private next = 0;

  /** Called every frame the game runs (not behind a local pause menu). */
  capture(dt: number, world: WorldState, startIn: number): void {
    this.time += dt;
    if (this.time < this.next) return;
    this.next = this.time + 1 / CAPTURE_RATE;
    this.frames.push({ t: this.time, startIn, data: encodeState(world) });
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
  }
}

/** Plays a recording back at any moment, blending between frames. */
export class Replay {
  private cache: { i: number; a: WorldState; b: WorldState } | null = null;

  constructor(readonly frames: readonly ReplayFrame[]) {}

  get duration(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  /** Index of the last frame at or before `t`. */
  private index(t: number): number {
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  at(t: number): { world: WorldState; startIn: number } | null {
    if (!this.frames.length) return null;
    const i = this.index(Math.max(0, Math.min(t, this.duration)));
    const j = Math.min(i + 1, this.frames.length - 1);
    if (this.cache?.i !== i) this.cache = { i, a: decodeState(this.frames[i].data), b: decodeState(this.frames[j].data) };
    const fa = this.frames[i];
    const fb = this.frames[j];
    const k = j === i ? 0 : Math.max(0, Math.min(1, (t - fa.t) / (fb.t - fa.t)));
    return { world: lerpState(this.cache.a, this.cache.b, k), startIn: fa.startIn + (fb.startIn - fa.startIn) * k };
  }
}

const CLIP = {
  start: { after: 5 },
  tip: { before: 6, after: 3 },
  volley: { before: 2.5, after: 3.5 },
  finish: { before: 8 },
  /** Clips closer than this are joined into one, s */
  join: 1,
  longest: 16,
};
/** Balls leaving one robot within this time count as a volley, s */
const VOLLEY = { balls: 3, within: 1.2 };

/** The moments of a match worth a clip, in order, overlapping ones joined. */
export function findHighlights(frames: readonly ReplayFrame[]): Highlight[] {
  if (frames.length < 2) return [];
  const worlds = frames.map(f => decodeState(f.data));
  const end = frames[frames.length - 1].t;
  const found: Highlight[] = [];
  const goTime = frames.find(f => f.startIn <= 0)?.t ?? 0;
  found.push({ kind: 'start', start: 0, end: goTime + CLIP.start.after });

  // Balls each robot let go of, and when, for volleys.
  const releases = new Map<string, number[]>();
  for (let i = 1; i < frames.length; i++) {
    const t = frames[i].t;
    for (const a of ['red', 'blue'] as const) {
      if (worlds[i].tips[a] > worlds[i - 1].tips[a]) found.push({ kind: 'tip', start: t - CLIP.tip.before, end: t + CLIP.tip.after, alliance: a });
    }
    for (const r of worlds[i].robots) {
      const before = worlds[i - 1].robots.find(p => p.slot === r.slot);
      if (!before || before.status === 'off') continue;
      const fired = before.stored.length - r.stored.length;
      if (fired <= 0) continue;
      const list = releases.get(r.slot) ?? [];
      for (let n = 0; n < fired; n++) list.push(t);
      while (list.length && t - list[0] > VOLLEY.within) list.shift();
      releases.set(r.slot, list);
      if (list.length >= VOLLEY.balls) {
        found.push({ kind: 'volley', start: list[0] - CLIP.volley.before, end: t + CLIP.volley.after, alliance: r.slot.startsWith('red') ? 'red' : 'blue' });
        list.length = 0;
      }
    }
  }
  if (worlds[worlds.length - 1].period === 'post') found.push({ kind: 'finish', start: end - CLIP.finish.before, end });

  found.sort((a, b) => a.start - b.start);
  const joined: Highlight[] = [];
  for (const h of found) {
    const clip = { ...h, start: Math.max(0, h.start), end: Math.min(end, h.end) };
    const last = joined[joined.length - 1];
    if (last && clip.start - last.end < CLIP.join && Math.max(last.end, clip.end) - last.start <= CLIP.longest) {
      last.end = Math.max(last.end, clip.end);
      // A tip is the better name for a clip that has one.
      if (clip.kind === 'tip' || (last.kind !== 'tip' && clip.kind === 'volley')) {
        last.kind = clip.kind;
        last.alliance = clip.alliance;
      }
    } else {
      joined.push(clip);
    }
  }
  return joined;
}
