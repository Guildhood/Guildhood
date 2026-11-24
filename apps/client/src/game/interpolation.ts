import { INTERPOLATION_DELAY_MS, TICK_MS, lerp, lerpAngle, type NetCar } from '@guildhood/shared';

/** Estimates the server's tick clock from snapshot arrivals. */
export class ServerClock {
  private offsetMs: number | null = null;

  observe(tick: number, nowMs: number): void {
    const sample = tick * TICK_MS - nowMs;
    if (this.offsetMs === null || sample > this.offsetMs) this.offsetMs = sample;
    else this.offsetMs += (sample - this.offsetMs) * 0.02; // drift slowly toward slower paths
  }

  reset(): void {
    this.offsetMs = null;
  }

  /** The (fractional) server tick to render remote cars at. */
  renderTick(nowMs: number): number | null {
    if (this.offsetMs === null) return null;
    return (nowMs + this.offsetMs - INTERPOLATION_DELAY_MS) / TICK_MS;
  }
}

export interface RemotePose {
  x: number;
  z: number;
  h: number;
  s: number;
  connected: boolean;
}

/** Buffers snapshots of other players' cars and blends between them. */
export class RemoteCars {
  private readonly buffers = new Map<string, { tick: number; car: NetCar }[]>();

  push(tick: number, cars: NetCar[], selfId: string): void {
    const seen = new Set<string>();
    for (const car of cars) {
      if (car.id === selfId) continue;
      seen.add(car.id);
      let buf = this.buffers.get(car.id);
      if (!buf) this.buffers.set(car.id, (buf = []));
      if (buf.length && buf[buf.length - 1]!.tick >= tick) continue;
      buf.push({ tick, car });
      if (buf.length > 30) buf.shift();
    }
    for (const id of [...this.buffers.keys()]) if (!seen.has(id)) this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }

  ids(): string[] {
    return [...this.buffers.keys()];
  }

  sample(renderTick: number): Map<string, RemotePose> {
    const out = new Map<string, RemotePose>();
    for (const [id, buf] of this.buffers) {
      if (buf.length === 0) continue;
      const first = buf[0]!;
      const last = buf[buf.length - 1]!;
      if (renderTick <= first.tick) {
        out.set(id, pose(first.car));
        continue;
      }
      if (renderTick >= last.tick) {
        // Short extrapolation along velocity covers a late snapshot; then hold.
        const ahead = Math.min(renderTick - last.tick, 4) * (TICK_MS / 1000);
        out.set(id, { ...pose(last.car), x: last.car.x + last.car.vx * ahead, z: last.car.z + last.car.vz * ahead });
        continue;
      }
      for (let i = buf.length - 1; i > 0; i--) {
        const a = buf[i - 1]!;
        const b = buf[i]!;
        if (a.tick <= renderTick && renderTick <= b.tick) {
          const t = (renderTick - a.tick) / (b.tick - a.tick);
          out.set(id, {
            x: lerp(a.car.x, b.car.x, t),
            z: lerp(a.car.z, b.car.z, t),
            h: lerpAngle(a.car.h, b.car.h, t),
            s: lerp(a.car.s, b.car.s, t),
            connected: b.car.c === 1,
          });
          break;
        }
      }
    }
    return out;
  }
}

function pose(c: NetCar): RemotePose {
  return { x: c.x, z: c.z, h: c.h, s: c.s, connected: c.c === 1 };
}
