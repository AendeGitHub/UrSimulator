// The small WebSocket every open game keeps to the server (server/Presence.ts): the online count
// for the main menu, and a nudge when something about this player's friends changed.

import type { OnlineCount, PresenceClientMessage, PresenceServerMessage } from './accountProtocol';
import { lobbyUrl } from './LobbyClient';

export interface PresenceEvents {
  online(count: OnlineCount): void;
  friends(): void;
}

/** Waits between tries to reconnect, s: the server may be restarting or asleep. */
const RETRY = [3, 10, 30, 60];

export class PresenceClient {
  private ws: WebSocket | null = null;
  private tries = 0;

  constructor(private readonly device: string, private token: string | null, private readonly events: PresenceEvents, private readonly url = lobbyUrl().replace(/\/ws$/, '/presence')) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.hello();
    };
    ws.onmessage = e => {
      let msg: PresenceServerMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.t === 'online') this.events.online({ online: msg.online, signedIn: msg.signedIn });
      else if (msg.t === 'friends') this.events.friends();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      setTimeout(() => this.ws === ws && this.connect(), RETRY[Math.min(this.tries++, RETRY.length - 1)] * 1000);
    };
  }

  private hello(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'hello', device: this.device, token: this.token } satisfies PresenceClientMessage));
  }

  /** Signed in or out: the server counts this browser again. */
  setToken(token: string | null): void {
    this.token = token;
    this.hello();
  }
}
