// Shared types for the simulation and the game.

import type { Alliance } from '../robot/robotConfig';

/** Driver station positions; "1" stages closest to the audience (manual 10.3.2). */
export type Slot = 'red1' | 'red2' | 'blue1' | 'blue2';
export const SLOTS: Slot[] = ['red1', 'red2', 'blue1', 'blue2'];

export const slotAlliance = (slot: Slot): Alliance => (slot.startsWith('red') ? 'red' : 'blue');

export const SLOT_NAMES: Record<Slot, string> = { red1: 'Red 1', red2: 'Red 2', blue1: 'Blue 1', blue2: 'Blue 2' };

/** What a driver sends for their robot every frame. */
export interface RobotInput {
  /** Raw gamepad1 sticks, FTC convention (up = -1) */
  lx: number;
  ly: number;
  rx: number;
  fieldCentric: boolean;
  slow: boolean;
  intake: boolean;
  eject: boolean;
  transfer: boolean;
  /** One-shot presses; kept until the next physics step uses them */
  shooterOn: boolean;
  shooterOff: boolean;
  imuReset: boolean;
  /** Raise / lower a robot's front arm (Bumble V) */
  armUp: boolean;
  armDown: boolean;
}

export const idleInput = (): RobotInput => ({
  lx: 0, ly: 0, rx: 0, fieldCentric: true, slow: false,
  intake: false, eject: false, transfer: false, shooterOn: false, shooterOff: false, imuReset: false,
  armUp: false, armDown: false,
});

/** Applies a newer input, keeping one-shot presses that have not been used yet. */
export function mergeInput(current: RobotInput, next: RobotInput): RobotInput {
  return {
    ...next,
    shooterOn: current.shooterOn || next.shooterOn,
    shooterOff: current.shooterOff || next.shooterOff,
    imuReset: current.imuReset || next.imuReset,
    armUp: current.armUp || next.armUp,
    armDown: current.armDown || next.armDown,
  };
}

export type GameMode = 'practice' | 'match';
