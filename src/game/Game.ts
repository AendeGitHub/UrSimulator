// Owns the scene, input and screens; draws the current game, side by side when two drivers play.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CAMERA_MODES, CameraRig, type CameraMode } from '../camera/CameraRig';
import type { FieldLayout } from '../field/layout';
import { withDefaults, type Bindings } from '../input/bindings';
import { modelName } from '../input/gamepad';
import { InputManager } from '../input/InputManager';
import { defaultServerUrl, rememberRecord, restoreRecords, submitRecord } from '../net/records';
import type { Alliance } from '../robot/robotConfig';
import { DEFAULT_ROBOT_ID, ROBOTS, robotById } from '../robot/robots';
import type { BallKind } from '../sim/BallSim';
import { parseColliders, type ColliderPart } from '../sim/colliders';
import { matchClock } from '../sim/Match';
import { cleanRules, type RuleOptions } from '../sim/Referee';
import { initPhysics } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import { slotAlliance, type GameMode, type RobotInput, type Slot } from '../sim/types';
import { GamepadScreen } from '../ui/GamepadScreen';
import { Hud } from '../ui/Hud';
import { MainMenu, PauseMenu, type Screen } from '../ui/menus';
import { RecordsScreen } from '../ui/RecordsScreen';
import { RobotSelectScreen, isSplit, type Pad2Role, type SelectPurpose, type SelectSettings } from '../ui/RobotSelect';
import { ResultsScreen, type ResultsTeam } from '../ui/ResultsScreen';
import { LANGUAGES, defaultLanguage, localize, setLanguage, t, type Language } from '../ui/i18n';
import { DEFAULT_GRAPHICS, SettingsScreen, cleanSensitivity, type GraphicsSettings, type QualityPreset, type Sensitivity, type SettingsValues } from '../ui/SettingsScreen';
import { Arena } from '../view/Arena';
import { asset } from '../view/assets';
import { BallsView, loadBallShapes, type HeldBall } from '../view/BallsView';
import { FieldView } from '../view/FieldView';
import { RobotView, robotModel, setModelDetail } from '../view/RobotView';
import { ScreenEffects } from '../view/ScreenEffects';
import { total, type AllianceScore } from './scoring';
import { Session, type Driver, type SessionEvents } from './Session';

const SETTINGS_KEY = 'ursim.settings';
/** Where the robot stands on the selection screen (x, z): open floor on the red side. */
const PREVIEW_SPOT: [number, number] = [-1.05, 0.95];
/**
 * Main menu view (MoSim style): a high corner view from the audience side that sways slowly.
 * The camera aims `shift` m left of the field center so the field sits right of the menu list.
 */
const MENU_VIEW = { angle: 0.62 * Math.PI, sway: 0.06 * Math.PI, distance: 4.25, height: 3.2, shift: 0.95 };

type State = 'menu' | 'select' | 'playing' | 'paused' | 'results';

interface Settings {
  robot: string;
  alliance: Alliance;
  fieldCentric: boolean;
  camera: CameraMode;
  name: string;
  /** gamepad2's robot and alliance on a split screen, and whether it drives one at all */
  robot2: string;
  alliance2: Alliance;
  pad2: Pad2Role;
  bindings: Bindings;
  sensitivity: Sensitivity;
  graphics: GraphicsSettings;
  rules: RuleOptions;
  language: Language;
}

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    // Unreadable settings: start from the defaults.
  }
  return {
    robot: DEFAULT_ROBOT_ID,
    alliance: 'red',
    fieldCentric: true,
    name: '',
    robot2: DEFAULT_ROBOT_ID,
    alliance2: 'red',
    ...saved,
    pad2: saved.pad2 === 'operator' ? 'operator' : 'robot',
    camera: CAMERA_MODES.includes(saved.camera as CameraMode) ? saved.camera as CameraMode : 'driver',
    // Nested settings are merged so options added in a later version get their defaults.
    bindings: withDefaults(saved.bindings),
    sensitivity: cleanSensitivity(saved.sensitivity),
    graphics: { ...DEFAULT_GRAPHICS, ...saved.graphics },
    rules: cleanRules(saved.rules),
    // The first time, from the browser's language.
    language: LANGUAGES.includes(saved.language as Language) ? saved.language as Language : defaultLanguage(),
  };
}

/**
 * World positions of the balls inside each robot, so you can see how many it holds. A robot with
 * two turrets keeps each kind of ball in the lane of the turret that shoots it.
 */
function heldBallPositions(world: WorldState, kindOf: (id: number) => BallKind): Map<number, HeldBall> {
  const held = new Map<number, HeldBall>();
  for (const r of world.robots) {
    const def = robotById(r.robot);
    const cos = Math.cos(r.yaw);
    const sin = Math.sin(r.yaw);
    const inLane = [0, 0];
    r.stored.forEach((id, n) => {
      const lane = def.second?.kinds.includes(kindOf(id)) ? 1 : 0;
      const { first, step } = lane ? def.second!.storage : def.storage;
      const i = def.second ? inLane[lane]++ : n;
      const [fx, y, rz] = [first[0] + step[0] * i, first[1] + step[1] * i, first[2] + step[2] * i];
      // Same rotation as the robot model (about +Y by yaw).
      held.set(id, { pos: [r.x + fx * cos + rz * sin, y, r.z - fx * sin + rz * cos], place: `${r.slot}:${lane}:${i}` });
    });
  }
  return held;
}

/**
 * Render quality steps, best first. Slow computers step down automatically: fewer pixels first,
 * then no ambient occlusion. The pixel ratio never goes above the screen's own. Edges are smoothed
 * by FXAA instead of drawing extra pixels, so even the top step draws few.
 */
const QUALITY = [
  { ratio: 1.25, ao: true },
  { ratio: 1, ao: true },
  { ratio: 1, ao: false },
  { ratio: 0.85, ao: false },
];
/** Fixed presets from Settings → Graphics, as steps of the ladder above */
const PRESET_LEVEL: Record<Exclude<QualityPreset, 'auto'>, number> = { high: 0, medium: 1, low: 3 };
/** Below this frame rate quality steps down; above the upper one for a while it tries a step up. */
const FPS_LOW = 50;
const FPS_HIGH = 58;

/** Driver stations: "1" stands closest to the audience (+Z). */
const DRIVER_Z: Record<Slot, number> = { red1: 0.6, red2: -0.6, blue1: 0.6, blue2: -0.6 };

const slotOf = (alliance: Alliance, station: 1 | 2): Slot => `${alliance}${station}`;

/** One picture on the screen: a camera, with ambient occlusion and black outlines on top. */
interface View {
  rig: CameraRig;
  effects: ScreenEffects;
}

/** A driver at this computer, with their robot and their part of the screen. */
interface Player {
  slot: Slot;
  /**
   * Split screen: the gamepad this player drives with (gamepad1 also has the keyboard). Solo: none,
   * so gamepad2 runs the mechanisms of the same robot as in FTC.
   */
  pad?: 1 | 2;
  view: View;
  fieldCentric: boolean;
  slow: boolean;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** Left and right half of a split screen; the first one is the whole screen otherwise. */
  private readonly views: View[];
  /** Where each view is drawn (x, y, width, height in CSS pixels) */
  private viewRects: [number, number, number, number][] = [];
  /** The first view's camera, also used by the menus */
  private readonly rig: CameraRig;
  private readonly input = new InputManager();
  private readonly hud = new Hud();
  private readonly overlay: HTMLElement;
  private readonly settings = loadSettings();

  private layout!: FieldLayout;
  private colliders!: ColliderPart[];
  private field!: FieldView;
  private ballsView!: BallsView;
  private readonly robotViews = new Map<Slot, RobotView>();
  private preview: RobotView | null = null;

  private session: Session | null = null;
  private players: Player[] = [];

  private state: State = 'menu';
  private screen: Screen | null = null;
  private readonly screens: {
    main: MainMenu; select: RobotSelectScreen; pause: PauseMenu; settings: SettingsScreen; pads: GamepadScreen; results: ResultsScreen; records: RecordsScreen;
  };
  /** Screens to go back to (main menu → settings → gamepads) */
  private readonly stack: Screen[] = [];
  private spot!: THREE.SpotLight;
  private fpsAverage = 60;
  private fpsShown = 0;

  private lastTime = 0;
  /** Index into QUALITY, and the best level that ran too slowly (never tried again). */
  private quality = 0;
  private qualityFloor = 0;
  private perf = { time: 0, frames: 0, goodTime: 0 };
  private menuOrbit = 0;
  /** gamepad1 and gamepad2 as last announced */
  private readonly lastPads = ['', ''];
  private lastMode: GameMode = 'practice';
  /** Matches finished since the page opened, for the results title */
  private matchNumber = 0;

  private constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[0].ratio));
    this.renderer.shadowMap.enabled = true;
    // Plain PCF: soft PCF samples the shadow map many more times for every lit pixel.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Drawn once a frame (render()), not again for every view and effect pass that draws the scene.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.views = [0, 1].map(() => {
      const rig = new CameraRig();
      return { rig, effects: new ScreenEffects(this.renderer, this.scene, rig.camera) };
    });
    this.rig = this.views[0].rig;
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    container.append(this.hud.el, this.overlay);
    this.hud.el.hidden = true;

    const back = () => this.show(this.stack.pop() ?? this.screens.main);
    const openSettings = () => {
      this.screens.settings.open(this.settingsValues());
      this.openSub(this.screens.settings);
    };
    this.screens = {
      main: new MainMenu({
        match: () => this.openSelect('match'),
        practice: () => this.openSelect('practice'),
        records: () => {
          this.screens.records.open(this.settings.robot);
          this.openSub(this.screens.records);
        },
        settings: openSettings,
      }),
      select: new RobotSelectScreen(this.selectSettings(), {
        change: settings => this.applySelect(settings),
        start: purpose => this.startGame(purpose),
        back: () => this.toMenu(),
      }),
      pause: new PauseMenu({
        resume: () => this.resume(),
        resetRobot: () => this.startGame(this.lastMode),
        settings: openSettings,
        exit: () => this.toMenu(),
      }),
      settings: new SettingsScreen({
        change: values => {
          Object.assign(this.settings, values);
          this.saveSettings();
          this.applySettings();
        },
        gamepads: () => this.openSub(this.screens.pads),
        back,
      }),
      pads: new GamepadScreen(this.input, back),
      results: new ResultsScreen({
        again: () => this.startGame(this.lastMode),
        menu: () => this.toMenu(),
      }),
      records: new RecordsScreen({
        server: defaultServerUrl,
        name: () => this.settings.name,
        rename: name => {
          this.settings.name = name;
          this.saveSettings();
        },
        back,
      }),
    };

    this.setupLighting();
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.resize();
  }

  static async create(container: HTMLElement, onProgress: (p: number) => void): Promise<Game> {
    const [, layout, colliderData] = await Promise.all([
      initPhysics(),
      fetch(asset('assets/field-layout.json')).then(r => r.json() as Promise<FieldLayout>),
      fetch(asset('assets/field-colliders.bin')).then(r => r.arrayBuffer()),
    ]);
    const game = new Game(container);
    game.layout = layout;
    game.colliders = parseColliders(colliderData);
    game.field = await FieldView.load(layout, game.scene, onProgress);
    game.ballsView = new BallsView(layout, game.scene, await loadBallShapes());
    game.showHomeField();
    game.show(game.screens.main);
    requestAnimationFrame(t => game.frame(t));
    // A server that restarted lost its high scores: give it back this player's. Bests from older
    // versions were kept here without a name; they go under the player's name.
    if (game.settings.name) {
      for (const { id } of ROBOTS) {
        let best = 0;
        try {
          best = Number(localStorage.getItem(`ursim.best.${id}`) ?? 0);
        } catch {
          // No storage
        }
        if (best > 0) rememberRecord(id, game.settings.name, best);
      }
    }
    restoreRecords(defaultServerUrl(), ROBOTS.map(r => r.id)).catch(() => undefined);
    return game;
  }

  private setupLighting(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.14;
    // Event lighting: the field glows under a spotlight, the hall fades into the dark around it.
    const dark = new THREE.Color('#090b0f');
    this.scene.background = dark;
    this.scene.fog = new THREE.FogExp2(dark, 0.075);
    new Arena(this.scene);

    this.scene.add(new THREE.HemisphereLight('#f2f5ff', '#5a6070', 0.13));
    const spot = new THREE.SpotLight('#ffffff', 4.8, 0, Math.atan(3.6 / 8.5), 0.75, 0);
    this.spot = spot;
    spot.position.set(0.6, 8.5, 1.2);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 4;
    spot.shadow.camera.far = 14;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.02;
    this.scene.add(spot, spot.target);

    // Alliance colors glow onto the floor and walls at each end of the field.
    for (const [color, x] of [['#ff2b2b', -2.6], ['#2b5bff', 2.6]] as const) {
      const glow = new THREE.PointLight(color, 6, 5.5, 1.5);
      glow.position.set(x, 1.4, 0);
      this.scene.add(glow);
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Settings simply won't persist.
    }
  }

  private selectSettings(): SelectSettings {
    const { robot, alliance, camera, fieldCentric, name, robot2, alliance2, pad2 } = this.settings;
    return { robot, alliance, camera, fieldCentric, name, robot2, alliance2, pad2 };
  }

  private openSelect(purpose: SelectPurpose): void {
    this.endSession();
    this.state = 'select';
    this.screens.select.open(purpose, this.selectSettings());
    this.show(this.screens.select);
    this.showPreview();
  }

  private applySelect(settings: SelectSettings): void {
    Object.assign(this.settings, settings);
    this.saveSettings();
    this.showPreview();
  }

  /** The selected robot on the field behind the selection screen. */
  private showPreview(): void {
    const def = robotById(this.settings.robot);
    if (this.preview?.def !== def || this.preview.model !== robotModel(def)) {
      this.preview?.dispose();
      this.preview = new RobotView(def, this.settings.alliance, def.number);
      this.scene.add(this.preview.root);
    }
    this.preview.setIdentity(this.settings.alliance, def.number);
    this.preview.root.position.set(PREVIEW_SPOT[0], 0.002, PREVIEW_SPOT[1]);
  }

  private hidePreview(): void {
    this.preview?.dispose();
    this.preview = null;
  }


  // ---- sessions --------------------------------------------------------------

  private readonly sessionEvents: SessionEvents = {
    // Drivers get no pop-ups about game events (tips, periods, cards): the field timer, the
    // scores and the battery are all they see, as at a real match.
    toast: () => {},
    finished: score => this.showResults(score),
  };

  private endSession(): void {
    this.hidePreview();
    this.session?.dispose();
    this.session = null;
    this.setPlayers([]);
    for (const view of this.robotViews.values()) view.dispose();
    this.robotViews.clear();
  }

  /** gamepad1's robot, and gamepad2's on a split screen when two gamepads are connected. */
  private startGame(mode: GameMode): void {
    this.endSession();
    this.lastMode = mode;
    const s = this.settings;
    const drivers: Driver[] = [{ slot: slotOf(s.alliance, 1), robot: s.robot }];
    // The same alliance: its second driver station; the other alliance: that one's first.
    if (isSplit(this.input, s)) drivers.push({ slot: slotOf(s.alliance2, s.alliance2 === s.alliance ? 2 : 1), robot: s.robot2 });
    this.session = new Session(this.layout, this.colliders, drivers, mode, s.rules, this.sessionEvents);
    const split = drivers.length > 1;
    this.setPlayers(drivers.map((d, i) => ({
      slot: d.slot,
      pad: split ? (i === 0 ? 1 : 2) : undefined,
      view: this.views[i],
      fieldCentric: s.fieldCentric,
      slow: false,
    })));
    this.enterPlay();
  }

  /** Splits the screen in two for two players (and joins it again). */
  private setPlayers(players: Player[]): void {
    const wasSplit = this.players.length > 1;
    this.players = players;
    if (wasSplit !== players.length > 1) this.resize();
  }

  private enterPlay(): void {
    for (const p of this.players) {
      p.view.rig.alliance = slotAlliance(p.slot);
      p.view.rig.driverZ = DRIVER_Z[p.slot];
      p.view.rig.setMode(this.settings.camera);
    }
    this.resume();
  }

  // ---- screens -------------------------------------------------------------

  private show(screen: Screen | null): void {
    this.screen = screen;
    this.overlay.replaceChildren(...(screen ? [screen.el] : []));
    this.overlay.classList.toggle('active', !!screen);
    if (screen) {
      // Screens are built once; the language may have changed since.
      localize(screen.el);
      screen.onShow?.();
      screen.nav.focusFirst();
    } else {
      document.body.classList.remove('pad-nav');
    }
  }

  private openSub(screen: Screen): void {
    if (this.screen) this.stack.push(this.screen);
    this.show(screen);
  }

  private resume(): void {
    this.stack.length = 0;
    this.state = 'playing';
    this.show(null);
    (document.activeElement as HTMLElement | null)?.blur();
    this.hud.el.hidden = false;
  }

  private pause(): void {
    this.state = 'paused';
    this.show(this.screens.pause);
  }

  private showResults(score: Record<Alliance, AllianceScore>): void {
    this.state = 'results';
    this.matchNumber++;
    const teams: Record<Alliance, ResultsTeam[]> = { red: [], blue: [] };
    for (const r of this.session?.state().robots ?? []) {
      const def = robotById(r.robot);
      teams[slotAlliance(r.slot)].push({ name: def.team, logo: def.teamLogo });
    }
    const solo = this.players.length === 1;
    this.screens.results.show({
      score,
      teams,
      title: t('results.match', { n: this.matchNumber }),
      event: t(solo ? 'results.solo' : 'results.split'),
    });
    this.show(this.screens.results);
    // Only solo matches go into the high score table.
    if (solo) {
      const alliance = slotAlliance(this.players[0].slot);
      this.saveRecord(alliance, total(score[alliance]));
    }
  }

  /** Solo match: into the robot's high score table (and a personal best kept in this browser). */
  private saveRecord(alliance: Alliance, points: number): void {
    const robot = this.settings.robot;
    const key = `ursim.best.${robot}`;
    let localBest = 0;
    try {
      localBest = Number(localStorage.getItem(key) ?? 0);
      if (points > localBest) localStorage.setItem(key, String(points));
    } catch {
      // No storage: only the server keeps records.
    }
    const name = this.settings.name;
    // Without a name the match only counts as a personal best in this browser.
    if (!name) {
      if (points > localBest && points > 0) this.screens.results.setRecord(alliance, t('results.personalBest'));
      return;
    }
    rememberRecord(robot, name, points);
    submitRecord(defaultServerUrl(), robot, name, points)
      .then(r => {
        if (this.state !== 'results' || !r.improved) return;
        this.screens.results.setRecord(alliance, r.rank === 1 ? t('results.topScore') : r.rank ? t('results.rank', { rank: r.rank }) : t('results.personalBest'));
      })
      .catch(() => {
        if (this.state === 'results' && points > localBest && points > 0) this.screens.results.setRecord(alliance, t('results.personalBest'));
      });
  }

  private toMenu(): void {
    this.stack.length = 0;
    this.endSession();
    this.state = 'menu';
    this.hud.el.hidden = true;
    this.showHomeField();
    this.show(this.screens.main);
  }

  /** Balls in their starting places behind the main menu. */
  private showHomeField(): void {
    const transforms = new Float32Array(this.ballsView.specs.length * 7);
    const states = new Uint8Array(this.ballsView.specs.length);
    this.ballsView.specs.forEach((s, i) => {
      transforms.set([...s.pos, 0, 0, 0, 1], i * 7);
      states[i] = s.homeState === 'held' ? 1 : 0;
    });
    this.ballsView.update({ states, transforms });
    this.field.setHiveAngles({ red: 0, blue: 0 });
  }

  // ---- loop ------------------------------------------------------------------

  /** Two players get the left and right half of the screen, one player all of it. */
  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    const left = Math.floor(w / 2);
    this.viewRects = this.players.length > 1 ? [[0, 0, left, h], [left, 0, w - left, h]] : [[0, 0, w, h]];
    this.viewRects.forEach(([, , vw, vh], i) => {
      this.views[i].effects.setSize(vw, vh, this.renderer.getPixelRatio());
      this.views[i].rig.resize(vw, vh);
    });
  }

  private render(dt: number): void {
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setScissorTest(this.viewRects.length > 1);
    this.viewRects.forEach(([x, y, w, h], i) => {
      this.renderer.setViewport(x, y, w, h);
      this.renderer.setScissor(x, y, w, h);
      this.views[i].effects.render(dt);
    });
    this.renderer.setScissorTest(false);
  }

  private settingsValues(): SettingsValues {
    const { bindings, sensitivity, graphics, rules, language } = this.settings;
    return structuredClone({ bindings, sensitivity, graphics, rules, language });
  }

  /** Controls, graphics, house rules and language from the settings (the rules apply from the next game). */
  private applySettings(): void {
    const g = this.settings.graphics;
    setLanguage(this.settings.language);
    this.input.bindings = this.settings.bindings;
    this.spot.castShadow = g.shadows;
    for (const { effects } of this.views) {
      effects.setOutlines(g.outlines);
      effects.setAntialias(g.antialias);
    }
    // Robots switch to their lighter model on Low (views are rebuilt with it on the next frame).
    setModelDetail(g.quality === 'low' ? 'low' : 'high');
    this.hud.showFps(g.fps);
    if (g.quality !== 'auto') this.setQuality(PRESET_LEVEL[g.quality]);
    else if (this.quality > this.qualityFloor) this.setQuality(this.qualityFloor);
  }

  private frame(time: number): void {
    requestAnimationFrame(t => this.frame(t));
    const raw = this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60;
    this.lastTime = time;
    if (raw > 0 && raw < 0.25) this.fpsAverage += (1 / raw - this.fpsAverage) * 0.05;
    this.fpsShown -= raw;
    if (this.fpsShown <= 0) {
      this.fpsShown = 0.5;
      this.hud.setFps(this.fpsAverage);
    }
    if (this.settings.graphics.quality === 'auto') this.adaptQuality(raw);
    this.tick(Math.min(0.1, raw));
  }

  /** Measures the frame rate over 2 s windows and steps render quality down (or back up). */
  private adaptQuality(dt: number): void {
    // Hidden tabs and one-off hitches (loading a model) say nothing about the GPU.
    if (document.hidden || dt > 0.25) return;
    const p = this.perf;
    p.time += dt;
    p.frames++;
    if (p.time < 2) return;
    const fps = p.frames / p.time;
    p.time = p.frames = 0;
    if (fps < FPS_LOW && this.quality < QUALITY.length - 1) {
      this.qualityFloor = Math.max(this.qualityFloor, this.quality + 1);
      this.setQuality(this.quality + 1);
      p.goodTime = 0;
    } else if (fps > FPS_HIGH && this.quality > this.qualityFloor) {
      // Only climb back to levels that have not already proved too slow.
      p.goodTime += 2;
      if (p.goodTime >= 10) {
        this.setQuality(this.quality - 1);
        p.goodTime = 0;
      }
    }
  }

  private setQuality(level: number): void {
    this.quality = level;
    const q = QUALITY[level];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.ratio));
    for (const { effects } of this.views) effects.setAmbientOcclusion(q.ao);
    this.resize();
  }

  /** One frame of game logic + rendering. Public so dev tools can drive the game without rAF. */
  tick(dt: number): void {
    this.input.update();
    this.announcePads();

    if (this.state === 'playing') {
      this.handleGameplayButtons();
      if (this.state === 'playing') this.session?.update(dt, this.readInputs());
    } else {
      const screen = this.screen;
      if (screen) {
        screen.update?.(this.input);
        // A screen may have just switched to another one; that one starts reading input next frame.
        if (this.screen === screen && !screen.blocksNav) screen.nav.update(this.input);
        if (this.state === 'paused' && this.screen === this.screens.pause && this.pausePressed()) this.resume();
      }
    }

    const world = this.session?.state() ?? null;
    if (world) this.draw(world, this.state === 'paused' ? 0 : dt);
    if (this.state !== 'select' && this.rig.camera.view?.enabled) this.rig.camera.clearViewOffset();
    if (this.state === 'menu') this.updateMenuCamera(dt);
    else if (this.state === 'select') this.updatePreviewCamera(dt);
    else for (const p of this.players) p.view.rig.update(world?.robots.find(r => r.slot === p.slot) ?? null, dt);
    if (world && (this.state === 'playing' || this.state === 'paused')) this.updateHud(world);
    this.render(dt);
  }

  private draw(world: WorldState, dt: number): void {
    this.field.setHiveAngles(world.hiveAngles);
    this.ballsView.update(world.balls, heldBallPositions(world, id => this.ballsView.specs[id].kind), dt);
    const present = new Set(world.robots.map(r => r.slot));
    for (const [slot, view] of this.robotViews) {
      if (!present.has(slot)) {
        view.dispose();
        this.robotViews.delete(slot);
      }
    }
    for (const r of world.robots) {
      const def = robotById(r.robot);
      // Team numbers on the signs, like real robots.
      const sign = def.number;
      let view = this.robotViews.get(r.slot);
      if (view && (view.def !== def || view.model !== robotModel(def))) {
        view.dispose();
        view = undefined;
      }
      if (!view) {
        view = new RobotView(def, slotAlliance(r.slot), sign);
        this.scene.add(view.root);
        this.robotViews.set(r.slot, view);
      }
      view.setIdentity(slotAlliance(r.slot), sign);
      view.apply(r, dt);
    }
  }

  private updateHud(world: WorldState): void {
    // The battery blocks show only when the battery rule is on.
    const battery = this.settings.rules.battery;
    this.hud.update({
      clock: matchClock(world.period, world.periodTime),
      score: { red: total(world.score.red), blue: total(world.score.blue) },
      cards: {
        red: world.score.red.redCards ? 'red' : world.score.red.yellowCards ? 'yellow' : 'none',
        blue: world.score.blue.redCards ? 'red' : world.score.blue.yellowCards ? 'yellow' : 'none',
      },
      drivers: this.players.map(p => {
        const robot = world.robots.find(r => r.slot === p.slot);
        return { slot: p.slot, battery: robot && battery ? { voltage: robot.voltage, min: robot.minVoltage } : null };
      }),
    });
  }

  /** Pause on gamepad1 or the keyboard, and on gamepad2 when it drives its own robot. */
  private pausePressed(): boolean {
    return this.input.triggered('pause') || (this.players.length > 1 && this.input.triggered('pause', 2));
  }

  private handleGameplayButtons(): void {
    const input = this.input;
    if (this.pausePressed()) return this.pause();
    for (const p of this.players) {
      // The camera is picked before the match; only the follow camera turns around during play.
      if (input.triggered('camera', p.pad) && p.view.rig.mode === 'follow') p.view.rig.flip();
      if (input.triggered('fieldCentric', p.pad)) {
        p.fieldCentric = !p.fieldCentric;
        // gamepad1's choice is kept for the next game.
        if (p.pad !== 2) {
          this.settings.fieldCentric = p.fieldCentric;
          this.saveSettings();
        }
      }
      if (input.triggered('slow', p.pad)) p.slow = !p.slow;
    }
    if (input.keyboard.pressed('KeyR')) this.startGame(this.lastMode);
  }

  private readInputs(): Partial<Record<Slot, RobotInput>> {
    return Object.fromEntries(this.players.map(p => [p.slot, this.readDriverInput(p)]));
  }

  /**
   * Solo: gamepad1 drives; mechanisms listen to both gamepads, so a second driver can run them as
   * in FTC. Split screen: each player's own gamepad.
   */
  private readDriverInput(p: Player): RobotInput {
    const input = this.input;
    const { lx, ly, rx } = input.driveSticks(p.pad);
    const { drive, turn } = this.settings.sensitivity;
    // Sensitivity scales the stick; the drive vector keeps its direction when it hits full speed.
    const k = drive / Math.max(1, Math.hypot(lx, ly) * drive);
    return {
      lx: lx * k,
      ly: ly * k,
      rx: Math.max(-1, Math.min(1, rx * turn)),
      fieldCentric: p.fieldCentric,
      slow: p.slow,
      intake: input.held('intake', p.pad),
      eject: input.held('eject', p.pad),
      transfer: input.held('transfer', p.pad),
      shooterOn: input.triggered('shooterOn', p.pad),
      shooterOff: input.triggered('shooterOff', p.pad),
      imuReset: input.triggered('imuReset', p.pad),
      armUp: input.triggered('armUp', p.pad),
      armDown: input.triggered('armDown', p.pad),
    };
  }

  private updatePreviewCamera(dt: number): void {
    this.menuOrbit += dt * 0.25;
    const cam = this.rig.camera;
    const [x, z] = PREVIEW_SPOT;
    cam.up.set(0, 1, 0);
    // Close enough to see the mechanisms.
    cam.position.set(x + Math.cos(this.menuOrbit) * 0.82, 0.52, z + Math.sin(this.menuOrbit) * 0.82);
    cam.lookAt(x, 0.16, z);
    // Shift the picture so the robot sits in the open area left of the settings and above the
    // robot cards (MoSim layout), not hidden behind them.
    const { width, height } = this.renderer.domElement;
    const wide = width / height > 1.2;
    cam.setViewOffset(width, height, wide ? width * 0.19 : 0, wide ? height * 0.12 : 0, width, height);
  }

  private updateMenuCamera(dt: number): void {
    this.menuOrbit += dt;
    const v = MENU_VIEW;
    const angle = v.angle + Math.sin(this.menuOrbit * 0.15) * v.sway;
    const cam = this.rig.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(Math.cos(angle) * v.distance, v.height, Math.sin(angle) * v.distance);
    // Aim at a point left of the field center as seen from the camera.
    cam.lookAt(-Math.sin(angle) * v.shift, 0.05, Math.cos(angle) * v.shift);
  }

  private announcePads(): void {
    for (const slot of [0, 1] as const) {
      const pad = this.input.slotInfo(slot);
      const key = pad ? `${pad.index}|${pad.model}` : '';
      if (key === this.lastPads[slot]) continue;
      if (pad) this.hud.toast(t('pad.connected', { model: modelName(pad.model), n: slot + 1 }));
      else if (this.lastPads[slot]) this.hud.toast(t(slot === 0 ? 'pad.disconnected' : 'pad.disconnected2'));
      this.lastPads[slot] = key;
    }
  }
}
