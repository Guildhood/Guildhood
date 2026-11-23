// Unit tests for the authoritative per-instance simulation (no network or database).
import { describe, expect, it } from 'vitest';
import { VEHICLE_SPECS, WORLDS } from '@guildhood/shared';
import { LiveInstance, type SeatConnection } from '../src/instance.ts';

const neighborhood = { id: 'n', name: 'Test', mapKey: 'copperleaf_v1', capacity: 8, isOpen: true };
const spec = VEHICLE_SPECS.sprout_hatch!;

function setup(players = 1) {
  const inst = new LiveInstance('i', neighborhood, WORLDS.copperleaf_v1!, 8, 0);
  const sent: string[][] = [];
  const seats = Array.from({ length: players }, (_, i) => {
    const out: string[] = [];
    sent.push(out);
    const conn: SeatConnection = { send: (j) => out.push(j), bufferedAmount: 0 };
    return inst.addSeat(`p${i}`, { id: `p${i}`, name: `P${i}`, model: 'sprout_hatch', color: i }, spec, new Set(), conn);
  });
  return { inst, seats, sent };
}

const speed = (s: { car: { vx: number; vz: number } }) => Math.hypot(s.car.vx, s.car.vz);

describe('LiveInstance', () => {
  it('applies at most one input per tick and acks it', () => {
    const { inst, seats } = setup();
    const seat = seats[0]!;
    for (let i = 1; i <= 5; i++) inst.queueInput(seat, i, { steer: 0, throttle: 1, brake: 0 });
    inst.step();
    expect(seat.ack).toBe(1);
    expect(seat.inputs).toHaveLength(4);
  });

  it('caps the input queue and ignores duplicate or old sequence numbers', () => {
    const { inst, seats } = setup();
    const seat = seats[0]!;
    for (let i = 1; i <= 50; i++) inst.queueInput(seat, i, { steer: 0, throttle: 1, brake: 0 });
    expect(seat.inputs.length).toBeLessThanOrEqual(6);
    inst.queueInput(seat, 3, { steer: 1, throttle: 1, brake: 0 });
    expect(seat.inputs.at(-1)!.seq).toBe(50);
  });

  it('drains a sustained backlog by dropping (not simulating) old inputs', () => {
    const { inst, seats } = setup();
    const seat = seats[0]!;
    let seq = 0;
    for (let i = 0; i < 5; i++) inst.queueInput(seat, ++seq, { steer: 0, throttle: 1, brake: 0 });
    // Steady state: one new input per tick, so without draining the backlog would never shrink.
    for (let t = 0; t < 200; t++) {
      inst.queueInput(seat, ++seq, { steer: 0, throttle: 1, brake: 0 });
      inst.step();
    }
    expect(seat.inputs.length).toBeLessThanOrEqual(2);
    expect(inst.tick).toBe(200);
  });

  it('repeats the last input briefly when starved, then parks the car', () => {
    const { inst, seats } = setup();
    const seat = seats[0]!;
    for (let t = 1; t <= 40; t++) {
      inst.queueInput(seat, t, { steer: 0, throttle: 1, brake: 0 });
      inst.step();
    }
    const cruising = speed(seat);
    inst.step(); // starved: repeats throttle
    expect(speed(seat)).toBeGreaterThan(cruising);
    for (let t = 0; t < 90; t++) inst.step();
    expect(speed(seat)).toBe(0);
  });

  it('parks a disconnected car and marks it disconnected in snapshots', () => {
    const { inst, seats, sent } = setup(2);
    const seat = seats[0]!;
    for (let t = 1; t <= 30; t++) {
      inst.queueInput(seat, t, { steer: 0, throttle: 1, brake: 0 });
      inst.step();
    }
    seat.conn = null;
    seat.disconnectedAt = 0;
    for (let t = 0; t < 90; t++) inst.step();
    expect(speed(seat)).toBe(0);
    inst.broadcastSnapshot();
    const snap = JSON.parse(sent[1]!.at(-1)!);
    expect(snap.cars.find((c: { id: string }) => c.id === 'p0').c).toBe(0);
    expect(sent[0]!.length).toBe(0); // nothing is sent to a disconnected seat
  });

  it('sends each player their own input ack in snapshots', () => {
    const { inst, seats, sent } = setup(2);
    inst.queueInput(seats[0]!, 7, { steer: 0, throttle: 1, brake: 0 });
    inst.queueInput(seats[1]!, 3, { steer: 0, throttle: 1, brake: 0 });
    inst.step();
    inst.broadcastSnapshot();
    expect(JSON.parse(sent[0]!.at(-1)!).ack).toBe(7);
    expect(JSON.parse(sent[1]!.at(-1)!).ack).toBe(3);
  });

  it('spawns a joining friend next to the friend they joined', () => {
    const { inst, seats } = setup(3);
    const host = seats[2]!;
    const conn: SeatConnection = { send: () => {}, bufferedAmount: 0 };
    const joiner = inst.addSeat('friend', { id: 'friend', name: 'F', model: 'sprout_hatch', color: 1 }, spec, new Set(['p2']), conn, 'p2');
    const d = Math.hypot(joiner.car.x - host.car.x, joiner.car.z - host.car.z);
    expect(d).toBeGreaterThanOrEqual(8);
    expect(d).toBeLessThan(40);
  });

  it('spawns players apart from each other', () => {
    const { seats } = setup(4);
    for (let i = 0; i < seats.length; i++)
      for (let j = i + 1; j < seats.length; j++) {
        const a = seats[i]!.car;
        const b = seats[j]!.car;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(8);
      }
  });
});
