// Owns the scene, input and screens; draws whatever the current session (solo or online) reports.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CAMERA_MODES, CameraRig, type CameraMode } from '../camera/CameraRig';
import type { FieldLayout } from '../field/layout';
import { withDefaults, type Bindings } from '../input/bindings';
import { modelName } from '../input/gamepad';
import { InputManager } from '../input/InputManager';
import { NetSession, defaultServerUrl } from '../net/NetSession';
import { cleanName, type RoomInfo } from '../net/protocol';
import { submitRecord } from '../net/records';
import type { Alliance } from '../robot/robotConfig';
import { DEFAULT_ROBOT_ID, robotById } from '../robot/robots';
import { parseColliders, type ColliderPart } from '../sim/colliders';
import { matchClock } from '../sim/Match';
import { cleanRules, type RuleOptions } from '../sim/Referee';
import { initPhysics } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import { slotAlliance, type GameMode, type RobotInput, type Slot } from '../sim/types';
import { GamepadScreen } from '../ui/GamepadScreen';
import { Hud } from '../ui/Hud';
import { MainMenu, PauseMenu, type Screen } from '../ui/menus';
import { ConnectScreen, LobbyScreen } from '../ui/online';
import { RecordsScreen } from '../ui/RecordsScreen';
import { RobotSelectScreen, type SelectPurpose, type SelectSettings } from '../ui/RobotSelect';
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
import { LocalSession, type Session, type SessionEvents } from './Session';

const SETTINGS_KEY = 'ursim.settings';
/** Where the robot stands on the selection screen (x, z): open floor on the red side. */
const PREVIEW_SPOT: [number, number] = [-1.05, 0.95];
/**
 * Main menu view (MoSim style): a high corner view from the audience side that sways slowly.
 * The camera aims `shift` m left of the field center so the field sits right of the menu list.
 */
const MENU_VIEW = { angle: 0.62 * Math.PI, sway: 0.06 * Math.PI, distance: 4.25, height: 3.2, shift: 0.95 };

type State = 'menu' | 'select' | 'playing' | 'paused' | 'results' | 'lobby';

interface Settings {
  robot: string;
  alliance: Alliance;
  fieldCentric: boolean;
  camera: CameraMode;
  name: string;
  server: string;
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
    server: defaultServerUrl(),
    ...saved,
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

/** World positions of the balls inside each robot, so you can see how many it holds. */
function heldBallPositions(world: WorldState): Map<number, HeldBall> {
  const held = new Map<number, HeldBall>();
  for (const r of world.robots) {
    const { first, step } = robotById(r.robot).storage;
    const cos = Math.cos(r.yaw);
    const sin = Math.sin(r.yaw);
    r.stored.forEach((id, i) => {
      const [fx, y, rz] = [first[0] + step[0] * i, first[1] + step[1] * i, first[2] + step[2] * i];
      // Same rotation as the robot model (about +Y by yaw).
      held.set(id, { pos: [r.x + fx * cos + rz * sin, y, r.z - fx * sin + rz * cos], place: `${r.slot}:${i}` });
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

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  /** Ambient occlusion and black outlines on top of the rendered scene */
  private readonly effects: ScreenEffects;
  private readonly scene = new THREE.Scene();
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
  private net: NetSession | null = null;

  private state: State = 'menu';
  private screen: Screen | null = null;
  private readonly screens: {
    main: MainMenu; select: RobotSelectScreen; pause: PauseMenu; settings: SettingsScreen; pads: GamepadScreen; results: ResultsScreen; connect: ConnectScreen; lobby: LobbyScreen; records: RecordsScreen;
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
  private lastPad1 = '';
  private slowMode = false;
  private lastSoloMode: GameMode = 'practice';
  /** Matches finished since the page opened, for the results title */
  private matchNumber = 0;

  private constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[0].ratio));
    this.renderer.shadowMap.enabled = true;
    // Plain PCF: soft PCF samples the shadow map many more times for every lit pixel.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.rig = new CameraRig();
    this.effects = new ScreenEffects(this.renderer, this.scene, this.rig.camera);
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
        online: () => this.openSelect('online'),
        records: () => {
          this.screens.records.open(this.settings.robot);
          this.openSub(this.screens.records);
        },
        settings: openSettings,
      }),
      select: new RobotSelectScreen(this.selectSettings(), {
        change: settings => this.applySelect(settings),
        start: purpose => (purpose === 'online' ? this.openConnect() : this.startSolo(purpose)),
        back: () => this.toMenu(),
      }),
      pause: new PauseMenu({
        resume: () => this.resume(),
        resetRobot: () => this.startSolo(this.lastSoloMode),
        settings: openSettings,
        stopOnline: () => this.net?.stop(),
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
        again: () => (this.net ? this.showLobby() : this.startSolo(this.lastSoloMode)),
        menu: () => this.toMenu(),
      }),
      connect: new ConnectScreen({ name: this.settings.name, server: this.settings.server }, {
        create: (name, server, format) => this.connect(name, server, net => net.create(format)),
        join: (name, server, code) => this.connect(name, server, net => net.join(code)),
        // Also drops a connection still on its way, so its room can't open the lobby over the menu.
        back: () => this.toMenu(),
      }),
      records: new RecordsScreen({
        server: () => this.settings.server || defaultServerUrl(),
        name: () => this.settings.name,
        rename: name => {
          this.settings.name = name;
          this.saveSettings();
        },
        back,
      }),
      lobby: new LobbyScreen({
        takeSlot: slot => this.net?.takeSlot(slot),
        start: mode => this.net?.start(mode, this.settings.rules),
        leave: () => this.toMenu(),
      }),
    };

    this.setupLighting();
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      // Solo games pause in the background; online games keep running on the server.
      if (document.hidden && this.state === 'playing' && !this.session?.online) this.pause();
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
    const { robot, alliance, camera, fieldCentric, name } = this.settings;
    return { robot, alliance, camera, fieldCentric, name };
  }

  private openSelect(purpose: SelectPurpose): void {
    this.endSession();
    this.state = 'select';
    this.screens.select.open(purpose, this.selectSettings());
    this.show(this.screens.select);
    this.showPreview();
  }

  /**
   * Online, once the robot is picked: the connect screen in the menu state, the one in which
   * room updates open the lobby and server errors show on this screen.
   */
  private openConnect(): void {
    this.hidePreview();
    this.state = 'menu';
    this.show(this.screens.connect);
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
    this.net = null;
    for (const view of this.robotViews.values()) view.dispose();
    this.robotViews.clear();
  }

  private startSolo(mode: GameMode): void {
    this.endSession();
    this.lastSoloMode = mode;
    const slot: Slot = this.settings.alliance === 'red' ? 'red1' : 'blue1';
    this.session = new LocalSession(this.layout, this.colliders, slot, this.settings.robot, mode, this.settings.rules, this.sessionEvents);
    this.enterPlay();
  }

  private connect(name: string, server: string, action: (net: NetSession) => void): void {
    this.endSession();
    this.settings.name = cleanName(name, t('common.player'));
    this.settings.server = server || defaultServerUrl();
    this.saveSettings();
    const net = new NetSession(this.settings.server, this.settings.name, this.settings.robot, {
      ...this.sessionEvents,
      room: room => this.onRoom(room),
      error: message => {
        if (this.state === 'lobby' || this.state === 'menu') this.screens.connect.setStatus(message, true);
        else this.hud.toast(message);
      },
      closed: () => {
        if (this.net !== net) return;
        this.endSession();
        this.hud.el.hidden = true;
        this.state = 'menu';
        this.show(this.screens.connect);
        this.screens.connect.setStatus(t('online.lost'), true);
      },
    });
    this.net = net;
    this.session = net;
    action(net);
  }

  private onRoom(room: RoomInfo | null): void {
    if (!room || !this.net) {
      if (this.net) this.toMenu();
      return;
    }
    if (room.running && this.net.localSlot !== undefined && (this.state === 'lobby' || this.state === 'menu')) {
      this.enterPlay();
    } else if (!room.running && (this.state === 'playing' || this.state === 'paused')) {
      this.showLobby();
    } else if (this.state === 'lobby' || this.state === 'menu') {
      this.showLobby();
    }
  }

  private showLobby(): void {
    if (!this.net?.room) return;
    this.state = 'lobby';
    this.hud.el.hidden = true;
    this.screens.lobby.show(this.net.room, this.net.myId, this.settings.server);
    this.show(this.screens.lobby);
  }

  private enterPlay(): void {
    const slot = this.session?.localSlot ?? null;
    const alliance = slot ? slotAlliance(slot) : 'red';
    this.rig.alliance = alliance;
    this.rig.driverZ = slot ? DRIVER_Z[slot] : 0.6;
    this.rig.setMode(slot ? this.settings.camera : 'audience');
    this.slowMode = false;
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
    this.screens.pause.configure(!!this.session?.online, !!this.net?.isHost);
    this.show(this.screens.pause);
  }

  private showResults(score: Record<Alliance, AllianceScore>): void {
    this.state = 'results';
    this.matchNumber++;
    const slot = this.session?.localSlot ?? null;
    const names = this.session?.names() ?? {};
    const teams: Record<Alliance, ResultsTeam[]> = { red: [], blue: [] };
    // Online the room knows every driver even if the last snapshot is already gone.
    const robots = this.net?.room?.players.flatMap(p => (p.slot ? [{ slot: p.slot, robot: p.robot }] : [])) ?? this.session?.state()?.robots ?? [];
    for (const r of robots) {
      const def = robotById(r.robot);
      teams[slotAlliance(r.slot)].push({ name: names[r.slot] ?? def.team, logo: def.teamLogo });
    }
    const room = this.net?.room;
    this.screens.results.show({
      score,
      teams,
      title: t(room ? 'results.onlineMatch' : 'results.match', { n: this.matchNumber }),
      event: room ? t('results.room', { code: room.code }) : t('results.solo'),
      online: !!this.net,
    });
    this.show(this.screens.results);
    if (slot && !this.net) this.saveRecord(slotAlliance(slot), total(score[slotAlliance(slot)]));
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
    submitRecord(this.settings.server || defaultServerUrl(), robot, name, points)
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

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.effects.setSize(w, h, this.renderer.getPixelRatio());
    this.rig.resize(w, h);
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
    this.effects.setOutlines(g.outlines);
    this.effects.setAntialias(g.antialias);
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
    this.effects.setAmbientOcclusion(q.ao);
    this.resize();
  }

  /** One frame of game logic + rendering. Public so dev tools can drive the game without rAF. */
  tick(dt: number): void {
    this.input.update();
    this.announcePads();

    if (this.state === 'playing') {
      this.handleGameplayButtons();
      if (this.state === 'playing') this.session?.update(dt, this.readDriverInput());
    } else {
      // Online games keep going behind menus; the robot just gets no input.
      if (this.session?.online) this.session.update(dt, null);
      const screen = this.screen;
      if (screen) {
        screen.update?.(this.input);
        // A screen may have just switched to another one; that one starts reading input next frame.
        if (this.screen === screen && !screen.blocksNav) screen.nav.update(this.input);
        if (this.state === 'paused' && this.screen === this.screens.pause && this.input.triggered('pause')) this.resume();
      }
    }

    const world = this.session?.state() ?? null;
    if (world) this.draw(world, this.state === 'paused' && !this.session?.online ? 0 : dt);
    const mine = world?.robots.find(r => r.slot === this.session?.localSlot) ?? null;
    if (this.state !== 'select' && this.rig.camera.view?.enabled) this.rig.camera.clearViewOffset();
    if (this.state === 'menu') this.updateMenuCamera(dt);
    else if (this.state === 'select') this.updatePreviewCamera(dt);
    else this.rig.update(mine, dt);
    if (world && (this.state === 'playing' || this.state === 'paused')) this.updateHud(world);
    this.effects.render(dt);
  }

  private draw(world: WorldState, dt: number): void {
    this.field.setHiveAngles(world.hiveAngles);
    this.ballsView.update(world.balls, heldBallPositions(world), dt);
    const names = this.session?.names() ?? {};
    const present = new Set(world.robots.map(r => r.slot));
    for (const [slot, view] of this.robotViews) {
      if (!present.has(slot)) {
        view.dispose();
        this.robotViews.delete(slot);
      }
    }
    for (const r of world.robots) {
      const def = robotById(r.robot);
      // Team numbers on the signs, like real robots; online, the player's name says who drives which.
      const sign = (this.session?.online ? names[r.slot] : undefined) ?? def.number;
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
    const slot = this.session?.localSlot ?? null;
    const mine = world.robots.find(r => r.slot === slot);
    this.hud.update({
      alliance: slot ? slotAlliance(slot) : 'red',
      clock: matchClock(world.period, world.periodTime),
      score: { red: total(world.score.red), blue: total(world.score.blue) },
      cards: {
        red: world.score.red.redCards ? 'red' : world.score.red.yellowCards ? 'yellow' : 'none',
        blue: world.score.blue.redCards ? 'red' : world.score.blue.yellowCards ? 'yellow' : 'none',
      },
      // The battery block shows only when the battery rule is on (the host's choice online).
      battery: mine && (this.net ? this.net.room?.rules.battery : this.settings.rules.battery) ? { voltage: mine.voltage, min: mine.minVoltage } : null,
    });
  }

  private handleGameplayButtons(): void {
    const input = this.input;
    if (input.triggered('pause')) return this.pause();
    // The camera is picked before the match; only the follow camera turns around during play.
    if (input.triggered('camera') && this.rig.mode === 'follow') this.rig.flip();
    if (input.triggered('fieldCentric')) {
      this.settings.fieldCentric = !this.settings.fieldCentric;
      this.saveSettings();
    }
    if (input.triggered('slow')) this.slowMode = !this.slowMode;
    if (input.keyboard.pressed('KeyR') && !this.session?.online) this.startSolo(this.lastSoloMode);
  }

  /** gamepad1 drives; mechanisms listen to both gamepads, so a second driver can run them as in FTC. */
  private readDriverInput(): RobotInput {
    const input = this.input;
    const { lx, ly, rx } = input.driveSticks();
    const { drive, turn } = this.settings.sensitivity;
    // Sensitivity scales the stick; the drive vector keeps its direction when it hits full speed.
    const k = drive / Math.max(1, Math.hypot(lx, ly) * drive);
    return {
      lx: lx * k,
      ly: ly * k,
      rx: Math.max(-1, Math.min(1, rx * turn)),
      fieldCentric: this.settings.fieldCentric,
      slow: this.slowMode,
      intake: input.held('intake'),
      eject: input.held('eject'),
      transfer: input.held('transfer'),
      shooterOn: input.triggered('shooterOn'),
      shooterOff: input.triggered('shooterOff'),
      imuReset: input.triggered('imuReset'),
      armUp: input.triggered('armUp'),
      armDown: input.triggered('armDown'),
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
    const p1 = this.input.slotInfo(0);
    const key = p1 ? `${p1.index}|${p1.model}` : '';
    if (key === this.lastPad1) return;
    if (p1) this.hud.toast(t('pad.connected', { model: modelName(p1.model) }));
    else if (this.lastPad1) this.hud.toast(t('pad.disconnected'));
    this.lastPad1 = key;
  }
}
