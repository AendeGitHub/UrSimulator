// Online play: lobby actions, sending the driver's input and drawing server snapshots.

import type { Session, SessionEvents } from '../game/Session';
import { decodeState, type WorldState } from '../sim/state';
import type { GameMode, RobotInput, Slot } from '../sim/types';
import { SnapshotBuffer } from './interpolate';
import type { RuleOptions } from '../sim/Referee';
import { DEFAULT_PORT, type ClientMessage, type RoomInfo, type ServerMessage } from './protocol';

export interface NetEvents extends SessionEvents {
  room(room: RoomInfo | null): void;
  error(message: string): void;
  closed(): void;
}

/** Where the game server is: ?server=… in the address, the Vite dev setup, or the page's own host. */
/** The public game server; the desktop app (loaded from app://) plays online here. */
export const PUBLIC_SERVER_URL = 'wss://ursim.onrender.com/ws';

export function defaultServerUrl(): string {
  const param = new URLSearchParams(location.search).get('server');
  if (param) return param;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return PUBLIC_SERVER_URL;
  if (import.meta.env.DEV) return `ws://${location.hostname || 'localhost'}:${DEFAULT_PORT}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

const now = () => performance.now() / 1000;
const INPUT_INTERVAL = 1 / 60;

export class NetSession implements Session {
  readonly online = true;
  myId = -1;
  room: RoomInfo | null = null;
  private readonly ws: WebSocket;
  private readonly queue: ClientMessage[] = [];
  private readonly buffer = new SnapshotBuffer();
  private pendingInput: RobotInput | null = null;
  private inputTimer = 0;

  constructor(url: string, name: string, robot: string, private readonly events: NetEvents) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ t: 'hello', name, robot } satisfies ClientMessage));
      for (const m of this.queue.splice(0)) this.ws.send(JSON.stringify(m));
    };
    this.ws.onmessage = e => this.receive(e.data);
    this.ws.onerror = () => events.error('Не удалось подключиться к серверу');
    this.ws.onclose = () => events.closed();
  }

  private send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(msg);
  }

  private receive(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.buffer.push(decodeState(data), now());
      return;
    }
    const msg = JSON.parse(data) as ServerMessage;
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        break;
      case 'room':
        if (!msg.room?.running) this.buffer.clear();
        this.room = msg.room;
        this.events.room(msg.room);
        break;
      case 'error':
        this.events.error(msg.message);
        break;
      case 'toast':
        this.events.toast(msg.text);
        break;
      case 'finished':
        this.events.finished(msg.score);
        break;
    }
  }

  get isHost(): boolean {
    return this.room?.hostId === this.myId;
  }

  get localSlot(): Slot | null {
    return this.room?.players.find(p => p.id === this.myId)?.slot ?? null;
  }

  create(): void {
    this.send({ t: 'create' });
  }

  join(code: string): void {
    this.send({ t: 'join', code });
  }

  takeSlot(slot: Slot | null): void {
    this.send({ t: 'slot', slot });
  }

  /** Host only: starts the game with the host's house rules. */
  start(mode: GameMode, rules: RuleOptions): void {
    this.send({ t: 'start', mode, rules });
  }

  stop(): void {
    this.send({ t: 'stop' });
  }

  update(dt: number, input: RobotInput | null): void {
    if (!input || !this.room?.running || !this.localSlot) return;
    // Keep one-shot presses until they are sent.
    this.pendingInput = this.pendingInput
      ? { ...input, shooterOn: this.pendingInput.shooterOn || input.shooterOn, shooterOff: this.pendingInput.shooterOff || input.shooterOff, imuReset: this.pendingInput.imuReset || input.imuReset }
      : input;
    this.inputTimer -= dt;
    if (this.inputTimer > 0) return;
    this.inputTimer = INPUT_INTERVAL;
    this.send({ t: 'input', input: this.pendingInput });
    this.pendingInput = null;
  }

  state(): WorldState | null {
    return this.buffer.sample(now());
  }

  names(): Partial<Record<Slot, string>> {
    const out: Partial<Record<Slot, string>> = {};
    for (const p of this.room?.players ?? []) if (p.slot) out[p.slot] = p.name;
    return out;
  }

  dispose(): void {
    this.ws.onclose = null;
    this.send({ t: 'leave' });
    this.ws.close();
  }
}
