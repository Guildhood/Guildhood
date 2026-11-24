import {
  CLOSE_CODES,
  FATAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  encode,
  type ClientMessage,
  type DriveInput,
  type ErrorCode,
  type JoinSpec,
  type NetCar,
  type PlayerInfo,
  type ServerMessage,
} from '@guildhood/shared';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'closed';

export interface ConnFailure {
  code: ErrorCode | 'network';
  message: string;
}

export interface ConnectionEvents {
  onStatus(status: ConnStatus, info: { attempt: number; failure?: ConnFailure }): void;
  onWelcome(msg: Extract<ServerMessage, { t: 'welcome' }>): void;
  onSnapshot(tick: number, ack: number, cars: NetCar[]): void;
  onPlayerJoined(player: PlayerInfo): void;
  onPlayerLeft(id: string, reason: string): void;
  onRtt(ms: number): void;
}

const GIVE_UP_AFTER_MS = 60_000;
const STALL_MS = 5_000;

/**
 * One player's connection to the game server, with automatic reconnection.
 *
 * - Unexpected closes, server restarts, token expiry, and stalls (no traffic for 5 s, typical
 *   when an iPad drops Wi-Fi) reconnect with backoff for up to a minute.
 * - Reconnects send `join: auto`, which the server resolves to the seat it is still holding.
 * - Errors the player must act on (signed out, no car, session full...) stop retrying.
 */
export class GameConnection {
  status: ConnStatus = 'connecting';
  private ws: WebSocket | null = null;
  private attempt = 0;
  private firstFailureAt: number | null = null;
  private retryTimer: number | null = null;
  private lastServerError: ConnFailure | null = null;
  private lastMessageAt = 0;
  private everWelcomed = false;
  private disposed = false;
  private readonly timers: number[] = [];
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (this.status === 'reconnecting') this.retryNow();
    else if (this.status === 'live' && performance.now() - this.lastMessageAt > STALL_MS) this.abandon();
  };
  private readonly onOnline = () => {
    if (this.status === 'reconnecting') this.retryNow();
  };

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly neighborhoodId: string,
    private readonly initialJoin: JoinSpec,
    private readonly events: ConnectionEvents,
  ) {}

  start(): void {
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
    this.timers.push(
      window.setInterval(() => {
        if (this.status !== 'live' || !this.ws) return;
        if (performance.now() - this.lastMessageAt > STALL_MS) {
          this.abandon(); // stalled: treat as dropped and reconnect
          return;
        }
        this.send({ t: 'ping', id: Math.round(performance.now()) });
      }, 2_000),
    );
    this.open();
  }

  private setStatus(status: ConnStatus, failure?: ConnFailure): void {
    this.status = status;
    this.events.onStatus(status, { attempt: this.attempt, failure });
  }

  private open(): void {
    if (this.disposed) return;
    this.setStatus(this.everWelcomed ? 'reconnecting' : 'connecting');
    this.lastServerError = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = async () => {
      const token = await this.getToken().catch(() => null);
      if (ws !== this.ws) return;
      if (!token) {
        this.fail({ code: 'auth_failed', message: 'You are signed out. Sign in again to drive.' });
        ws.close();
        return;
      }
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        token,
        neighborhoodId: this.neighborhoodId,
        join: this.everWelcomed ? { mode: 'auto' } : this.initialJoin,
      });
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = performance.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.onClosed(ev.code);
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.everWelcomed = true;
        this.attempt = 0;
        this.firstFailureAt = null;
        this.setStatus('live');
        this.events.onWelcome(msg);
        return;
      case 'snap':
        this.events.onSnapshot(msg.tick, msg.ack, msg.cars);
        return;
      case 'player_joined':
        this.events.onPlayerJoined(msg.player);
        return;
      case 'player_left':
        this.events.onPlayerLeft(msg.id, msg.reason);
        return;
      case 'pong':
        this.events.onRtt(Math.max(0, performance.now() - msg.id));
        return;
      case 'error':
        this.lastServerError = { code: msg.code, message: msg.message };
        return;
    }
  }

  private onClosed(code: number): void {
    if (this.disposed || this.status === 'closed' || this.status === 'failed') return;
    const err = this.lastServerError;
    if (code === CLOSE_CODES.replaced) {
      this.fail({ code: 'replaced', message: 'You started driving on another screen.' });
      return;
    }
    // A specific session that has ended is the player's call (drive anyway?), not a retry.
    if (!this.everWelcomed && code === CLOSE_CODES.instance_not_found) {
      this.fail(err ?? { code: 'instance_not_found', message: 'That session has ended.' });
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      this.fail(err ?? { code: 'network', message: 'Disconnected.' });
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    const now = performance.now();
    this.firstFailureAt ??= now;
    if (now - this.firstFailureAt > GIVE_UP_AFTER_MS) {
      this.fail(this.lastServerError ?? { code: 'network', message: 'Can’t reach the game server. Check your Wi-Fi.' });
      return;
    }
    this.attempt++;
    this.setStatus(this.everWelcomed ? 'reconnecting' : 'connecting');
    const delay = Math.min(8_000, 500 * 2 ** (this.attempt - 1)) * (0.8 + Math.random() * 0.4);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private retryNow(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.ws) this.open();
  }

  private fail(failure: ConnFailure): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.setStatus('failed', failure);
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  sendInput(seq: number, input: DriveInput): void {
    if (this.status === 'live') this.send({ t: 'input', seq, steer: input.steer, throttle: input.throttle, brake: input.brake });
  }

  sendAuth(token: string): void {
    this.send({ t: 'auth', token });
  }

  /** Graceful leave: the seat is released immediately. */
  leave(): void {
    this.send({ t: 'leave' });
    this.dispose();
  }

  /**
   * Gives up on the current socket without waiting for its close event. On a dead network the
   * close handshake cannot complete, and browsers can leave the socket CLOSING (no `close` event)
   * for a long time, so waiting would strand the player on a frozen "live" connection.
   */
  private abandon(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    this.onClosed(1006);
  }

  /** Test/diagnostic hook: drop the socket as if the network failed. */
  simulateDrop(): void {
    this.abandon();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = 'closed';
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    for (const t of this.timers) window.clearInterval(t);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'bye');
  }
}
