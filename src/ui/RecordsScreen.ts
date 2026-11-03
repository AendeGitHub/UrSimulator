// Records: the leaderboard of a season or month (high scores solo / duo for each robot or all of
// them, and the ranked online ladder), and a player's career — their numbers for a period and
// their match history. Anyone's career opens from their row; the signed-in player's from the
// account button, with their match archive: the latest matches, each to watch again.

import { canSignIn, signInInBrowser, type AccountClient } from '../net/account';
import { GAME_TYPES, MAX_REPLAYS, winRate, type BoardEntry, type BoardKind, type CareerResponse, type GameType, type HistoryEntry, type MatchResult, type Provider, type RankedEntry, type ReplayInfo } from '../net/accountProtocol';
import { ALL_TIME, monthLabel, periodsOf, seasonLabel, seasonMonths, seasons } from '../net/periods';
import { cleanName } from '../net/records';
import { ROBOTS, isCustomRobotId, robotById } from '../robot/robots';
import { h } from './dom';
import { Dropdown } from './Dropdown';
import { ht, language, t, type TextKey } from './i18n';
import { icon } from './icons';
import { formatNumber, type Screen } from './menus';
import { MenuNav } from './MenuNav';

export interface RecordsContext {
  account: AccountClient;
  /** A guest's name for the tables, as saved in the settings */
  name(): string;
  rename(name: string): void;
  signIn(provider: Provider): void;
  /** Watches a match from the archive; rejects when it can't */
  watch(replay: ReplayInfo): Promise<void>;
  back(): void;
}

type Tab = 'leaderboard' | 'career';
type Board = 'high' | 'ranked';
/** In the month list: the whole season */
const WHOLE = 'season';
const SHOW = [10, 25, 50, 100];

/** 1 h 5 min, 4 min 10 s, 0 s */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours) return `${t('time.h', { n: hours })} ${t('time.min', { n: minutes })}`;
  if (minutes) return `${t('time.min', { n: minutes })} ${t('time.s', { n: s % 60 })}`;
  return t('time.s', { n: s });
}

/** A robot's name; a duo's two robots: 'URAN V2 + Bumble V'. A player's own robot not kept here: "Custom robot". */
const robotLabel = (id: string) => id.split('+').map(r => (isCustomRobotId(r) && robotById(r).id !== r ? t('workshop.customRobot') : robotById(r).name)).join(' + ');

export class RecordsScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: MenuNav;
  private readonly search: HTMLInputElement;
  private readonly tabs = h('div', { class: 'rec-tabs' });
  private readonly body = h('div', { class: 'rec-body' });
  private tab: Tab = 'leaderboard';

  // Leaderboard
  private readonly lbSeason = new Dropdown<number>(v => this.pickSeason(v));
  private readonly lbMonth = new Dropdown<string>(v => {
    this.lbPeriod.month = v;
    this.renderLeaderboard();
    void this.loadBoard();
  });
  private lbPeriod = { season: 0, month: WHOLE };
  private board: Board = 'high';
  private kind: BoardKind = 'solo';
  private robot = 'all';
  private rows: BoardEntry[] | RankedEntry[] | null = null;
  private boardError = false;
  private readonly boardEl = h('div', { class: 'rec-board' });
  private readonly nameInput: HTMLInputElement;

  // Career
  /** Whose career: null for the signed-in player */
  private user: string | null = null;
  private readonly crSeason = new Dropdown<string>(v => {
    this.crPeriod = { season: v, month: WHOLE };
    void this.loadCareer();
  });
  private readonly crMonth = new Dropdown<string>(v => {
    this.crPeriod.month = v;
    void this.loadCareer();
  });
  private crPeriod = { season: ALL_TIME, month: WHOLE };
  private career: CareerResponse | null = null;
  private careerError: 'offline' | 'missing' | null = null;
  private readonly typeFilter = new Dropdown<GameType | 'all'>(() => this.renderHistory());
  private readonly resultFilter = new Dropdown<MatchResult | 'any'>(() => this.renderHistory());
  private readonly showFilter = new Dropdown<number>(() => this.renderHistory());
  private readonly historyEl = h('div', { class: 'rec-history' });
  private editing = false;
  private editError = '';
  /** What is typed in the edit form, kept when it is drawn again */
  private draft = { name: '', username: '' };
  private providers: Record<Provider, boolean> | null = null;
  /** The e-mail form: signing in or up, what is typed, and why the server refused */
  private emailMode: 'login' | 'register' = 'login';
  private emailDraft = { email: '', password: '', name: '' };
  private emailError = '';
  private emailBusy = false;
  /** The signed-in player's match archive (null: loading), the match being opened, and one asked to remove */
  private archive: ReplayInfo[] | null = null;
  private archiveError = '';
  private archiveOpening: string | null = null;
  private archiveRemoving: string | null = null;
  private readonly archiveEl = h('div', { class: 'rec-archive' });

  /** Ignores answers to requests made before the latest one. */
  private request = 0;

  constructor(private readonly ctx: RecordsContext) {
    this.search = ht('input', { class: 'field rec-search', spellcheck: 'false' }, 'records.search');
    this.search.addEventListener('input', () => this.renderBoard());
    this.search.addEventListener('keydown', e => {
      // Enter on a @username opens that player's career.
      const name = this.search.value.trim();
      if (e.key === 'Enter' && name) this.openCareer(name.replace(/^@/, '').toLowerCase());
    });
    this.nameInput = ht('input', { class: 'field', maxlength: '16' }, 'common.namePlaceholder');
    this.nameInput.addEventListener('change', () => {
      const name = this.nameInput.value.trim() ? cleanName(this.nameInput.value) : '';
      this.nameInput.value = name;
      ctx.rename(name);
      this.renderBoard();
    });
    this.el = h('div', { class: 'screen menu-records' },
      h('div', { class: 'rec-top' },
        ht('button', { class: 'btn btn-ghost btn-small', onclick: ctx.back }, 'common.backArrow'),
        ht('h2', {}, 'menu.records')),
      this.search,
      this.tabs,
      this.body,
    );
    this.nav = new MenuNav(this.el, ctx.back);
    ctx.account.onChange(() => {
      if (!this.el.isConnected) return;
      if (this.tab === 'career' && this.user === null) void this.loadCareer();
      else this.render();
    });
  }

  /** Opens on a tab: the leaderboard, or a career (no user: the signed-in player's). */
  open(options: { tab?: Tab; user?: string | null } = {}): void {
    this.tab = options.tab ?? 'leaderboard';
    if (options.user !== undefined) this.user = options.user;
    this.editing = false;
  }

  onShow(): void {
    this.nameInput.value = this.ctx.name();
    const now = new Date();
    if (!this.lbPeriod.season) this.lbPeriod = { season: seasons(now)[0], month: periodsOf(now)[1] };
    // The labels are in the current language.
    this.typeFilter.set(this.typeChoices(), this.typeFilter.value ?? 'all');
    this.resultFilter.set(this.resultChoices(), this.resultFilter.value ?? 'any');
    this.showFilter.set(this.showChoices(), this.showFilter.value ?? 25);
    if (!this.providers) {
      this.ctx.account.providers().then(p => {
        this.providers = p;
        if (this.tab === 'career') this.render();
      }, () => undefined);
    }
    this.render();
    if (this.tab === 'leaderboard') void this.loadBoard();
    else void this.loadCareer();
  }

  private openTab(tab: Tab): void {
    this.tab = tab;
    if (tab === 'career') this.user = null;
    this.editing = false;
    this.render();
    if (tab === 'leaderboard') void this.loadBoard();
    else void this.loadCareer();
  }

  private openCareer(user: string): void {
    this.tab = 'career';
    this.user = this.ctx.account.me?.username === user ? null : user;
    this.editing = false;
    void this.loadCareer();
  }

  private render(): void {
    this.tabs.replaceChildren(...(['leaderboard', 'career'] as Tab[]).map(tab => h('button', {
      class: `rec-tab ${tab === this.tab ? 'rec-tab-on' : ''}`,
      onclick: () => this.openTab(tab),
    }, t(`records.${tab}` as TextKey))));
    if (this.tab === 'leaderboard') this.renderLeaderboard();
    else this.renderCareer();
  }

  // ---- leaderboard ---------------------------------------------------------

  private pickSeason(season: number): void {
    this.lbPeriod = { season, month: WHOLE };
    this.renderLeaderboard();
    void this.loadBoard();
  }

  private periodKey(p: { season: number | string; month: string }): string {
    return p.month === WHOLE ? String(p.season) : p.month;
  }

  private periodTitle(p: { season: number | string; month: string }): string {
    if (p.season === ALL_TIME) return t('records.allTime');
    const season = seasonLabel(Number(p.season));
    return p.month === WHOLE ? season : `${monthLabel(p.month, language())} · ${season}`;
  }

  /** The whole season first, then its months, the current one marked. */
  private monthChoices(season: number) {
    const current = periodsOf(new Date())[1];
    return [
      { value: WHOLE, label: t('records.wholeSeason') },
      ...seasonMonths(season).map(m => ({ value: m, label: `${monthLabel(m, language())}${m === current ? ` ${t('records.current')}` : ''}` })),
    ];
  }

  private seasonChoices() {
    const current = seasons()[0];
    return seasons().map(s => ({ value: s, label: `${seasonLabel(s)}${s === current ? ` ${t('records.current')}` : ''}` }));
  }

  private renderLeaderboard(): void {
    this.lbSeason.set(this.seasonChoices(), this.lbPeriod.season);
    this.lbMonth.set(this.monthChoices(this.lbPeriod.season), this.lbPeriod.month);
    const seg = (on: boolean, label: string, change: () => void) => h('button', {
      class: `seg ${on ? 'seg-on' : ''}`,
      onclick: () => {
        change();
        this.renderLeaderboard();
        void this.loadBoard();
      },
    }, label);
    const high = this.board === 'high';
    const robots = high && this.kind === 'solo'
      ? h('div', { class: 'rec-filter' },
        ht('span', { class: 'rec-label' }, 'records.robot'),
        h('div', { class: 'segs' },
          seg(this.robot === 'all', t('records.overall'), () => (this.robot = 'all')),
          ...ROBOTS.map(r => seg(this.robot === r.id, r.name, () => (this.robot = r.id)))))
      : null;
    this.body.replaceChildren(
      h('h3', { class: 'rec-period-title' }, this.periodTitle(this.lbPeriod)),
      h('div', { class: 'rec-period' }, ht('span', { class: 'rec-label' }, 'records.period'), this.lbSeason.el, this.lbMonth.el),
      h('div', { class: 'panel rec-panel' },
        h('div', { class: 'rec-panel-head' },
          h('div', { class: 'segs' },
            seg(high, t('records.highScores'), () => (this.board = 'high')),
            seg(!high, t('records.ranked'), () => (this.board = 'ranked'))),
          high ? h('div', { class: 'segs' },
            seg(this.kind === 'solo', t('games.solo'), () => (this.kind = 'solo')),
            seg(this.kind === 'duo', t('games.duo'), () => (this.kind = 'duo'))) : null),
        robots,
        h('p', { class: 'muted rec-about' }, t(high ? (this.kind === 'solo' ? 'records.aboutSolo' : 'records.aboutDuo') : 'records.aboutRanked')),
        this.boardEl),
      ...(this.ctx.account.me ? [] : [h('label', { class: 'field-label records-name' }, ht('span', {}, 'records.name'), this.nameInput)]),
    );
    this.renderBoard();
  }

  private async loadBoard(): Promise<void> {
    const id = ++this.request;
    const period = this.periodKey(this.lbPeriod);
    this.rows = null;
    this.boardError = false;
    this.renderBoard();
    try {
      const rows = this.board === 'ranked'
        ? await this.ctx.account.ranked(period)
        : await this.ctx.account.leaderboard(period, this.kind, this.kind === 'duo' ? 'all' : this.robot);
      if (id !== this.request) return;
      this.rows = rows;
    } catch {
      if (id !== this.request) return;
      this.boardError = true;
    }
    this.renderBoard();
  }

  private renderBoard(): void {
    if (this.tab !== 'leaderboard') return;
    const show = (...children: HTMLElement[]) => this.boardEl.replaceChildren(...children);
    if (this.boardError) return show(h('p', { class: 'warn' }, t('records.offline')));
    if (!this.rows) return show(h('p', { class: 'muted' }, t('records.loading')));
    const query = this.search.value.trim().toLowerCase().replace(/^@/, '');
    const me = this.ctx.account.me;
    const guest = this.ctx.name().toLowerCase();
    const ranked = this.board === 'ranked';
    const all = (this.rows as (BoardEntry | RankedEntry)[]).map((e, i) => ({ e, place: i + 1 }));
    const shown = query ? all.filter(({ e }) => e.name.toLowerCase().includes(query) || (e.username ?? '').includes(query)) : all;
    if (!shown.length) return show(h('p', { class: 'muted rec-empty' }, t(query ? 'records.noMatch' : ranked ? 'records.rankedEmpty' : 'records.empty')));
    const mine = (e: BoardEntry | RankedEntry) => {
      const user = 'id' in e ? e.id : e.user;
      return me ? user === me.id : !user && !!guest && e.name.toLowerCase() === guest;
    };
    const driver = (e: { name: string; username?: string }) => h('td', { class: 'rec-driver' },
      e.username
        ? h('button', { class: 'link', onclick: () => this.openCareer(e.username!) }, h('b', {}, e.name), h('span', { class: 'muted' }, ` @${e.username}`))
        : h('b', {}, e.name));
    const head = ranked
      ? [h('th', {}, '#'), h('th', {}, t('records.driver')), h('th', { class: 'num' }, t('records.rating')), h('th', { class: 'num' }, t('records.wlt'))]
      : [h('th', {}, '#'), h('th', {}, t('records.driver')), h('th', {}, t('records.robot')), h('th', { class: 'num' }, t('records.score')), h('th', { class: 'num rec-date' }, t('records.date'))];
    const date = (iso: string) => new Date(iso).toLocaleDateString(language());
    const rows = shown.map(({ e, place }) => {
      const cls = mine(e) ? 'records-me' : '';
      if ('rating' in e) {
        return h('tr', { class: cls }, h('td', { class: 'records-place' }, String(place)), driver(e), h('td', { class: 'num rec-score' }, String(e.rating)), h('td', { class: 'num muted' }, `${e.wins}–${e.losses}–${e.ties}`));
      }
      return h('tr', { class: cls },
        h('td', { class: 'records-place' }, String(place)),
        driver(e),
        h('td', {}, h('span', { class: 'robot-pill' }, robotLabel(e.robot))),
        h('td', { class: 'num rec-score' }, String(e.score)),
        h('td', { class: 'num muted rec-date' }, date(e.date)));
    });
    show(h('div', { class: 'rec-table-wrap' }, h('table', { class: 'records-table' }, h('tr', {}, ...head), ...rows)));
  }

  // ---- career --------------------------------------------------------------

  private careerPeriodKey(): string {
    return this.crPeriod.season === ALL_TIME ? ALL_TIME : this.periodKey(this.crPeriod);
  }

  private async loadCareer(): Promise<void> {
    const id = ++this.request;
    this.career = null;
    this.careerError = null;
    this.render();
    if (this.user === null && !this.ctx.account.me) return;
    if (this.user === null) void this.loadArchive();
    try {
      const career = await this.ctx.account.career(this.user, this.careerPeriodKey());
      if (id !== this.request) return;
      this.career = career;
    } catch (err) {
      if (id !== this.request) return;
      this.careerError = (err as { status?: number }).status === 404 ? 'missing' : 'offline';
    }
    if (this.tab === 'career') this.render();
  }

  private async loadArchive(): Promise<void> {
    this.archive = null;
    this.archiveError = '';
    try {
      this.archive = await this.ctx.account.replays();
    } catch {
      this.archive = [];
      this.archiveError = t('records.offline');
    }
    this.renderArchive();
  }

  /** The latest matches, each to watch again from any angle. */
  private renderArchive(): void {
    const list = this.archive;
    const when = (iso: string) => new Date(iso).toLocaleString(language(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const watch = async (r: ReplayInfo) => {
      if (this.archiveOpening) return;
      this.archiveOpening = r.id;
      this.archiveError = '';
      this.renderArchive();
      try {
        await this.ctx.watch(r);
      } catch {
        this.archiveError = t('archive.cantPlay');
      }
      this.archiveOpening = null;
      this.renderArchive();
    };
    const remove = async (r: ReplayInfo) => {
      if (this.archiveRemoving !== r.id) {
        this.archiveRemoving = r.id;
        return this.renderArchive();
      }
      this.archiveRemoving = null;
      try {
        await this.ctx.account.deleteReplay(r.id);
        this.archive = (this.archive ?? []).filter(x => x.id !== r.id);
      } catch {
        this.archiveError = t('records.offline');
      }
      this.renderArchive();
    };
    const rows = (list ?? []).map((r, i) => h('tr', {},
      h('td', { class: 'muted' }, when(r.date), i === 0 ? h('span', { class: 'rec-latest' }, ` ${t('archive.latest')}`) : null),
      h('td', {}, t(`games.${r.type}` as TextKey), r.ai.length ? h('span', { class: 'muted' }, ` · ${t('career.vsAi')}`) : null),
      h('td', {}, h('span', { class: `robot-pill robot-pill-${r.alliance}` }, robotLabel(r.robot))),
      h('td', { class: 'num rec-score' }, r.result ? `${r.score} – ${r.opponent}` : String(r.score)),
      h('td', {}, r.result ? h('span', { class: `result-badge result-${r.result}` }, t(`career.${r.result}` as TextKey)) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'rec-archive-actions' },
        h('button', { class: 'btn btn-small btn-primary', disabled: !!this.archiveOpening, onclick: () => void watch(r) }, this.archiveOpening === r.id ? t('records.loading') : `▶ ${t('archive.watch')}`),
        h('button', { class: `btn btn-small btn-ghost ${this.archiveRemoving === r.id ? 'warn' : ''}`, title: t('archive.remove'), onclick: () => void remove(r) }, this.archiveRemoving === r.id ? t('archive.removeSure') : '✕'))));
    this.archiveEl.replaceChildren(
      h('div', { class: 'rec-panel-head' }, ht('h4', { class: 'rec-caps' }, 'archive.title'), h('span', { class: 'muted' }, t('archive.keeps', { count: MAX_REPLAYS }))),
      this.archiveError ? h('p', { class: 'warn' }, this.archiveError) : '',
      list === null ? h('p', { class: 'muted' }, t('records.loading'))
        : !list.length ? h('div', { class: 'rec-empty' }, h('b', {}, t('archive.empty')), h('div', { class: 'muted' }, t('archive.emptyNote')))
        : h('div', { class: 'rec-table-wrap' }, h('table', { class: 'records-table' },
          h('tr', {}, h('th', {}, t('records.date')), h('th', {}, t('career.type')), h('th', {}, t('records.robot')), h('th', { class: 'num' }, t('records.score')), h('th', {}, t('career.result')), h('th', {}, '')),
          ...rows)));
  }

  private renderCareer(): void {
    const me = this.ctx.account.me;
    if (this.user === null && !me) return void this.body.replaceChildren(this.signInPanel());
    this.crSeason.set([{ value: ALL_TIME, label: t('records.allTime') }, ...this.seasonChoices().map(c => ({ value: String(c.value), label: c.label }))], this.crPeriod.season);
    const allTime = this.crPeriod.season === ALL_TIME;
    if (!allTime) this.crMonth.set(this.monthChoices(Number(this.crPeriod.season)), this.crPeriod.month);
    this.crMonth.el.hidden = allTime;
    const title = h('h3', { class: 'rec-period-title' }, this.periodTitle(this.crPeriod));
    const period = h('div', { class: 'rec-period' }, ht('span', { class: 'rec-label' }, 'records.period'), this.crSeason.el, this.crMonth.el);
    if (this.careerError) return void this.body.replaceChildren(title, period, h('p', { class: 'warn' }, t(this.careerError === 'missing' ? 'career.missing' : 'records.offline')));
    const c = this.career;
    if (!c) return void this.body.replaceChildren(title, period, h('p', { class: 'muted' }, t('records.loading')));
    const own = !!me && c.account.id === me.id;
    // A first sign-in with a service (Google…) made the account: the player picks their name and @username.
    const welcome = own && !!me.needsName;
    if (welcome && !this.editing) {
      this.editing = true;
      this.editError = '';
      this.draft = { name: me.name, username: me.username };
    }
    const s = c.stats;
    const rate = winRate(s);
    const box = (value: string, key: TextKey, sub?: string) => h('div', { class: 'stat-box stat-box-big' }, h('b', {}, value), t(key), sub ? h('small', { class: 'muted' }, sub) : null);
    this.body.replaceChildren(
      welcome ? h('div', { class: 'panel rec-panel rec-welcome' },
        ht('h3', {}, 'account.welcomeTitle'),
        ht('p', { class: 'muted' }, 'account.welcomeText'),
        this.editForm(true)) : '',
      title,
      period,
      h('div', { class: 'panel rec-panel' },
        h('div', { class: 'rec-panel-head' }, ht('h4', { class: 'rec-caps' }, 'career.overall'), this.who(c, own)),
        own && this.editing && !welcome ? this.editForm() : null,
        h('div', { class: 'stat-grid' },
          box(formatNumber(s.games), 'career.gamesPlayed', allTime ? undefined : t('career.allTime', { count: formatNumber(c.allTime.games) })),
          box(rate === null ? '—' : `${Math.round(rate * 100)}%`, 'career.winRate', `${s.wins}–${s.losses}–${s.ties}`),
          box(formatDuration(s.playtime), 'career.playtime'),
          box(s.best ? String(s.best) : '—', 'career.best'),
          c.ranked ? box(String(c.ranked.rating), 'career.rating', `${c.ranked.wins}–${c.ranked.losses}–${c.ranked.ties}`) : null),
        s.games ? null : h('p', { class: 'rec-empty' }, h('b', {}, t('career.noGames')))),
      own ? h('div', { class: 'panel rec-panel' }, this.archiveEl) : '',
      h('div', { class: 'panel rec-panel' },
        ht('h4', { class: 'rec-caps' }, 'career.history'),
        h('div', { class: 'rec-filters' }, this.typeFilter.el, this.resultFilter.el, this.showFilter.el),
        this.historyEl),
    );
    this.renderHistory();
    if (own) this.renderArchive();
  }

  /** The player's name, and what can be done: edit and sign out (own), add as a friend (someone else's). */
  private who(c: CareerResponse, own: boolean): HTMLElement {
    const actions: HTMLElement[] = [];
    if (own) {
      if (!this.editing) {
        actions.push(h('button', {
          class: 'btn btn-small btn-ghost',
          onclick: () => {
            const me = this.ctx.account.me!;
            this.editing = true;
            this.editError = '';
            this.draft = { name: me.name, username: me.username };
            this.render();
          },
        }, t('account.edit')));
      }
      actions.push(h('button', { class: 'btn btn-small btn-ghost', onclick: () => void this.ctx.account.signOut() }, t('account.signOut')));
    } else if (this.ctx.account.me) {
      actions.push(h('button', {
        class: 'btn btn-small',
        onclick: async (e: MouseEvent) => {
          const btn = e.currentTarget as HTMLButtonElement;
          try {
            const res = await this.ctx.account.requestFriend(c.account.username);
            btn.textContent = t(`friends.result.${res.result}` as TextKey, { username: c.account.username });
          } catch {
            btn.textContent = t('friends.error');
          }
          btn.disabled = true;
        },
      }, icon('friends'), t('career.addFriend')));
    }
    return h('div', { class: 'rec-who' },
      h('span', { class: 'rec-chip' }, h('b', {}, c.account.name), h('span', { class: 'muted' }, ` @${c.account.username}`)),
      ...actions);
  }

  /** The name and @username fields; `welcome`: finishing a sign-up, with one button. */
  private editForm(welcome = false): HTMLElement {
    const name = h('input', { class: 'field', maxlength: '16', value: this.draft.name });
    const username = h('input', { class: 'field', maxlength: '21', value: this.draft.username, spellcheck: 'false', autocapitalize: 'off' });
    name.addEventListener('input', () => (this.draft.name = name.value));
    username.addEventListener('input', () => (this.draft.username = username.value));
    const save = async () => {
      try {
        await this.ctx.account.update({ name: name.value, username: username.value.trim().replace(/^@/, '').toLowerCase() });
        this.editing = false;
        void this.loadCareer();
      } catch (err) {
        this.editError = t((err as { status?: number }).status === 409 ? 'account.taken' : 'account.invalid');
        this.render();
      }
    };
    return h('div', { class: 'rec-edit' },
      h('label', { class: 'field-label' }, ht('span', {}, 'account.name'), name),
      h('label', { class: 'field-label' }, ht('span', {}, 'account.username'), username),
      this.editError ? h('p', { class: 'warn' }, this.editError) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-small btn-primary', onclick: save }, t(welcome ? 'account.welcomeDone' : 'account.save')),
        welcome ? null : h('button', {
          class: 'btn btn-small btn-ghost',
          onclick: () => {
            this.editing = false;
            this.render();
          },
        }, t('friends.cancel'))));
  }

  private signInPanel(): HTMLElement {
    const p = this.providers;
    // The services sign in through a page of theirs: the website opens it, the desktop app opens the
    // player's browser for it (an older app can't).
    const desktop = !canSignIn();
    const buttons: HTMLElement[] = [];
    if (!desktop && p?.google) buttons.push(h('button', { class: 'btn btn-primary btn-google', onclick: () => this.ctx.signIn('google') }, icon('google'), t('account.signInGoogle')));
    if (!desktop && p?.steam) buttons.push(h('button', { class: 'btn btn-primary', onclick: () => this.ctx.signIn('steam') }, t('account.signInSteam')));
    if (!desktop && p?.dev) buttons.push(h('button', { class: 'btn', onclick: () => this.ctx.signIn('dev') }, t('account.signInDev')));
    const note = p?.email ? null : desktop ? 'account.signInDesktop' : p && !buttons.length ? 'account.signInOff' : null;

    return h('div', { class: 'panel rec-panel rec-signin' },
      ht('h3', {}, 'account.title'),
      ht('p', { class: 'muted' }, 'account.why'),
      !p ? h('p', { class: 'muted' }, t('records.loading')) : null,
      buttons.length ? h('div', { class: 'row' }, ...buttons) : null,
      buttons.length && signInInBrowser() ? ht('p', { class: 'muted' }, 'account.signInBrowser') : null,
      p?.email ? this.emailForm(buttons.length > 0) : null,
      note ? h('p', { class: 'warn' }, t(note)) : null);
  }

  /** Signing in or up with an e-mail and a password. */
  private emailForm(afterButtons: boolean): HTMLElement {
    const d = this.emailDraft;
    const register = this.emailMode === 'register';
    const field = (key: keyof typeof d, label: TextKey, attrs: Record<string, string>) => {
      const input = h('input', { class: 'field', value: d[key], spellcheck: 'false', autocapitalize: 'off', ...attrs });
      input.addEventListener('input', () => (d[key] = input.value));
      input.addEventListener('keydown', e => e.key === 'Enter' && void submit());
      return h('label', { class: 'field-label' }, ht('span', {}, label), input);
    };
    const submit = async () => {
      if (this.emailBusy) return;
      this.emailBusy = true;
      const fields = { email: d.email.trim(), password: d.password, ...(register && { name: d.name.trim() }) };
      const error = await this.ctx.account.emailSignIn(this.emailMode, fields);
      this.emailBusy = false;
      // Signed in: the account's change draws the career instead.
      if (!error) {
        this.emailDraft = { email: '', password: '', name: '' };
        this.emailError = '';
        return;
      }
      const known = ['badEmail', 'shortPassword', 'noName', 'emailTaken', 'wrongPassword', 'tooMany'];
      this.emailError = t(`account.error.${known.includes(error) ? error : 'failed'}` as TextKey);
      if (error === 'emailTaken') this.emailMode = 'login';
      this.render();
    };
    const toggle = () => {
      this.emailMode = register ? 'login' : 'register';
      this.emailError = '';
      this.render();
    };
    return h('div', { class: 'rec-email' },
      afterButtons ? ht('p', { class: 'rec-or muted' }, 'account.orEmail') : null,
      field('email', 'account.email', { type: 'email', autocomplete: 'email', maxlength: '254', placeholder: 'name@mail.com' }),
      field('password', 'account.password', { type: 'password', autocomplete: register ? 'new-password' : 'current-password', maxlength: '128' }),
      register ? field('name', 'account.name', { maxlength: '16', autocomplete: 'nickname', placeholder: t('common.namePlaceholder') }) : null,
      this.emailError ? h('p', { class: 'warn' }, this.emailError) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => void submit() }, t(register ? 'account.register' : 'account.login')),
        h('button', { class: 'btn btn-ghost btn-small', onclick: toggle }, t(register ? 'account.toLogin' : 'account.toRegister'))));
  }

  private typeChoices() {
    return [{ value: 'all' as const, label: t('career.allTypes') }, ...GAME_TYPES.map(type => ({ value: type, label: t(`games.${type}` as TextKey) }))];
  }

  private resultChoices() {
    return [{ value: 'any' as const, label: t('career.anyResult') }, ...(['win', 'loss', 'tie'] as MatchResult[]).map(r => ({ value: r, label: t(`career.${r}` as TextKey) }))];
  }

  private showChoices() {
    return SHOW.map(n => ({ value: n, label: t('career.show', { count: n }) }));
  }

  private renderHistory(): void {
    const c = this.career;
    if (!c) return;
    const type = this.typeFilter.value;
    const result = this.resultFilter.value;
    const list = c.history.filter(e => (type === 'all' || e.type === type) && (result === 'any' || e.result === result)).slice(0, this.showFilter.value);
    if (!list.length) {
      this.historyEl.replaceChildren(h('div', { class: 'rec-empty' }, h('b', {}, t('career.noMatches')), h('div', { class: 'muted' }, t('career.nothingFor', { period: this.periodTitle(this.crPeriod) }))));
      return;
    }
    const when = (iso: string) => new Date(iso).toLocaleString(language(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const score = (e: HistoryEntry) => (e.score === null ? '—' : e.opponent === null ? String(e.score) : `${e.score} – ${e.opponent}`);
    const result$ = (e: HistoryEntry) => h('td', {},
      e.result ? h('span', { class: `result-badge result-${e.result}` }, t(`career.${e.result}` as TextKey)) : h('span', { class: 'muted' }, '—'),
      e.rating !== undefined ? h('span', { class: `rec-rating ${e.rating >= 0 ? 'up' : 'down'}` }, ` ${e.rating >= 0 ? '+' : ''}${e.rating}`) : null);
    this.historyEl.replaceChildren(h('div', { class: 'rec-table-wrap' }, h('table', { class: 'records-table' },
      h('tr', {}, h('th', {}, t('records.date')), h('th', {}, t('career.type')), h('th', {}, t('records.robot')), h('th', { class: 'num' }, t('records.score')), h('th', {}, t('career.result')), h('th', { class: 'num rec-date' }, t('career.time'))),
      ...list.map(e => h('tr', {},
        h('td', { class: 'muted' }, when(e.date)),
        h('td', {}, t(`games.${e.type}` as TextKey), e.ai ? h('span', { class: 'muted' }, ` · ${t('career.vsAi')}`) : null),
        h('td', {}, h('span', { class: `robot-pill robot-pill-${e.alliance}` }, robotLabel(e.robot))),
        h('td', { class: 'num rec-score' }, score(e)),
        result$(e),
        h('td', { class: 'num muted rec-date' }, formatDuration(e.duration)))))));
  }
}
