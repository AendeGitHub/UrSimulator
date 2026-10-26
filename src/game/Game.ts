// Owns the scene, input and screens; draws whatever the current session (solo or online) reports.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CAMERA_MODES, CAMERA_NAMES, CameraRig, type CameraMode } from '../camera/CameraRig';
import type { FieldLayout } from '../field/layout';
import { MODEL_NAMES } from '../input/gamepad';
import { InputManager } from '../input/InputManager';
import { NetSession, defaultServerUrl } from '../net/NetSession';
import { cleanName, type RoomInfo } from '../net/protocol';
import type { Alliance } from '../robot/robotConfig';
import { DEFAULT_ROBOT_ID, robotById } from '../robot/robots';
import { parseColliders, type ColliderPart } from '../sim/colliders';
import { CAPACITY, shotRange } from '../sim/Mechanisms';
import { matchClock } from '../sim/Match';
import { initPhysics } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import { slotAlliance, type GameMode, type RobotInput, type Slot } from '../sim/types';
import { GamepadScreen } from '../ui/GamepadScreen';
import { Hud } from '../ui/Hud';
import { HelpScreen, MainMenu, PauseMenu, type Screen } from '../ui/menus';
import { ConnectScreen, LobbyScreen } from '../ui/online';
import { RobotSelectScreen, type SelectPurpose, type SelectSettings } from '../ui/RobotSelect';
import { ResultsScreen, type ResultsTeam } from '../ui/ResultsScreen';
import { Arena } from '../view/Arena';
import { asset } from '../view/assets';
import { BallsView } from '../view/BallsView';
import { FieldView } from '../view/FieldView';
import { RobotView } from '../view/RobotView';
import { total, type AllianceScore } from './scoring';
import { LocalSession, type Session, type SessionEvents } from './Session';

const SETTINGS_KEY = 'ursim.settings';
/** Where the robot stands on the selection screen (x, z): open floor on the red side. */
const PREVIEW_SPOT: [number, number] = [-1.05, 0.95];

type State = 'menu' | 'select' | 'playing' | 'paused' | 'results' | 'lobby';

interface Settings {
  robot: string;
  alliance: Alliance;
  fieldCentric: boolean;
  camera: CameraMode;
  name: string;
  server: string;
}

function loadSettings(): Settings {
  const defaults: Settings = { robot: DEFAULT_ROBOT_ID, alliance: 'red', fieldCentric: true, camera: 'driver', name: '', server: defaultServerUrl() };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...defaults, ...saved, camera: CAMERA_MODES.includes(saved.camera) ? saved.camera : defaults.camera };
  } catch {
    return defaults;
  }
}

/** Driver stations: "1" stands closest to the audience (+Z). */
const DRIVER_Z: Record<Slot, number> = { red1: 0.6, red2: -0.6, blue1: 0.6, blue2: -0.6 };

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
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
    main: MainMenu; select: RobotSelectScreen; pause: PauseMenu; help: HelpScreen; pads: GamepadScreen; results: ResultsScreen; connect: ConnectScreen; lobby: LobbyScreen;
  };
  private returnTo: Screen | null = null;

  private lastTime = 0;
  private fps = 60;
  private menuOrbit = 0;
  private resetKeyWasDown = false;
  private lastPad1 = '';
  private slowMode = false;
  private lastSoloMode: GameMode = 'practice';

  private constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.rig = new CameraRig(this.renderer.domElement);
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    container.append(this.hud.el, this.overlay);
    this.hud.el.hidden = true;

    const back = () => this.show(this.returnTo);
    this.screens = {
      main: new MainMenu({
        match: () => this.openSelect('match'),
        practice: () => this.openSelect('practice'),
        online: () => this.openSelect('online'),
        gamepads: () => this.openSub(this.screens.pads),
        help: () => this.openSub(this.screens.help),
      }),
      select: new RobotSelectScreen(this.selectSettings(), {
        change: settings => this.applySelect(settings),
        start: purpose => (purpose === 'online' ? this.show(this.screens.connect) : this.startSolo(purpose)),
        back: () => this.toMenu(),
      }),
      pause: new PauseMenu({
        resume: () => this.resume(),
        resetRobot: () => this.startSolo(this.lastSoloMode),
        gamepads: () => this.openSub(this.screens.pads),
        help: () => this.openSub(this.screens.help),
        stopOnline: () => this.net?.stop(),
        exit: () => this.toMenu(),
      }),
      help: new HelpScreen(this.input, back),
      pads: new GamepadScreen(this.input, back),
      results: new ResultsScreen({
        again: () => (this.net ? this.showLobby() : this.startSolo('match')),
        practice: () => this.startSolo('practice'),
        menu: () => this.toMenu(),
      }),
      connect: new ConnectScreen({ name: this.settings.name, server: this.settings.server }, {
        create: (name, server) => this.connect(name, server, net => net.create()),
        join: (name, server, code) => this.connect(name, server, net => net.join(code)),
        back: () => this.show(this.screens.main),
      }),
      lobby: new LobbyScreen({
        takeSlot: slot => this.net?.takeSlot(slot),
        start: mode => this.net?.start(mode),
        leave: () => this.toMenu(),
      }),
    };

    this.setupLighting();
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
    game.ballsView = new BallsView(layout, game.scene);
    game.showHomeField();
    game.show(game.screens.main);
    requestAnimationFrame(t => game.frame(t));
    return game;
  }

  private setupLighting(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    this.scene.background = new THREE.Color('#3a4150');
    new Arena(this.scene);

    // Bright, even gym lighting from the ceiling.
    this.scene.add(new THREE.HemisphereLight('#f2f5ff', '#5a6070', 1.3));
    const sun = new THREE.DirectionalLight('#ffffff', 2.4);
    sun.position.set(2.5, 7, 3.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -3.4;
    sun.shadow.camera.right = 3.4;
    sun.shadow.camera.top = 3.4;
    sun.shadow.camera.bottom = -3.4;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 16;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Settings simply won't persist.
    }
  }

  private selectSettings(): SelectSettings {
    const { robot, alliance, camera, fieldCentric } = this.settings;
    return { robot, alliance, camera, fieldCentric };
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
    if (this.preview?.def !== def) {
      this.preview?.dispose();
      this.preview = new RobotView(def, this.settings.alliance, def.team);
      this.scene.add(this.preview.root);
    }
    this.preview.setIdentity(this.settings.alliance, def.team);
    this.preview.root.position.set(PREVIEW_SPOT[0], 0.002, PREVIEW_SPOT[1]);
  }

  private hidePreview(): void {
    this.preview?.dispose();
    this.preview = null;
  }


  // ---- sessions --------------------------------------------------------------

  private readonly sessionEvents: SessionEvents = {
    toast: text => this.hud.toast(text),
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
    this.session = new LocalSession(this.layout, this.colliders, slot, this.settings.robot, mode, this.sessionEvents);
    this.enterPlay();
    if (mode === 'match') this.hud.toast('АВТОНОМ: 30 секунд. Автонома пока нет — потренируй маршрут вручную');
  }

  private connect(name: string, server: string, action: (net: NetSession) => void): void {
    this.endSession();
    this.settings.name = cleanName(name);
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
        this.screens.connect.setStatus('Соединение с сервером потеряно', true);
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
    this.rig.setMode(slot ? this.settings.camera : 'top');
    this.slowMode = false;
    this.resume();
  }

  // ---- screens -------------------------------------------------------------

  private show(screen: Screen | null): void {
    this.screen = screen;
    this.overlay.replaceChildren(...(screen ? [screen.el] : []));
    this.overlay.classList.toggle('active', !!screen);
    if (screen) {
      screen.onShow?.();
      screen.nav.focusFirst();
    }
  }

  private openSub(screen: Screen): void {
    this.returnTo = this.screen;
    this.show(screen);
  }

  private resume(): void {
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
    const slot = this.session?.localSlot ?? null;
    const mine = slot ? slotAlliance(slot) : null;
    const names = this.session?.names() ?? {};
    const teams: Record<Alliance, ResultsTeam[]> = { red: [], blue: [] };
    // Online the room knows every driver even if the last snapshot is already gone.
    const robots = this.net?.room?.players.flatMap(p => (p.slot ? [{ slot: p.slot, robot: p.robot }] : [])) ?? this.session?.state()?.robots ?? [];
    for (const r of robots) {
      const def = robotById(r.robot);
      teams[slotAlliance(r.slot)].push({ name: names[r.slot] ?? def.team, logo: def.teamLogo });
    }
    // Personal best for solo matches, kept in this browser.
    let highScore = false;
    if (mine && !this.net) {
      const points = total(score[mine]);
      const key = `ursim.best.${this.settings.robot}`;
      try {
        const best = Number(localStorage.getItem(key) ?? 0);
        if (points > best) {
          localStorage.setItem(key, String(points));
          highScore = best > 0 || points > 0;
        }
      } catch {
        // No storage: no record keeping.
      }
    }
    const title = this.net?.room ? `Онлайн-матч · комната ${this.net.room.code}` : 'Матч';
    this.screens.results.show({ score, mine, teams, title, online: !!this.net, highScore });
    this.show(this.screens.results);
  }

  private toMenu(): void {
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
    this.rig.resize(w, h);
  }

  private frame(time: number): void {
    requestAnimationFrame(t => this.frame(t));
    const dt = Math.min(0.1, this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60);
    this.lastTime = time;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    this.tick(dt);
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
      if (this.screen) {
        this.screen.update?.(this.input);
        if (!this.screen.blocksNav) this.screen.nav.update(this.input);
        if (this.state === 'paused' && this.screen === this.screens.pause && this.input.pressed(1, 'guide')) this.resume();
      }
    }

    const world = this.session?.state() ?? null;
    if (world) this.draw(world, this.state === 'paused' && !this.session?.online ? 0 : dt);
    const mine = world?.robots.find(r => r.slot === this.session?.localSlot) ?? null;
    if (this.state === 'menu') this.updateMenuCamera(dt);
    else if (this.state === 'select') this.updatePreviewCamera(dt);
    else this.rig.update(mine, dt);
    if (world && (this.state === 'playing' || this.state === 'paused')) this.updateHud(world);
    this.renderer.render(this.scene, this.rig.camera);
  }

  private draw(world: WorldState, dt: number): void {
    this.field.setHiveAngles(world.hiveAngles);
    this.ballsView.update(world.balls);
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
      let view = this.robotViews.get(r.slot);
      if (view && view.def !== def) {
        view.dispose();
        view = undefined;
      }
      if (!view) {
        view = new RobotView(def, slotAlliance(r.slot), names[r.slot] ?? def.team);
        this.scene.add(view.root);
        this.robotViews.set(r.slot, view);
      }
      view.setIdentity(slotAlliance(r.slot), names[r.slot] ?? def.team);
      view.apply(r, dt);
    }
  }

  private updateHud(world: WorldState): void {
    const slot = this.session?.localSlot ?? null;
    const mine = world.robots.find(r => r.slot === slot);
    this.hud.update({
      spectator: !mine,
      model: this.input.model1,
      gamepad2: this.input.slotInfo(1)?.model ?? null,
      fieldCentric: this.settings.fieldCentric,
      slow: this.slowMode,
      headingDeg: ((mine?.heading ?? 0) * 180) / Math.PI,
      speed: mine?.speed ?? 0,
      camera: CAMERA_NAMES[this.rig.mode],
      alliance: slot ? slotAlliance(slot) : 'red',
      fps: this.fps,
      clock: matchClock(world.period, world.periodTime),
      score: { red: total(world.score.red), blue: total(world.score.blue) },
      cards: {
        red: world.score.red.redCards ? 'red' : world.score.red.yellowCards ? 'yellow' : 'none',
        blue: world.score.blue.redCards ? 'red' : world.score.blue.yellowCards ? 'yellow' : 'none',
      },
      tips: world.tips,
      stored: (mine?.stored ?? []).map(id => this.ballsView.specs[id].color),
      capacity: CAPACITY,
      shooter: mine?.status ?? 'off',
      shotSpeed: mine?.shotSpeed ?? 0,
      targetDistance: mine?.shotDistance ?? 0,
      range: shotRange(mine?.shotDistance ?? 0, robotById(mine?.robot).shooter),
    });
  }

  private handleGameplayButtons(): void {
    const input = this.input;
    if (input.pressed(1, 'guide')) return this.pause();
    if (input.pressed(1, 'right_stick_button') || input.pressed(1, 'touchpad')) {
      this.settings.camera = this.rig.next();
      this.saveSettings();
      this.hud.toast(`Камера: ${CAMERA_NAMES[this.rig.mode]}`);
    }
    if (input.pressed(1, 'back')) {
      this.settings.fieldCentric = !this.settings.fieldCentric;
      this.saveSettings();
      this.hud.toast(this.settings.fieldCentric ? 'Field-centric: «вверх» — от водителя' : 'Robot-centric: «вверх» — вперёд робота');
    }
    if (input.pressed(1, 'start')) this.hud.toast('Курс сброшен: «вперёд» = куда сейчас смотрит робот');
    if (input.pressed(1, 'left_stick_button')) {
      this.slowMode = !this.slowMode;
      this.hud.toast(this.slowMode ? 'Медленный режим' : 'Обычная скорость');
    }
    const resetDown = input.keyboard.isDown('KeyR');
    if (resetDown && !this.resetKeyWasDown && !this.session?.online) this.startSolo(this.lastSoloMode);
    this.resetKeyWasDown = resetDown;
  }

  /** gamepad1 drives; mechanisms listen to both gamepads, so a second driver can run them as in FTC. */
  private readDriverInput(): RobotInput {
    const input = this.input;
    const g1 = input.gamepad1;
    const g2 = input.gamepad2;
    return {
      lx: g1.left_stick_x,
      ly: g1.left_stick_y,
      rx: g1.right_stick_x,
      fieldCentric: this.settings.fieldCentric,
      slow: this.slowMode,
      intake: g1.left_bumper || g2.left_bumper,
      eject: g1.dpad_down || g2.dpad_down,
      transfer: g1.right_bumper || g2.right_bumper,
      shooterOn: input.triggerPressed(1, 'right_trigger') || input.triggerPressed(2, 'right_trigger'),
      shooterOff: input.triggerPressed(1, 'left_trigger') || input.triggerPressed(2, 'left_trigger'),
      imuReset: input.pressed(1, 'start'),
    };
  }

  private updatePreviewCamera(dt: number): void {
    this.menuOrbit += dt * 0.25;
    const cam = this.rig.camera;
    const [x, z] = PREVIEW_SPOT;
    cam.up.set(0, 1, 0);
    // Looking slightly above the robot places it low-center, between the panels and the cards.
    cam.position.set(x + Math.cos(this.menuOrbit) * 1.25, 0.75, z + Math.sin(this.menuOrbit) * 1.25);
    cam.lookAt(x, 0.28, z);
  }

  private updateMenuCamera(dt: number): void {
    this.menuOrbit += dt * 0.07;
    const cam = this.rig.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(Math.cos(this.menuOrbit) * 4.6, 2.6, Math.sin(this.menuOrbit) * 4.6);
    cam.lookAt(0, 0.45, 0);
  }

  private announcePads(): void {
    const p1 = this.input.slotInfo(0);
    const key = p1 ? `${p1.index}|${p1.model}` : '';
    if (key === this.lastPad1) return;
    if (p1) this.hud.toast(`Подключён ${MODEL_NAMES[p1.model]} → gamepad1`);
    else if (this.lastPad1) this.hud.toast('gamepad1 отключён — управление с клавиатуры');
    this.lastPad1 = key;
  }
}
