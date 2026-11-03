// Main menu and pause menu.

import type { AiLevel } from '../ai/level';
import { cameraName, type CameraMode } from '../camera/CameraRig';
import { padName } from '../input/gamepad';
import type { InputManager } from '../input/InputManager';
import { GAME_TYPES, type Me, type OnlineCount, type Totals } from '../net/accountProtocol';
import { h } from './dom';
import { ht, language, t, type TextKey } from './i18n';
import { icon } from './icons';
import { MenuNav } from './MenuNav';
import { aiLevelName } from './RobotSelect';
import { SPONSORS } from './sponsors';

export const LINKS = {
  instagram: 'https://www.instagram.com/ursim_ftc/',
  github: 'https://github.com/AendeGitHub/UrSimulator',
  /** The desktop game for Windows, macOS and Linux */
  download: 'https://github.com/AendeGitHub/UrSimulator/releases',
  /** What the game keeps about players (public/privacy.html), the page Google's sign-in links to */
  privacy: 'https://ursim.duckdns.org/privacy.html',
};

/** Opens a page in a new tab (a button, so the controller can reach it). */
const openLink = (url: string) => () => window.open(url, '_blank', 'noopener');

/** macOS has no driver for the F310's "X" (XInput) mode, so there it shows up only on "D". */
const IS_MAC = /Mac/.test(navigator.userAgent);

/** 2 765 (ru, kk) or 2,765 (en). */
export const formatNumber = (n: number) => n.toLocaleString(language());

export interface Screen {
  el: HTMLElement;
  nav: MenuNav;
  /** Called every frame while the screen is shown. */
  update?(input: InputManager): void;
  onShow?(): void;
  /** True while the screen reads the controller itself (e.g. button assignment). */
  readonly blocksNav?: boolean;
}

export interface MainMenuActions {
  match(): void;
  practice(): void;
  online(): void;
  /** Robots of the player's own */
  workshop(): void;
  records(): void;
  settings(): void;
  /** The account button: the player's career, or signing in */
  account(): void;
  friends(): void;
}

/** A big white menu entry, outlined when focused (MoSim style). */
function item(key: TextKey, onclick: () => void): HTMLButtonElement {
  return ht('button', { class: 'btn menu-item', onclick }, key);
}

export class MainMenu implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly list = h('div', { class: 'menu-list' });
  private readonly pads = h('div', { class: 'pad-status' });
  private readonly totalsEl = h('div', { class: 'menu-totals' });
  private readonly onlineEl = h('span', { class: 'menu-online' });
  private readonly accountBtn = h('button', { class: 'menu-account' });
  private readonly friendsBadge = h('span', { class: 'friends-badge' });
  private padKey = '';
  private page: 'root' | 'play' = 'root';
  private totals: Totals | null = null;
  private online: OnlineCount | null = null;
  private me: Me | null = null;
  /** Something that closes on Back first (the friends panel): true when it did */
  backHandler: (() => boolean) | null = null;

  /** `desktop`: the desktop game, which doesn't offer itself for download. */
  constructor(private readonly actions: MainMenuActions, desktop = false) {
    this.accountBtn.addEventListener('click', () => actions.account());
    this.friendsBadge.hidden = true;
    // The DOM order is the controller's order: the menu first, the corners after it.
    this.el = h('div', { class: 'screen menu-main' },
      h('div', { class: 'menu-left' }, this.list, this.totalsEl),
      h('div', { class: 'menu-brand' },
        h('img', { src: 'assets/logo-2.0.svg', alt: 'UrSim 2.0 Beta', class: 'menu-logo' }),
        // Made by team URAN92 (a brand line: the same words in every language).
        h('div', { class: 'menu-presented' }, h('span', {}, 'Presented by'), h('img', { src: 'assets/teams/uran.svg', alt: 'URAN' })),
        h('div', { class: 'menu-links' },
          h('button', { class: 'pill', onclick: openLink(LINKS.instagram) }, icon('instagram'), 'Instagram'),
          h('button', { class: 'pill', onclick: openLink(LINKS.github) }, icon('github'), 'GitHub'),
          // The website offers the desktop game; the desktop game is it.
          desktop ? null : h('button', { class: 'pill', title: t('menu.downloadHint'), onclick: openLink(LINKS.download) }, icon('download'), ht('span', {}, 'menu.download')))),
      h('div', { class: 'menu-corner' },
        h('div', { class: 'menu-status' }, this.onlineEl, this.accountBtn),
        h('img', { src: 'assets/biobuzz.webp', alt: 'FIRST Tech Challenge · BIOBUZZ', class: 'menu-season' })),
      h('button', { class: 'friends-tab', onclick: () => actions.friends() }, icon('friends'), ht('span', {}, 'friends.title'), this.friendsBadge),
      h('div', { class: 'menu-foot' },
        this.pads,
        h('div', { class: 'menu-credits' },
          h('div', { class: 'menu-sponsors' },
            ht('span', { class: 'menu-sponsors-label' }, 'menu.sponsors'),
            ...SPONSORS.map(s => h('img', { src: s.src, alt: s.name, title: s.name, class: s.square ? 'menu-sponsor-square' : '' }))),
          h('p', { class: 'menu-legal' }, `UrSim v${__APP_VERSION__} · `,
            ht('button', { class: 'menu-legal-link', onclick: openLink(LINKS.privacy) }, 'menu.privacy'), ' · ',
            ht('span', {}, 'menu.legal')))),
    );
    this.nav = new MenuNav(this.el, () => {
      if (this.backHandler?.()) return;
      if (this.page === 'play') this.open('root');
    });
    this.open('root');
    this.render();
  }

  /** Players and games of everyone (null: the server didn't answer). */
  setTotals(totals: Totals | null): void {
    this.totals = totals;
    this.render();
  }

  setOnline(count: OnlineCount | null): void {
    this.online = count;
    this.render();
  }

  /** The signed-in player; null: the button offers to sign in. */
  setAccount(me: Me | null): void {
    this.me = me;
    this.render();
  }

  /** Friend requests waiting for an answer, shown on the Friends button. */
  setRequests(count: number): void {
    this.friendsBadge.hidden = !count;
    this.friendsBadge.textContent = String(count);
  }

  private render(): void {
    const n = formatNumber;
    this.onlineEl.replaceChildren(...(this.online
      ? [h('span', { class: 'dot dot-on' }), h('b', {}, n(this.online.online)), ` ${t('menu.onlineCount', { signedIn: n(this.online.signedIn) })}`]
      : []));
    this.accountBtn.replaceChildren(...(this.me
      ? [h('span', { class: 'avatar' }, this.me.name.charAt(0).toUpperCase()), h('span', { class: 'menu-account-name' }, this.me.name)]
      : [icon('google'), h('span', {}, t('menu.signIn'))]));
    this.accountBtn.title = this.me ? `@${this.me.username}` : '';
    const totals = this.totals;
    this.totalsEl.hidden = !totals;
    if (!totals) return;
    const games = GAME_TYPES.reduce((sum, type) => sum + totals.games[type], 0);
    this.totalsEl.replaceChildren(
      h('div', { class: 'menu-totals-boxes' },
        h('div', { class: 'stat-box' }, h('b', {}, n(totals.players)), t('menu.players')),
        h('div', { class: 'stat-box' }, h('b', {}, n(totals.accounts)), t('menu.accounts')),
        h('div', { class: 'stat-box' }, h('b', {}, n(games)), t('menu.gamesPlayed'))),
      h('div', { class: 'menu-totals-types' }, ...GAME_TYPES.map(type => h('span', {}, `${t(`games.${type}` as TextKey)} `, h('b', {}, n(totals.games[type]))))),
      h('div', { class: 'menu-totals-types' }, h('span', {}, `${t('menu.signedInGames')} `, h('b', {}, n(totals.signedInGames)))),
    );
  }

  /** "Play" opens a sub-list in place, like MoSim's Play menu. */
  private open(page: 'root' | 'play'): void {
    this.page = page;
    const a = this.actions;
    this.list.replaceChildren(...(page === 'root'
      ? [item('menu.play', () => this.open('play')), item('menu.online', a.online), item('menu.workshop', a.workshop), item('menu.records', a.records), item('menu.settings', a.settings)]
      : [ht('div', { class: 'menu-heading' }, 'menu.play'), item('menu.match', a.match), item('menu.practice', a.practice), item('common.back', () => this.open('root'))]));
    this.nav.focusFirst();
  }

  /** Redraws the controller line and the numbers too, in case the language changed in the settings. */
  onShow(): void {
    this.padKey = '';
    this.render();
  }

  update(input: InputManager): void {
    const p1 = input.slotInfo(0);
    const p2 = input.slotInfo(1);
    const key = JSON.stringify([p1?.id, p1?.guessed, p2?.id, p2?.guessed]);
    if (key === this.padKey) return;
    this.padKey = key;
    // A pad without a standard layout plays with guessed buttons until they're set up.
    const guessed = [p1, p2].findIndex(p => p?.guessed) + 1;
    this.pads.replaceChildren(
      h('span', { class: `dot ${p1 ? 'dot-on' : 'dot-off'}` }),
      p1 ? `gamepad1: ${padName(p1)}` : t('menu.noPad'),
      p2 ? h('span', { class: 'muted' }, ` · gamepad2: ${padName(p2)}`) : '',
      !p1 && IS_MAC ? h('div', { class: 'muted' }, t('menu.f310Mac')) : '',
      guessed ? h('div', { class: 'muted' }, t('menu.guessedPad', { n: guessed })) : '',
    );
  }
}

export interface PauseActions {
  resume(): void;
  resetRobot(): void;
  /** The next camera, and the other drive mode, for this computer's drivers (online too) */
  camera(): void;
  drive(): void;
  /** A game at this computer with the AI: its next level, at once */
  aiLevel(): void;
  settings(): void;
  exit(): void;
  /** Practice: starts recording the game, or stops it (a match records itself) */
  record(): void;
  /** The recording so far, or the one stopped, in the replay studio */
  watch(): void;
  /** Online, the admin: back to the room for everyone */
  endOnline(): void;
}

/** What the pause menu offers for recording the game */
export interface PauseRecording {
  /** Practice can be recorded by hand; a match records itself */
  canRecord: boolean;
  recording: boolean;
  /** Something recorded to watch */
  canWatch: boolean;
}

export class PauseMenu implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly restart: HTMLButtonElement;
  private readonly endOnline: HTMLButtonElement;
  private readonly camera = h('button', { class: 'btn menu-item' });
  private readonly drive = h('button', { class: 'btn menu-item' });
  private readonly aiLevel = h('button', { class: 'btn menu-item' });
  private readonly record = h('button', { class: 'btn menu-item' });
  private readonly watch = h('button', { class: 'btn menu-item' });
  private local: { camera: CameraMode; fieldCentric: boolean } = { camera: 'driver', fieldCentric: true };
  /** The AI's level in this game at this computer; null without the AI (or online, where the room's admin picks it) */
  private level: AiLevel | null = null;
  private recording: PauseRecording = { canRecord: false, recording: false, canWatch: false };

  constructor(actions: PauseActions) {
    this.restart = item('pause.restart', () => actions.resetRobot());
    this.endOnline = item('pause.endOnline', () => actions.endOnline());
    this.endOnline.hidden = true;
    this.camera.addEventListener('click', () => actions.camera());
    this.drive.addEventListener('click', () => actions.drive());
    this.aiLevel.addEventListener('click', () => actions.aiLevel());
    this.record.addEventListener('click', () => actions.record());
    this.watch.addEventListener('click', () => actions.watch());
    this.el = h('div', { class: 'screen menu-pause' },
      h('div', { class: 'menu-list' },
        ht('div', { class: 'menu-heading' }, 'pause.title'),
        item('pause.resume', () => actions.resume()),
        this.restart,
        this.endOnline,
        this.camera,
        this.drive,
        this.aiLevel,
        this.record,
        this.watch,
        item('menu.settings', () => actions.settings()),
        item('pause.toMenu', () => actions.exit()),
      ),
    );
    this.nav = new MenuNav(this.el, actions.resume);
  }

  /** The camera and drive mode the drivers at this computer have now. */
  setLocal(camera: CameraMode, fieldCentric: boolean): void {
    this.local = { camera, fieldCentric };
    this.onShow();
  }

  setAiLevel(level: AiLevel | null): void {
    this.level = level;
    this.onShow();
  }

  setRecording(recording: PauseRecording): void {
    this.recording = recording;
    this.onShow();
  }

  /** Also after the settings: the language may have changed. */
  onShow(): void {
    this.camera.textContent = `${t('select.camera')}: ${cameraName(this.local.camera)}`;
    this.drive.textContent = `${t('select.drive')}: ${this.local.fieldCentric ? 'Field-centric' : 'Robot-centric'}`;
    this.aiLevel.hidden = !this.level;
    if (this.level) this.aiLevel.textContent = `${t('select.aiLevel')}: ${aiLevelName(this.level)}`;
    const { canRecord, recording, canWatch } = this.recording;
    this.record.hidden = !canRecord;
    this.record.replaceChildren(h('span', { class: 'menu-rec-icon' }, recording ? '■' : '●'), ` ${t(recording ? 'pause.recordStop' : 'pause.recordStart')}`);
    this.watch.hidden = !canWatch;
    this.watch.textContent = `▶ ${t('pause.watch')}`;
  }

  /** Online the game can't be restarted from here: it goes on for everyone. Only the admin ends it. */
  setOnline(on: boolean, admin: boolean): void {
    this.restart.hidden = on;
    this.endOnline.hidden = !on || !admin;
  }
}
