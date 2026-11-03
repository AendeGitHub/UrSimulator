// The browser's connection to the lobby server (server/Lobby.ts): the room list, the room the
// player is in, WebRTC signaling and, without a direct connection, game data relayed through it.

import { defaultServerUrl } from './records';
import { RELAY, type ClientMessage, type LobbyError, type RoomInfo, type RoomSummary, type ServerMessage } from './lobbyProtocol';

export interface LobbyEvents {
  rooms(list: RoomSummary[]): void;
  room(room: RoomInfo | null): void;
  error(code: LobbyError): void;
  /** Quick play started or stopped looking for a room */
  quick(searching: boolean): void;
  /** The connection to the server failed or closed */
  closed(): void;
  signal(from: number, data: unknown): void;
  relay(from: number, payload: Uint8Array): void;
}

/** The lobby's WebSocket next to the game (the high score server's address with /ws). */
export function lobbyUrl(server = defaultServerUrl()): string {
  const url = new URL(server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

export type LobbyHello = Omit<Extract<ClientMessage, { t: 'hello' }>, 't'>;

/** Relayed game data waits while the socket has this much unsent, bytes. */
const RELAY_BACKLOG = 64 * 1024;

export class LobbyClient {
  myId = -1;
  room: RoomInfo | null = null;
  rooms: RoomSummary[] = [];
  private readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private closed = false;

  /** `hello`: the player's name, and for the statistics this browser and the signed-in player's session. */
  constructor(hello: LobbyHello, private readonly events: LobbyEvents, url = lobbyUrl()) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ t: 'hello', ...hello } satisfies ClientMessage));
      for (const m of this.queue.splice(0)) this.ws.send(m);
    };
    this.ws.onmessage = e => this.receive(e.data as string | ArrayBuffer);
    this.ws.onclose = () => {
      if (!this.closed) events.closed();
      this.closed = true;
    };
  }

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get isAdmin(): boolean {
    return this.room?.adminId === this.myId;
  }

  send(msg: ClientMessage): void {
    const text = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(text);
  }

  /** Game data for another player through the server. `droppable` data waits for nothing. */
  relay(to: number, payload: Uint8Array, droppable: boolean): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (droppable && this.ws.bufferedAmount > RELAY_BACKLOG) return;
    const frame = new Uint8Array(RELAY.header + payload.length);
    frame[0] = droppable ? 1 : 2;
    frame[1] = to & 0xff;
    frame[2] = to >> 8;
    frame.set(payload, RELAY.header);
    this.ws.send(frame);
  }

  private receive(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes.length > RELAY.header) this.events.relay(bytes[1] | (bytes[2] << 8), bytes.subarray(RELAY.header));
      return;
    }
    const msg = JSON.parse(data) as ServerMessage;
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        break;
      case 'rooms':
        this.rooms = msg.rooms;
        this.events.rooms(msg.rooms);
        break;
      case 'room':
        this.room = msg.room;
        this.events.room(msg.room);
        break;
      case 'error':
        this.events.error(msg.code);
        break;
      case 'quick':
        this.events.quick(msg.searching);
        break;
      case 'signal':
        this.events.signal(msg.from, msg.data);
        break;
    }
  }

  close(): void {
    this.closed = true;
    this.send({ t: 'leave' });
    this.ws.close();
  }
}
