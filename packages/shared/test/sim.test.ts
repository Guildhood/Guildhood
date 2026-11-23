import { describe, expect, it } from 'vitest';
import {
  BODY_CIRCLE_RADIUS,
  PARK_INPUT,
  TICK_DT,
  VEHICLE_SPECS,
  WORLDS,
  bodyCircles,
  chooseSpawn,
  forwardSpeed,
  resolveCarPair,
  sanitizeInput,
  spawnState,
  stepCar,
  type CarState,
  type DriveInput,
} from '../src/index.ts';

const world = WORLDS.copperleaf_v1!;
const spec = VEHICLE_SPECS.sprout_hatch!;

/** Small deterministic PRNG so "random" driving is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomInputs(n: number, seed: number): DriveInput[] {
  const r = rng(seed);
  const out: DriveInput[] = [];
  let cur: DriveInput = { steer: 0, throttle: 1, brake: 0 };
  for (let i = 0; i < n; i++) {
    if (r() < 0.05) cur = { steer: r() * 2 - 1, throttle: r() < 0.8 ? r() : 0, brake: r() < 0.2 ? r() : 0 };
    out.push(cur);
  }
  return out;
}

const run = (start: CarState, inputs: DriveInput[]) => inputs.reduce((s, i) => stepCar(s, i, spec, world, TICK_DT), start);

describe('vehicle simulation', () => {
  it('is deterministic for identical input sequences', () => {
    const inputs = randomInputs(900, 7);
    expect(run(spawnState(world, 0), inputs)).toEqual(run(spawnState(world, 0), inputs));
  });

  it('resuming from a mid-run state reproduces the continuous run exactly (reconciliation replay)', () => {
    const inputs = randomInputs(600, 11);
    const full = run(spawnState(world, 3), inputs);
    const mid = run(spawnState(world, 3), inputs.slice(0, 250));
    const resumed = run({ ...mid }, inputs.slice(250));
    expect(resumed).toEqual(full);
  });

  it('accelerates forward and respects top speed on the road', () => {
    // North ring road heading +x has a long straight.
    let s: CarState = { x: -60, z: -70, heading: Math.PI / 2, vx: 0, vz: 0 };
    let maxV = 0;
    for (let i = 0; i < 150; i++) {
      s = stepCar(s, { steer: 0, throttle: 1, brake: 0 }, spec, world, TICK_DT);
      maxV = Math.max(maxV, forwardSpeed(s));
    }
    expect(s.x).toBeGreaterThan(-60 + 40);
    expect(Math.abs(s.z + 70)).toBeLessThan(1e-6);
    expect(maxV).toBeLessThanOrEqual(spec.maxSpeed);
    expect(maxV).toBeGreaterThan(spec.maxSpeed * 0.8);
  });

  it('is slower on grass than on the road', () => {
    // Inside the park (off-road), heading +x.
    let grass: CarState = { x: 10, z: -15, heading: Math.PI / 2, vx: 0, vz: 0 };
    for (let i = 0; i < 90; i++) grass = stepCar(grass, { steer: 0, throttle: 1, brake: 0 }, spec, world, TICK_DT);
    expect(forwardSpeed(grass)).toBeLessThanOrEqual(spec.maxSpeed * spec.offroadSpeedFactor + 1e-6);
  });

  it('positive steer turns toward the driver’s right (−x when facing +z)', () => {
    let s: CarState = { x: 70, z: -40, heading: 0, vx: 0, vz: 0 };
    for (let i = 0; i < 45; i++) s = stepCar(s, { steer: 1, throttle: 0.6, brake: 0 }, spec, world, TICK_DT);
    expect(s.heading).toBeLessThan(0);
    expect(s.x).toBeLessThan(70);
  });

  it('brakes to a stop, then reverses no faster than maxReverse', () => {
    let s: CarState = { x: 40, z: -70, heading: Math.PI / 2, vx: 15, vz: 0 };
    let stoppedAt = -1;
    for (let i = 0; i < 300; i++) {
      s = stepCar(s, { steer: 0, throttle: 0, brake: 1 }, spec, world, TICK_DT);
      if (stoppedAt < 0 && forwardSpeed(s) <= 0) stoppedAt = i;
      expect(forwardSpeed(s)).toBeGreaterThanOrEqual(-spec.maxReverse - 1e-9);
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(40);
    expect(forwardSpeed(s)).toBeLessThan(-spec.maxReverse * 0.8);
  });

  it('park input stops the car and holds it without reversing', () => {
    let s: CarState = { x: 40, z: -70, heading: Math.PI / 2, vx: 18, vz: 0 };
    for (let i = 0; i < 150; i++) s = stepCar(s, PARK_INPUT, spec, world, TICK_DT);
    expect(s.vx).toBe(0);
    expect(s.vz).toBe(0);
    const x = s.x;
    for (let i = 0; i < 150; i++) s = stepCar(s, PARK_INPUT, spec, world, TICK_DT);
    expect(s.x).toBe(x);
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(sanitizeInput({ steer: 50, throttle: 9, brake: -3 })).toEqual({ steer: 1, throttle: 1, brake: 0 });
    expect(sanitizeInput({ steer: NaN, throttle: Infinity, brake: -Infinity })).toEqual({ steer: 0, throttle: 0, brake: 0 });
    const start = spawnState(world, 0);
    const boosted = run(start, Array(60).fill({ steer: 0, throttle: 1e9, brake: 0 }));
    const normal = run(start, Array(60).fill({ steer: 0, throttle: 1, brake: 0 }));
    expect(boosted).toEqual(normal);
  });

  it('never penetrates buildings or leaves the fence under long random driving', () => {
    for (const seed of [1, 2, 3, 4]) {
      let s = spawnState(world, seed * 3);
      for (const input of randomInputs(2400, seed)) {
        s = stepCar(s, input, spec, world, TICK_DT);
        const [ax, az, bx, bz] = bodyCircles(s);
        for (const [cx, cz] of [
          [ax, az],
          [bx, bz],
        ] as const) {
          expect(Math.abs(cx)).toBeLessThanOrEqual(world.halfSize - BODY_CIRCLE_RADIUS + 0.05);
          expect(Math.abs(cz)).toBeLessThanOrEqual(world.halfSize - BODY_CIRCLE_RADIUS + 0.05);
          for (const b of world.buildings) {
            const px = Math.max(b.x - b.w / 2, Math.min(cx, b.x + b.w / 2));
            const pz = Math.max(b.z - b.d / 2, Math.min(cz, b.z + b.d / 2));
            // Allow tiny residual overlap from multi-contact corners.
            expect(Math.hypot(cx - px, cz - pz)).toBeGreaterThan(BODY_CIRCLE_RADIUS - 0.15);
          }
        }
      }
    }
  });

  it('driving straight into a wall stops the car at the wall', () => {
    // East-facing on the east ring road toward the outer houses at x = 89.
    let s: CarState = { x: 60, z: -48, heading: Math.PI / 2, vx: 0, vz: 0 };
    for (let i = 0; i < 240; i++) s = stepCar(s, { steer: 0, throttle: 1, brake: 0 }, spec, world, TICK_DT);
    expect(s.x).toBeLessThan(89 - 5 + 0.01);
    expect(s.x).toBeGreaterThan(75);
  });
});

describe('car-to-car collisions', () => {
  it('separates overlapping cars and conserves momentum', () => {
    const a: CarState = { x: 0, z: 0, heading: Math.PI / 2, vx: 10, vz: 0 };
    const b: CarState = { x: 2.5, z: 0, heading: Math.PI / 2, vx: 0, vz: 0 };
    const before = a.vx + b.vx;
    expect(resolveCarPair(a, b)).toBe(true);
    expect(a.vx + b.vx).toBeCloseTo(before, 9);
    expect(b.vx).toBeGreaterThan(0);
    expect(resolveCarPair(a, b)).toBe(false);
  });
});

describe('spawning', () => {
  it('picks a spawn away from occupied positions', () => {
    const first = chooseSpawn(world, []);
    const sp = world.spawns[first]!;
    const second = chooseSpawn(world, [{ x: sp.x, z: sp.z }]);
    expect(second).not.toBe(first);
    const s2 = world.spawns[second]!;
    expect(Math.hypot(s2.x - sp.x, s2.z - sp.z)).toBeGreaterThanOrEqual(8);
  });
});
