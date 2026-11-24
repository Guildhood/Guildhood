import { describe, expect, it } from 'vitest';
import { TICK_DT, VEHICLE_SPECS, WORLDS, spawnState, stepCar, type CarState, type DriveInput } from '@guildhood/shared';
import { Predictor } from '../src/game/prediction.ts';

const world = WORLDS.copperleaf_v1!;
const spec = VEHICLE_SPECS.sprout_hatch!;
const gas: DriveInput = { steer: 0.2, throttle: 1, brake: 0 };

describe('Predictor', () => {
  it('matches the server exactly when the server agrees (no correction)', () => {
    const start = spawnState(world, 0);
    const p = new Predictor(spec, world);
    p.reset(start);
    let server: CarState = start;
    for (let seq = 1; seq <= 60; seq++) {
      p.step(seq, gas);
      // The server runs the same simulation but acknowledges 5 inputs behind (latency).
      if (seq > 5) {
        server = stepCar(server, gas, spec, world, TICK_DT);
        p.reconcile(server, seq - 5);
        expect(p.lastCorrection).toBe(0);
      }
    }
  });

  it('adopts the authoritative state and smooths the visual error away', () => {
    const start = spawnState(world, 0);
    const p = new Predictor(spec, world);
    p.reset(start);
    for (let seq = 1; seq <= 10; seq++) p.step(seq, gas);
    // Server says we were bumped 2 m sideways (e.g. another car hit us).
    const bumped = { ...start, x: start.x + 0, z: start.z + 2 };
    p.reconcile(bumped, 0);
    expect(p.lastCorrection).toBeGreaterThan(1.5);
    const first = p.visual(1 / 60)!;
    let v = first;
    for (let i = 0; i < 60; i++) v = p.visual(1 / 60)!;
    expect(Math.hypot(v.x - p.state!.x, v.z - p.state!.z)).toBeLessThan(0.01);
    expect(Math.hypot(first.x - p.state!.x, first.z - p.state!.z)).toBeGreaterThan(1);
  });

  it('snaps instead of sliding when the correction is huge', () => {
    const p = new Predictor(spec, world);
    p.reset(spawnState(world, 0));
    p.reconcile(spawnState(world, 8), 0);
    const v = p.visual(1 / 60)!;
    expect(v.x).toBe(p.state!.x);
    expect(v.z).toBe(p.state!.z);
  });
});
