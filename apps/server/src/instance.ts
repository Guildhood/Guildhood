import {
  MAX_INPUT_QUEUE,
  NEUTRAL_INPUT,
  PARK_INPUT,
  TICK_DT,
  chooseSpawn,
  quantizeCar,
  resolveCarPair,
  resolveStatic,
  sanitizeInput,
  spawnState,
  stepCar,
  type CarState,
  type DriveInput,
  type NetCar,
  type PlayerInfo,
  type VehicleSpec,
  type WorldMap,
} from '@guildhood/shared';
import type { NeighborhoodRecord } from './backend.ts';

/** The transport side of a connected player, implemented by the WebSocket layer. */
export interface SeatConnection {
  send(json: string): void;
  /** Bytes queued but not yet flushed; used to skip snapshots for slow clients. */
  readonly bufferedAmount: number;
}

/** One player's place in a live instance. Survives disconnects for the reconnect grace period. */
export interface Seat {
  userId: string;
  info: PlayerInfo;
  spec: VehicleSpec;
  friendIds: Set<string>;
  car: CarState;
  lastInput: DriveInput;
  inputs: { seq: number; input: DriveInput }[];
  /** Highest input seq received on the current connection (older/duplicate seqs are ignored). */
  lastReceivedSeq: number;
  /** Seq of the last input the simulation applied (sent back as `ack`). */
  ack: number;
  conn: SeatConnection | null;
  disconnectedAt: number | null;
  /** Ticks in which no input was waiting (diagnostics). */
  starvedTicks: number;
  /** Consecutive starved ticks; after STARVE_LIMIT the car brakes instead of repeating input. */
  starvedStreak: number;
}

const DISCONNECTED_INPUT: DriveInput = PARK_INPUT;
/**
 * Repeating the last input smooths over network jitter, but a client that stops sending (iPad app
 * backgrounded with the socket still open) must not keep driving: after ~200 ms the car brakes.
 */
const STARVE_LIMIT = 6;
const SLOW_CLIENT_BYTES = 256 * 1024;

/**
 * A live session instance: one running copy of a persistent neighborhood. It owns the
 * authoritative state of every car in it and advances them at a fixed tick.
 */
export class LiveInstance {
  readonly seats = new Map<string, Seat>();
  tick = 0;
  emptySince: number | null;
  private spawnCursor = 0;

  constructor(
    readonly id: string,
    readonly neighborhood: NeighborhoodRecord,
    readonly world: WorldMap,
    readonly capacity: number,
    now: number,
  ) {
    this.emptySince = now;
  }

  get playerCount(): number {
    return this.seats.size;
  }

  get isFull(): boolean {
    return this.seats.size >= this.capacity;
  }

  hasFriendOf(friendIds: Set<string>): boolean {
    for (const id of this.seats.keys()) if (friendIds.has(id)) return true;
    return false;
  }

  addSeat(userId: string, info: PlayerInfo, spec: VehicleSpec, friendIds: Set<string>, conn: SeatConnection): Seat {
    const occupied = [...this.seats.values()].map((s) => s.car);
    const spawnIndex = chooseSpawn(this.world, occupied, 8, this.spawnCursor++);
    const seat: Seat = {
      userId,
      info,
      spec,
      friendIds,
      car: spawnState(this.world, spawnIndex),
      lastInput: { ...NEUTRAL_INPUT },
      inputs: [],
      lastReceivedSeq: -1,
      ack: -1,
      conn,
      disconnectedAt: null,
      starvedTicks: 0,
      starvedStreak: 0,
    };
    this.seats.set(userId, seat);
    this.emptySince = null;
    return seat;
  }

  /** Attaches a new connection to an existing seat (reconnect or second device). */
  reattach(seat: Seat, conn: SeatConnection, info: PlayerInfo, friendIds: Set<string>): void {
    seat.conn = conn;
    seat.disconnectedAt = null;
    seat.info = info;
    seat.friendIds = friendIds;
    seat.inputs = [];
    seat.lastReceivedSeq = -1;
    seat.ack = -1;
    seat.lastInput = { ...NEUTRAL_INPUT };
    seat.starvedStreak = 0;
  }

  removeSeat(userId: string, now: number): Seat | undefined {
    const seat = this.seats.get(userId);
    this.seats.delete(userId);
    if (this.seats.size === 0) this.emptySince = now;
    return seat;
  }

  queueInput(seat: Seat, seq: number, input: DriveInput): void {
    if (seq <= seat.lastReceivedSeq) return; // duplicate or reordered
    seat.lastReceivedSeq = seq;
    seat.inputs.push({ seq, input: sanitizeInput(input) });
    // A client cannot bank inputs to move faster: extras are dropped, and at most one runs per tick.
    while (seat.inputs.length > MAX_INPUT_QUEUE) seat.inputs.shift();
  }

  /** Advances every car by exactly one tick. */
  step(): void {
    for (const seat of this.seats.values()) {
      let input: DriveInput;
      if (seat.conn === null) {
        input = DISCONNECTED_INPUT;
      } else {
        const next = seat.inputs.shift();
        if (next) {
          input = next.input;
          seat.lastInput = next.input;
          seat.ack = next.seq;
          seat.starvedStreak = 0;
        } else {
          seat.starvedTicks++;
          seat.starvedStreak++;
          input = seat.starvedStreak > STARVE_LIMIT ? DISCONNECTED_INPUT : seat.lastInput;
        }
      }
      seat.car = stepCar(seat.car, input, seat.spec, this.world, TICK_DT);
    }

    // Car-to-car contacts, then make sure nobody was pushed into a building.
    const seats = [...this.seats.values()];
    if (seats.length > 1) {
      let touched = false;
      for (let i = 0; i < seats.length; i++) {
        for (let j = i + 1; j < seats.length; j++) {
          if (resolveCarPair(seats[i]!.car, seats[j]!.car)) touched = true;
        }
      }
      if (touched) {
        for (const s of seats) {
          resolveStatic(s.car, this.world);
          s.car = quantizeCar(s.car);
        }
      }
    }
    this.tick++;
  }

  netCars(): NetCar[] {
    const cars: NetCar[] = [];
    for (const s of this.seats.values()) {
      cars.push({
        id: s.userId,
        x: s.car.x,
        z: s.car.z,
        h: s.car.heading,
        vx: s.car.vx,
        vz: s.car.vz,
        s: s.conn ? s.lastInput.steer : 0,
        c: s.conn ? 1 : 0,
      });
    }
    return cars;
  }

  playerInfos(): PlayerInfo[] {
    return [...this.seats.values()].map((s) => s.info);
  }

  /** Sends one snapshot to every connected player, each with their own input ack. */
  broadcastSnapshot(): void {
    const carsJson = JSON.stringify(this.netCars());
    for (const seat of this.seats.values()) {
      const conn = seat.conn;
      if (!conn || conn.bufferedAmount > SLOW_CLIENT_BYTES) continue;
      conn.send(`{"t":"snap","tick":${this.tick},"ack":${seat.ack},"cars":${carsJson}}`);
    }
  }

  broadcast(json: string, exceptUserId?: string): void {
    for (const seat of this.seats.values()) {
      if (seat.userId !== exceptUserId && seat.conn) seat.conn.send(json);
    }
  }
}
