// A direct connection between the room admin and one other player (WebRTC data channels), so the
// game data does not wait for the server. "fast" is unordered and never resent: a lost snapshot or
// input is simply replaced by the next one, so nothing stalls. "sure" carries what must arrive
// (the final score). Until the direct connection is up, or when it can't be made (some mobile
// networks), the same messages go through the lobby server instead.

import type { LobbyClient } from './LobbyClient';

export type LinkState = 'connecting' | 'direct' | 'relay';

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/** Without a direct connection by then, the link says it goes through the server, ms */
const DIRECT_TIMEOUT = 8000;
/** Snapshots wait for nothing: skipped while this much is still unsent, bytes */
const FAST_BACKLOG = 64 * 1024;
/** `?relay` in the address sends everything through the server (to check that path). */
const CAN_CONNECT = typeof RTCPeerConnection !== 'undefined' && !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay'));

type Signal = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export class PeerLink {
  state: LinkState = 'connecting';
  onMessage: (data: Uint8Array) => void = () => {};
  onState: (state: LinkState) => void = () => {};
  private pc: RTCPeerConnection | null = null;
  private fast: RTCDataChannel | null = null;
  private sure: RTCDataChannel | null = null;
  private readonly pending: RTCIceCandidateInit[] = [];
  private readonly timer: ReturnType<typeof setTimeout>;

  /** The admin starts the connection (`initiator`); the other player answers. */
  constructor(private readonly lobby: LobbyClient, readonly peerId: number, initiator: boolean) {
    this.timer = setTimeout(() => this.state === 'connecting' && this.setState('relay'), DIRECT_TIMEOUT);
    if (!CAN_CONNECT) return;
    if (initiator) {
      const pc = this.open();
      this.attach(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      this.attach(pc.createDataChannel('sure', { ordered: true }));
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => this.signal({ sdp: pc.localDescription!.toJSON() }))
        .catch(() => this.setState('relay'));
    }
  }

  private open(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onicecandidate = e => e.candidate && this.signal({ candidate: e.candidate.toJSON() });
    pc.ondatachannel = e => this.attach(e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.setState('relay');
    };
    return pc;
  }

  private attach(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'fast') this.fast = channel;
    else this.sure = channel;
    channel.onmessage = e => this.onMessage(new Uint8Array(e.data as ArrayBuffer));
    channel.onopen = () => {
      if (this.fast?.readyState === 'open' && this.sure?.readyState === 'open') this.setState('direct');
    };
    channel.onclose = () => this.state === 'direct' && this.setState('relay');
  }

  private signal(data: Signal): void {
    this.lobby.send({ t: 'signal', to: this.peerId, data });
  }

  /** An offer, answer or ICE candidate from the other player (through the lobby). */
  async receiveSignal(data: Signal): Promise<void> {
    if (!CAN_CONNECT) return;
    try {
      if (data.sdp) {
        const pc = this.pc ?? this.open();
        await pc.setRemoteDescription(data.sdp);
        for (const c of this.pending.splice(0)) await pc.addIceCandidate(c);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal({ sdp: pc.localDescription!.toJSON() });
        }
      } else if (data.candidate) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.candidate);
        else this.pending.push(data.candidate);
      }
    } catch {
      this.setState('relay');
    }
  }

  /** Data relayed through the server from this player. */
  receiveRelay(data: Uint8Array): void {
    this.onMessage(data);
  }

  /** `fast`: may be lost or arrive out of order, never waits. Otherwise it always arrives. */
  send(data: Uint8Array, fast: boolean): void {
    const channel = fast ? this.fast : this.sure;
    if (this.state === 'direct' && channel?.readyState === 'open') {
      if (fast && channel.bufferedAmount > FAST_BACKLOG) return;
      channel.send(data);
      return;
    }
    this.lobby.relay(this.peerId, data, fast);
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  close(): void {
    clearTimeout(this.timer);
    this.pc?.close();
    this.pc = null;
  }
}
