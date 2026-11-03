// The Workshop: robots of the player's own. The list (build one of blocks, upload a 3D model, open a
// robot file or paste a share code; edit, test drive, duplicate, share, publish or delete one), the
// gallery of robots players published (server/Gallery.ts: look at one on the field, add it to your
// robots) and the editor, whose every change shows at once on the robot behind it. Laid out like the
// robot selection: the robot on the field in the open area (drag to look around it, the wheel
// zooms), the panel on the right.

import { ApiError, canSignIn, type AccountClient } from '../net/account';
import type { SyncState } from '../net/robotSync';
import { GALLERY, type GalleryEntry, type GalleryRobot, type GallerySort } from '../net/galleryProtocol';
import {
  DEFAULT_BLUEPRINT, DRIVETRAINS, INTAKE_KINDS, INTAKE_LIMITS, LIMITS, MAX_TURRETS, TURRET, TURRET_LIMITS, UP_AXES, arrangeTurrets, cleanBlueprint, customDefinition, heldKinds,
  shareCode, topSpeed, turretBounds, withTurret, withoutMesh, withoutTurret, type Blueprint, type Drivetrain, type IntakeKind, type IntakePart, type MeshFit, type TurretPart, type UpAxis,
} from '../robot/custom';
import { ROBOT_FILE_EXTENSION, definitionOf, exportRobot, getMeshFile, importRobot, newMeshId, newRobotId, saveRobot, savedRobot, savedRobots, type SavedRobot } from '../robot/customStore';
import { robotById, type RobotDefinition } from '../robot/robots';
import { BATTERY } from '../sim/Battery';
import { DRAFT_ROBOT, ModelError, addMeshSource, forgetMeshSource, guessFit, meshFormat, meshSize, robotThumbnail } from '../view/customModel';
import { h } from './dom';
import { ht, language, t, type TextKey } from './i18n';
import type { Screen } from './menus';
import { MenuNav } from './MenuNav';
import { robotInfo, spinName } from './RobotSelect';

export interface WorkshopActions {
  /** The robot on the field behind the screen; `helpers`: the boxes that show how an uploaded model fits */
  show(def: RobotDefinition | null, helpers: boolean): void;
  /** Keeps a robot (and a 3D file picked for it); false when this browser couldn't */
  save(robot: SavedRobot, model: ArrayBuffer | null): Promise<boolean>;
  remove(id: string): void;
  testDrive(id: string): void;
  /** Signing in (the gallery needs an account to publish or report, and the player's robots go with it) */
  signIn(): void;
  /** How the player's robots and their account's stand */
  syncState(): SyncState;
  /** Turns the view around the robot (pixels dragged) and zooms it (wheel steps) */
  orbit(dx: number, dy: number): void;
  zoom(delta: number): void;
  back(): void;
}

type NumberKey = keyof typeof LIMITS;
type Range = { min: number; max: number; step: number };
type Tab = 'general' | 'drive' | 'intake' | 'shooter' | 'model';
type Section = 'mine' | 'gallery';
/** The gallery newest or most added first, or only the player's own */
type GalleryView = GallerySort | 'mine';
const TABS: { tab: Tab; label: TextKey }[] = [
  { tab: 'general', label: 'workshop.tabGeneral' },
  { tab: 'drive', label: 'workshop.tabDrive' },
  { tab: 'intake', label: 'workshop.tabIntake' },
  { tab: 'shooter', label: 'workshop.tabShooter' },
  { tab: 'model', label: 'workshop.tabModel' },
];

const PALETTE = ['#e0383d', '#f28c28', '#f5c518', '#2fb36d', '#1fb5c9', '#2f6fe4', '#7a4fe0', '#e04fa0', '#f2f2f2', '#9aa3ad', '#3a3f47', '#151719'];
/** Units of an uploaded model: metres per unit */
const UNITS: { scale: number; label: TextKey }[] = [
  { scale: 0.001, label: 'workshop.unitMm' },
  { scale: 0.01, label: 'workshop.unitCm' },
  { scale: 0.0254, label: 'workshop.unitIn' },
  { scale: 1, label: 'workshop.unitM' },
];
const SPINS = [1, 0.25, 0, -0.5];
const DRIVETRAIN_TEXT: Record<Drivetrain, [TextKey, TextKey]> = {
  mecanum: ['workshop.driveMecanum', 'workshop.mecanumNote'],
  swerve: ['workshop.driveSwerve', 'workshop.swerveNote'],
  tank: ['workshop.driveTank', 'workshop.tankNote'],
};
/** What a turret shoots: anything first */
const SHOOTS: IntakeKind[] = ['both', 'pollen', 'nectar'];
/** A bigger file than this is no robot model, bytes */
const MAX_FILE = 200 * 1024 * 1024;
/**
 * A model bigger than this is in other units than it seems, m: FTC's starting box is 45.7 cm, and a
 * lowered arm reaches some 10 cm past it.
 */
const SIZE_LIMIT = 0.6;
/** A gallery robot's 3D model up to this size comes by itself when it is picked; a bigger one on a press, bytes */
const AUTO_MODEL_BYTES = 8 * 1024 * 1024;
/** Gallery models kept in memory for adding */
const MODELS_KEPT = 3;

const num = (v: number, digits = 0) => v.toLocaleString(language(), { maximumFractionDigits: digits, minimumFractionDigits: digits });
const mm = (v: number) => t('workshop.mm', { v: num(v * 1000) });
const kindName = (k: IntakeKind) => (k === 'both' ? t('robot.bothKinds') : k.toUpperCase());
const shootsName = (k: IntakeKind) => (k === 'both' ? t('workshop.shootsAll') : k.toUpperCase());
/** A turret's place forward or back of the frame's center, and to the left or right of the center line */
const along = (v: number) => (v > 0 ? t('workshop.ahead', { v: num(v * 1000) }) : v < 0 ? t('workshop.behind', { v: num(-v * 1000) }) : t('workshop.centered'));
const across = (v: number) => (v > 0 ? t('workshop.toRight', { v: num(v * 1000) }) : v < 0 ? t('workshop.toLeft', { v: num(-v * 1000) }) : t('workshop.centered'));
/** Where a turret rests: degrees to the left of straight ahead */
function facingName(deg: number): string {
  if (deg === 0) return t('workshop.facingAhead');
  if (Math.abs(deg) === 180) return t('workshop.facingBack');
  return deg > 0 ? t('workshop.facingLeft', { deg: num(deg) }) : t('workshop.facingRight', { deg: num(-deg) });
}

function modelErrorText(err: unknown): string {
  if (!(err instanceof ModelError)) return t('workshop.errUnreadable');
  if (err.code === 'tooBig') return t('workshop.errTooBig', { count: num(err.triangles / 1e6, 1) });
  return t(err.code === 'compressed' ? 'workshop.errCompressed' : err.code === 'empty' ? 'workshop.errEmpty' : 'workshop.errUnreadable');
}

/** Why the gallery refused, in the player's language. */
function galleryErrorText(err: unknown): string {
  switch (err instanceof ApiError ? err.code : '') {
    case 'signIn': return t('gallery.signIn');
    case 'limit': return t('gallery.errLimit', { n: GALLERY.perAccount });
    case 'tooLarge': return t('gallery.errTooLarge', { mb: GALLERY.modelBytes / 1048576 });
    case 'full': return t('gallery.errFull');
    case 'tooMany': return t('gallery.errTooMany');
    case 'invalid': return t('gallery.errInvalid');
    default: return t('gallery.errFailed');
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name.replace(/[\\/:*?"<>|]/g, '_') });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class WorkshopScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private page: 'list' | 'edit' = 'list';
  private readonly title = h('div', { class: 'ms-title' });
  private readonly body = h('div', { class: 'ws-body' });
  private readonly foot = h('div', { class: 'ws-foot' });
  private readonly statusEl = h('p', { class: 'ws-status' });
  private readonly modelInput = h('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl', hidden: true });
  private readonly robotInput = h('input', { type: 'file', accept: `${ROBOT_FILE_EXTENSION},.json,.txt`, hidden: true });
  /** The list: the player's own robots or the gallery, the robot shown, and the button pressed once of those that ask first */
  private section: Section = 'mine';
  private selected: string | null = null;
  private confirming: string | null = null;
  /** The gallery: which robots, the search, those loaded so far, and the one on the field */
  private galleryView: GalleryView = 'new';
  private galleryQuery = '';
  private galleryRobots: GalleryEntry[] = [];
  private galleryTotal = 0;
  private galleryState: 'idle' | 'loading' | 'failed' = 'idle';
  /** The player may take down anyone's robot */
  private moderator = false;
  private picked: GalleryRobot | null = null;
  private pickedDef: RobotDefinition | null = null;
  /** Gallery robots' model files downloaded here, by gallery id */
  private readonly galleryModels = new Map<string, ArrayBuffer>();
  /** Each load counts up: answers to older ones are dropped */
  private galleryLoad = 0;
  private pickLoad = 0;
  /** The search field stays the same element, so typing in it goes on while the list changes */
  private readonly search: HTMLInputElement;
  /** The editor: the robot (a new one gets its id at once), as it is now and as last saved (a new one: as it began) */
  private id = '';
  private draft: Blueprint = DEFAULT_BLUEPRINT;
  private saved: Blueprint = DEFAULT_BLUEPRINT;
  private exists = false;
  /** A 3D file picked in this editor, kept when the robot is saved */
  private model: ArrayBuffer | null = null;
  private modelSize: [number, number, number] | null = null;
  private tab: Tab = 'general';
  /** The turret and the intake being changed */
  private turret = 0;
  private intakeEnd: 'front' | 'back' = 'front';
  /** Back was pressed once with unsaved changes */
  private leaving = false;
  private busy = false;
  /** What the editor's rows show is brought up to date by these after every change */
  private rows: (() => void)[] = [];
  private readonly info = h('div', { class: 'ms-info ws-info' });

  constructor(private readonly actions: WorkshopActions, private readonly account: AccountClient) {
    this.search = ht('input', { class: 'ms-input ws-code ws-search', type: 'search', maxlength: '40' }, 'gallery.search');
    let typing: ReturnType<typeof setTimeout> | undefined;
    const find = () => {
      clearTimeout(typing);
      if (this.search.value.trim() === this.galleryQuery) return;
      this.galleryQuery = this.search.value.trim();
      void this.loadGallery();
    };
    this.search.addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(find, 400);
    });
    this.search.addEventListener('keydown', e => e.key === 'Enter' && find());
    this.el = h('div', { class: 'screen menu-workshop' },
      ht('button', { class: 'ms-back', onclick: () => this.back() }, 'common.backArrow'),
      h('div', { class: 'ms-panel ws-panel' }, this.title, this.body, this.statusEl, this.foot),
      this.modelInput, this.robotInput,
    );
    this.nav = new MenuNav(this.el, () => this.back());
    this.modelInput.addEventListener('change', () => {
      const file = this.modelInput.files?.[0];
      this.modelInput.value = '';
      if (file) void this.pickModel(file);
    });
    this.robotInput.addEventListener('change', () => {
      const file = this.robotInput.files?.[0];
      this.robotInput.value = '';
      if (file) void file.text().then(text => this.importText(text));
    });
    this.lookAround();
  }

  /** Dragging the open area turns the view around the robot; the wheel zooms. */
  private lookAround(): void {
    let drag: { x: number; y: number } | null = null;
    this.el.addEventListener('pointerdown', e => {
      if (e.target !== this.el) return;
      drag = { x: e.clientX, y: e.clientY };
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', e => {
      if (!drag) return;
      this.actions.orbit(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    });
    const stop = () => (drag = null);
    this.el.addEventListener('pointerup', stop);
    this.el.addEventListener('pointercancel', stop);
    this.el.addEventListener('wheel', e => {
      if (e.target !== this.el) return;
      e.preventDefault();
      this.actions.zoom(Math.sign(e.deltaY));
    }, { passive: false });
  }

  /** The list of the player's robots (`select`: show this one). */
  openList(select?: string): void {
    this.page = 'list';
    if (select) {
      this.selected = select;
      this.section = 'mine';
    }
    this.confirming = null;
    this.setStatus('');
    this.render();
  }

  /** The editor for a saved robot, or a new one (`upload`: starting from a 3D file the player picks now). */
  openEditor(id: string | null, upload = false): void {
    const robot = id ? savedRobot(id) : undefined;
    this.page = 'edit';
    this.id = robot?.id ?? newRobotId();
    this.exists = !!robot;
    this.draft = robot?.blueprint ?? { ...DEFAULT_BLUEPRINT, name: t('workshop.defaultName', { n: savedRobots().length + 1 }) };
    this.saved = this.draft;
    this.model = null;
    this.modelSize = null;
    this.tab = upload ? 'model' : 'general';
    this.turret = 0;
    this.intakeEnd = 'front';
    this.leaving = false;
    this.setStatus('');
    this.render();
    if (upload) this.modelInput.click();
    if (this.draft.mesh) void this.measureModel();
  }

  onShow(): void {
    this.render();
  }

  /** The player's robots changed from elsewhere (their account brought some): the list shows them. */
  robotsChanged(): void {
    if (this.page === 'list' && this.section === 'mine' && this.el.isConnected) this.render();
  }

  private back(): void {
    if (this.page === 'list') return this.actions.back();
    if (this.dirty && !this.leaving) {
      this.leaving = true;
      this.setStatus(t('workshop.unsaved'));
      return;
    }
    this.openList(this.exists ? this.id : undefined);
  }

  private get dirty(): boolean {
    return !!this.model || JSON.stringify(this.draft) !== JSON.stringify(this.saved);
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
  }

  private render(): void {
    this.rows = [];
    if (this.page === 'list') this.renderList();
    else this.renderEditor();
    this.nav.focusFirst();
  }

  // ---- the list ----------------------------------------------------------------

  private renderList(): void {
    this.title.textContent = t('workshop.title');
    const tab = (section: Section, label: TextKey) =>
      ht('button', { class: `ms-tab ${section === this.section ? 'ms-tab-on' : ''}`, onclick: () => this.openSection(section) }, label);
    this.body.replaceChildren(
      h('div', { class: 'settings-tabs ws-tabs' }, tab('mine', 'workshop.mine'), tab('gallery', 'gallery.title')),
      ...(this.section === 'mine' ? this.mineRows() : this.galleryRows()));
    this.foot.replaceChildren();
  }

  private openSection(section: Section): void {
    this.section = section;
    this.confirming = null;
    this.setStatus('');
    // The gallery as it is now: others may have published since.
    if (section === 'gallery') void this.loadGallery();
    else this.render();
  }

  private button(label: TextKey, onclick: () => void, cls = ''): HTMLButtonElement {
    return ht('button', { class: `ms-select ws-button ${cls}`, onclick }, label);
  }

  /** A button that asks first: its first press says what will happen (`note`), the second does it. */
  private confirmButton(key: string, label: TextKey, sure: TextKey, note: string, run: () => void): HTMLButtonElement {
    return h('button', {
      class: 'ms-select ws-button ws-danger',
      onclick: () => {
        if (this.confirming !== key) {
          this.confirming = key;
          this.setStatus(note);
          return this.render();
        }
        this.confirming = null;
        run();
      },
    }, t(this.confirming === key ? sure : label));
  }

  private mineRows(): (HTMLElement | string)[] {
    const robots = savedRobots();
    if (!this.selected || !savedRobot(this.selected)) this.selected = robots[robots.length - 1]?.id ?? null;
    const selected = this.selected ? savedRobot(this.selected) : undefined;
    this.actions.show(selected ? robotById(selected.id) : null, false);

    const button = this.button.bind(this);
    const code = ht('input', { class: 'ms-input ws-code' }, 'workshop.codePlaceholder');
    const addCode = () => code.value.trim() && void this.importText(code.value);
    code.addEventListener('keydown', e => e.key === 'Enter' && addCode());

    const list = robots.length
      ? h('div', { class: 'ws-list' }, ...robots.map(r => {
        const def = robotById(r.id);
        const line = [r.blueprint.team || t('workshop.customRobot'), t('robot.speedValue', { v: num(def.config.drive.maxWheelSpeed, 1) }), r.gallery ? t('gallery.inGallery') : null];
        return h('button', { class: `ws-robot ${r.id === this.selected ? 'ws-robot-on' : ''}`, onclick: () => this.select(r.id) },
          h('img', { src: def.teamLogo, alt: '' }),
          h('span', { class: 'ws-robot-name' }, def.name, h('small', {}, line.filter(Boolean).join(' · '))));
      }))
      : ht('p', { class: 'ws-empty' }, 'workshop.none');

    return [
      ht('p', { class: 'ws-about' }, 'workshop.about'),
      this.accountLine(),
      h('div', { class: 'ws-buttons' },
        button('workshop.build', () => this.openEditor(null), 'ws-main'),
        // The file picker opens straight from the click: browsers allow it only then.
        button('workshop.upload', () => this.openEditor(null, true), 'ws-main')),
      list,
      selected ? h('div', { class: 'ws-buttons' },
        button('workshop.edit', () => this.openEditor(selected.id)),
        button('workshop.testDrive', () => this.actions.testDrive(selected.id)),
        button('workshop.copy', () => void this.duplicate(selected)),
        button('workshop.export', () => void exportRobot(selected).then(blob => download(blob, `${selected.blueprint.name}${ROBOT_FILE_EXTENSION}`))),
        button('workshop.shareCode', () => void this.copyCode(selected, code)),
        this.confirmButton(`delete:${selected.id}`, 'workshop.delete', 'workshop.deleteSure', t('workshop.deleteConfirm', { name: selected.blueprint.name }), () => this.remove(selected))) : '',
      selected ? h('div', { class: 'ws-buttons' },
        button(selected.gallery ? 'gallery.update' : 'gallery.publish', () => void this.publish(selected), 'ws-main'),
        selected.gallery ? this.confirmButton(`unpublish:${selected.id}`, 'gallery.takeDown', 'gallery.takeDownSure', t('gallery.takeDownConfirm'), () => void this.unpublish(selected)) : '') : '',
      selected && !selected.gallery ? ht('p', { class: 'ws-note' }, 'gallery.publishNote') : '',
      ht('div', { class: 'ws-heading' }, 'workshop.share'),
      h('div', { class: 'ws-buttons' }, button('workshop.import', () => this.robotInput.click())),
      h('div', { class: 'ws-code-row' }, code, ht('button', { class: 'ms-select ws-button', onclick: addCode }, 'workshop.add')),
    ];
  }

  /** Where the player's robots are kept: with their account (on every computer), or only here. */
  private accountLine(): HTMLElement {
    const me = this.account.me;
    if (!me) {
      return h('div', { class: 'ws-account' },
        ht('span', {}, canSignIn() ? 'workshop.cloudOff' : 'workshop.cloudNoSignIn'),
        canSignIn() ? h('button', { class: 'ms-select ws-button', onclick: () => this.actions.signIn() }, t('menu.signIn')) : '');
    }
    const state = this.actions.syncState();
    const text = state === 'syncing' ? t('workshop.cloudSyncing')
      : state === 'failed' ? t('workshop.cloudFailed')
      : state === 'full' ? t('workshop.cloudFull')
      : t('workshop.cloudOn', { username: me.username });
    return h('div', { class: `ws-account ${state === 'failed' || state === 'full' ? 'warn' : ''}` }, h('span', {}, text));
  }

  private select(id: string): void {
    this.selected = id;
    this.confirming = null;
    this.setStatus('');
    this.render();
  }

  private remove(robot: SavedRobot): void {
    this.actions.remove(robot.id);
    this.selected = null;
    this.setStatus('');
    this.render();
  }

  /** A copy to change: it shares the 3D file, which stays until no robot shows it. */
  private async duplicate(robot: SavedRobot): Promise<void> {
    const id = newRobotId();
    const blueprint = cleanBlueprint({ ...robot.blueprint, name: t('workshop.copyName', { name: robot.blueprint.name }) })!;
    if (await this.actions.save({ id, blueprint, saved: Date.now(), from: robot.from }, null)) this.select(id);
    else this.setStatus(t('workshop.storageFull'));
  }

  private async copyCode(robot: SavedRobot, field: HTMLInputElement): Promise<void> {
    const code = shareCode(robot.blueprint);
    const note = t(robot.blueprint.mesh ? 'workshop.codeCopiedMesh' : 'workshop.codeCopied');
    try {
      await navigator.clipboard.writeText(code);
      this.setStatus(note);
    } catch {
      // No clipboard here: the code goes into the field, selected, to copy by hand.
      field.value = code;
      field.select();
      this.setStatus(t('workshop.codeSelect'));
    }
  }

  /** A robot from a robot file or a share code becomes one of the player's. */
  private async importText(text: string): Promise<void> {
    const robot = await importRobot(text);
    if (!robot) return this.setStatus(t('workshop.badImport'));
    let { blueprint } = robot;
    if (robot.model && blueprint.mesh) {
      // Its file gets an id of its own here: the same robot may come in twice.
      blueprint = { ...blueprint, mesh: { ...blueprint.mesh, id: newMeshId() } };
      await addMeshSource(blueprint.mesh!.id, robot.model, blueprint.mesh!.format).catch(() => undefined);
    }
    const id = newRobotId();
    if (!(await this.actions.save({ id, blueprint, saved: Date.now() }, robot.model))) return this.setStatus(t('workshop.storageFull'));
    this.page = 'list';
    this.section = 'mine';
    this.selected = id;
    this.render();
    this.setStatus(t('workshop.imported', { name: blueprint.name }));
  }

  /** Signing in first: the gallery knows its robots' authors. */
  private needAccount(): boolean {
    if (this.account.me) return false;
    if (!canSignIn()) {
      this.setStatus(t('gallery.noSignIn'));
      return true;
    }
    this.setStatus(t('gallery.signIn'));
    this.actions.signIn();
    return true;
  }

  /** Puts a robot of the player's into the gallery, or a new version of it, with its picture and 3D model. */
  private async publish(robot: SavedRobot): Promise<void> {
    if (this.busy || this.needAccount()) return;
    this.busy = true;
    this.setStatus(t('gallery.publishing'));
    try {
      const model = robot.blueprint.mesh ? await getMeshFile(robot.blueprint.mesh.id).catch(() => null) : null;
      if (model && model.byteLength > GALLERY.modelBytes) return this.setStatus(galleryErrorText(new ApiError(413, 'tooLarge')));
      const thumb = robot.thumb && /^data:image\/(webp|png|jpeg);/.test(robot.thumb) ? robot.thumb : await robotThumbnail(definitionOf(robot));
      if (!thumb) return this.setStatus(t('gallery.errFailed'));
      const blueprint = model ? robot.blueprint : withoutMesh(robot.blueprint);
      const published = await this.account.publishRobot({ source: robot.id, blueprint, thumb }, model);
      // A new version, so the player's other computers learn where it is in the gallery too.
      saveRobot({ ...robot, gallery: published.id, saved: Date.now() });
      this.setStatus(t(robot.gallery ? 'gallery.updated' : 'gallery.published'));
    } catch (err) {
      this.setStatus(galleryErrorText(err));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async unpublish(robot: SavedRobot): Promise<void> {
    try {
      await this.account.unpublishRobot(robot.gallery!);
    } catch (err) {
      // Already gone (a moderator took it down): it is off the gallery all the same.
      if (!(err instanceof ApiError && err.status === 404)) return this.setStatus(galleryErrorText(err));
    }
    saveRobot({ ...robot, gallery: undefined, saved: Date.now() });
    this.setStatus(t('gallery.takenDown'));
    this.render();
  }

  // ---- the gallery ---------------------------------------------------------------

  private galleryRows(): (HTMLElement | string)[] {
    this.actions.show(this.pickedDef, false);
    const sorts: [GalleryView, TextKey][] = [['new', 'gallery.new'], ['popular', 'gallery.popular']];
    if (this.account.me) sorts.push(['mine', 'gallery.mine']);
    const robots = this.galleryRobots;
    const list: (HTMLElement | string)[] = [];
    if (this.galleryState === 'failed') {
      list.push(ht('p', { class: 'ws-empty' }, 'gallery.offline'), h('div', { class: 'ws-buttons' }, this.button('gallery.retry', () => void this.loadGallery())));
    } else if (!robots.length) {
      list.push(ht('p', { class: 'ws-empty' }, this.galleryState === 'loading' ? 'gallery.loading' : this.galleryQuery ? 'gallery.nothing' : 'gallery.empty'));
    } else {
      list.push(h('div', { class: 'ws-list' }, ...robots.map(e => this.galleryRow(e))));
      if (robots.length < this.galleryTotal) list.push(h('div', { class: 'ws-buttons' }, this.button('gallery.more', () => void this.loadGallery(true))));
    }
    return [
      ht('p', { class: 'ws-about' }, 'gallery.about'),
      h('div', { class: 'settings-tabs ws-tabs ws-sorts' }, ...sorts.map(([view, label]) =>
        ht('button', { class: `ms-tab ${view === this.galleryView ? 'ms-tab-on' : ''}`, onclick: () => this.viewGallery(view) }, label))),
      this.search,
      ...list,
      ...this.pickedRows(),
    ];
  }

  private galleryRow(e: GalleryEntry): HTMLElement {
    const line = [
      e.team !== e.name ? e.team : null,
      `@${e.author.username}`,
      t('robot.speedValue', { v: num(e.speed, 1) }),
      e.model ? t('gallery.hasModel') : null,
      t('gallery.addedCount', { n: e.added }),
      e.hidden ? t('gallery.hidden') : null,
    ];
    return h('button', { class: `ws-robot ${e.id === this.picked?.id ? 'ws-robot-on' : ''} ${e.hidden ? 'ws-robot-hidden' : ''}`, onclick: () => void this.pick(e) },
      h('img', { src: this.account.galleryThumb(e), alt: '', loading: 'lazy' }),
      h('span', { class: 'ws-robot-name' }, e.name, h('small', {}, line.filter(Boolean).join(' · '))));
  }

  /** The gallery robot on the field: its figures, who made it, and what can be done with it. */
  private pickedRows(): HTMLElement[] {
    const p = this.picked;
    if (!p || !this.pickedDef) return [];
    const me = this.account.me;
    const mine = me?.id === p.author.id;
    const have = savedRobots().some(r => r.from === p.id || r.gallery === p.id);
    const modelShown = this.galleryModels.has(p.id);
    const info = h('div', { class: 'ms-info ws-info' }, ...robotInfo(this.pickedDef));
    const buttons: HTMLElement[] = [
      this.button(have ? 'gallery.addAgain' : 'gallery.add', () => void this.addFromGallery(p), 'ws-main'),
      this.button('workshop.testDrive', () => void this.addFromGallery(p, true)),
    ];
    if (p.model && p.blueprint.mesh && !modelShown) {
      buttons.push(h('button', { class: 'ms-select ws-button', onclick: () => void this.loadModel(p) }, t('gallery.loadModel', { mb: num(p.model.size / 1048576, 1) })));
    }
    if (mine || this.moderator) {
      buttons.push(this.confirmButton(`takeDown:${p.id}`, 'gallery.takeDown', 'gallery.takeDownSure', t('gallery.takeDownConfirm'), () => void this.takeDown(p)));
    }
    if (this.moderator && p.hidden) buttons.push(this.button('gallery.restore', () => void this.restore(p)));
    if (!mine) {
      buttons.push(this.confirmButton(`report:${p.id}`, 'gallery.report', 'gallery.reportSure', t('gallery.reportConfirm'), () => void this.report(p)));
    }
    return [
      info,
      h('p', { class: 'ws-note' }, `${t('gallery.by', { name: p.author.name, username: p.author.username })}${have ? ` ${t('gallery.haveIt')}` : ''}`),
      h('div', { class: 'ws-buttons' }, ...buttons),
    ];
  }

  private viewGallery(view: GalleryView): void {
    this.galleryView = view;
    void this.loadGallery();
  }

  /** The first page of the gallery as it is now (or, `more`, the next one). */
  private async loadGallery(more = false): Promise<void> {
    const load = ++this.galleryLoad;
    this.galleryState = 'loading';
    if (!more) {
      this.galleryRobots = [];
      this.galleryTotal = 0;
    }
    const showing = () => this.page === 'list' && this.section === 'gallery';
    if (showing()) this.render();
    try {
      const view = this.galleryView;
      const page = await this.account.gallery({ sort: view === 'mine' ? 'new' : view, mine: view === 'mine', q: this.galleryQuery, offset: more ? this.galleryRobots.length : 0 });
      if (load !== this.galleryLoad) return;
      this.galleryRobots = more ? [...this.galleryRobots, ...page.robots] : page.robots;
      this.galleryTotal = page.total;
      this.moderator = page.moderator;
      this.galleryState = 'idle';
      // The first robot shows on the field while the player looks through the list.
      if (!this.picked && page.robots.length) void this.pick(page.robots[0]);
    } catch {
      if (load !== this.galleryLoad) return;
      this.galleryState = 'failed';
    }
    if (showing()) this.render();
  }

  /** Shows a gallery robot on the field: its blocks at once, its 3D model once it is here (small ones come by themselves). */
  private async pick(entry: GalleryEntry): Promise<void> {
    const load = ++this.pickLoad;
    this.confirming = null;
    this.setStatus(t('gallery.loading'));
    try {
      const robot = await this.account.galleryRobot(entry.id);
      if (load !== this.pickLoad) return;
      this.picked = robot;
      this.setStatus('');
      this.showPicked();
      if (robot.model && robot.blueprint.mesh && robot.model.size <= AUTO_MODEL_BYTES) void this.loadModel(robot);
    } catch {
      if (load === this.pickLoad) this.setStatus(t('gallery.offline'));
    }
  }

  private showPicked(): void {
    const p = this.picked;
    this.pickedDef = p && customDefinition(DRAFT_ROBOT, this.galleryModels.has(p.id) ? p.blueprint : withoutMesh(p.blueprint));
    if (this.page === 'list' && this.section === 'gallery') this.render();
  }

  private async loadModel(robot: GalleryRobot): Promise<void> {
    if (this.galleryModels.has(robot.id) || !robot.blueprint.mesh) return;
    this.setStatus(t('gallery.modelLoading'));
    try {
      const data = await this.account.galleryModel(robot);
      await addMeshSource(robot.blueprint.mesh.id, data, robot.blueprint.mesh.format);
      this.galleryModels.set(robot.id, data);
      // Models take memory: only the last few stay.
      for (const id of [...this.galleryModels.keys()].slice(0, -MODELS_KEPT)) {
        this.galleryModels.delete(id);
        forgetMeshSource(`gal${id}`);
      }
      if (this.picked?.id !== robot.id) return;
      this.setStatus('');
      this.showPicked();
    } catch (err) {
      if (this.picked?.id === robot.id) this.setStatus(err instanceof ModelError ? modelErrorText(err) : t('gallery.modelFailed'));
    }
  }

  /** A gallery robot becomes one of the player's (with its 3D model); `drive`: and off to a test drive. */
  private async addFromGallery(robot: GalleryRobot, drive = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setStatus(t('gallery.adding'));
    try {
      let blueprint = withoutMesh(robot.blueprint);
      let model: ArrayBuffer | null = null;
      if (robot.model && robot.blueprint.mesh) {
        model = this.galleryModels.get(robot.id) ?? await this.account.galleryModel(robot);
        // The copy's file gets an id of its own here.
        blueprint = { ...robot.blueprint, mesh: { ...robot.blueprint.mesh, id: newMeshId() } };
        await addMeshSource(blueprint.mesh!.id, model, blueprint.mesh!.format).catch(() => undefined);
      }
      const id = newRobotId();
      if (!(await this.actions.save({ id, blueprint, saved: Date.now(), from: robot.id }, model))) return this.setStatus(t('workshop.storageFull'));
      void this.account.galleryAdded(robot.id).catch(() => undefined);
      this.selected = id;
      this.setStatus(t('gallery.added', { name: robot.name }));
      if (drive) this.actions.testDrive(id);
      else this.render();
    } catch {
      this.setStatus(t('gallery.modelFailed'));
    } finally {
      this.busy = false;
    }
  }

  /** Its author or a moderator takes a robot down. */
  private async takeDown(robot: GalleryRobot): Promise<void> {
    try {
      await this.account.unpublishRobot(robot.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return this.setStatus(galleryErrorText(err));
    }
    for (const r of savedRobots()) if (r.gallery === robot.id) saveRobot({ ...r, gallery: undefined, saved: Date.now() });
    this.picked = null;
    this.pickedDef = null;
    this.setStatus(t('gallery.takenDown'));
    void this.loadGallery();
  }

  private async report(robot: GalleryRobot): Promise<void> {
    if (this.needAccount()) return;
    try {
      await this.account.reportRobot(robot.id);
      this.setStatus(t('gallery.reported'));
    } catch (err) {
      this.setStatus(galleryErrorText(err));
    }
    this.render();
  }

  private async restore(robot: GalleryRobot): Promise<void> {
    try {
      await this.account.restoreRobot(robot.id);
      this.picked = { ...robot, hidden: false };
      this.setStatus(t('gallery.restored'));
      void this.loadGallery();
    } catch (err) {
      this.setStatus(galleryErrorText(err));
    }
  }

  // ---- the editor --------------------------------------------------------------

  private get definition(): RobotDefinition {
    return customDefinition(DRAFT_ROBOT, this.draft);
  }

  /** Changes the robot being edited; its rows, numbers and the robot on the field follow. */
  private change(patch: Partial<Blueprint>): void {
    this.draft = cleanBlueprint({ ...this.draft, ...patch }) ?? this.draft;
    this.leaving = false;
    this.refresh();
  }

  private refresh(): void {
    for (const row of this.rows) row();
    const def = this.definition;
    this.info.replaceChildren(...robotInfo(def));
    this.actions.show(def, !!this.draft.mesh);
  }

  private renderEditor(): void {
    this.title.textContent = t(this.exists ? 'workshop.editTitle' : 'workshop.newTitle');
    const tabs = h('div', { class: 'settings-tabs ws-tabs' }, ...TABS.map(({ tab, label }) =>
      ht('button', { class: `ms-tab ${tab === this.tab ? 'ms-tab-on' : ''}`, onclick: () => this.openTab(tab) }, label)));
    this.body.replaceChildren(tabs, h('div', { class: 'ws-rows' }, ...this.tabRows()), this.info);
    this.foot.replaceChildren(
      ht('button', { class: 'ms-start ws-save', onclick: () => void this.save() }, 'workshop.save'),
      ht('button', { class: 'ms-start ws-drive', onclick: () => void this.saveAndDrive() }, 'workshop.testDrive'),
    );
    this.refresh();
  }

  private openTab(tab: Tab): void {
    this.tab = tab;
    this.rerender();
  }

  /** The editor again, for another tab or other parts of the robot. */
  private rerender(): void {
    this.rows = [];
    this.renderEditor();
    // A controller player stays on the tab (or the part) just picked.
    if (document.body.classList.contains('pad-nav')) {
      this.body.querySelector<HTMLElement>(this.tab === 'intake' || this.tab === 'shooter' ? '.ws-parts .ms-tab-on' : '.ms-tab-on')?.focus({ preventScroll: true });
    }
  }

  private tabRows(): HTMLElement[] {
    const d = () => this.draft;
    switch (this.tab) {
      case 'general':
        return [
          this.textRow('workshop.name', 'name', 'workshop.namePlaceholder', 24),
          this.textRow('workshop.team', 'team', 'workshop.teamPlaceholder', 24),
          this.textRow('workshop.number', 'number', 'workshop.numberPlaceholder', 6),
          this.colorRow('workshop.color', 'color'),
          this.colorRow('workshop.accent', 'accent'),
        ];
      case 'drive':
        return [
          ht('p', { class: 'ws-note' }, 'workshop.sizeRule'),
          this.blueprintRow('length', 'workshop.length', mm),
          this.blueprintRow('width', 'workshop.width', mm),
          this.blueprintRow('frameHeight', 'workshop.frameHeight', mm),
          this.choiceRow('workshop.drivetrain', DRIVETRAINS, () => d().drivetrain, drivetrain => this.change({ drivetrain }), k => t(DRIVETRAIN_TEXT[k][0])),
          this.liveNote(() => t(DRIVETRAIN_TEXT[d().drivetrain][1])),
          this.blueprintRow('wheel', 'workshop.wheel', mm),
          this.blueprintRow('rpm', 'workshop.rpm', v => t('workshop.rpmValue', { rpm: v, v: num(topSpeed({ rpm: v, wheel: d().wheel }), 1) })),
          this.blueprintRow('mass', 'workshop.mass', v => t('robot.massValue', { kg: num(v, 1) })),
        ];
      case 'intake':
        return this.intakeRows();
      case 'shooter':
        return this.turretRows();
      case 'model':
        return this.modelRows();
    }
  }

  /** A note that changes with the robot. */
  private liveNote(text: () => string): HTMLElement {
    const note = h('p', { class: 'ws-note' });
    this.rows.push(() => (note.textContent = text()));
    return note;
  }

  /** A tab for one of the robot's intakes or turrets (`on`: the one being changed). */
  private partTab(text: string, on: boolean, onclick: () => void, title?: string): HTMLButtonElement {
    return h('button', { class: `ms-tab ${on ? 'ms-tab-on' : ''}`, title, onclick }, text);
  }

  // ---- intakes ------------------------------------------------------------------

  /** The intake being changed: the back one when it is picked, else the front one. */
  private get intakePart(): IntakePart {
    return (this.intakeEnd === 'back' && this.draft.backIntake) || this.draft.intake;
  }

  private changeIntake(patch: Partial<IntakePart>): void {
    if (this.intakeEnd === 'back' && this.draft.backIntake) this.change({ backIntake: { ...this.draft.backIntake, ...patch } });
    else this.change({ intake: { ...this.draft.intake, ...patch } });
  }

  private pickIntake(end: 'front' | 'back'): void {
    this.intakeEnd = end;
    this.rerender();
  }

  /** A second intake at the back, like the front one. */
  private addBackIntake(): void {
    this.intakeEnd = 'back';
    this.change({ backIntake: { ...this.draft.intake } });
    this.rerender();
  }

  private removeBackIntake(): void {
    this.intakeEnd = 'front';
    this.change({ backIntake: null });
    this.rerender();
  }

  private intakeRows(): HTMLElement[] {
    const back = this.intakeEnd === 'back' && !!this.draft.backIntake;
    const row = (key: keyof typeof INTAKE_LIMITS, label: TextKey, show: (v: number) => string) =>
      this.numberRow(INTAKE_LIMITS[key], label, () => this.intakePart[key], v => this.changeIntake({ [key]: v }), show);
    return [
      h('div', { class: 'settings-tabs ws-tabs ws-parts' },
        this.partTab(t('workshop.front'), !back, () => this.pickIntake('front')),
        this.draft.backIntake
          ? this.partTab(t('workshop.back'), back, () => this.pickIntake('back'))
          : this.partTab(t('workshop.addBack'), false, () => this.addBackIntake())),
      this.choiceRow('robot.intakes', INTAKE_KINDS, () => this.intakePart.kind, kind => this.changeIntake({ kind }), kindName),
      row('width', 'workshop.intakeWidth', mm),
      row('reach', 'workshop.intakeReach', mm),
      row('rate', 'workshop.intakeRate', v => t('workshop.perSecond', { v: num(v, 1) })),
      back
        ? h('div', { class: 'ws-buttons' }, this.button('workshop.removeBack', () => this.removeBackIntake(), 'ws-danger'))
        : this.choiceRow('workshop.arm', [false, true], () => this.draft.arm, arm => this.change({ arm }), on => t(on ? 'common.on' : 'common.off'), () => this.draft.intake.kind !== 'nectar'),
      ht('p', { class: 'ws-note' }, back ? 'workshop.backNote' : 'workshop.frontNote'),
    ];
  }

  // ---- turrets ------------------------------------------------------------------

  /** Which turret is being changed (the last one, if it was taken away). */
  private get turretIndex(): number {
    return Math.min(this.turret, this.draft.turrets.length - 1);
  }

  private get turretPart(): TurretPart {
    return this.draft.turrets[this.turretIndex];
  }

  private changeTurret(patch: Partial<TurretPart>): void {
    const i = this.turretIndex;
    this.change({ turrets: this.draft.turrets.map((tr, k) => (k === i ? { ...tr, ...patch } : tr)) });
  }

  private pickTurret(i: number): void {
    this.turret = i;
    this.rerender();
  }

  /** One more turret, set like the one being changed. */
  private addTurret(): void {
    this.change({ turrets: withTurret(this.draft, this.turretIndex) });
    this.turret = this.draft.turrets.length - 1;
    this.rerender();
  }

  private removeTurret(): void {
    this.change({ turrets: withoutTurret(this.draft, this.turretIndex) });
    this.rerender();
  }

  /** Every turret set like this one, each staying where it is and shooting what it shoots. */
  private sameForAll(): void {
    const { height, facing, range, rapidFire, spin } = this.turretPart;
    this.change({ turrets: this.draft.turrets.map(tr => ({ ...tr, height, facing, range, rapidFire, spin })) });
  }

  /** This turret shooting `kind` still leaves a turret for every ball the robot can hold. */
  private canShoot(kind: IntakeKind): boolean {
    const shoots = this.draft.turrets.map((tr, k) => (k === this.turretIndex ? kind : tr.shoots));
    return heldKinds(this.draft).every(held => shoots.some(s => s === 'both' || s === held));
  }

  private turretRows(): HTMLElement[] {
    const count = this.draft.turrets.length;
    const index = this.turretIndex;
    const row = (key: keyof typeof TURRET_LIMITS, label: TextKey, show: (v: number) => string, range: () => Range = () => TURRET_LIMITS[key]) =>
      this.numberRow(range, label, () => this.turretPart[key], v => this.changeTurret({ [key]: v }), show);
    // The turret's axis stays on the frame: the sliders reach as far as it can go.
    const within = (side: 0 | 1) => () => {
      const { step } = TURRET_LIMITS.x;
      const bound = Math.floor(turretBounds(this.draft)[side] / step + 1e-6) * step;
      return { min: -bound, max: bound, step };
    };
    return [
      h('div', { class: 'settings-tabs ws-tabs ws-parts' },
        ht('span', { class: 'ws-label ws-parts-label' }, 'workshop.turrets'),
        ...this.draft.turrets.map((_, i) => this.partTab(String(i + 1), i === index, () => this.pickTurret(i))),
        count < MAX_TURRETS ? this.partTab('+', false, () => this.addTurret(), t('workshop.addTurret')) : ''),
      h('p', { class: 'ws-note' }, t(count > 1 ? 'workshop.turretOf' : 'workshop.turretOne', { n: index + 1, count })),
      this.choiceRow('workshop.shoots', SHOOTS, () => this.turretPart.shoots, shoots => this.changeTurret({ shoots }), shootsName, () => heldKinds(this.draft).length > 1, kind => this.canShoot(kind)),
      row('x', 'workshop.turretX', along, within(0)),
      row('z', 'workshop.turretZ', across, within(1)),
      row('height', 'workshop.shooterHeight', mm),
      row('facing', 'workshop.facing', facingName),
      row('range', 'workshop.turretRange', v => (v ? t('robot.turretValue', { deg: num(v) }) : t('robot.turretFixed'))),
      row('rapidFire', 'robot.rapidFire', v => t('robot.rapidFireValue', { s: num(v, 2) })),
      this.choiceRow('robot.spin', SPINS, () => this.turretPart.spin, spin => this.changeTurret({ spin }), v => t(spinName(v))),
      count > 1 ? h('div', { class: 'ws-buttons' },
        this.button('workshop.sameForAll', () => this.sameForAll()),
        this.button('workshop.arrange', () => this.change({ turrets: arrangeTurrets(this.draft) })),
        this.button('workshop.removeTurret', () => this.removeTurret(), 'ws-danger')) : '',
      // How long a full battery lasts with every flywheel at full speed (sim/Battery.ts).
      this.liveNote(() => t('workshop.turretNote', { s: num((BATTERY.full - BATTERY.empty) / (this.draft.turrets.length * BATTERY.flywheelDrain)) })),
    ].filter((row): row is HTMLElement => row !== '');
  }

  private modelRows(): HTMLElement[] {
    const choose = ht('button', { class: 'ms-select ws-button ws-main', onclick: () => this.modelInput.click() }, 'workshop.chooseFile');
    const mesh = this.draft.mesh;
    if (!mesh) return [ht('p', { class: 'ws-note' }, 'workshop.modelAbout'), h('div', { class: 'ws-buttons' }, choose)];
    const fit = (patch: Partial<MeshFit>) => {
      this.change({ mesh: { ...this.draft.mesh!, ...patch } });
      void this.measureModel();
    };
    const size = h('p', { class: 'ws-note' });
    this.rows.push(() => {
      const s = this.modelSize;
      const big = !!s && Math.max(...s) > SIZE_LIMIT;
      size.textContent = s ? `${t('workshop.modelSize', { l: num(s[0] * 1000), w: num(s[2] * 1000), h: num(s[1] * 1000) })}${big ? ` ${t('workshop.modelTooBig')}` : ''}` : '';
      size.classList.toggle('warn', big);
    });
    const unit = (scale: number) => UNITS.find(u => Math.abs(u.scale - scale) < 1e-9);
    return [
      h('div', { class: 'ms-row ws-row' }, ht('span', { class: 'ws-label' }, 'workshop.file'), h('span', { class: 'ws-file' }, mesh.file)),
      size,
      this.choiceRow('workshop.units', UNITS.map(u => u.scale), () => this.draft.mesh?.scale ?? 1, scale => fit({ scale }),
        v => (unit(v) ? t(unit(v)!.label) : `× ${v}`)),
      this.choiceRow('workshop.up', UP_AXES, () => this.draft.mesh?.up ?? 'y', up => fit({ up: up as UpAxis }), v => v.toUpperCase().replace('-', '−')),
      this.choiceRow('workshop.turn', [0, 1, 2, 3], () => this.draft.mesh?.turn ?? 0, turn => fit({ turn }), v => `${v * 90}°`),
      this.choiceRow('workshop.signs', [true, false], () => this.draft.mesh?.signs ?? true, signs => fit({ signs }), on => t(on ? 'common.on' : 'common.off')),
      h('div', { class: 'ws-buttons' },
        ht('button', { class: 'ms-select ws-button', onclick: () => void this.fitSizes() }, 'workshop.fitSizes'),
        choose,
        ht('button', { class: 'ms-select ws-button ws-danger', onclick: () => this.removeModel() }, 'workshop.removeModel')),
      ht('p', { class: 'ws-note ws-legend' }, 'workshop.legend'),
    ];
  }

  // ---- rows ---------------------------------------------------------------------

  /**
   * A number: its name and value, and − slider + under them (the buttons for the controller).
   * `range`: its limits, or what they are now (they may follow other numbers).
   */
  private numberRow(range: Range | (() => Range), label: TextKey, get: () => number, set: (v: number) => void, show: (v: number) => string): HTMLElement {
    const limits = typeof range === 'function' ? range : () => range;
    const { step } = limits();
    const value = h('span', { class: 'ws-value' });
    const slider = h('input', { type: 'range', class: 'ws-slider', step: String(step) });
    slider.addEventListener('input', () => set(Number(slider.value)));
    this.rows.push(() => {
      const { min, max } = limits();
      slider.min = String(min);
      slider.max = String(max);
      const v = get();
      value.textContent = show(v);
      slider.value = String(v);
    });
    return h('div', { class: 'ws-row ws-num' },
      h('div', { class: 'ws-row-head' }, ht('span', { class: 'ws-label' }, label), value),
      h('div', { class: 'ws-slide' },
        h('button', { class: 'ms-step ws-step', onclick: () => set(get() - step) }, '−'),
        slider,
        h('button', { class: 'ms-step ws-step', onclick: () => set(get() + step) }, '+')));
  }

  /** One of the blueprint's own numbers. */
  private blueprintRow(key: NumberKey, label: TextKey, show: (v: number) => string): HTMLElement {
    return this.numberRow(LIMITS[key], label, () => this.draft[key], v => this.change({ [key]: v }), show);
  }

  /** A choice that steps through `options`, past those `allowed` says no to (greyed out while `enabled` says no). */
  private choiceRow<T>(label: TextKey, options: readonly T[], get: () => T, set: (v: T) => void, name: (v: T) => string, enabled = () => true, allowed: (v: T) => boolean = () => true): HTMLElement {
    const next = () => {
      const at = options.indexOf(get());
      for (let k = 1; k < options.length; k++) {
        const v = options[(at + k) % options.length];
        if (allowed(v)) return v;
      }
      return get();
    };
    const button = h('button', { class: 'ms-select', onclick: () => set(next()) });
    this.rows.push(() => {
      button.textContent = name(get());
      button.disabled = !enabled();
    });
    return h('div', { class: 'ms-row ws-row' }, ht('span', { class: 'ws-label' }, label), button);
  }

  private textRow(label: TextKey, key: 'name' | 'team' | 'number', placeholder: TextKey, max: number): HTMLElement {
    const input = ht('input', { class: 'ms-input ws-input', maxlength: String(max), inputmode: key === 'number' ? 'numeric' : undefined }, placeholder);
    input.value = this.draft[key];
    // What is typed stays as typed; the robot gets it cleaned (no line breaks, digits for the number).
    input.addEventListener('input', () => this.change({ [key]: input.value }));
    input.addEventListener('change', () => (input.value = this.draft[key]));
    return h('div', { class: 'ms-row ws-row' }, ht('span', { class: 'ws-label' }, label), input);
  }

  private colorRow(label: TextKey, key: 'color' | 'accent'): HTMLElement {
    const swatches = PALETTE.map(color => h('button', { class: 'ws-swatch', style: `background: ${color}`, title: color, onclick: () => this.change({ [key]: color }) }));
    // Any other color, with the mouse.
    const other = h('input', { type: 'color', class: 'ws-swatch ws-picker', title: t('workshop.otherColor') });
    other.addEventListener('input', () => this.change({ [key]: other.value }));
    this.rows.push(() => {
      swatches.forEach((s, i) => s.classList.toggle('ws-swatch-on', PALETTE[i] === this.draft[key]));
      other.value = this.draft[key];
      other.classList.toggle('ws-swatch-on', !PALETTE.includes(this.draft[key]));
    });
    return h('div', { class: 'ws-row ws-colors' }, ht('span', { class: 'ws-label' }, label), h('div', { class: 'ws-swatches' }, ...swatches, other));
  }

  // ---- the 3D file ----------------------------------------------------------------

  private async pickModel(file: File): Promise<void> {
    const format = meshFormat(file.name);
    if (!format) return this.setStatus(t('workshop.errFormat'));
    if (file.size > MAX_FILE) return this.setStatus(t('workshop.errFile'));
    this.busy = true;
    this.setStatus(t('workshop.loading'));
    try {
      const data = await file.arrayBuffer();
      const id = newMeshId();
      const source = await addMeshSource(id, data, format);
      this.model = data;
      this.change({ mesh: { id, file: file.name, format, ...guessFit(source, format), turn: 0, signs: true } });
      // The robot takes the model's size: the collision box, the intake and the shooter fit it.
      await this.fitSizes();
      this.setStatus('');
    } catch (err) {
      this.setStatus(modelErrorText(err));
    } finally {
      this.busy = false;
    }
    if (this.page === 'edit') this.openTab('model');
  }

  private async measureModel(): Promise<void> {
    const mesh = this.draft.mesh;
    if (!mesh) return;
    try {
      const size = await meshSize(mesh);
      if (this.draft.mesh !== mesh) return;
      this.modelSize = size;
      this.refresh();
    } catch (err) {
      this.setStatus(modelErrorText(err));
    }
  }

  /** The robot's length, width and height from its model's (within FTC's 18 inches). */
  private async fitSizes(): Promise<void> {
    await this.measureModel();
    const s = this.modelSize;
    if (!s) return;
    this.change({ length: s[0], width: s[2], turrets: this.draft.turrets.map(tr => ({ ...tr, height: s[1] - TURRET.above })) });
  }

  private removeModel(): void {
    this.model = null;
    this.modelSize = null;
    this.change({ mesh: null });
    this.openTab('model');
  }

  private async save(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const ok = await this.actions.save({ id: this.id, blueprint: this.draft, saved: Date.now() }, this.model);
      if (!ok) {
        this.setStatus(t('workshop.storageFull'));
        return false;
      }
      this.saved = this.draft;
      this.exists = true;
      this.model = null;
      this.leaving = false;
      this.title.textContent = t('workshop.editTitle');
      this.setStatus(t('workshop.saved'));
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async saveAndDrive(): Promise<void> {
    if (await this.save()) this.actions.testDrive(this.id);
  }
}
