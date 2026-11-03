// Friends, in a panel at the right edge of the main menu: add a player by @username, answer
// requests, see who is online and join the room a friend is in.

import type { AccountClient } from '../net/account';
import type { FriendInfo, FriendRequestResult, FriendsResponse, Me, PublicAccount } from '../net/accountProtocol';
import { FORMAT_SLOTS } from '../net/lobbyProtocol';
import { h } from './dom';
import { t, type TextKey } from './i18n';
import { icon } from './icons';

export interface FriendsActions {
  signIn(): void;
  /** Into the online room a friend is in */
  join(room: string): void;
  /** A friend's career */
  profile(username: string): void;
}

/** A friend's list refreshes this often while the panel is open (rooms change without a nudge), ms */
const REFRESH_MS = 15_000;

export class FriendsPanel {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'friends-body' });
  private readonly status = h('p', { class: 'muted friends-status' });
  private readonly input: HTMLInputElement;
  private me: Me | null = null;
  private data: FriendsResponse | null = null;
  /** The friend whose Remove was pressed once (pressing again removes) */
  private removing: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Called with the number of requests waiting, whenever it may have changed */
  onRequests: (count: number) => void = () => {};

  constructor(private readonly account: AccountClient, private readonly actions: FriendsActions) {
    this.input = h('input', { class: 'field', maxlength: '21', placeholder: '@username', spellcheck: 'false', autocapitalize: 'off' });
    this.input.addEventListener('keydown', e => e.key === 'Enter' && this.add());
    this.el = h('aside', { class: 'friends-panel' },
      h('div', { class: 'friends-head' },
        h('h3', {}, icon('friends'), h('span', { 'data-t': 'friends.title' }, t('friends.title'))),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.close() }, icon('close'))),
      this.body);
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    this.render();
    void this.refresh();
    if (!this.timer) this.timer = setInterval(() => this.isOpen && this.refresh(), REFRESH_MS);
  }

  close(): void {
    this.el.hidden = true;
    this.removing = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setAccount(me: Me | null): void {
    if (me?.id !== this.me?.id) this.data = null;
    this.me = me;
    if (me) void this.refresh();
    else this.onRequests(0);
    if (this.isOpen) this.render();
  }

  /** Fetches the lists again (on open, on a nudge from the server, now and then while open). */
  async refresh(): Promise<void> {
    if (!this.me) return;
    try {
      this.show(await this.account.friends());
    } catch {
      if (this.isOpen && !this.data) this.setStatus(t('friends.error'));
    }
  }

  private show(data: FriendsResponse): void {
    this.data = data;
    this.onRequests(data.incoming.length);
    if (this.isOpen) this.render();
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private async add(): Promise<void> {
    const username = this.input.value.trim().replace(/^@/, '').toLowerCase();
    if (!username) return;
    try {
      const res = await this.account.requestFriend(username);
      this.input.value = res.result === 'sent' || res.result === 'accepted' ? '' : this.input.value;
      this.setStatus(t(`friends.result.${res.result satisfies FriendRequestResult}` as TextKey, { username }));
      this.show(res);
    } catch {
      this.setStatus(t('friends.error'));
    }
  }

  private async act(run: () => Promise<FriendsResponse>): Promise<void> {
    this.removing = null;
    try {
      this.show(await run());
    } catch {
      this.setStatus(t('friends.error'));
    }
  }

  private render(): void {
    if (!this.me) {
      this.body.replaceChildren(
        h('p', { class: 'muted' }, t('friends.signIn')),
        h('button', { class: 'btn btn-primary', onclick: () => this.actions.signIn() }, icon('google'), t('menu.signIn')));
      return;
    }
    const d = this.data;
    const who = (a: PublicAccount) => h('span', { class: 'friend-who' }, h('b', {}, a.name), h('span', { class: 'muted' }, ` @${a.username}`));
    const section = (key: TextKey, rows: HTMLElement[]) => (rows.length ? [h('h4', {}, t(key)), ...rows] : []);
    const incoming = (d?.incoming ?? []).map(a => h('div', { class: 'friend-row' }, who(a),
      h('span', { class: 'friend-actions' },
        h('button', { class: 'btn btn-small btn-primary', onclick: () => this.act(() => this.account.acceptFriend(a.id)) }, t('friends.accept')),
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => this.act(() => this.account.removeFriend(a.id)) }, t('friends.decline')))));
    const friends = (d?.friends ?? []).map(f => this.friendRow(f, who));
    const outgoing = (d?.outgoing ?? []).map(a => h('div', { class: 'friend-row' }, who(a),
      h('span', { class: 'friend-actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => this.act(() => this.account.removeFriend(a.id)) }, t('friends.cancel')))));
    this.body.replaceChildren(
      h('p', { class: 'muted friends-me' }, t('friends.you', { username: this.me.username })),
      h('div', { class: 'friends-add' }, this.input, h('button', { class: 'btn btn-small btn-primary', onclick: () => this.add() }, t('friends.add'))),
      this.status,
      ...section('friends.requests', incoming),
      h('h4', {}, t('friends.list')),
      ...(friends.length ? friends : [h('p', { class: 'muted' }, d ? t('friends.none') : t('records.loading'))]),
      ...section('friends.sent', outgoing),
    );
  }

  private friendRow(f: FriendInfo, who: (a: PublicAccount) => HTMLElement): HTMLElement {
    const room = f.room;
    const joinable = room && !room.running && !room.locked && room.players < FORMAT_SLOTS[room.format].length;
    const format = room ? t(`online.${room.format}` as TextKey) : '';
    const state = !f.online
      ? t('friends.offline')
      : room
        ? t(room.running ? 'friends.playing' : 'friends.inRoom', { format, players: `${room.players}/${FORMAT_SLOTS[room.format].length}` })
        : t('friends.online');
    const sure = this.removing === f.id;
    return h('div', { class: 'friend-row' },
      h('span', { class: `dot ${f.online ? 'dot-on' : 'dot-off'}` }),
      h('span', { class: 'friend-main' }, who(f), h('span', { class: 'friend-state muted' }, state)),
      h('span', { class: 'friend-actions' },
        joinable ? h('button', { class: 'btn btn-small btn-primary', onclick: () => this.actions.join(room.id) }, t('friends.join')) : null,
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => this.actions.profile(f.username) }, t('friends.profile')),
        h('button', {
          class: `btn btn-small btn-ghost ${sure ? 'friend-remove-sure' : ''}`,
          onclick: () => {
            if (!sure) {
              this.removing = f.id;
              return this.render();
            }
            void this.act(() => this.account.removeFriend(f.id));
          },
        }, t(sure ? 'friends.removeSure' : 'friends.remove'))));
  }
}
