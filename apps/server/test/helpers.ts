import WebSocket from 'ws';
import type { ServerMessage } from '@guildhood/shared';
import { createSupabaseVerifier } from '../src/auth.ts';
import { SupabaseBackend, type Backend } from '../src/backend.ts';
import { GameServer, type GameServerOptions } from '../src/game-server.ts';
import { localEnv } from '../../../tests/support/env.ts';

export const STARTER = 'a1000000-0000-4000-8000-000000000001';

export function realBackend(): SupabaseBackend {
  const env = localEnv();
  return new SupabaseBackend(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
}

export async function startServer(overrides: Partial<GameServerOptions> = {}) {
  const env = localEnv();
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  const server = new GameServer({
    port: 0,
    host: '127.0.0.1',
    backend: realBackend(),
    verifier: createSupabaseVerifier({ issuer, jwksUrl: `${issuer}/.well-known/jwks.json` }),
    heartbeatMs: 1_000,
    ...overrides,
  });
  const port = await server.start();
  return { server, url: `ws://127.0.0.1:${port}/game`, port };
}

export type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

/** A scripted game client that records every server message. */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  private readonly consumed = new Set<number>();
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private seq = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const w of this.waiters) w();
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  hello(token: string, join: unknown = { mode: 'auto' }, neighborhoodId = STARTER): void {
    this.send({ t: 'hello', v: 1, token, neighborhoodId, join });
  }

  drive(input: { steer?: number; throttle?: number; brake?: number }): number {
    const seq = ++this.seq;
    this.send({ t: 'input', seq, steer: input.steer ?? 0, throttle: input.throttle ?? 0, brake: input.brake ?? 0 });
    return seq;
  }

  /** Resolves with the first not-yet-consumed message matching `pred`. */
  waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, timeoutMs = 8_000): Promise<Msg<T>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = 0; i < this.messages.length; i++) {
          const m = this.messages[i]!;
          if (!this.consumed.has(i) && m.t === t && pred(m as Msg<T>)) {
            this.consumed.add(i);
            cleanup();
            resolve(m as Msg<T>);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for "${t}". Last messages: ${JSON.stringify(this.messages.slice(-3)).slice(0, 600)}`));
      }, timeoutMs);
      const waiter = () => void check();
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      if (!check()) this.waiters.push(waiter);
    });
  }

  lastSnap(): Msg<'snap'> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i]!.t === 'snap') return this.messages[i] as Msg<'snap'>;
    return undefined;
  }

  close(): void {
    this.ws.close();
  }

  /** Drops the TCP connection without a close handshake, like an iPad losing Wi-Fi. */
  kill(): void {
    this.ws.terminate();
  }
}

/** Sends inputs at the client tick rate for `ms` milliseconds. */
/** Sends inputs at the client tick rate for `ms` milliseconds; returns the last seq sent. */
export async function driveFor(c: TestClient, ms: number, input: { steer?: number; throttle?: number; brake?: number }): Promise<number> {
  const end = Date.now() + ms;
  let last = 0;
  while (Date.now() < end) {
    last = c.drive(input);
    await sleep(1000 / 30);
  }
  return last;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps a backend so tests can simulate a database outage. */
export function flaky(inner: Backend): Backend & { down: boolean } {
  const wrapper = { down: false } as Backend & { down: boolean };
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner)) as (keyof Backend)[]) {
    if (key === ('constructor' as keyof Backend)) continue;
    (wrapper as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      if (wrapper.down) return Promise.reject(new Error('simulated database outage'));
      return (inner[key] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
    };
  }
  return wrapper;
}
