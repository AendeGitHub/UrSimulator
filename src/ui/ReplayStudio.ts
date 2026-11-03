// Watching a match again (the last one from the results, or one from the archive in the career)
// from any angle. Cameras: a free one (drag to turn, wheel to zoom, right-drag to move, WASD / Q E
// to fly), a slow orbit, a "director" that follows the action, a view from above, and the game's
// own driver, audience and follow cameras. The highlights (HIVE tips, volleys, the start and the
// finish) are found by themselves. Players save it as video at 1920 × 1080 with the match sounds:
// from any moment until they stop, or the highlights as clips, one after another with a camera
// that suits each.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraRig } from '../camera/CameraRig';
import { Replay, findHighlights, type Highlight, type ReplayFrame } from '../game/replay';
import { total } from '../game/scoring';
import { matchClock } from '../sim/Match';
import type { RobotState, WorldState } from '../sim/state';
import { SLOTS, slotAlliance, type Slot } from '../sim/types';
import { h } from './dom';
import { t, type TextKey } from './i18n';

export type StudioCamera = 'free' | 'orbit' | 'action' | 'top' | 'redDriver' | 'blueDriver' | 'audience' | 'follow';
const CAMERAS: StudioCamera[] = ['free', 'orbit', 'action', 'top', 'redDriver', 'blueDriver', 'audience', 'follow'];
const SPEEDS = [0.25, 0.5, 1, 2];
const SEEK_STEP = 5;
/** Recorded clips: full HD whatever the window, at a bitrate that keeps the LED digits sharp */
const CLIP_SIZE: [number, number] = [1920, 1080];
const CLIP_BITRATE = 16_000_000;
/** The HIVE's pivot, what the orbit and the director look toward */
const HIVE = new THREE.Vector3(0, 1.1, 0);
/** The director changes robot at most this often, s */
const DIRECTOR_HOLD = 3;
/** The free camera flying with WASD (forward, left, back, right) and Q / E (down, up), m/s; Shift is faster */
const FLY_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1], KeyS: [0, 0, -1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyQ: [0, -1, 0], KeyE: [0, 1, 0],
};
const FLY_SPEED = 2.5;
const FLY_FAST = 3;

export interface StudioHost {
  readonly canvas: HTMLCanvasElement;
  readonly rig: CameraRig;
  /** The match sounds as a stream, to record with the picture (null if the browser can't) */
  audioStream(): MediaStream | null;
  /** Draws at a fixed size while a clip is recorded; null goes back to the window. */
  captureSize(size: [number, number] | null): void;
  exit(): void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function videoType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) ?? null;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export class ReplayStudio {
  readonly el = h('div', { class: 'studio' });
  time = 0;
  playing = true;
  speed = 1;
  private replay = new Replay([]);
  private highlights: Highlight[] = [];
  private camera: StudioCamera = 'action';
  private controls: OrbitControls | null = null;
  private orbitAngle = 0.6;
  private followSlot: Slot = 'red1';
  private director: { slot: Slot | null; since: number; pos: THREE.Vector3; look: THREE.Vector3 } = { slot: null, since: 0, pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private recording: { end: number; done: () => void } | null = null;
  private cancel = false;
  private status = '';
  private readonly scrub: HTMLInputElement;
  private readonly clock = h('span', { class: 'studio-time' });
  /** The match clock and score at this moment of the replay */
  private readonly board = h('span', { class: 'studio-board' });
  /** Fly keys held down for the free camera */
  private readonly held = new Set<string>();
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.held.delete(e.code);
  private readonly onBlur = () => this.held.clear();

  constructor(private readonly host: StudioHost) {
    this.scrub = h('input', { type: 'range', class: 'studio-scrub', min: '0', max: '1', step: '0.01', value: '0' });
    this.scrub.addEventListener('input', () => this.seek(Number(this.scrub.value)));
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(frames: readonly ReplayFrame[]): void {
    this.replay = new Replay(frames);
    this.highlights = findHighlights(frames);
    this.time = 0;
    this.playing = true;
    this.speed = 1;
    this.status = '';
    this.scrub.max = String(this.replay.duration);
    this.el.hidden = false;
    this.setCamera('action');
    // Before the game's own keys: Esc here leaves the studio, not the pause menu too.
    window.addEventListener('keydown', this.onKey, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', this.onBlur);
    this.render();
  }

  close(): void {
    this.cancel = true;
    this.recording?.done();
    this.el.hidden = true;
    this.controls?.dispose();
    this.controls = null;
    this.held.clear();
    window.removeEventListener('keydown', this.onKey, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('blur', this.onBlur);
  }

  /** The match sounds play along only at normal speed. */
  get soundRunning(): boolean {
    return this.playing && this.speed === 1;
  }

  /** Moves playback and the camera on; the world to draw. */
  update(dt: number): { world: WorldState; startIn: number } | null {
    if (this.playing) this.time = Math.min(this.replay.duration, this.time + dt * this.speed);
    if (this.time >= this.replay.duration && !this.recording) this.playing = false;
    if (this.recording && this.time >= this.recording.end) this.recording.done();
    const frame = this.replay.at(this.time);
    if (frame) {
      this.moveCamera(frame.world, dt);
      const w = frame.world;
      const clock = matchClock(w.period, w.periodTime);
      const board = `${clock.label} ${clock.text}  ·  ${total(w.score.red)} – ${total(w.score.blue)}`;
      if (this.board.textContent !== board) this.board.textContent = board;
    }
    this.scrub.value = String(this.time);
    this.clock.textContent = `${fmt(this.time)} / ${fmt(this.replay.duration)}`;
    return frame;
  }

  private seek(time: number): void {
    this.time = Math.max(0, Math.min(this.replay.duration, time));
    this.director.slot = null;
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') return void this.held.add(e.code);
    if (FLY_KEYS[e.code]) {
      // Flying is the free camera's; any other camera hands over to it where it is.
      if (this.camera !== 'free') this.setCamera('free', true);
      this.held.add(e.code);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.code === 'Space') this.playing = !this.playing;
    else if (e.code === 'ArrowLeft') this.seek(this.time - SEEK_STEP);
    else if (e.code === 'ArrowRight') this.seek(this.time + SEEK_STEP);
    else if (e.code === 'KeyH') this.el.classList.toggle('studio-hidden');
    else if (e.code === 'Escape') {
      if (this.recording) this.cancel = true;
      else this.host.exit();
    } else if (/^Digit[1-8]$/.test(e.code)) this.setCamera(CAMERAS[Number(e.code.slice(5)) - 1]);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.render();
  }

  /** `here`: the free camera starts where the camera is now, looking the same way. */
  private setCamera(camera: StudioCamera, here = false): void {
    if (camera === 'follow' && this.camera === 'follow') {
      // Pressing it again moves on to the next robot.
      this.followSlot = SLOTS[(SLOTS.indexOf(this.followSlot) + 1) % SLOTS.length];
    }
    this.camera = camera;
    this.director.slot = null;
    const rig = this.host.rig;
    this.controls?.dispose();
    this.controls = null;
    rig.camera.up.set(0, 1, 0);
    if (camera === 'free') {
      this.controls = new OrbitControls(rig.camera, this.host.canvas);
      if (here) this.controls.target.copy(rig.camera.position).add(rig.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(2));
      else this.controls.target.copy(HIVE).setY(0.4);
      this.controls.enableDamping = true;
      this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    } else if (camera === 'redDriver' || camera === 'blueDriver' || camera === 'audience' || camera === 'follow') {
      rig.setMode(camera === 'audience' ? 'audience' : camera === 'follow' ? 'follow' : 'driver');
      rig.alliance = camera === 'blueDriver' ? 'blue' : camera === 'follow' ? slotAlliance(this.followSlot) : 'red';
      rig.driverZ = 0.6;
    }
    this.render();
  }

  private moveCamera(world: WorldState, dt: number): void {
    const cam = this.host.rig.camera;
    const robot = (slot: Slot) => world.robots.find(r => r.slot === slot) ?? null;
    switch (this.camera) {
      case 'free':
        this.fly(dt);
        this.controls?.update();
        break;
      case 'orbit':
        this.orbitAngle += dt * this.speed * 0.12;
        cam.position.set(Math.cos(this.orbitAngle) * 4.6, 2.4, Math.sin(this.orbitAngle) * 4.6);
        cam.lookAt(0, 0.6, 0);
        break;
      case 'top':
        cam.up.set(0, 0, -1);
        cam.position.set(0, 7.2, 0.001);
        cam.lookAt(0, 0, 0);
        break;
      case 'action':
        this.direct(world, dt);
        break;
      case 'redDriver':
        this.host.rig.update(robot('red1'), dt);
        break;
      case 'blueDriver':
        this.host.rig.update(robot('blue1'), dt);
        break;
      case 'audience':
        this.host.rig.update(robot('red1') ?? robot('blue1'), dt);
        break;
      case 'follow':
        this.host.rig.update(robot(this.followSlot) ?? world.robots[0] ?? null, dt);
        break;
    }
  }

  /** WASD / Q E move the free camera and the point it turns around, along the way it looks. */
  private fly(dt: number): void {
    if (!this.held.size || !this.controls) return;
    const cam = this.host.rig.camera;
    const forward = cam.getWorldDirection(new THREE.Vector3()).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    for (const code of this.held) {
      const [x, y, z] = FLY_KEYS[code] ?? [0, 0, 0];
      move.addScaledVector(right, x).addScaledVector(forward, z).y += y;
    }
    if (!move.lengthSq()) return;
    const fast = this.held.has('ShiftLeft') || this.held.has('ShiftRight');
    move.normalize().multiplyScalar(FLY_SPEED * (fast ? FLY_FAST : 1) * dt);
    // Never under the floor.
    move.y = Math.max(move.y, 0.15 - cam.position.y);
    cam.position.add(move);
    this.controls.target.add(move);
  }

  /** The director: a low chase camera on the robot doing the most, eased from shot to shot. */
  private direct(world: WorldState, dt: number): void {
    const d = this.director;
    const busy = (r: RobotState) => r.stored.length * 2 + (r.status !== 'off' ? 1.5 : 0) + Math.abs(r.speed);
    if (!d.slot || this.time - d.since > DIRECTOR_HOLD || this.time < d.since) {
      const pick = [...world.robots].sort((a, b) => busy(b) - busy(a))[0];
      if (pick && pick.slot !== d.slot) {
        const first = d.slot === null;
        d.slot = pick.slot;
        d.since = this.time;
        if (first) d.pos.set(pick.x * 1.6, 1.4, pick.z * 1.6 + 2.5);
      }
    }
    const r = world.robots.find(p => p.slot === d.slot);
    if (!r) return;
    // Behind the robot as seen from the HIVE, a little to the side, looking past it at the HIVE.
    const away = new THREE.Vector3(r.x - HIVE.x, 0, r.z - HIVE.z);
    if (away.lengthSq() < 0.01) away.set(slotAlliance(r.slot) === 'red' ? -1 : 1, 0, 0);
    away.normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const want = new THREE.Vector3(r.x, 0, r.z).addScaledVector(away, 1.9).addScaledVector(side, 0.9).setY(1.25);
    const look = new THREE.Vector3(r.x, 0.3, r.z).lerp(HIVE, 0.35);
    const k = 1 - Math.exp(-dt * 2.2);
    d.pos.lerp(want, k);
    d.look.lerp(look, d.look.lengthSq() ? k : 1);
    this.host.rig.camera.position.copy(d.pos);
    this.host.rig.camera.lookAt(d.look);
  }

  /** The camera that suits a highlight. */
  private clipCamera(h: Highlight): StudioCamera {
    return h.kind === 'start' ? 'orbit' : h.kind === 'tip' ? 'audience' : 'action';
  }

  private async record(clips: { start: number; end: number; camera: StudioCamera | null; name: string }[]): Promise<void> {
    const type = videoType();
    if (!type) {
      this.status = t('studio.noRecorder');
      return this.render();
    }
    this.cancel = false;
    for (const [i, clip] of clips.entries()) {
      if (this.cancel) break;
      this.status = t('studio.recording', { n: i + 1, count: clips.length });
      this.el.classList.add('studio-recording');
      this.render();
      this.host.captureSize(CLIP_SIZE);
      this.seek(clip.start);
      if (clip.camera) this.setCamera(clip.camera);
      this.speed = 1;
      this.playing = true;
      // Two frames at the new size before the recording starts.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const stream = this.host.canvas.captureStream(60);
      for (const track of this.host.audioStream()?.getAudioTracks() ?? []) stream.addTrack(track);
      const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: CLIP_BITRATE });
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
      const stopped = new Promise(r => (recorder.onstop = r));
      recorder.start(500);
      await new Promise<void>(done => {
        this.recording = { end: clip.end, done };
        const check = setInterval(() => this.cancel && done(), 100);
        void stopped.then(() => clearInterval(check));
      });
      this.recording = null;
      recorder.stop();
      await stopped;
      for (const track of stream.getVideoTracks()) track.stop();
      this.host.captureSize(null);
      const file = `${clip.name}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      // Stopped before a single frame: no empty file.
      if (blob.size) download(blob, file);
      this.status = blob.size ? t('studio.saved', { file }) : '';
    }
    this.el.classList.remove('studio-recording');
    this.render();
  }

  /** Each clip named by when it starts, so saving one again doesn't make a copy of another. */
  private recordHighlights(list: Highlight[]): void {
    void this.record(list.map(h => ({ start: h.start, end: h.end, camera: this.clipCamera(h), name: `ursim-${fmt(h.start).replace(':', '-')}-${h.kind}` })));
  }

  private render(): void {
    if (this.el.hidden) return;
    const kindName = (h: Highlight) => `${t(`studio.kind.${h.kind}` as TextKey)}${h.alliance ? ` · ${t(h.alliance === 'red' ? 'select.red' : 'select.blue')}` : ''}`;
    const recording = this.el.classList.contains('studio-recording');
    // From this moment until Stop or the end (at the end, from the start again), with the camera
    // picked and any picked meanwhile.
    const recordHere = () => {
      const from = this.time < this.replay.duration - 0.1 ? this.time : 0;
      void this.record([{ start: from, end: this.replay.duration, camera: null, name: `ursim-${fmt(from).replace(':', '-')}` }]);
    };
    this.el.replaceChildren(
      h('div', { class: 'studio-bar' },
        h('button', { class: 'studio-btn', onclick: () => { this.playing = !this.playing; this.render(); } }, this.playing ? '❚❚' : '▶'),
        this.board,
        this.clock,
        this.scrub,
        ...SPEEDS.map(s => h('button', { class: `studio-btn ${s === this.speed ? 'studio-on' : ''}`, onclick: () => { this.speed = s; this.render(); } }, `${s}×`)),
        recording
          ? h('button', { class: 'studio-btn studio-rec', onclick: () => (this.cancel = true) }, `■ ${t('studio.stop')}`)
          : h('button', { class: 'studio-btn studio-rec', onclick: recordHere }, `● ${t('studio.recordHere')}`)),
      h('div', { class: 'studio-bar' },
        h('span', { class: 'studio-label' }, t('studio.camera')),
        ...CAMERAS.map((c, i) => h('button', { class: `studio-btn ${c === this.camera ? 'studio-on' : ''}`, title: String(i + 1), onclick: () => this.setCamera(c) },
          c === 'follow' && this.camera === 'follow' ? `${t('studio.cam.follow')} · ${this.followSlot}` : t(`studio.cam.${c}` as TextKey)))),
      h('div', { class: 'studio-bar' },
        h('span', { class: 'studio-label' }, t('studio.highlights')),
        h('button', { class: 'studio-btn studio-rec', disabled: recording || !this.highlights.length, onclick: () => this.recordHighlights(this.highlights) }, `● ${t('studio.recordAll')}`),
        h('div', { class: 'studio-clips' }, ...this.highlights.map(hl => h('span', { class: `studio-clip studio-clip-${hl.alliance ?? 'none'}` },
          h('button', { class: 'studio-btn', onclick: () => { this.seek(hl.start); this.playing = true; this.render(); } }, `${kindName(hl)} · ${fmt(hl.start)}`),
          h('button', { class: 'studio-btn studio-rec', disabled: recording, onclick: () => this.recordHighlights([hl]) }, '●'))))),
      h('div', { class: 'studio-foot' },
        h('span', { class: 'studio-status' }, this.status),
        h('span', { class: 'studio-keys' }, t('studio.keys')),
        h('button', { class: 'studio-btn', onclick: () => this.host.exit() }, t('studio.exit'))),
    );
  }
}
