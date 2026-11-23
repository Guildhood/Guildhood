import { describe, expect, it } from 'vitest';
import { BODY_CIRCLE_RADIUS, WORLDS, isOnRoad, pointInRect, spawnState, resolveStatic } from '../src/index.ts';

const overlaps = (a: { x: number; z: number; w: number; d: number }, b: typeof a) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

describe.each(Object.values(WORLDS))('world $key', (world) => {
  it('keeps buildings off roads and apart from each other', () => {
    for (const b of world.buildings) {
      for (const r of world.roads) expect(overlaps(b, r), `building at ${b.x},${b.z}`).toBe(false);
      for (const o of world.buildings) if (o !== b) expect(overlaps(b, o)).toBe(false);
      expect(Math.abs(b.x) + b.w / 2).toBeLessThanOrEqual(world.halfSize);
      expect(Math.abs(b.z) + b.d / 2).toBeLessThanOrEqual(world.halfSize);
    }
  });

  it('keeps trees and props off roads and out of buildings', () => {
    for (const t of [...world.trees, ...world.props]) {
      expect(isOnRoad(world, t.x, t.z), `tree at ${t.x},${t.z}`).toBe(false);
      for (const b of world.buildings) expect(pointInRect(t.x, t.z, b, t.r)).toBe(false);
    }
  });

  it('has at least 8 spawn points, all on a road and free of obstacles', () => {
    expect(world.spawns.length).toBeGreaterThanOrEqual(8);
    world.spawns.forEach((sp, i) => {
      expect(isOnRoad(world, sp.x, sp.z)).toBe(true);
      const s = spawnState(world, i);
      const moved = { ...s };
      resolveStatic(moved, world);
      expect(Math.hypot(moved.x - s.x, moved.z - s.z), `spawn ${i}`).toBeLessThan(1e-9);
      expect(Math.abs(sp.x)).toBeLessThan(world.halfSize - BODY_CIRCLE_RADIUS * 3);
    });
  });
});
