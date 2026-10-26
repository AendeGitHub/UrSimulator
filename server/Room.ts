// One online room: up to 4 players in slots Red 1/2 and Blue 1/2, and its simulation.

import type { FieldLayout } from '../src/field/layout';
import { CODE_LETTERS, MAX_PLAYERS, cleanName, type RoomInfo, type ServerMessage } from '../src/net/protocol';
import type { ColliderPart } from '../src/sim/colliders';
import { PHYSICS_DT, Simulation } from '../src/sim/Simulation';
import { encodeState } from '../src/sim/state';
import { SLOTS, type GameMode, type RobotInput, type Slot } from '../src/sim/types';

/** What a room needs from a connection (a WebSocket in production, a fake in tests). */
export interface Peer {
  sendText(msg: ServerMessage): void;
  sendBinary(data: ArrayBuffer): void;
}

interface Player {
  id: number;
  name: string;
  robot: string;
  slot: Slot | null;
  peer: Peer;
}

const MAX_STEPS_PER_TICK = 12;

export function randomCode(taken: (code: string) => boolean): string {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
    if (!taken(code)) return code;
  }
}

export class Room {
  private readonly players = new Map<number, Player>();
  private hostId = -1;
  private sim: Simulation | null = null;
  private running: GameMode | null = null;
  private accumulator = 0;
  private snapshotTimer = 0;

  constructor(readonly code: string, private readonly layout: FieldLayout, private readonly colliders: ColliderPart[], private readonly snapshotInterval: number) {}

  get size(): number {
    return this.players.size;
  }

  info(): RoomInfo {
    return {
      code: this.code,
      hostId: this.hostId,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, robot: p.robot, slot: p.slot })),
      running: this.running,
    };
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.players.values()) p.peer.sendText(msg);
  }

  private broadcastRoom(): void {
    this.broadcast({ t: 'room', room: this.info() });
  }

  /** Adds a player in the first free slot. Returns false when the room is full. */
  join(id: number, name: string, robot: string, peer: Peer): boolean {
    if (this.players.size >= MAX_PLAYERS) return false;
    const used = new Set([...this.players.values()].map(p => p.slot));
    // Alternate alliances as people join: Red 1, Blue 1, Red 2, Blue 2.
    const slot = (['red1', 'blue1', 'red2', 'blue2'] as Slot[]).find(s => !used.has(s)) ?? null;
    this.players.set(id, { id, name: cleanName(name), robot, slot, peer });
    if (this.hostId < 0) this.hostId = id;
    if (this.running === 'practice' && slot) this.sim?.addRobot(slot, cleanName(name), robot);
    this.broadcastRoom();
    return true;
  }

  leave(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.slot) this.sim?.removeRobot(p.slot);
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? -1;
    if (!this.players.size) this.running = null;
    this.broadcastRoom();
  }

  setSlot(id: number, slot: Slot | null): void {
    const p = this.players.get(id);
    if (!p || p.slot === slot) return;
    if (slot && [...this.players.values()].some(o => o.slot === slot)) return p.peer.sendText({ t: 'error', message: 'Это место уже занято' });
    if (this.running === 'match') return p.peer.sendText({ t: 'error', message: 'Во время матча меняться нельзя' });
    if (p.slot) this.sim?.removeRobot(p.slot);
    p.slot = slot;
    if (this.running === 'practice' && slot) this.sim?.addRobot(slot, p.name, p.robot);
    this.broadcastRoom();
  }

  start(id: number, mode: GameMode): void {
    const p = this.players.get(id);
    if (!p) return;
    if (id !== this.hostId) return p.peer.sendText({ t: 'error', message: 'Начать может только хост комнаты' });
    this.sim ??= new Simulation(this.layout, this.colliders, {
      toast: text => this.broadcast({ t: 'toast', text }),
      finished: () => this.finish(),
    });
    for (const slot of SLOTS) this.sim.removeRobot(slot);
    for (const pl of this.players.values()) if (pl.slot) this.sim.addRobot(pl.slot, pl.name, pl.robot);
    this.sim.start(mode);
    this.running = mode;
    this.accumulator = 0;
    this.snapshotTimer = 0;
    this.broadcastRoom();
  }

  /** Host sends everyone back to the lobby. */
  stop(id: number): void {
    if (id !== this.hostId || !this.running) return;
    this.running = null;
    this.broadcastRoom();
  }

  private finish(): void {
    if (!this.sim) return;
    this.broadcast({ t: 'finished', score: structuredClone(this.sim.match.score) });
    this.running = null;
    this.broadcastRoom();
  }

  input(id: number, input: RobotInput): void {
    const p = this.players.get(id);
    if (p?.slot && this.running) this.sim?.setInput(p.slot, input);
  }

  /** Advances the simulation by real elapsed time and sends snapshots. */
  tick(dt: number): void {
    if (!this.running || !this.sim) return;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_TICK && this.running) {
      this.sim.step();
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_TICK) this.accumulator = 0;
    this.snapshotTimer -= dt;
    if (this.snapshotTimer <= 0 && this.running) {
      this.snapshotTimer += this.snapshotInterval;
      const data = encodeState(this.sim.state());
      for (const p of this.players.values()) p.peer.sendBinary(data);
    }
  }

  dispose(): void {
    this.sim?.world.free();
  }
}
