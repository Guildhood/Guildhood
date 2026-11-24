import { describe, expect, it } from 'vitest';
import { INTERPOLATION_DELAY_MS, TICK_MS, type NetCar } from '@guildhood/shared';
import { RemoteCars, ServerClock } from '../src/game/interpolation.ts';

const car = (id: string, x: number, h = 0, c: 0 | 1 = 1): NetCar => ({ id, x, z: 0, h, vx: 0, vz: 0, s: 0, c });

describe('RemoteCars', () => {
  it('blends between the two snapshots around the render time', () => {
    const r = new RemoteCars();
    r.push(10, [car('a', 0), car('me', 99)], 'me');
    r.push(12, [car('a', 10), car('me', 99)], 'me');
    expect(r.ids()).toEqual(['a']);
    expect(r.sample(11).get('a')!.x).toBeCloseTo(5);
  });

  it('interpolates heading along the short way around', () => {
    const r = new RemoteCars();
    r.push(1, [car('a', 0, Math.PI - 0.1)], 'me');
    r.push(2, [car('a', 0, -Math.PI + 0.1)], 'me');
    expect(Math.abs(r.sample(1.5).get('a')!.h)).toBeCloseTo(Math.PI, 5);
  });

  it('forgets cars that are no longer in snapshots and reports disconnected cars', () => {
    const r = new RemoteCars();
    r.push(1, [car('a', 0), car('b', 0, 0, 0)], 'me');
    expect(r.sample(1).get('b')!.connected).toBe(false);
    r.push(2, [car('a', 1)], 'me');
    expect(r.ids()).toEqual(['a']);
  });
});

describe('ServerClock', () => {
  it('renders remote cars a fixed delay behind the newest server tick', () => {
    const clock = new ServerClock();
    clock.observe(100, 5_000);
    const t = clock.renderTick(5_000)!;
    expect(t).toBeCloseTo(100 - INTERPOLATION_DELAY_MS / TICK_MS, 5);
  });
});
