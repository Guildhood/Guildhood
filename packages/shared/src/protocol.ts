/**
 * Game-server wire protocol (JSON over WebSocket, version 1).
 *
 * Clients send intent only: who they are (a Supabase access token), where they want to be, and
 * per-tick driving input. Positions, speeds, ownership, and results always come from the server.
 */
import { MAX_MESSAGE_BYTES } from './constants.ts';

export const PROTOCOL_VERSION = 1;

/** WebSocket path on the game server (and on the dev proxy). */
export const GAME_WS_PATH = '/game';

export type JoinSpec =
  | { mode: 'auto' }
  | { mode: 'instance'; instanceId: string }
  | { mode: 'friend'; friendId: string };

export type ClientMessage =
  | { t: 'hello'; v: number; token: string; neighborhoodId: string; join: JoinSpec }
  | { t: 'input'; seq: number; steer: number; throttle: number; brake: number }
  | { t: 'auth'; token: string }
  | { t: 'ping'; id: number }
  | { t: 'leave' };

export interface PlayerInfo {
  id: string;
  name: string;
  model: string;
  color: number;
}

/** Car state as sent on the wire (short keys keep snapshots small). */
export interface NetCar {
  id: string;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  /** Last applied steer, for wheel visuals. */
  s: number;
  /** 1 = connected, 0 = disconnected and held for reconnection. */
  c: 0 | 1;
}

export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      instanceId: string;
      neighborhoodId: string;
      neighborhoodName: string;
      mapKey: string;
      selfId: string;
      tick: number;
      tickRate: number;
      snapshotEvery: number;
      /** True when this connection reclaimed a seat held after a disconnect. */
      resumed: boolean;
      /** Last input sequence the server applied for this player (resume prediction after it). */
      ack: number;
      players: PlayerInfo[];
      cars: NetCar[];
    }
  | { t: 'snap'; tick: number; ack: number; cars: NetCar[] }
  | { t: 'player_joined'; player: PlayerInfo }
  | { t: 'player_left'; id: string; reason: 'left' | 'timeout' | 'kicked' | 'moved' }
  | { t: 'pong'; id: number; tick: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'bad_message'
  | 'unsupported_version'
  | 'auth_failed'
  | 'token_expired'
  | 'not_member'
  | 'no_vehicle'
  | 'neighborhood_closed'
  | 'instance_not_found'
  | 'instance_full'
  | 'not_allowed'
  | 'friend_not_online'
  | 'replaced'
  | 'rate_limited'
  | 'backend_unavailable'
  | 'server_shutdown';

/** WebSocket close codes (4000-4999 are application-defined). */
export const CLOSE_CODES: Readonly<Record<ErrorCode | 'left', number>> = {
  left: 4000,
  bad_message: 4001,
  unsupported_version: 4002,
  auth_failed: 4003,
  token_expired: 4004,
  not_member: 4005,
  no_vehicle: 4006,
  neighborhood_closed: 4007,
  instance_not_found: 4008,
  instance_full: 4009,
  not_allowed: 4010,
  friend_not_online: 4011,
  replaced: 4012,
  rate_limited: 4013,
  backend_unavailable: 4014,
  server_shutdown: 4015,
};

/** Errors after which the client should stop retrying automatically and show the player why. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_CODES.left,
  CLOSE_CODES.bad_message,
  CLOSE_CODES.unsupported_version,
  CLOSE_CODES.auth_failed,
  CLOSE_CODES.not_member,
  CLOSE_CODES.no_vehicle,
  CLOSE_CODES.neighborhood_closed,
  CLOSE_CODES.instance_full,
  CLOSE_CODES.not_allowed,
  CLOSE_CODES.friend_not_online,
  CLOSE_CODES.replaced,
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseJoin(v: unknown): JoinSpec | null {
  if (!isObj(v)) return null;
  if (v.mode === 'auto') return { mode: 'auto' };
  if (v.mode === 'instance' && isUuid(v.instanceId)) return { mode: 'instance', instanceId: v.instanceId.toLowerCase() };
  if (v.mode === 'friend' && isUuid(v.friendId)) return { mode: 'friend', friendId: v.friendId.toLowerCase() };
  return null;
}

/**
 * Parses and validates one client frame. Returns null for anything malformed: wrong types,
 * non-finite numbers, unknown fields' values, oversized frames. Input values are range-checked
 * here and clamped again by the simulation.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'hello': {
      const join = parseJoin(m.join);
      if (!finite(m.v) || typeof m.token !== 'string' || m.token.length < 20 || m.token.length > 4096) return null;
      if (!isUuid(m.neighborhoodId) || !join) return null;
      return { t: 'hello', v: m.v, token: m.token, neighborhoodId: m.neighborhoodId.toLowerCase(), join };
    }
    case 'input': {
      if (!finite(m.seq) || !Number.isInteger(m.seq) || m.seq < 0 || m.seq > 2 ** 31) return null;
      if (!finite(m.steer) || !finite(m.throttle) || !finite(m.brake)) return null;
      if (Math.abs(m.steer) > 1 || m.throttle < 0 || m.throttle > 1 || m.brake < 0 || m.brake > 1) return null;
      return { t: 'input', seq: m.seq, steer: m.steer, throttle: m.throttle, brake: m.brake };
    }
    case 'auth':
      if (typeof m.token !== 'string' || m.token.length < 20 || m.token.length > 4096) return null;
      return { t: 'auth', token: m.token };
    case 'ping':
      if (!finite(m.id)) return null;
      return { t: 'ping', id: m.id };
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}
