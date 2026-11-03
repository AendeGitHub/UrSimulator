// A player's side of an online room: the lobby connection, and a direct link to every other
// player for the admin (to the admin for everyone else). Game data from any link comes out of
// `data`, whichever way it travelled.

import { LobbyClient, type LobbyHello } from './LobbyClient';
import type { LobbyError, RoomInfo, RoomSummary } from './lobbyProtocol';
import { PeerLink, type LinkState } from './peer';

export interface OnlineEvents {
  rooms(list: RoomSummary[]): void;
  room(room: RoomInfo | null): void;
  error(code: LobbyError): void;
  quick(searching: boolean): void;
  closed(): void;
  /** A link became direct or fell back to the server */
  links(): void;
  data(from: number, data: Uint8Array): void;
}

export class OnlineRoom {
  readonly lobby: LobbyClient;
  private readonly links = new Map<number, PeerLink>();

  constructor(hello: LobbyHello, private readonly events: OnlineEvents) {
    this.lobby = new LobbyClient(hello, {
      rooms: list => events.rooms(list),
      room: room => {
        this.syncLinks(room);
        events.room(room);
      },
      error: code => events.error(code),
      quick: searching => events.quick(searching),
      closed: () => events.closed(),
      signal: (from, data) => this.link(from, false)?.receiveSignal(data as never),
      relay: (from, payload) => events.data(from, payload),
    });
  }

  get room(): RoomInfo | null {
    return this.lobby.room;
  }

  get myId(): number {
    return this.lobby.myId;
  }

  get isAdmin(): boolean {
    return this.lobby.isAdmin;
  }

  /** How this player reaches another one: null for themselves or someone not linked. */
  linkState(id: number): LinkState | null {
    return this.links.get(id)?.state ?? null;
  }

  send(to: number, data: Uint8Array, fast: boolean): void {
    const link = this.links.get(to);
    if (link) link.send(data, fast);
    else this.lobby.relay(to, data, fast);
  }

  /** The admin links to everyone; the others only to the admin, who starts each connection. */
  private syncLinks(room: RoomInfo | null): void {
    const me = this.lobby.myId;
    const wanted = new Set<number>();
    if (room) {
      if (room.adminId === me) for (const m of room.members) m.id !== me && wanted.add(m.id);
      else wanted.add(room.adminId);
    }
    for (const [id, link] of this.links) {
      if (wanted.has(id)) continue;
      link.close();
      this.links.delete(id);
    }
    for (const id of wanted) this.link(id, room!.adminId === me);
  }

  private link(id: number, initiator: boolean): PeerLink | null {
    let link = this.links.get(id);
    if (link) return link;
    const room = this.lobby.room;
    // Only players in the same room, and only the admin starts a connection to someone else.
    if (!room?.members.some(m => m.id === id)) return null;
    if (!initiator && room.adminId !== id) return null;
    link = new PeerLink(this.lobby, id, initiator);
    link.onMessage = data => this.events.data(id, data);
    link.onState = () => this.events.links();
    this.links.set(id, link);
    return link;
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.lobby.close();
  }
}
