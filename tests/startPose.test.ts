import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FieldLayout } from '../src/field/layout';
import { checkStart, clampStart, cleanStart, defaultStart, forAlliance, keepOnWalls, resolveStarts, startField, startOutline } from '../src/field/startPose';
import { buildZones } from '../src/field/zones';
import { ROBOTS, URAN_V2, robotById } from '../src/robot/robots';
import { parseColliders } from '../src/sim/colliders';
import { Simulation, initPhysics } from '../src/sim/Simulation';
import { idleInput } from '../src/sim/types';

const layout: FieldLayout = JSON.parse(fs.readFileSync('public/assets/field-layout.json', 'utf8'));
const bin = fs.readFileSync('public/assets/field-colliders.bin');
const colliders = parseColliders(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
const field = startField(layout, buildZones(layout));
const cfg = URAN_V2.config;
const w = field.wall;
/** Touching the alliance wall (red side), facing the field */
const atAllianceWall = (z: number) => ({ x: -(w - cfg.length / 2 - 0.004), z, yaw: 0 });

describe('start position (G304)', () => {
  it('allows the usual spots of both driver stations for every robot', () => {
    for (const r of ROBOTS) {
      for (const station of [1, 2] as const) expect(checkStart(defaultStart(station, r.config.length, w), r.config, field), `${r.id} ${station}`).toBeNull();
    }
  });

  it('wants the robot on its own side, touching the wall, off the FLOWERS, the LOADING ZONE and the GARDEN', () => {
    expect(checkStart({ x: -1, z: 0, yaw: 0 }, cfg, field)).toBe('wall');
    expect(checkStart({ x: 0.05, z: w - cfg.width / 2 - 0.004, yaw: 0 }, cfg, field)).toBe('side');
    expect(checkStart(atAllianceWall(-0.9), cfg, field)).toBe('loading');
    expect(checkStart(atAllianceWall(0.55), cfg, field)).toBe('flower');
    // Along the audience wall, into the corner where the GARDEN's POLLEN lies
    expect(checkStart(clampStart({ x: -1.5, z: 2, yaw: -Math.PI / 2 }, cfg, w), cfg, field)).toBe('garden');
    // Against a side wall, the back of the robot at the center line: allowed
    expect(checkStart(clampStart({ x: 0, z: 2, yaw: Math.PI / 2 }, cfg, w), cfg, field)).toBeNull();
    // Turned 45° in the corner by the drivers, touching both walls with its corners
    expect(checkStart(clampStart({ x: -2, z: -2, yaw: Math.PI / 4 }, cfg, w), cfg, field)).toBeNull();
    // Over the partner's robot
    const partner = startOutline(atAllianceWall(1.15), cfg);
    expect(checkStart(atAllianceWall(1.0), cfg, field, [partner])).toBe('robot');
  });

  it('stops a dragged robot at the walls and the center line, and keeps it on a wall while it turns', () => {
    const p = clampStart({ x: 3, z: -3, yaw: 0.3 }, cfg, w);
    for (const [x, z] of startOutline(p, cfg)) {
      expect(x).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(z)).toBeLessThan(w);
    }
    const square = clampStart({ x: -1, z: -2, yaw: Math.PI / 2 }, cfg, w);
    const turned = keepOnWalls(square, { ...square, yaw: Math.PI / 2 - 0.4 }, cfg, w);
    const back = keepOnWalls(turned, { ...turned, yaw: Math.PI / 2 }, cfg, w);
    expect(checkStart(turned, cfg, field)).toBeNull();
    expect(back.z).toBeCloseTo(square.z, 6);
  });

  it('is the same start for blue, turned about the field center', () => {
    const red = { x: -0.3, z: 1.5, yaw: Math.PI / 2 };
    expect(forAlliance(red, 'blue')).toMatchObject({ x: 0.3, z: -1.5 });
    expect(forAlliance(red, 'blue').yaw).toBeCloseTo(-Math.PI / 2);
    expect(forAlliance(forAlliance(red, 'blue'), 'blue').yaw).toBeCloseTo(red.yaw);
  });

  it("puts a driver's start in the match unless it is against the rules, and moves the partner out of its way", () => {
    const mine = clampStart({ x: -0.3, z: 2, yaw: Math.PI / 2 }, cfg, w);
    const starts = resolveStarts([
      { slot: 'red1', cfg, start: mine },
      { slot: 'blue1', cfg, start: mine },
      { slot: 'red2', cfg },
    ], field);
    expect(starts.get('red1')).toEqual(mine);
    expect(starts.get('blue1')).toEqual(forAlliance(mine, 'blue'));
    expect(starts.get('red2')).toEqual(defaultStart(2, cfg.length, w));

    // In the LOADING ZONE: the usual spot instead.
    expect(resolveStarts([{ slot: 'red1', cfg, start: atAllianceWall(-0.9) }], field).get('red1')).toEqual(defaultStart(1, cfg.length, w));
    // On station 2's spot: the robot of station 2 starts on station 1's.
    const taken = resolveStarts([{ slot: 'red1', cfg, start: defaultStart(2, cfg.length, w) }, { slot: 'red2', cfg }], field);
    expect(taken.get('red2')).toEqual(defaultStart(1, cfg.length, w));
  });

  it('keeps only real poses from storage or the network', () => {
    expect(cleanStart({ x: -1, z: 0.5, yaw: 0 })).toEqual({ x: -1, z: 0.5, yaw: 0 });
    expect(cleanStart({ x: 'a', z: 0, yaw: 0 })).toBeNull();
    expect(cleanStart({ x: 1e9, z: 0, yaw: 0 })).toBeNull();
    expect(cleanStart({ x: NaN, z: 0, yaw: 0 })).toBeNull();
    expect(cleanStart(null)).toBeNull();
  });

  describe('in the simulation', () => {
    beforeAll(() => initPhysics());

    it('starts the robot there, and again after a restart', () => {
      const sim = new Simulation(layout, colliders, { toast() {}, finished() {} });
      sim.addRobot('blue1', 'test', 'bumble-v');
      sim.addRobot('red1', 'test');
      const start = clampStart({ x: -1, z: -2, yaw: -Math.PI / 2 }, robotById('bumble-v').config, w);
      sim.setStarts({ blue1: start });
      sim.start('match');
      const at = forAlliance(start, 'blue');
      const pose = () => sim.robots.get('blue1')!.robot.position;
      expect(pose()[0]).toBeCloseTo(at.x, 3);
      expect(pose()[2]).toBeCloseTo(at.z, 3);
      sim.reset();
      expect(pose()[0]).toBeCloseTo(at.x, 3);
      // Nobody picked a start for red1: its usual spot.
      expect(sim.robots.get('red1')!.robot.position[2]).toBeCloseTo(defaultStart(1, cfg.length, w).z, 3);
    });

    it('drives field-centric away from the drivers from a turned start', () => {
      const sim = new Simulation(layout, colliders, { toast() {}, finished() {} });
      sim.addRobot('red1', 'test');
      sim.addRobot('blue1', 'test');
      // Both put down sideways against a side wall, facing along it.
      const start = clampStart({ x: -1.4, z: -2, yaw: -Math.PI / 2 }, cfg, w);
      sim.setStarts({ red1: start, blue1: start });
      sim.start('practice');
      const at = (slot: 'red1' | 'blue1') => sim.robots.get(slot)!.robot.position;
      const before = { red1: at('red1'), blue1: at('blue1') };
      for (const slot of ['red1', 'blue1'] as const) sim.setInput(slot, { ...idleInput(), ly: -1, fieldCentric: true });
      for (let i = 0; i < 48; i++) sim.step();
      // Stick forward: red goes to +X, blue to -X (strafing, so a little slower), neither along the wall.
      expect(at('red1')[0] - before.red1[0]).toBeGreaterThan(0.2);
      expect(at('blue1')[0] - before.blue1[0]).toBeLessThan(-0.2);
      expect(Math.abs(at('red1')[2] - before.red1[2])).toBeLessThan(0.05);
      expect(Math.abs(at('blue1')[2] - before.blue1[2])).toBeLessThan(0.05);
    });
  });
});
