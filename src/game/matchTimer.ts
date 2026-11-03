// The FTC match timer, from a recording of a real field (assets/sound/match-timer.*): its sounds
// (3-2-1, start, end of AUTO, "drivers, pick up your controllers", 3-2-1, END GAME, end) and its
// display, shown on the screens behind the field (view/TimerScreens.ts). The game clock leads and
// the recording follows it: it plays with the match and holds with the pause menu. The game clock
// loses time on slow frames, so the recording runs ahead of it; it then plays a little slower, or
// waits for the match, but never jumps back over what was just heard (that said "drivers, pick up
// your controllers" twice). Outside a match the screens show the recording's "Match Has Not Started".

import { DURATION, type Period } from '../sim/Match';

/** Seconds into the recording: where playback starts (just before its 3-2-1), and where AUTO and TELEOP start. */
export const RECORDING = { from: 1.0, auto: 4.15, teleop: 42.25 };
/** A match starts after the recording's own 3-2-1. */
export const MATCH_COUNTDOWN = RECORDING.auto - RECORDING.from;
/** Outside a match: off by more than this, the screens jump to "Match Has Not Started", s */
const DRIFT = 0.25;
/**
 * In a match, how far the recording may be from the game clock (s): further behind it skips
 * ahead; further ahead it waits for the match (silent) until the match catches up; further than
 * `jump` either way (a new match, the studio's timeline) it goes straight there.
 */
const SYNC = { behind: 0.5, ahead: 0.35, resume: 0.05, jump: 3 };
/** Closer than that it plays up to this much faster or slower to meet the game clock */
const RATE_RANGE = 0.1;
const RATE_GAIN = 0.5;
const VOLUME = 0.8;

/** Seconds into the recording at a moment of a match (`startIn` s before it starts); null in practice. */
export function recordingTime(period: Period, time: number, startIn: number): number | null {
  switch (period) {
    case 'practice':
      return null;
    case 'auto':
      return startIn > 0 ? RECORDING.auto - startIn : RECORDING.auto + time;
    case 'transition':
      return RECORDING.auto + DURATION.auto + time;
    case 'teleop':
      return RECORDING.teleop + time;
    case 'post':
      return RECORDING.teleop + DURATION.teleop + time;
  }
}

/** The whole file in memory: it can jump to any moment at once, from any server. */
async function blobUrl(url: string, type: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

/** The recording's picture for the screens: kept in the page (but unseen) so every browser decodes it. */
function screenVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  return video;
}

export class MatchTimer {
  /** The picture, for the screens behind the field */
  readonly video = screenVideo();
  private readonly sound = new Audio();
  /** play() asked for and not started yet */
  private readonly starting = new WeakSet<HTMLMediaElement>();
  /** The browser blocks sound until the player clicks or presses a key on the page. */
  private soundBlocked = false;

  constructor() {
    this.sound.volume = VOLUME;
    // A tab in the background gets no frames: the game stops, and so must the recording.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this.sound.pause();
      this.video.pause();
    });
  }

  async load(audioUrl: string, videoUrl: string): Promise<void> {
    const [audio, video] = await Promise.all([blobUrl(audioUrl, 'audio/mpeg'), blobUrl(videoUrl, 'video/mp4')]);
    this.sound.src = audio;
    this.video.src = video;
  }

  set muted(on: boolean) {
    this.sound.muted = on;
  }

  /** The match sounds as a stream, for recording them with the picture (replay studio). */
  audioStream(): MediaStream | null {
    const el = this.sound as HTMLAudioElement & { captureStream?(): MediaStream; mozCaptureStream?(): MediaStream };
    return el.captureStream?.() ?? el.mozCaptureStream?.() ?? null;
  }

  /** Follows the match: `at` s into the recording, running or held; null outside a match. */
  update(at: number | null, running: boolean): void {
    running &&= at !== null;
    for (const m of [this.sound, this.video]) {
      if (!m.src) continue;
      if ((at === null || !running) && !m.paused) m.pause();
      if (at === null && m === this.sound) continue;
      const target = Math.min(at ?? RECORDING.from, Number.isFinite(m.duration) ? m.duration : Infinity);
      let lead = m.currentTime - target;
      if (!m.seeking && (at === null ? Math.abs(lead) > DRIFT : lead > SYNC.jump || lead < -SYNC.behind)) {
        m.currentTime = target;
        lead = 0;
      }
      if (at === null) continue;
      const wait = lead > SYNC.ahead || (m.paused && lead > SYNC.resume);
      if (wait && !m.paused) m.pause();
      const rate = Math.round((1 - Math.max(-RATE_RANGE, Math.min(RATE_RANGE, lead * RATE_GAIN))) * 100) / 100;
      if (m.playbackRate !== rate) m.playbackRate = rate;
      if (!running || wait || !m.paused || m.ended || this.starting.has(m) || (m === this.sound && this.soundBlocked)) continue;
      this.starting.add(m);
      m.play()
        .catch((e: unknown) => {
          if (m === this.sound && e instanceof DOMException && e.name === 'NotAllowedError') this.waitForGesture();
        })
        .finally(() => this.starting.delete(m));
    }
  }

  private waitForGesture(): void {
    this.soundBlocked = true;
    const unblock = () => {
      this.soundBlocked = false;
      window.removeEventListener('pointerdown', unblock);
      window.removeEventListener('keydown', unblock);
    };
    window.addEventListener('pointerdown', unblock);
    window.addEventListener('keydown', unblock);
  }
}
