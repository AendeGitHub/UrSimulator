import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { Session } from '../src/game/Session';
import { parseColliders } from '../src/sim/colliders';
import { DEFAULT_RULES } from '../src/sim/Referee';
import { initPhysics } from '../src/sim/Simulation';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);

describe('game session frame rate', () => {
  beforeAll(() => initPhysics());

  /** URAN V2 driving forward flat out for 0.8 s at `fps` frames a second: where each frame draws it. */
  const drive = (fps: number) => {
    const session = new Session(layout, colliders, [{ slot: 'red1', robot: 'uran-v2' }], [], 'practice', DEFAULT_RULES, { toast: () => {}, finished: () => {} });
    // On open floor along the red wall, facing down the field.
    session.simulation.robots.get('red1')!.robot.setPose({ x: -1.4, z: -1.2, yaw: 0 });
    const at = () => {
      const r = session.state().robots[0];
      return [r.x, r.z] as const;
    };
    const start = at();
    const frames: number[] = [];
    for (let i = 0; i < Math.round(0.8 * fps); i++) {
      session.update(1 / fps, { red1: { ...idleInput(), fieldCentric: false, ly: -1 } });
      const [x, z] = at();
      frames.push(Math.hypot(x - start[0], z - start[1]));
    }
    session.dispose();
    return frames;
  };

  it('moves a robot as far in the same time at any frame rate, down to 10 frames a second', () => {
    const reference = drive(60).at(-1)!;
    expect(reference).toBeGreaterThan(1);
    for (const fps of [10, 24, 30, 75, 144, 240]) expect(Math.abs(drive(fps).at(-1)! - reference), `${fps} fps`).toBeLessThan(0.03);
  });

  it('draws it moving evenly at 144 frames a second: no frame shows a physics step twice', () => {
    const frames = drive(144);
    // At full speed (after 0.4 s) every frame moves it on by about the same distance.
    const moves = frames.slice(Math.round(0.4 * 144)).map((d, i, a) => (i ? d - a[i - 1] : 0)).slice(1);
    const mean = moves.reduce((s, m) => s + m, 0) / moves.length;
    expect(Math.min(...moves)).toBeGreaterThan(mean * 0.7);
    expect(Math.max(...moves)).toBeLessThan(mean * 1.3);
  });
});
