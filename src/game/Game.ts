// Owns the scene, input and screens; draws the current game, side by side when two drivers play.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AI_LEVELS, cleanAiLevel, type AiLevel } from '../ai/level';
import { CAMERA_MODES, CameraRig, type CameraMode } from '../camera/CameraRig';
import { NECTAR_RADIUS, POLLEN_RADIUS, type FieldLayout } from '../field/layout';
import { cleanStart, forAlliance, resolveStarts, startField, startOutline, type StartField, type StartPose } from '../field/startPose';
import { buildZones } from '../field/zones';
import { withDefaults, type Bindings } from '../input/bindings';
import { padName } from '../input/gamepad';
import { InputManager } from '../input/InputManager';
import { AccountClient, canSignIn, deviceId } from '../net/account';
import type { GameReportBody, Me, Provider, ReplayInfo, ReplayUpload } from '../net/accountProtocol';
import type { RoomInfo } from '../net/lobbyProtocol';
import { GuestSession, HostSession, roomDrivers } from '../net/OnlineSession';
import { OnlineRoom } from '../net/OnlineRoom';
import { PresenceClient } from '../net/presence';
import { RobotSync } from '../net/robotSync';
import { defaultServerUrl, rememberRecord, restoreRecords } from '../net/records';
import { customDefinition, withoutMesh, type Blueprint } from '../robot/custom';
import { addSharedRobot, definitionOf, deleteRobot, putMeshFile, saveRobot, type SavedRobot } from '../robot/customStore';
import type { Alliance } from '../robot/robotConfig';
import { DEFAULT_ROBOT_ID, ROBOTS, boxExitPosition, isCustomRobotId, pushBackSpot, robotById, robotTitle, turretsOf, type RobotDefinition } from '../robot/robots';
import type { BallKind } from '../sim/BallSim';
import { parseColliders, type ColliderPart } from '../sim/colliders';
import { DURATION, TELEOP_COUNTDOWN, matchClock } from '../sim/Match';
import { cleanRules, type RuleOptions } from '../sim/Referee';
import { initPhysics } from '../sim/Simulation';
import type { WorldState } from '../sim/state';
import { SLOTS, idleInput, slotAlliance, type GameMode, type RobotInput, type Slot } from '../sim/types';
import { FriendsPanel } from '../ui/FriendsPanel';
import { GamepadScreen } from '../ui/GamepadScreen';
import { Hud } from '../ui/Hud';
import { MainMenu, PauseMenu, type Screen } from '../ui/menus';
import { RoomListScreen, RoomScreen, lobbyErrorText } from '../ui/OnlineScreens';
import { RecordsScreen } from '../ui/RecordsScreen';
import { RobotSelectScreen, aiLevelName, isSplit, opponentIn, type Opponent, type Pad2Role, type SelectPurpose, type SelectSettings } from '../ui/RobotSelect';
import { ResultsScreen, type ResultsTeam } from '../ui/ResultsScreen';
import { StartPositionScreen, startKeys } from '../ui/StartPositionScreen';
import { WinAnimation } from '../ui/WinAnimation';
import { WorkshopScreen } from '../ui/Workshop';
import { localize, setLanguage, startLanguage, t, type Language } from '../ui/i18n';
import { ClickSound } from '../ui/clickSound';
import { ReplayStudio } from '../ui/ReplayStudio';
import { DEFAULT_GRAPHICS, DEFAULT_SOUND, SettingsScreen, cleanSensitivity, type GraphicsSettings, type QualityPreset, type Sensitivity, type SettingsValues, type SoundSettings } from '../ui/SettingsScreen';
import { Arena } from '../view/Arena';
import { asset } from '../view/assets';
import { BallsView, loadBallShapes, type HeldBall } from '../view/BallsView';
import { robotHelpers, robotThumbnail } from '../view/customModel';
import { FieldLights } from '../view/FieldLights';
import { FieldView } from '../view/FieldView';
import { HallAds } from '../view/HallAds';
import { RobotView, robotModel, setModelDetail, setRobotEnvironment } from '../view/RobotView';
import { ScreenEffects } from '../view/ScreenEffects';
import { StartMarker } from '../view/StartMarker';
import { TimerScreens } from '../view/TimerScreens';
import { MATCH_COUNTDOWN, MatchTimer, recordingTime } from './matchTimer';
import { Replay, ReplayRecorder, type ReplayFrame } from './replay';
import { EventRanking } from './ranking';
import { autoPoints, earnedPoints, matchRankingPoints, matchWinner, scoreRows, total, type AllianceScore } from './scoring';
import { cleanScoreDisplay, type ScoreDisplay } from './scoreDisplay';
import { Session, type Driver, type GameSession, type SessionEvents } from './Session';

const SETTINGS_KEY = 'ursim.settings';
/** Where the robot stands on the selection screen (x, z): open floor on the red side. */
const PREVIEW_SPOT: [number, number] = [-1.05, 0.95];
/** Picking a start: room around the field in the view from above, m */
const PLACE_MARGIN = 0.3;
const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/**
 * Main menu view (MoSim style): a high corner view from the audience side that sways slowly.
 * The camera aims `shift` m left of the field center so the field sits right of the menu list.
 */
const MENU_VIEW = { angle: 0.62 * Math.PI, sway: 0.06 * Math.PI, distance: 4.25, height: 3.2, shift: 0.95 };
/**
 * The Workshop's view of the robot it shows: around it at this height above the tiles, closer or
 * further (m), and turning slowly by itself once the player has let go of it for `idle` s.
 */
const WORKSHOP_VIEW = { target: 0.16, near: 0.45, far: 1.6, idle: 4 };

type State = 'menu' | 'select' | 'place' | 'workshop' | 'playing' | 'paused' | 'results' | 'replay';

/** The developer build (`npm run dev`): practice is recorded from the start, for clips in the replay studio. */
const STUDIO = import.meta.env.DEV;

/**
 * Every game starts after a 3-2-1 with the field still (a match: the timer recording's own, a
 * little longer), and so does TELEOP; then GO! stays up this long, s.
 */
const COUNTDOWN = 3;
const GO_SHOWN = 0.7;
/** Shorter practice doesn't count as a game, s (server/Lobby.ts MIN_PRACTICE) */
const MIN_PRACTICE = 20;
/** The main menu's totals are fetched again after this long, ms */
const TOTALS_TTL = 30_000;

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
  /** The AI in a game at this computer (1 vs 1 or 2 vs 2), its robot and how well it drives */
  opponent: Opponent;
  aiRobot: string;
  /** Also the level of the AI in an online room this player makes */
  aiLevel: AiLevel;
  /** Where the player wants each robot to start (red side, by robot id); the usual spot if missing */
  startPoses: Record<string, StartPose>;
  bindings: Bindings;
  sensitivity: Sensitivity;
  graphics: GraphicsSettings;
  sound: SoundSettings;
  rules: RuleOptions;
  /** The scores during a match (Settings → Interface) */
  scoreDisplay: ScoreDisplay;
  language: Language;
  /** The player picked the language in the settings; until then the game is in English */
  languagePicked: boolean;
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
    aiRobot: DEFAULT_ROBOT_ID,
    ...saved,
    pad2: saved.pad2 === 'operator' ? 'operator' : 'robot',
    opponent: saved.opponent === 'ai' || saved.opponent === 'ai2v2' ? saved.opponent : 'none',
    aiLevel: cleanAiLevel(saved.aiLevel),
    camera: CAMERA_MODES.includes(saved.camera as CameraMode) ? saved.camera as CameraMode : 'driver',
    startPoses: cleanStarts(saved.startPoses),
    // Nested settings are merged so options added in a later version get their defaults.
    bindings: withDefaults(saved.bindings),
    sensitivity: cleanSensitivity(saved.sensitivity),
    graphics: { ...DEFAULT_GRAPHICS, ...saved.graphics },
    sound: { ...DEFAULT_SOUND, ...saved.sound },
    rules: cleanRules(saved.rules),
    scoreDisplay: cleanScoreDisplay(saved.scoreDisplay),
    language: startLanguage(saved.language, saved.languagePicked),
    languagePicked: saved.languagePicked === true,
  };
}

/** Saved starts of robots that are in the game, as poses. */
function cleanStarts(value: unknown): Record<string, StartPose> {
  const starts: Record<string, StartPose> = {};
  if (!value || typeof value !== 'object') return starts;
  for (const [robot, pose] of Object.entries(value)) {
    const start = cleanStart(pose);
    if (start && (ROBOTS.some(r => r.id === robot) || isCustomRobotId(robot))) starts[robot] = start;
  }
  return starts;
}

/**
 * World positions of the balls inside each robot, so you can see how many it holds. A robot with
 * several turrets keeps each ball in the lane of a turret that shoots it, the one with fewest.
 */
function heldBallPositions(world: WorldState, kindOf: (id: number) => BallKind): Map<number, HeldBall> {
  const held = new Map<number, HeldBall>();
  for (const r of world.robots) {
    const def = robotById(r.robot);
    const cos = Math.cos(r.yaw);
    const sin = Math.sin(r.yaw);
    const turrets = turretsOf(def);
    const inLane = turrets.map(() => 0);
    r.stored.forEach(id => {
      const kind = kindOf(id);
      let lane = -1;
      turrets.forEach((t, k) => {
        if ((!t.kinds || t.kinds.includes(kind)) && (lane < 0 || inLane[k] < inLane[lane])) lane = k;
      });
      lane = Math.max(0, lane);
      const places = turrets[lane].storage;
      const i = inLane[lane]++;
      const [fx, y, rz] = places[Math.min(i, places.length - 1)];
      // Same rotation as the robot model (about +Y by yaw).
      held.set(id, { pos: [r.x + fx * cos + rz * sin, y, r.z - fx * sin + rz * cos], place: `${r.slot}:${lane}:${i}` });
    });
    // The push back's ball on the floor in front of the intake, inside the lowered arm.
    if (r.pocket !== null && def.arm) {
      const at = pushBackSpot(def.intakeFront ?? def.config.length / 2, def.arm);
      const y = (kindOf(r.pocket) === 'nectar' ? NECTAR_RADIUS : POLLEN_RADIUS) + (def.arm.pocketLift ?? 0);
      held.set(r.pocket, { pos: [r.x + at * cos, y, r.z - at * sin], place: `${r.slot}:pocket` });
    }
    // Balls in a lift's box stand one on another under the top one, as high as its rollers have
    // carried them, riding the lift; the one leaving it goes out through the hole in its back wall.
    const lift = def.lift;
    if (lift) {
      const [fx, bottom, rz] = lift.storage[0];
      const apart = lift.storage[1][1] - bottom;
      const up = r.lift * lift.height;
      const at = (y: number): [number, number, number] => [r.x + fx * cos + rz * sin, y + up, r.z - fx * sin + rz * cos];
      r.box.forEach((id, i) => held.set(id, { pos: at(r.boxTop - i * apart), place: `${r.slot}:box:${id}` }));
      if (r.boxExit) held.set(r.boxExit.id, { pos: boxExitPosition(lift, r.x, r.z, r.yaw, up, r.boxExit.t, r.boxExit.to), place: `${r.slot}:boxExit` });
    }
  }
  return held;
}

/**
 * Render quality steps, best first. Slow computers step down automatically: fewer pixels first,
 * then no ambient occlusion. The pixel ratio never goes above the screen's own. Edges are smoothed
 * by FXAA instead of drawing extra pixels, so even the top step draws few.
 */
const QUALITY: { ratio: number; ao: boolean; ultra?: boolean }[] = [
  // Ultra (only when picked): at least twice the screen's pixels, so even a plain screen gets
  // supersampled edges; full-resolution ambient occlusion and sharper, softer shadows.
  { ratio: 2, ao: true, ultra: true },
  { ratio: 1.25, ao: true },
  { ratio: 1, ao: true },
  { ratio: 1, ao: false },
  { ratio: 0.85, ao: false },
];
/** Fixed presets from Settings → Graphics, as steps of the ladder above */
const PRESET_LEVEL: Record<Exclude<QualityPreset, 'auto'>, number> = { ultra: 0, high: 1, medium: 2, low: 4 };
/** Auto never climbs above High: Ultra is for computers picked for it. */
const AUTO_TOP = 1;
/** Below this frame rate quality steps down; above the upper one for a while it tries a step up. */
const FPS_LOW = 50;
const FPS_HIGH = 58;

/** Driver stations: "1" stands closest to the audience (+Z). */
const DRIVER_Z: Record<Slot, number> = { red1: 0.6, red2: -0.6, blue1: 0.6, blue2: -0.6 };

const slotOf = (alliance: Alliance, station: 1 | 2): Slot => `${alliance}${station}`;

/** Who drives each robot of an online room's match: the players by name, the AI as itself. */
function roomNames(room: RoomInfo): Partial<Record<Slot, string>> {
  const names: Partial<Record<Slot, string>> = {};
  for (const d of roomDrivers(room).ai) names[d.slot] = t('online.ai');
  for (const m of room.members) if (m.slot) names[m.slot] = m.name;
  return names;
}

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
  private readonly matchTimer = new MatchTimer();
  private readonly clickSound = new ClickSound(asset('assets/sound/click.mp3'));
  private readonly overlay: HTMLElement;
  private readonly settings = loadSettings();

  private layout!: FieldLayout;
  private colliders!: ColliderPart[];
  private field!: FieldView;
  private fieldLights: FieldLights | null = null;
  private hallAds!: HallAds;
  private ballsView!: BallsView;
  private readonly robotViews = new Map<Slot, RobotView>();
  private preview: RobotView | null = null;
  /** The Workshop: boxes that show how an uploaded model fits the robot */
  private previewHelpers: THREE.Group | null = null;
  /** The Workshop's view around its robot (WORKSHOP_VIEW) */
  private readonly orbit = { yaw: 0.9, pitch: 0.42, distance: 0.9, idle: 0 };
  /** Where the Workshop goes back to, the robot last saved in it, and the robot of a test drive under way */
  private workshopFrom: 'menu' | 'select' = 'menu';
  private workshopSaved: string | null = null;
  private testDriving: string | null = null;
  /** What the robot selection was opened for */
  private selectPurpose: SelectPurpose = 'practice';
  /** The red side's limits for a robot's start (G304) */
  private startField!: StartField;
  /** Picking a start: whose robot, where on the field, and the screen to go back to */
  private placing: { from: 'select' | 'room'; robot: RobotDefinition; slot: Slot } | null = null;
  private startMarker!: StartMarker;
  private readonly raycaster = new THREE.Raycaster();

  private session: GameSession | null = null;
  /** Online: the room, and this game's side of the match (the admin's or a guest's) */
  private online: OnlineRoom | null = null;
  private net: HostSession | GuestSession | null = null;
  /** The admin when the online game started: telling "the admin left" from "the admin ended it" */
  private netAdmin = -1;
  /** Online: who drives each robot (the AI's stations too), shown over the robots in the game and its replays */
  private names: Partial<Record<Slot, string>> | null = null;
  private players: Player[] = [];
  /** Seconds until the game starts; below zero while GO! is still up. */
  private startIn = -GO_SHOWN;
  /**
   * The game being recorded (a match always, practice once the player starts it from the pause
   * menu, or always in the developer build), the last match finished, and the viewer to watch it
   */
  private recorder: ReplayRecorder | null = null;
  private lastReplay: readonly ReplayFrame[] | null = null;
  /** The player started the recording (REC on the HUD), and the one they stopped, to watch from the pause menu */
  private recordingOwn = false;
  private demo: readonly ReplayFrame[] | null = null;
  private readonly studio: ReplayStudio;
  /** Studio recording: a fixed picture size instead of the window's */
  private captureSize: [number, number] | null = null;
  /** Where the replay goes back to: the results, the game behind the pause menu, or the archive in the career */
  private studioFrom: 'results' | 'paused' | 'records' = 'results';

  private state: State = 'menu';
  private screen: Screen | null = null;
  private readonly screens: {
    main: MainMenu; select: RobotSelectScreen; pause: PauseMenu; settings: SettingsScreen; pads: GamepadScreen; results: ResultsScreen; records: RecordsScreen;
    rooms: RoomListScreen; room: RoomScreen; start: StartPositionScreen; workshop: WorkshopScreen;
  };
  /** Screens to go back to (main menu → settings → gamepads) */
  private readonly stack: Screen[] = [];
  private spot!: THREE.SpotLight;
  private fpsAverage = 60;
  private fpsShown = 0;

  private lastTime = 0;
  /** Index into QUALITY, and the best level that ran too slowly (never tried again). */
  private quality = AUTO_TOP;
  private qualityFloor = AUTO_TOP;
  private perf = { time: 0, frames: 0, goodTime: 0 };
  private menuOrbit = 0;
  /** gamepad1 and gamepad2 as last announced */
  private readonly lastPads = ['', ''];
  private lastMode: GameMode = 'practice';
  /** Matches finished since the page opened, as qualifications: each team's place on the results */
  private readonly ranking = new EventRanking();
  /** RED WINS! / BLUE WINS! between the end of a match and the results */
  private readonly winAnimation = new WinAnimation();
  /** The signed-in player, the online count and friends (server/api.ts) */
  readonly account = new AccountClient();
  /** The player's own robots kept with their account, so they have them on every computer */
  private readonly robotSync = new RobotSync(this.account, robot => robotThumbnail(definitionOf(robot)), () => this.screens.workshop.robotsChanged());
  private presence: PresenceClient | null = null;
  private readonly friends: FriendsPanel;
  private totalsFetched = 0;
  /** The game being played at this computer, for the statistics: who drives what */
  private localGame: { players: GameReportBody['players']; ai: GameReportBody['ai']; reported: boolean } | null = null;

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
    this.studio = new ReplayStudio({
      canvas: this.renderer.domElement,
      rig: this.views[0].rig,
      audioStream: () => this.matchTimer.audioStream(),
      captureSize: size => {
        this.captureSize = size;
        this.setQuality(this.quality);
      },
      exit: () => this.closeStudio(),
    });
    container.append(this.hud.el, this.winAnimation.el, this.overlay, this.studio.el);
    this.hud.el.hidden = true;
    // Every menu button clicks, with the mouse or the gamepad (MenuNav clicks it).
    this.overlay.addEventListener('click', e => {
      if (e.target instanceof Element && e.target.closest('button')) this.clickSound.play();
    });

    const back = () => this.show(this.stack.pop() ?? this.screens.main);
    const openSettings = () => {
      this.screens.settings.open(this.settingsValues());
      this.openSub(this.screens.settings);
    };
    this.screens = {
      main: new MainMenu({
        match: () => this.openSelect('match'),
        practice: () => this.openSelect('practice'),
        online: () => this.openOnline(),
        workshop: () => this.openWorkshop(null, 'menu'),
        records: () => {
          this.screens.records.open({ tab: 'leaderboard' });
          this.openSub(this.screens.records);
        },
        settings: openSettings,
        account: () => this.openCareer(null),
        friends: () => (this.friends.isOpen ? this.friends.close() : this.friends.open()),
      }, !canSignIn()),
      select: new RobotSelectScreen(this.selectSettings(), {
        change: settings => this.applySelect(settings),
        start: purpose => this.startGame(purpose),
        startPosition: () => this.openStartPosition('select'),
        hasStart: robot => !!this.settings.startPoses[robot],
        workshop: robot => this.openWorkshop(robot, 'select'),
        back: () => this.toMenu(),
      }),
      pause: new PauseMenu({
        resume: () => this.resume(),
        resetRobot: () => !this.online && this.startGame(this.lastMode),
        camera: () => {
          const mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.settings.camera) + 1) % CAMERA_MODES.length];
          this.settings.camera = mode;
          this.saveSettings();
          for (const p of this.players) p.view.rig.setMode(mode);
          this.showPauseLocal();
        },
        drive: () => {
          const on = !(this.players[0]?.fieldCentric ?? this.settings.fieldCentric);
          this.settings.fieldCentric = on;
          this.saveSettings();
          for (const p of this.players) p.fieldCentric = on;
          this.showPauseLocal();
        },
        aiLevel: () => {
          const level = AI_LEVELS[(AI_LEVELS.indexOf(this.settings.aiLevel) + 1) % AI_LEVELS.length];
          this.settings.aiLevel = level;
          this.saveSettings();
          this.session?.setAiLevel?.(level);
          this.showPauseLocal();
        },
        settings: openSettings,
        exit: () => this.toMenu(),
        record: () => this.toggleRecording(),
        watch: () => this.openStudio(this.recorder?.frames ?? this.demo),
        endOnline: () => this.backToRoom(),
      }),
      settings: new SettingsScreen({
        change: values => {
          // A language picked here is kept; one never picked stays English (loadSettings).
          if (values.language !== this.settings.language) this.settings.languagePicked = true;
          Object.assign(this.settings, values);
          this.saveSettings();
          this.applySettings();
        },
        gamepads: () => this.openSub(this.screens.pads),
        back,
      }),
      pads: new GamepadScreen(this.input, back),
      results: new ResultsScreen({
        again: () => (this.online ? this.backToRoom() : this.startGame(this.lastMode)),
        menu: () => this.toMenu(),
        replay: () => this.openStudio(),
      }),
      records: new RecordsScreen({
        account: this.account,
        name: () => this.settings.name,
        rename: name => {
          this.settings.name = name;
          this.saveSettings();
        },
        signIn: provider => this.signIn(provider),
        watch: replay => this.watchArchived(replay),
        back,
      }),
      rooms: new RoomListScreen({
        rename: name => {
          this.settings.name = name;
          this.saveSettings();
          this.online?.lobby.send({ t: 'hello', name });
        },
        quick: () => this.online?.lobby.send({ t: 'quick', robot: this.settings.robot, custom: this.myBlueprint(), start: this.myStart() }),
        cancelQuick: () => this.online?.lobby.send({ t: 'quickCancel' }),
        // A new room starts with this player's house rules and scoreboard (Settings → Rules, Interface).
        create: format => this.online?.lobby.send({ t: 'create', format, robot: this.settings.robot, custom: this.myBlueprint(), start: this.myStart(), rules: this.settings.rules, scoreDisplay: this.settings.scoreDisplay, aiLevel: this.settings.aiLevel }),
        join: (room, password) => this.online?.lobby.send({ t: 'join', room, robot: this.settings.robot, custom: this.myBlueprint(), start: this.myStart(), password }),
        back: () => this.toMenu(),
      }),
      room: new RoomScreen({
        slot: slot => this.online?.lobby.send({ t: 'slot', slot }),
        robot: robot => {
          this.settings.robot = robot;
          this.saveSettings();
          this.online?.lobby.send({ t: 'robot', robot, custom: this.myBlueprint(), start: this.myStart() });
        },
        startPosition: () => this.openStartPosition('room'),
        local: () => ({ camera: this.settings.camera, fieldCentric: this.settings.fieldCentric }),
        camera: mode => {
          this.settings.camera = mode;
          this.saveSettings();
          this.screens.room.render();
        },
        fieldCentric: on => {
          this.settings.fieldCentric = on;
          this.saveSettings();
          this.screens.room.render();
        },
        settings: openSettings,
        lock: password => this.online?.lobby.send({ t: 'lock', password }),
        ai: (slot, robot) => {
          if (robot) {
            this.settings.aiRobot = robot;
            this.saveSettings();
          }
          this.online?.lobby.send({ t: 'ai', slot, robot });
        },
        aiLevel: level => {
          this.settings.aiLevel = level;
          this.saveSettings();
          this.online?.lobby.send({ t: 'aiLevel', level });
        },
        rules: rules => this.online?.lobby.send({ t: 'rules', rules }),
        mode: mode => this.online?.lobby.send({ t: 'mode', mode }),
        scoreDisplay: display => this.online?.lobby.send({ t: 'scoreDisplay', display }),
        start: () => this.online?.lobby.send({ t: 'start' }),
        leave: () => this.online?.lobby.send({ t: 'leave' }),
      }),
      start: new StartPositionScreen({
        moved: (pose, problem) => this.movePlaced(pose, !problem),
        floorPoint: (x, y) => this.floorPoint(x, y),
        save: pose => this.saveStart(pose),
        cancel: () => this.closeStartPosition(),
      }),
      workshop: new WorkshopScreen({
        show: (def, helpers) => this.showWorkshopRobot(def, helpers),
        save: (robot, model) => this.saveCustomRobot(robot, model),
        remove: id => this.removeCustomRobot(id),
        testDrive: id => this.testDrive(id),
        signIn: () => this.openCareer(null),
        syncState: () => this.robotSync.state,
        orbit: (dx, dy) => {
          const o = this.orbit;
          o.yaw += dx * 0.008;
          o.pitch = Math.max(0.05, Math.min(1.35, o.pitch + dy * 0.006));
          o.idle = 0;
        },
        zoom: step => {
          const o = this.orbit;
          o.distance = Math.max(WORKSHOP_VIEW.near, Math.min(WORKSHOP_VIEW.far, o.distance * (1 + step * 0.1)));
          o.idle = 0;
        },
        back: () => this.closeWorkshop(),
      }, this.account),
    };

    this.friends = new FriendsPanel(this.account, {
      signIn: () => this.openCareer(null),
      join: room => {
        this.friends.close();
        this.openOnline(room);
      },
      profile: username => {
        this.friends.close();
        this.openCareer(username);
      },
    });
    this.friends.onRequests = count => this.screens.main.setRequests(count);
    this.screens.main.el.append(this.friends.el);
    this.screens.main.backHandler = () => {
      if (!this.friends.isOpen) return false;
      this.friends.close();
      return true;
    };
    this.account.onChange(me => this.accountChanged(me));

    this.setupLighting();
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      // Online the match goes on for everyone else (and runs here for the admin): no pause.
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
    game.startField = startField(layout, buildZones(layout));
    game.field = await FieldView.load(layout, game.scene, onProgress);
    game.ballsView = new BallsView(layout, game.scene, await loadBallShapes());
    game.fieldLights = new FieldLights(game.scene, layout.wallInnerHalf);
    game.fieldLights.setMode(game.settings.graphics.fieldLights);
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
    // Who is online, and the signed-in player (if this browser has a session).
    game.presence = new PresenceClient(deviceId(), game.account.sessionToken, {
      online: count => game.screens.main.setOnline(count),
      friends: () => void game.friends.refresh(),
    });
    void game.account.load();
    game.refreshTotals();
    // The match timer recording loads in the background; a match that starts before it runs silent.
    game.matchTimer.load(asset('assets/sound/match-timer.mp3'), asset('assets/sound/match-timer.mp4')).catch(() => undefined);
    game.clickSound.preload();
    return game;
  }

  private setupLighting(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.14;
    // Robots reflect it more strongly than the field: their aluminium has to shine.
    setRobotEnvironment(this.scene.environment);
    // Event lighting: the field glows under a spotlight, the hall fades into the dark around it.
    const dark = new THREE.Color('#090b0f');
    this.scene.background = dark;
    this.scene.fog = new THREE.FogExp2(dark, 0.055);
    new Arena(this.scene);
    this.hallAds = new HallAds(this.scene);
    new TimerScreens(this.scene, this.matchTimer.video);
    this.startMarker = new StartMarker(this.scene);

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
    const { robot, alliance, camera, fieldCentric, name, robot2, alliance2, pad2, opponent, aiRobot, aiLevel } = this.settings;
    return { robot, alliance, camera, fieldCentric, name, robot2, alliance2, pad2, opponent, aiRobot, aiLevel };
  }

  private openSelect(purpose: SelectPurpose): void {
    this.endSession();
    this.selectPurpose = purpose;
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
    this.setPreviewHelpers(null);
  }

  private setPreviewHelpers(helpers: THREE.Group | null): void {
    this.previewHelpers?.removeFromParent();
    this.previewHelpers?.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.previewHelpers = helpers;
    if (!helpers) return;
    helpers.position.set(PREVIEW_SPOT[0], 0.002, PREVIEW_SPOT[1]);
    this.scene.add(helpers);
  }

  // ---- the Workshop ------------------------------------------------------------

  /** The player's own robots: the list, or the editor of one (`edit`); from the main menu or the robot selection. */
  private openWorkshop(edit: string | null, from: 'menu' | 'select'): void {
    this.workshopFrom = from;
    this.workshopSaved = null;
    this.state = 'workshop';
    this.hud.el.hidden = true;
    this.orbit.idle = 0;
    if (edit && isCustomRobotId(edit) && robotById(edit).id === edit) this.screens.workshop.openEditor(edit);
    else this.screens.workshop.openList(edit ?? undefined);
    this.show(this.screens.workshop);
  }

  /** Back where the Workshop was opened from; the robot selection picks a robot just made. */
  private closeWorkshop(): void {
    const saved = this.workshopSaved;
    this.workshopSaved = null;
    this.hidePreview();
    if (this.workshopFrom === 'menu') return this.toMenu();
    if (saved) {
      this.settings.robot = saved;
      this.saveSettings();
    }
    this.state = 'select';
    this.screens.select.open(this.selectPurpose, this.selectSettings());
    this.show(this.screens.select);
    this.showPreview();
  }

  /** The Workshop's robot on the field (rebuilt when it changes), with the helper boxes for an uploaded model. */
  private showWorkshopRobot(def: RobotDefinition | null, helpers: boolean): void {
    if (this.preview?.def !== def) {
      this.preview?.dispose();
      this.preview = def && new RobotView(def, this.settings.alliance, def.number);
      if (this.preview) {
        this.preview.root.position.set(PREVIEW_SPOT[0], 0.002, PREVIEW_SPOT[1]);
        this.scene.add(this.preview.root);
      }
    }
    this.setPreviewHelpers(def && helpers ? robotHelpers(def) : null);
  }

  /** Keeps a robot from the Workshop: its 3D file, a picture of it for its card, the robot itself. */
  private async saveCustomRobot(robot: SavedRobot, model: ArrayBuffer | null): Promise<boolean> {
    try {
      if (model && robot.blueprint.mesh) await putMeshFile(robot.blueprint.mesh.id, model);
    } catch {
      return false;
    }
    const thumb = await robotThumbnail(customDefinition(robot.id, robot.blueprint)).catch(() => undefined);
    if (!saveRobot({ ...robot, thumb })) return false;
    this.workshopSaved = robot.id;
    return true;
  }

  /** A deleted robot is no longer anyone's pick here. */
  private removeCustomRobot(id: string): void {
    deleteRobot(id);
    const s = this.settings;
    if (s.robot === id) s.robot = DEFAULT_ROBOT_ID;
    if (s.robot2 === id) s.robot2 = DEFAULT_ROBOT_ID;
    if (s.aiRobot === id) s.aiRobot = DEFAULT_ROBOT_ID;
    delete s.startPoses[id];
    if (this.workshopSaved === id) this.workshopSaved = null;
    this.saveSettings();
  }

  /** Practice with a robot from the Workshop; leaving it goes back to its editor. */
  private testDrive(id: string): void {
    this.settings.robot = id;
    this.saveSettings();
    this.testDriving = id;
    this.startGame('practice');
  }

  /** The blueprint of this player's robot when it is one they made (an online room builds it from that). */
  private myBlueprint(): Blueprint | null {
    const def = robotById(this.settings.robot);
    return def.custom && def.id === this.settings.robot ? withoutMesh(def.custom) : null;
  }


  // ---- sessions --------------------------------------------------------------

  private readonly sessionEvents: SessionEvents = {
    // Drivers get no pop-ups about game events (tips, periods, cards): the field timer, the
    // scores and the battery are all they see, as at a real match.
    toast: () => {},
    finished: score => this.showResults(score),
  };

  private endSession(): void {
    // A replay being watched when the next online match starts, or the menu opens.
    this.shutStudio();
    this.reportPractice();
    this.hidePreview();
    this.clearPlacement();
    this.winAnimation.stop();
    this.session?.dispose();
    this.session = null;
    this.net = null;
    this.names = null;
    this.recorder = null;
    this.recordingOwn = false;
    this.demo = null;
    this.setPlayers([]);
    for (const view of this.robotViews.values()) view.dispose();
    this.robotViews.clear();
  }

  /**
   * gamepad1's robot, and gamepad2's on a split screen when two gamepads are connected; alone, the
   * AI can drive a robot for the other alliance.
   */
  private startGame(mode: GameMode): void {
    this.endSession();
    this.lastMode = mode;
    const s = this.settings;
    const { drivers, ai } = this.localLineup();
    this.session = new Session(this.layout, this.colliders, drivers, ai, mode, s.rules, this.sessionEvents);
    this.localGame = { players: drivers.map(d => ({ alliance: slotAlliance(d.slot), robot: d.robot })), ai: [...new Set(ai.map(d => slotAlliance(d.slot)))], reported: false };
    const split = drivers.length > 1;
    this.setPlayers(drivers.map((d, i) => ({
      slot: d.slot,
      pad: split ? (i === 0 ? 1 : 2) : undefined,
      view: this.views[i],
      fieldCentric: s.fieldCentric,
    })));
    this.startIn = mode === 'match' ? MATCH_COUNTDOWN : COUNTDOWN;
    // Every match can be watched again from the results; endless practice once the player starts
    // recording it from the pause menu (from the start in the developer build).
    this.recorder = STUDIO || mode === 'match' ? new ReplayRecorder() : null;
    this.enterPlay();
  }

  /**
   * The robots of a game on this computer: gamepad1's, gamepad2's on a split screen, and the AI's:
   * one against gamepad1 (1 vs 1), or one on every free driver station (2 vs 2).
   */
  private localLineup(): { drivers: Driver[]; ai: Driver[] } {
    const s = this.settings;
    const drivers: Driver[] = [{ slot: slotOf(s.alliance, 1), robot: s.robot, start: s.startPoses[s.robot] }];
    // The same alliance: its second driver station; the other alliance: that one's first.
    const split = isSplit(this.input, s);
    if (split) drivers.push({ slot: slotOf(s.alliance2, s.alliance2 === s.alliance ? 2 : 1), robot: s.robot2, start: s.startPoses[s.robot2] });
    const opponent = opponentIn(s.opponent, split);
    const taken = new Set(drivers.map(d => d.slot));
    const slots = opponent === 'ai' ? [slotOf(s.alliance === 'red' ? 'blue' : 'red', 1)] : opponent === 'ai2v2' ? SLOTS.filter(slot => !taken.has(slot)) : [];
    return { drivers, ai: slots.map(slot => ({ slot, robot: s.aiRobot, level: s.aiLevel })) };
  }

  // ---- start position ----------------------------------------------------------

  /** The start this player picked for their robot (sent to an online room), or null for the usual spot. */
  private myStart(): StartPose | null {
    return this.settings.startPoses[this.settings.robot] ?? null;
  }

  /**
   * Picking where gamepad1's robot starts: the field from above with the other robots of the
   * coming game on their spots (an online room: everyone in it).
   */
  private openStartPosition(from: 'select' | 'room'): void {
    let lineup: Driver[];
    let slot: Slot;
    if (from === 'room') {
      const online = this.online;
      const room = online?.room;
      if (!online || !room || room.running) return;
      const { drivers, ai } = roomDrivers(room);
      slot = room.members.find(m => m.id === online.myId)?.slot ?? 'red1';
      lineup = [...drivers, ...ai];
    } else {
      const { drivers, ai } = this.localLineup();
      slot = drivers[0].slot;
      lineup = [...drivers, ...ai];
    }
    const robot = robotById(this.settings.robot);
    const alliance = slotAlliance(slot);
    const others = lineup.filter(d => d.slot !== slot);
    const entry = (d: Driver) => ({ slot: d.slot, cfg: robotById(d.robot).config, start: d.start });
    const placed = resolveStarts(others.map(entry), this.startField);
    // The usual spot is wherever the others leave this robot.
    const standard = forAlliance(resolveStarts([...others.map(entry), { slot, cfg: robot.config }], this.startField).get(slot)!, alliance);

    this.hidePreview();
    this.placing = { from, robot, slot };
    this.state = 'place';
    this.hud.el.hidden = true;
    for (const d of others) {
      const pose = placed.get(d.slot)!;
      const view = this.robotView(d.slot, robotById(d.robot));
      view.root.position.set(pose.x, 0.002, pose.z);
      view.root.rotation.set(0, pose.yaw, 0);
    }
    const sameSide = others.filter(d => slotAlliance(d.slot) === alliance);
    this.screens.start.open({
      robotName: robotTitle(robot),
      cfg: robot.config,
      field: this.startField,
      current: this.settings.startPoses[robot.id] ?? standard,
      standard,
      others: sameSide.map(d => startOutline(forAlliance(placed.get(d.slot)!, alliance), robotById(d.robot).config)),
    }, ...startKeys(this.settings.bindings.keys));
    this.show(this.screens.start);
  }

  /** The robot being placed (red-side pose) is drawn where it is on the field. */
  private movePlaced(pose: StartPose, ok: boolean): void {
    const p = this.placing;
    if (!p) return;
    const world = forAlliance(pose, slotAlliance(p.slot));
    const view = this.robotView(p.slot, p.robot);
    view.root.position.set(world.x, 0.002, world.z);
    view.root.rotation.set(0, world.yaw, 0);
    this.startMarker.show(world, p.robot.config, ok);
  }

  private saveStart(pose: StartPose | null): void {
    const p = this.placing;
    if (!p) return;
    if (pose) this.settings.startPoses[p.robot.id] = pose;
    else delete this.settings.startPoses[p.robot.id];
    this.saveSettings();
    if (p.from === 'room') this.online?.lobby.send({ t: 'robot', robot: p.robot.id, start: pose });
    this.closeStartPosition();
  }

  /** Back to the robot selection or the online room. */
  private closeStartPosition(): void {
    const p = this.placing;
    if (!p) return;
    this.clearPlacement();
    if (p.from === 'select') {
      this.state = 'select';
      this.show(this.screens.select);
      this.showPreview();
      return;
    }
    const room = this.online?.room;
    if (room) this.toRoomScreen(room);
    else this.toMenu();
  }

  private clearPlacement(): void {
    if (!this.placing) return;
    this.placing = null;
    this.startMarker.hide();
    for (const view of this.robotViews.values()) view.dispose();
    this.robotViews.clear();
  }

  /** The floor under a point of the window, as on the red side (null above the horizon). */
  private floorPoint(clientX: number, clientY: number): [number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hit = this.raycaster.ray.intersectPlane(FLOOR, new THREE.Vector3());
    if (!hit) return null;
    return this.placing && slotAlliance(this.placing.slot) === 'blue' ? [-hit.x, -hit.z] : [hit.x, hit.z];
  }

  // ---- online --------------------------------------------------------------

  /** The room list; `join`: straight into a friend's room. */
  private openOnline(join?: string): void {
    this.endSession();
    this.closeOnline();
    const online = new OnlineRoom({ name: this.playerName(), device: deviceId(), token: this.account.sessionToken }, {
      rooms: list => this.screens.rooms.setRooms(list),
      room: room => this.onRoom(room),
      error: code => {
        if (this.screen === this.screens.room) this.screens.room.setStatus(lobbyErrorText(code));
        else this.screens.rooms.setStatus(lobbyErrorText(code), true);
      },
      quick: searching => this.screens.rooms.setSearching(searching),
      closed: () => {
        if (this.online !== online) return;
        this.toMenu();
        this.hud.toast(t('online.lost'));
      },
      links: () => this.screen === this.screens.room && this.screens.room.render(),
      data: (from, data) => this.net?.receive(from, data),
    });
    this.online = online;
    this.screens.rooms.open(this.settings.name);
    this.show(this.screens.rooms);
    if (join) online.lobby.send({ t: 'join', room: join, robot: this.settings.robot, start: this.myStart() });
    // The server may be asleep (free hosting wakes up in up to a minute).
    setTimeout(() => {
      if (this.online === online && !online.lobby.connected && this.screen === this.screens.rooms) this.screens.rooms.setStatus(t('online.offline'), true);
    }, 60_000);
  }

  private closeOnline(): void {
    this.online?.close();
    this.online = null;
    this.screens.pause.setOnline(false, false);
  }

  /** The room changed: its players, or a match starting or stopping. */
  private onRoom(room: RoomInfo | null): void {
    const online = this.online;
    if (!online) return;
    // Robots players in the room made: in the game here before anything shows or drives them.
    for (const m of room?.members ?? []) if (m.custom) addSharedRobot(m.custom);
    const inMatch = !!this.net && (this.state === 'playing' || this.state === 'paused' || (this.state === 'replay' && this.studioFrom === 'paused'));
    if (!room) {
      if (this.net) this.endSession();
      this.clearPlacement();
      this.state = 'menu';
      this.hud.el.hidden = true;
      this.screens.rooms.open(this.settings.name);
      this.screens.rooms.setRooms(online.lobby.rooms);
      this.show(this.screens.rooms);
      return;
    }
    if (room.running && !this.net) return this.startOnlineGame(room);
    if (!room.running && this.net) {
      // Stopped by the admin after the match, or the admin left in the middle of it.
      const wasResults = this.state === 'results';
      this.endSession();
      if (wasResults && this.screen === this.screens.results) {
        this.showRoom(room);
        return;
      }
      this.toRoomScreen(room);
      if (inMatch) this.screens.room.setStatus(t(room.adminId === this.netAdmin ? 'online.adminEnded' : 'online.adminLeft'));
      return;
    }
    this.showRoom(room);
    // Settings opened from the room stay open; the room is there when the player comes back.
    const fromRoom = this.screen === this.screens.room || this.stack.includes(this.screens.room);
    if (!room.running && this.state !== 'results' && this.state !== 'place' && !fromRoom) this.toRoomScreen(room);
  }

  private showRoom(room: RoomInfo): void {
    const online = this.online!;
    this.screens.room.show(room, online.myId, id => online.linkState(id), this.settings.aiRobot);
  }

  private toRoomScreen(room: RoomInfo): void {
    this.state = 'menu';
    this.hud.el.hidden = true;
    this.showHomeField();
    this.showRoom(room);
    this.show(this.screens.room);
  }

  /** The admin's game runs here, with the room's mode and rules; everyone else drives through the network. */
  private startOnlineGame(room: RoomInfo): void {
    const online = this.online!;
    this.endSession();
    this.lastMode = room.mode;
    this.netAdmin = room.adminId;
    const s = this.settings;
    const send = (to: number, data: Uint8Array, fast: boolean) => online.send(to, data, fast);
    const me = room.members.find(m => m.id === online.myId);
    if (online.isAdmin) {
      this.net = new HostSession(this.layout, this.colliders, room, online.myId, send, { direct: id => online.linkState(id) === 'direct' }, this.sessionEvents);
    } else {
      this.net = new GuestSession(roomDrivers(room).ai, me?.slot ?? null, room.adminId, send, this.sessionEvents);
    }
    this.session = this.net;
    this.localGame = null;
    this.names = roomNames(room);
    this.setPlayers(me?.slot ? [{ slot: me.slot, view: this.views[0], fieldCentric: s.fieldCentric }] : []);
    this.screens.pause.setOnline(true, online.isAdmin);
    this.startIn = room.mode === 'match' ? MATCH_COUNTDOWN : COUNTDOWN;
    this.recorder = STUDIO || room.mode === 'match' ? new ReplayRecorder() : null;
    this.enterPlay();
  }

  /** After an online match: the admin takes the room back to choosing; everyone sees the room. */
  private backToRoom(): void {
    const online = this.online;
    if (!online?.room) return this.toMenu();
    if (online.isAdmin && online.room.running) online.lobby.send({ t: 'stop' });
    this.endSession();
    this.toRoomScreen(online.room);
  }

  /** Splits the screen in two for two players (and joins it again). */
  private setPlayers(players: Player[]): void {
    const wasSplit = this.players.length > 1;
    this.players = players;
    if (wasSplit !== players.length > 1) this.resize();
  }

  private enterPlay(): void {
    // The win animations download during the match, ready for its end.
    if (this.lastMode === 'match') this.winAnimation.preload();
    this.resetCameras();
    this.resume();
  }

  /** Each player's camera at their driver station, as they picked it. */
  private resetCameras(): void {
    for (const p of this.players) {
      p.view.rig.alliance = slotAlliance(p.slot);
      p.view.rig.driverZ = DRIVER_Z[p.slot];
      p.view.rig.setMode(this.settings.camera);
    }
  }

  // ---- screens -------------------------------------------------------------

  private show(screen: Screen | null): void {
    this.screen = screen;
    this.overlay.classList.remove('fr-reveal');
    this.overlay.replaceChildren(...(screen ? [screen.el] : []));
    this.overlay.classList.toggle('active', !!screen);
    if (screen) {
      // Screens are built once; the language may have changed since.
      localize(screen.el);
      if (screen === this.screens.main) this.refreshTotals();
      else this.friends.close();
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
    this.showPauseLocal();
    this.show(this.screens.pause);
  }

  /** The pause menu's camera and drive mode rows (as gamepad1's driver has them now) and its recording. */
  private showPauseLocal(): void {
    this.screens.pause.setRecording({
      canRecord: this.lastMode !== 'match',
      recording: !!this.recorder,
      canWatch: !!(this.recorder?.frames.length || this.demo?.length),
    });
    this.screens.pause.setLocal(this.settings.camera, this.players[0]?.fieldCentric ?? this.settings.fieldCentric);
    // Online the room's admin picks the AI's level, before the match.
    const ai = !this.online && this.session?.ai.length;
    this.screens.pause.setAiLevel(ai ? this.settings.aiLevel : null);
  }

  /**
   * Practice, from the pause menu: a new recording starts (REC on the HUD) and the game goes on,
   * or the one going stops and stays to be watched until the game ends.
   */
  private toggleRecording(): void {
    if (!this.recorder) {
      this.recorder = new ReplayRecorder();
      this.recordingOwn = true;
      this.demo = null;
      return this.resume();
    }
    if (this.recorder.frames.length) this.demo = this.recorder.frames;
    this.recorder = null;
    this.recordingOwn = false;
    this.showPauseLocal();
  }

  /**
   * The end of a match: the winner's animation over the field (online, also over the pause menu),
   * then the results fade in. The match counts as the next qualification for each team's place.
   */
  private showResults(score: Record<Alliance, AllianceScore>): void {
    // Online the match may end while the player watches it so far.
    this.shutStudio();
    this.show(null);
    this.state = 'results';
    this.lastReplay = this.recorder?.frames ?? null;
    this.recorder = null;
    this.recordingOwn = false;
    const ai = new Map(this.session?.ai.map(d => [d.slot, d.level]));
    const players = this.online?.room?.members ?? [];
    const robots = (this.session?.state()?.robots ?? []).map(r => {
      const def = robotById(r.robot);
      const player = players.find(m => m.slot === r.slot)?.name;
      const level = ai.get(r.slot);
      // Ranked as the team on its own, its AI (at its level) or a player driving it.
      const who = ai.has(r.slot) ? (level ? `${t('results.ai')} · ${aiLevelName(level)}` : t('results.ai')) : player ?? '';
      return { alliance: slotAlliance(r.slot), def, who, name: who ? `${def.team} · ${who}` : def.team };
    });
    const rp = matchRankingPoints(score);
    const places = this.ranking.record(robots.map(({ alliance, name }) => {
      const s = score[alliance];
      return { key: name, rp: rp[alliance].total, points: earnedPoints(s), tips: s.autoTips + s.teleopTips, auto: autoPoints(s), disqualified: s.redCards > 0 };
    }));
    const teams: Record<Alliance, ResultsTeam[]> = { red: [], blue: [] };
    for (const { alliance, def, who, name } of robots) {
      const place = places.get(name)!;
      teams[alliance].push({ number: def.number, name: who, logo: def.teamLogo, rank: place.rank, move: place.move });
    }
    const online = !!this.online;
    const solo = this.players.length === 1 && !ai.size && !online;
    this.screens.results.show({
      score,
      teams,
      event: 'UrSim',
      again: online ? 'online.toRoom' : undefined,
      replay: !!this.lastReplay?.length,
    });
    this.winAnimation.play(matchWinner(score), () => {
      if (this.state !== 'results') return;
      this.show(this.screens.results);
      this.overlay.classList.add('fr-reveal');
    });
    const points = { red: total(score.red), blue: total(score.blue) };
    // Online the admin's game tells the server how it ended, for everyone in the room.
    if (online && this.online!.isAdmin) this.online!.lobby.send({ t: 'result', score: points });
    if (!online) this.reportMatch(points, solo ? slotAlliance(this.players[0].slot) : null);
    this.archiveMatch(score);
  }

  /** A signed-in player's finished match goes into their archive (Records → Career). */
  private archiveMatch(score: Record<Alliance, AllianceScore>): void {
    const frames = this.lastReplay;
    if (!this.account.me || !frames?.length || this.lastMode !== 'match') return;
    const online = this.online;
    const room = online?.room ?? null;
    // Gamepad1's robot; online, this player's (someone watching without a station keeps nothing).
    const slot = online ? room?.members.find(m => m.id === online.myId)?.slot : this.players[0]?.slot;
    if (!slot) return;
    const robots: ReplayUpload['robots'] = {};
    for (const r of this.session?.state()?.robots ?? []) robots[r.slot] = r.robot;
    const names: ReplayUpload['names'] = {};
    if (room) {
      for (const m of room.members) if (m.slot) names[m.slot] = m.name;
    } else {
      names[slot] = this.playerName();
    }
    const alliance = slotAlliance(slot);
    const upload: ReplayUpload = {
      type: room ? room.format : this.players.length > 1 ? 'duo' : 'solo',
      robot: robots[slot] ?? this.settings.robot,
      alliance,
      score: total(score[alliance]),
      opponent: total(score[alliance === 'red' ? 'blue' : 'red']),
      duration: frames[frames.length - 1].t,
      robots,
      names,
      ai: [...new Set(this.session?.ai.map(d => d.slot) ?? [])],
      version: __APP_VERSION__,
    };
    this.account.saveReplay(upload, frames).catch(err => console.warn('match archive:', err));
  }

  /** A match from the archive in the career; throws when it can't be watched. */
  private async watchArchived(replay: ReplayInfo): Promise<void> {
    const frames = await this.account.replay(replay.id);
    // A recording from a game version with other snapshots doesn't play.
    if (!frames.length || !new Replay(frames).at(0)) throw new Error('empty replay');
    if (this.screen !== this.screens.records) return;
    // An online match shows who drove which robot, as it did in the game.
    const online = replay.type === '1v1' || replay.type === '2v2';
    this.names = online ? { ...Object.fromEntries(replay.ai.map(slot => [slot, t('online.ai')])), ...replay.names } : null;
    this.openStudio(frames, 'records');
  }

  /**
   * A match at this computer goes into the statistics; a record run (solo: alone, no AI) also into
   * the high score tables, and a personal best kept in this browser.
   */
  private reportMatch(points: { red: number; blue: number }, soloAlliance: Alliance | null): void {
    const game = this.localGame;
    if (!game || game.reported) return;
    game.reported = true;
    const robot = this.settings.robot;
    let localBest = 0;
    if (soloAlliance) {
      const key = `ursim.best.${robot}`;
      try {
        localBest = Number(localStorage.getItem(key) ?? 0);
        if (points[soloAlliance] > localBest) localStorage.setItem(key, String(points[soloAlliance]));
      } catch {
        // No storage: only the server keeps records.
      }
    }
    const name = this.playerName();
    const mine = soloAlliance ? points[soloAlliance] : 0;
    const personalBest = () => soloAlliance && this.state === 'results' && mine > localBest && mine > 0 && this.screens.results.setRecord(soloAlliance, t('results.personalBest'));
    // A copy for the all-time tables, in case the server forgets them (free hosting without a database).
    // A robot the player made has no table.
    if (soloAlliance && name && !game.ai.length && !isCustomRobotId(robot)) rememberRecord(robot, name, mine);
    this.account.reportGame({
      type: game.players.length > 1 ? 'duo' : 'solo',
      mode: 'match',
      duration: this.playedTime(),
      score: points,
      players: game.players,
      ai: game.ai,
      name: name || undefined,
    }).then(r => {
      this.refreshTotals(true);
      if (!soloAlliance || this.state !== 'results') return;
      if (r.improved && (name || this.account.me)) this.screens.results.setRecord(soloAlliance, r.rank === 1 ? t('results.topScore') : r.rank ? t('results.rank', { rank: r.rank }) : t('results.personalBest'));
      else personalBest();
    }, () => personalBest());
  }

  /** Seconds the game at this computer has run (the field's clock: pauses don't count). */
  private playedTime(): number {
    return this.session?.state()?.time ?? 0;
  }

  /** Practice at this computer counts as a game once it went on long enough. */
  private reportPractice(): void {
    const game = this.localGame;
    const duration = this.playedTime();
    if (!game || game.reported || this.lastMode !== 'practice' || duration < MIN_PRACTICE) return;
    game.reported = true;
    this.account.reportGame({ type: 'practice', mode: 'practice', duration, players: game.players, ai: game.ai, name: this.playerName() || undefined })
      .then(() => this.refreshTotals(true), () => undefined);
  }

  // ---- accounts ------------------------------------------------------------

  /** The name in online rooms and guest high scores: the settings' one (the account's when there is none). */
  private playerName(): string {
    return this.settings.name || this.account.me?.name || '';
  }

  private accountChanged(me: Me | null): void {
    this.screens.main.setAccount(me);
    this.friends.setAccount(me);
    this.presence?.setToken(this.account.sessionToken);
    // A first sign-in fills in the name everyone sees in rooms.
    if (me && !this.settings.name) {
      this.settings.name = me.name;
      this.saveSettings();
    }
    this.online?.lobby.send({ t: 'hello', name: this.playerName(), device: deviceId(), token: this.account.sessionToken });
    // The robots this player made, here and on their other computers, come together.
    void this.robotSync.sync();
  }

  private signIn(provider: Provider): void {
    this.account.signIn(provider);
  }

  /** A player's career in Records (null: the signed-in player's, or signing in). */
  private openCareer(user: string | null): void {
    this.screens.records.open({ tab: 'career', user });
    if (this.screen === this.screens.records) this.screens.records.onShow();
    else this.openSub(this.screens.records);
  }

  /** The main menu's totals, unless fetched a moment ago. */
  private refreshTotals(force = false): void {
    if (!force && Date.now() - this.totalsFetched < TOTALS_TTL) return;
    this.totalsFetched = Date.now();
    this.account.totals().then(
      totals => {
        this.screens.main.setTotals(totals);
        this.screens.main.setOnline({ online: totals.online, signedIn: totals.signedIn });
      },
      () => {
        this.totalsFetched = 0;
      },
    );
  }

  private toMenu(): void {
    this.stack.length = 0;
    this.endSession();
    this.closeOnline();
    // A test drive ends back in the Workshop, at its robot.
    const tested = this.testDriving;
    this.testDriving = null;
    if (tested) return this.openWorkshop(tested, this.workshopFrom);
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
    if (this.captureSize) {
      // A studio clip: the picture at its own size, whatever the window (shown squeezed meanwhile).
      const [cw, ch] = this.captureSize;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(cw, ch, false);
      this.viewRects = [[0, 0, cw, ch]];
      this.views[0].effects.setSize(cw, ch, 1);
      this.views[0].rig.resize(cw, ch);
      return;
    }
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
    const { bindings, sensitivity, graphics, sound, rules, scoreDisplay, language } = this.settings;
    return structuredClone({ bindings, sensitivity, graphics, sound, rules, scoreDisplay, language });
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
    setModelDetail(g.quality === 'low' ? 'low' : g.quality === 'ultra' ? 'high' : 'auto');
    this.hud.showFps(g.fps);
    this.fieldLights?.setMode(g.fieldLights);
    this.matchTimer.muted = !this.settings.sound.match;
    this.clickSound.enabled = this.settings.sound.buttons;
    if (g.quality !== 'auto') this.setQuality(PRESET_LEVEL[g.quality]);
    else if (this.quality !== this.qualityFloor) this.setQuality(this.qualityFloor);
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
    // Frames under the win animation say nothing about the GPU: the field isn't drawn then.
    if (this.settings.graphics.quality === 'auto' && !this.winAnimation.covering) this.adaptQuality(raw);
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
    // Below Ultra never more pixels than the screen has; Ultra at least twice (capped at 3).
    this.renderer.setPixelRatio(q.ultra ? Math.min(3, Math.max(window.devicePixelRatio, q.ratio)) : Math.min(window.devicePixelRatio, q.ratio));
    for (const { effects } of this.views) {
      effects.setAmbientOcclusion(q.ao);
      effects.setUltra(!!q.ultra);
    }
    this.setShadowDetail(!!q.ultra);
    // Below Medium (Low, or auto stepped down that far) the win animation comes in 720p 30 fps.
    this.winAnimation.light = level > PRESET_LEVEL.medium;
    this.resize();
  }

  /** Ultra: a shadow map twice as sharp, with soft edges. */
  private setShadowDetail(ultra: boolean): void {
    const size = ultra ? 4096 : 2048;
    const type = ultra ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.spot.shadow.mapSize.x === size && this.renderer.shadowMap.type === type) return;
    this.spot.shadow.mapSize.set(size, size);
    this.spot.shadow.map?.dispose();
    this.spot.shadow.map = null;
    this.renderer.shadowMap.type = type;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** One frame of game logic + rendering. Public so dev tools can drive the game without rAF. */
  tick(dt: number): void {
    this.input.update();
    this.announcePads();

    if (this.state === 'replay') {
      // Online the game goes on while the player watches it so far (the admin's runs it for
      // everyone), with this computer's robots standing still, and it is still being recorded.
      if (this.studioFrom === 'paused' && this.session?.online) {
        this.advance(dt, false);
        const live = this.session?.state();
        if (live) this.recorder?.capture(dt, live, this.startIn);
      }
      // Unless the match has just ended: the results then.
      if (this.state === 'replay') return this.tickStudio(dt);
    }

    // Online the match goes on behind the pause menu, with this computer's robots standing still.
    const playing = this.state === 'playing';
    const pausedOnline = this.state === 'paused' && !!this.session?.online;
    if (playing || pausedOnline) {
      if (this.state === 'playing') this.handleGameplayButtons();
      if (this.state === 'playing' || pausedOnline) this.advance(dt, !pausedOnline);
    }
    // A screen opened this frame (the pause menu) starts reading input next frame.
    if (!playing) {
      const screen = this.screen;
      if (screen) {
        screen.update?.(this.input);
        // A screen may have just switched to another one; that one starts reading input next frame.
        if (this.screen === screen && !screen.blocksNav) screen.nav.update(this.input);
        if (this.state === 'paused' && this.screen === this.screens.pause && this.pausePressed()) this.resume();
      } else if (this.winAnimation.playing && this.skipPressed()) {
        this.winAnimation.skip();
      }
    }

    const world = this.session?.state() ?? null;
    if (world) this.draw(world, this.state === 'paused' ? 0 : dt);
    if (this.state !== 'select' && this.state !== 'place' && this.state !== 'workshop' && this.rig.camera.view?.enabled) this.rig.camera.clearViewOffset();
    if (this.state === 'menu') this.updateMenuCamera(dt);
    else if (this.state === 'select') this.updatePreviewCamera(dt);
    else if (this.state === 'workshop') this.updateWorkshopCamera(dt);
    else if (this.state === 'place') this.updatePlaceCamera();
    else for (const p of this.players) p.view.rig.update(world?.robots.find(r => r.slot === p.slot) ?? null, dt);
    const inGame = world && (this.state === 'playing' || this.state === 'paused');
    if (inGame) this.updateHud(world);
    this.fieldLights?.update(dt, world?.robots ?? []);
    this.hallAds.update(dt);
    if (world && (playing || pausedOnline)) this.recorder?.capture(dt, world, this.startIn);
    this.matchTimer.update(inGame ? recordingTime(world.period, world.periodTime, this.startIn) : null, this.state === 'playing');
    // The win animation hides the field: not drawing it leaves a slow computer free to play the video.
    if (!this.winAnimation.covering) this.render(dt);
  }

  /** The game's clock and robots move on after the 3-2-1; `drive`: with this computer's drivers' input, else standing still. */
  private advance(dt: number, drive: boolean): void {
    // A guest follows the admin's countdown.
    const remote = this.session?.remoteStartIn;
    if (remote !== undefined && remote !== null) this.startIn = remote;
    // The match clock, the robots and the AI all wait for the 3-2-1.
    const started = this.startIn <= 0;
    this.startIn = Math.max(-GO_SHOWN, this.startIn - dt);
    if (started) this.session?.update(dt, drive ? this.readInputs() : this.idleInputs());
    this.session?.frame?.(dt, this.startIn);
  }

  // ---- replays ------------------------------------------------------------------

  /** The finished game from the results, the game so far from the pause menu, or a match from the archive. */
  private openStudio(frames = this.lastReplay, from?: 'records'): void {
    if (!frames?.length) return;
    this.studioFrom = from ?? (this.state === 'paused' ? 'paused' : 'results');
    this.state = 'replay';
    this.show(null);
    this.hud.el.hidden = true;
    this.studio.open([...frames]);
  }

  private closeStudio(): void {
    this.shutStudio();
    if (this.studioFrom === 'paused') {
      // Back to the game (online it has gone on, and so has its recording).
      this.state = 'paused';
      this.hud.el.hidden = false;
      this.showPauseLocal();
      this.show(this.screens.pause);
      return;
    }
    if (this.studioFrom === 'records') {
      // Back to the archive, with the field as the menus show it.
      this.endSession();
      this.state = 'menu';
      this.showHomeField();
      this.show(this.screens.records);
      return;
    }
    this.state = 'results';
    this.show(this.screens.results);
  }

  /** The studio closes where it is: the picture back to the window's size, each player's camera as they had it. */
  private shutStudio(): void {
    if (!this.studio.isOpen) return;
    this.studio.close();
    this.captureSize = null;
    this.setQuality(this.quality);
    this.resetCameras();
  }

  private tickStudio(dt: number): void {
    // A gamepad leaves it with ○ / B (the keyboard with Esc, ui/ReplayStudio.ts).
    if (this.input.menuPressed('b')) return this.closeStudio();
    const frame = this.studio.update(dt);
    if (frame) this.draw(frame.world, this.studio.playing ? dt * this.studio.speed : 0);
    this.fieldLights?.update(this.studio.playing ? dt * this.studio.speed : 0, frame?.world.robots ?? []);
    this.hallAds.update(this.studio.playing ? dt * this.studio.speed : 0);
    this.matchTimer.update(frame ? recordingTime(frame.world.period, frame.world.periodTime, frame.startIn) : null, this.studio.soundRunning);
    this.render(dt);
  }

  private draw(world: WorldState, dt: number): void {
    this.field.setHiveAngles(world.hiveAngles);
    this.field.setParkingHint(world.period, world.periodTime, world.time);
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
      const view = this.robotView(r.slot, def);
      // Team numbers on the signs, like real robots.
      view.setIdentity(slotAlliance(r.slot), def.number);
      // Online, who drives each robot; a driver doesn't see their own name while playing.
      const own = this.state !== 'replay' && this.players.some(p => p.slot === r.slot);
      view.setTag(own ? null : this.names?.[r.slot] ?? null);
      view.apply(r, dt);
    }
  }

  /** The robot at a driver station, made again when the robot (or its model detail) changes. */
  private robotView(slot: Slot, def: RobotDefinition): RobotView {
    let view = this.robotViews.get(slot);
    if (view && (view.def !== def || view.model !== robotModel(def))) {
      view.dispose();
      view = undefined;
    }
    if (!view) {
      view = new RobotView(def, slotAlliance(slot), def.number);
      this.scene.add(view.root);
      this.robotViews.set(slot, view);
    }
    return view;
  }

  private updateHud(world: WorldState): void {
    // The battery blocks show only when the battery rule is on (online: the room's rule).
    const battery = (this.net && this.online?.room ? this.online.room.rules : this.settings.rules).battery;
    // Settings → Interface (online: the admin's choice for the room): the whole score, only what was
    // earned on the field (FOULS and cards wait for the results), or nothing until the results.
    // Practice never ends, so it is never hidden.
    const practice = world.period === 'practice';
    const chosen = this.net && this.online?.room ? this.online.room.scoreDisplay : this.settings.scoreDisplay;
    const display = practice && chosen === 'end' ? 'live' : chosen;
    const { red, blue } = world.score;
    this.hud.update({
      clock: matchClock(world.period, world.periodTime),
      timer: !practice,
      score: display === 'end' ? null
        : display === 'earned' ? { red: earnedPoints(red), blue: earnedPoints(blue) }
        : { red: total(red), blue: total(blue) },
      cards: display !== 'live' ? { red: 'none', blue: 'none' } : {
        red: red.redCards ? 'red' : red.yellowCards ? 'yellow' : 'none',
        blue: blue.redCards ? 'red' : blue.yellowCards ? 'yellow' : 'none',
      },
      drivers: this.players.map(p => {
        const robot = world.robots.find(r => r.slot === p.slot);
        return {
          slot: p.slot,
          battery: robot && battery ? { voltage: robot.voltage, min: robot.minVoltage } : null,
          points: display === 'earned' ? scoreRows(world.score[slotAlliance(p.slot)]) : null,
        };
      }),
    });
    this.hud.setCountdown(this.countdownText(world));
    const own = this.recordingOwn ? this.recorder?.frames : undefined;
    this.hud.setRecording(own ? own[own.length - 1]?.t ?? 0 : null);
  }

  /** The big 3-2-1 before the game and before TELEOP, then GO! */
  private countdownText(world: WorldState): string | null {
    if (this.startIn > 0) return String(Math.min(COUNTDOWN, Math.ceil(this.startIn)));
    if (this.startIn > -GO_SHOWN) return t('hud.go');
    const left = DURATION.transition - world.periodTime;
    if (world.period === 'transition' && left <= TELEOP_COUNTDOWN) return String(Math.ceil(left));
    if (world.period === 'teleop' && world.periodTime < GO_SHOWN) return t('hud.go');
    return null;
  }

  /** Pause on gamepad1 or the keyboard, and on gamepad2 when it drives its own robot. */
  private pausePressed(): boolean {
    return this.input.triggered('pause') || (this.players.length > 1 && this.input.triggered('pause', 2));
  }

  /** Skips the win animation: the results screen's keys (R, Esc, ✕ / A, ○ / B), Enter or Space. */
  private skipPressed(): boolean {
    const keys = this.input.keyboard;
    return ['KeyR', 'Escape', 'Enter', 'Space'].some(code => keys.pressed(code))
      || this.input.menuPressed('a') || this.input.menuPressed('b') || this.input.triggered('pause');
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
    }
    if (input.keyboard.pressed('KeyR') && !this.online) this.startGame(this.lastMode);
  }

  private readInputs(): Partial<Record<Slot, RobotInput>> {
    return Object.fromEntries(this.players.map(p => [p.slot, this.readDriverInput(p)]));
  }

  private idleInputs(): Partial<Record<Slot, RobotInput>> {
    return Object.fromEntries(this.players.map(p => [p.slot, idleInput()]));
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
      intake: input.held('intake', p.pad),
      eject: input.held('eject', p.pad),
      transfer: input.held('transfer', p.pad),
      shooterOn: input.triggered('shooterOn', p.pad),
      shooterOff: input.triggered('shooterOff', p.pad),
      imuReset: input.triggered('imuReset', p.pad),
      armUp: input.triggered('armUp', p.pad),
      armDown: input.triggered('armDown', p.pad),
      lift: input.triggered('lift', p.pad),
      boxRollers: input.held('boxRollers', p.pad),
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

  /** Around the Workshop's robot as the player turns and zooms the view, slowly by itself when left alone. */
  private updateWorkshopCamera(dt: number): void {
    const o = this.orbit;
    o.idle += dt;
    if (o.idle > WORKSHOP_VIEW.idle) o.yaw += dt * 0.25;
    const cam = this.rig.camera;
    const [x, z] = PREVIEW_SPOT;
    const y = WORKSHOP_VIEW.target;
    const flat = Math.cos(o.pitch) * o.distance;
    cam.up.set(0, 1, 0);
    cam.position.set(x + Math.cos(o.yaw) * flat, y + Math.sin(o.pitch) * o.distance, z + Math.sin(o.yaw) * flat);
    cam.lookAt(x, y, z);
    // The robot in the open area left of the panel, as on the robot selection.
    const { width, height } = this.renderer.domElement;
    cam.setViewOffset(width, height, width / height > 1.2 ? width * 0.19 : 0, 0, width, height);
  }

  /**
   * Straight down on the field with the driver's wall at the bottom, the field fitted into the
   * part of the window the panel leaves free.
   */
  private updatePlaceCamera(): void {
    const cam = this.rig.camera;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const panel = this.screens.start.panelRect();
    // The panel stands at the right on wide windows and at the bottom on narrow ones.
    const free = panel.left > width / 2 ? { w: panel.left, h: height } : { w: width, h: Math.max(height * 0.35, panel.top) };
    const half = this.startField.wall + PLACE_MARGIN;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const distance = half / (tan * Math.min(free.h / height, (cam.aspect * free.w) / width));
    const forward = this.placing && slotAlliance(this.placing.slot) === 'blue' ? -1 : 1;
    cam.up.set(forward, 0, 0);
    cam.position.set(0, distance, 0);
    cam.lookAt(0, 0, 0);
    cam.setViewOffset(width, height, width / 2 - free.w / 2, height / 2 - free.h / 2, width, height);
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
      const key = pad ? `${pad.index}|${pad.id}` : '';
      if (key === this.lastPads[slot]) continue;
      if (pad) this.hud.toast(t('pad.connected', { model: padName(pad), n: slot + 1 }));
      else if (this.lastPads[slot]) this.hud.toast(t(slot === 0 ? 'pad.disconnected' : 'pad.disconnected2'));
      this.lastPads[slot] = key;
    }
  }
}
