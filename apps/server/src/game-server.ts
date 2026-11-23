import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  CLOSE_CODES,
  EMPTY_INSTANCE_TTL_MS,
  GAME_WS_PATH,
  HEARTBEAT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  SNAPSHOT_EVERY,
  TICK_MS,
  TICK_RATE,
  encode,
  parseClientMessage,
  vehicleSpec,
  worldByKey,
  type ClientMessage,
  type ErrorCode,
  type PlayerInfo,
  type ServerMessage,
  type WorldMap,
} from '@guildhood/shared';
import { AuthError, type TokenVerifier, type VerifiedToken } from './auth.ts';
import type { Backend, NeighborhoodRecord } from './backend.ts';
import { LiveInstance, type Seat, type SeatConnection } from './instance.ts';
import { log } from './log.ts';

export interface GameServerOptions {
  port: number;
  host?: string;
  serverId?: string;
  backend: Backend;
  verifier: TokenVerifier;
  /** Browser origins allowed to open a socket. Unset = any (development). */
  allowedOrigins?: string[] | null;
  graceMs?: number;
  emptyTtlMs?: number;
  helloTimeoutMs?: number;
  heartbeatMs?: number;
  reapEveryMs?: number;
  tokenCheckMs?: number;
  keepaliveMs?: number;
  /** Forces a per-instance capacity (tests); otherwise the neighborhood's setting is used. */
  capacityOverride?: number;
  rateLimit?: { perSecond: number; burst: number };
}

interface Conn {
  readonly id: number;
  readonly ws: WebSocket;
  readonly adapter: SeatConnection;
  userId: string | null;
  instance: LiveInstance | null;
  seat: Seat | null;
  tokenExpiresAt: number;
  helloTimer: NodeJS.Timeout | null;
  helloStarted: boolean;
  closed: boolean;
  alive: boolean;
  bucket: number;
  bucketAt: number;
}

interface Placement {
  instance: LiveInstance;
  seat: Seat;
}

class JoinRejected extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Authoritative game server. Hosts many live instances, each a running copy of one persistent
 * neighborhood. Trusts clients for nothing but identity (verified token) and driving intent.
 */
export class GameServer {
  readonly serverId: string;
  private readonly opts: Required<Omit<GameServerOptions, 'capacityOverride' | 'allowedOrigins' | 'serverId' | 'host'>> &
    Pick<GameServerOptions, 'capacityOverride' | 'allowedOrigins' | 'host'>;
  private readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly instances = new Map<string, LiveInstance>();
  private readonly seatsByUser = new Map<string, Placement>();
  private readonly conns = new Set<Conn>();
  private readonly neighborhoodCache = new Map<string, { value: NeighborhoodRecord; at: number }>();
  private readonly creating = new Map<string, Promise<LiveInstance>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private nextConnId = 1;
  private stopping = false;

  constructor(options: GameServerOptions) {
    this.serverId = options.serverId ?? `gs-${randomUUID().slice(0, 8)}`;
    this.opts = {
      graceMs: RECONNECT_GRACE_MS,
      emptyTtlMs: EMPTY_INSTANCE_TTL_MS,
      helloTimeoutMs: 10_000,
      heartbeatMs: HEARTBEAT_MS,
      reapEveryMs: 30_000,
      tokenCheckMs: 1_000,
      keepaliveMs: 10_000,
      rateLimit: { perSecond: 60, burst: 120 },
      ...options,
    };
    this.http = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES * 2 });
    this.http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== GAME_WS_PATH || this.stopping) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (origin && this.opts.allowedOrigins && !this.opts.allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        log('warn', 'origin_rejected', { origin });
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, this.opts.host ?? '0.0.0.0', resolve));
    const port = (this.http.address() as AddressInfo).port;
    this.nextTickAt = performance.now() + TICK_MS;
    this.scheduleTick();
    this.timers.push(setInterval(() => void this.heartbeat(), this.opts.heartbeatMs));
    this.timers.push(setInterval(() => void this.reap(), this.opts.reapEveryMs));
    this.timers.push(setInterval(() => this.checkTokens(), this.opts.tokenCheckMs));
    this.timers.push(setInterval(() => this.keepalive(), this.opts.keepaliveMs));
    void this.reap();
    log('info', 'server_started', { serverId: this.serverId, port });
    return port;
  }

  /** Graceful shutdown: tell clients, close instances in the registry, stop listening. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const t of this.timers) clearInterval(t);
    for (const conn of this.conns) this.reject(conn, 'server_shutdown', 'The game server is restarting');
    await Promise.allSettled([...this.instances.values()].map((i) => this.opts.backend.closeInstance(i.id)));
    this.instances.clear();
    this.seatsByUser.clear();
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    log('info', 'server_stopped', { serverId: this.serverId });
  }

  /** Read-only view for health checks and tests. */
  stats() {
    return {
      serverId: this.serverId,
      instances: [...this.instances.values()].map((i) => ({
        id: i.id,
        neighborhoodId: i.neighborhood.id,
        tick: i.tick,
        players: [...i.seats.values()].map((s) => ({ id: s.userId, connected: s.conn !== null, starvedTicks: s.starvedTicks })),
      })),
    };
  }

  /** The authoritative car of a player, for tests and diagnostics. */
  carOf(userId: string) {
    const p = this.seatsByUser.get(userId);
    return p ? { instanceId: p.instance.id, tick: p.instance.tick, car: { ...p.seat.car } } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------------------------

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && (path === '/healthz' || path === '/')) {
      const players = [...this.instances.values()].reduce((n, i) => n + i.playerCount, 0);
      res.writeHead(this.stopping ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: !this.stopping, serverId: this.serverId, instances: this.instances.size, players }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }

  // ---------------------------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const conn: Conn = {
      id: this.nextConnId++,
      ws,
      adapter: {
        send: (json: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(json);
        },
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
      },
      userId: null,
      instance: null,
      seat: null,
      tokenExpiresAt: 0,
      helloTimer: null,
      helloStarted: false,
      closed: false,
      alive: true,
      bucket: this.opts.rateLimit.burst,
      bucketAt: Date.now(),
    };
    this.conns.add(conn);
    conn.helloTimer = setTimeout(() => this.reject(conn, 'bad_message', 'No hello received in time'), this.opts.helloTimeoutMs);
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', (err) => log('debug', 'socket_error', { conn: conn.id, err: err.message }));
  }

  private takeToken(conn: Conn): boolean {
    const now = Date.now();
    const { perSecond, burst } = this.opts.rateLimit;
    conn.bucket = Math.min(burst, conn.bucket + ((now - conn.bucketAt) / 1000) * perSecond);
    conn.bucketAt = now;
    if (conn.bucket < 1) return false;
    conn.bucket -= 1;
    return true;
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.closed) return;
    if (!this.takeToken(conn)) return this.reject(conn, 'rate_limited', 'Too many messages');
    if (isBinary) return this.reject(conn, 'bad_message', 'Binary frames are not supported');
    const msg = parseClientMessage(data.toString());
    if (!msg) return this.reject(conn, 'bad_message', 'Malformed message');
    this.dispatch(conn, msg);
  }

  private dispatch(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello':
        if (conn.helloStarted) return this.reject(conn, 'bad_message', 'Duplicate hello');
        conn.helloStarted = true;
        if (conn.helloTimer) clearTimeout(conn.helloTimer);
        void this.handleHello(conn, msg).catch((err) => {
          if (err instanceof JoinRejected) this.reject(conn, err.code, err.message);
          else {
            log('error', 'join_crashed', { err: (err as Error).stack });
            this.reject(conn, 'backend_unavailable', 'Could not join right now');
          }
        });
        return;
      case 'input':
        if (conn.seat && conn.instance && conn.seat.conn === conn.adapter) {
          conn.instance.queueInput(conn.seat, msg.seq, msg);
        }
        return;
      case 'auth':
        void this.handleReauth(conn, msg.token);
        return;
      case 'ping':
        this.send(conn, { t: 'pong', id: msg.id, tick: conn.instance?.tick ?? 0 });
        return;
      case 'leave':
        this.handleLeave(conn);
        return;
    }
  }

  private onClose(conn: Conn): void {
    conn.closed = true;
    this.conns.delete(conn);
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    const seat = conn.seat;
    if (seat && seat.conn === conn.adapter) {
      // Hold the seat for the reconnect grace period; the car brakes to a stop meanwhile.
      seat.conn = null;
      seat.disconnectedAt = Date.now();
      log('info', 'player_disconnected', { user: seat.userId, instance: conn.instance?.id });
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    conn.adapter.send(encode(msg));
  }

  /** Sends a typed error and closes with the matching application close code. */
  private reject(conn: Conn, code: ErrorCode, message: string): void {
    if (conn.closed) return;
    this.send(conn, { t: 'error', code, message });
    conn.closed = true;
    conn.ws.close(CLOSE_CODES[code], code);
    log(code === 'server_shutdown' ? 'debug' : 'info', 'connection_rejected', { conn: conn.id, user: conn.userId, code, message });
  }

  // ---------------------------------------------------------------------------------------------
  // Joining
  // ---------------------------------------------------------------------------------------------

  private async handleHello(conn: Conn, msg: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) throw new JoinRejected('unsupported_version', `Server speaks protocol ${PROTOCOL_VERSION}`);

    let verified: VerifiedToken;
    try {
      verified = await this.opts.verifier.verify(msg.token);
    } catch (err) {
      if (err instanceof AuthError) throw new JoinRejected(err.code, err.message);
      throw new JoinRejected('auth_failed', 'Could not verify sign-in');
    }
    conn.userId = verified.userId;
    if (conn.closed) return;

    // Identity, car, friends, and memberships come from the database, never from the client.
    let player, neighborhood;
    try {
      [player, neighborhood] = await Promise.all([
        this.opts.backend.getPlayer(verified.userId),
        this.getNeighborhood(msg.neighborhoodId),
      ]);
    } catch (err) {
      log('warn', 'backend_unavailable', { err: (err as Error).message });
      throw new JoinRejected('backend_unavailable', 'Player records are unavailable; try again shortly');
    }
    if (conn.closed) return;
    if (!player) throw new JoinRejected('auth_failed', 'No player profile for this account');
    if (!neighborhood || !neighborhood.isOpen) throw new JoinRejected('neighborhood_closed', 'That neighborhood is not open');
    if (!player.neighborhoodIds.has(neighborhood.id)) throw new JoinRejected('not_member', 'You are not a resident of that neighborhood');
    const spec = player.vehicle ? vehicleSpec(player.vehicle.modelId) : undefined;
    if (!player.vehicle || !spec) throw new JoinRejected('no_vehicle', 'Choose a car you own before driving');
    const world = worldByKey(neighborhood.mapKey);
    if (!world) throw new JoinRejected('neighborhood_closed', 'This neighborhood map is not available on this server');

    const uid = verified.userId;
    const info: PlayerInfo = { id: uid, name: player.displayName, model: spec.id, color: player.vehicle.colorIndex };

    // Decide which instance the player wants.
    let target: LiveInstance | null = null;
    if (msg.join.mode === 'friend') {
      if (!player.friendIds.has(msg.join.friendId)) throw new JoinRejected('not_allowed', 'You can only join players on your friends list');
      const friend = this.seatsByUser.get(msg.join.friendId);
      if (!friend || friend.instance.neighborhood.id !== neighborhood.id) throw new JoinRejected('friend_not_online', 'Your friend is not driving here right now');
      target = friend.instance;
    } else if (msg.join.mode === 'instance') {
      target = this.instances.get(msg.join.instanceId) ?? null;
      if (!target || target.neighborhood.id !== neighborhood.id) throw new JoinRejected('instance_not_found', 'That session has ended');
    }

    // Reclaim an existing seat (reconnect, token refresh, or second device) when it matches.
    const existing = this.seatsByUser.get(uid);
    if (existing && existing.instance.neighborhood.id === neighborhood.id && (target === null || target === existing.instance)) {
      this.resume(conn, existing, info, player.friendIds, verified);
      return;
    }

    if (target) {
      if (target.isFull) throw new JoinRejected('instance_full', 'That session is full');
      if (!target.hasFriendOf(player.friendIds)) throw new JoinRejected('not_allowed', 'You can only join sessions with a friend in them');
    } else {
      target = this.pickInstance(neighborhood.id, player.friendIds) ?? (await this.createInstance(neighborhood, world));
      if (conn.closed) return;
    }

    // State may have changed while awaiting: re-check before seating.
    const again = this.seatsByUser.get(uid);
    if (again && again.instance === target) {
      this.resume(conn, again, info, player.friendIds, verified);
      return;
    }
    if (target.isFull) throw new JoinRejected('instance_full', 'That session is full');
    if (again) this.removeSeat(again.instance, uid, 'moved');

    const seat = target.addSeat(uid, info, spec, player.friendIds, conn.adapter);
    this.seatsByUser.set(uid, { instance: target, seat });
    this.bind(conn, target, seat, verified);
    this.sendWelcome(conn, target, seat, false);
    target.broadcast(encode({ t: 'player_joined', player: info }), uid);
    log('info', 'player_joined', { user: uid, instance: target.id, players: target.playerCount });
    void this.safely('set_presence', () => this.opts.backend.setPresence(uid, target.id));
  }

  private resume(conn: Conn, placement: Placement, info: PlayerInfo, friendIds: Set<string>, verified: VerifiedToken): void {
    const { instance, seat } = placement;
    if (seat.conn) {
      const previous = [...this.conns].find((c) => c.adapter === seat.conn);
      if (previous) this.reject(previous, 'replaced', 'You joined from another screen');
    }
    instance.reattach(seat, conn.adapter, info, friendIds);
    this.bind(conn, instance, seat, verified);
    this.sendWelcome(conn, instance, seat, true);
    instance.broadcast(encode({ t: 'player_joined', player: info }), seat.userId);
    log('info', 'player_resumed', { user: seat.userId, instance: instance.id });
    void this.safely('set_presence', () => this.opts.backend.setPresence(seat.userId, instance.id));
  }

  private bind(conn: Conn, instance: LiveInstance, seat: Seat, verified: VerifiedToken): void {
    conn.instance = instance;
    conn.seat = seat;
    conn.userId = verified.userId;
    conn.tokenExpiresAt = verified.expiresAt;
  }

  private sendWelcome(conn: Conn, instance: LiveInstance, seat: Seat, resumed: boolean): void {
    this.send(conn, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      instanceId: instance.id,
      neighborhoodId: instance.neighborhood.id,
      neighborhoodName: instance.neighborhood.name,
      mapKey: instance.world.key,
      selfId: seat.userId,
      tick: instance.tick,
      tickRate: TICK_RATE,
      snapshotEvery: SNAPSHOT_EVERY,
      resumed,
      ack: seat.ack,
      players: instance.playerInfos(),
      cars: instance.netCars(),
    });
  }

  /** Prefer an instance with friends in it, then the busiest one with room. */
  private pickInstance(neighborhoodId: string, friendIds: Set<string>): LiveInstance | null {
    let best: LiveInstance | null = null;
    let bestScore = -1;
    for (const inst of this.instances.values()) {
      if (inst.neighborhood.id !== neighborhoodId || inst.isFull) continue;
      let friends = 0;
      for (const id of inst.seats.keys()) if (friendIds.has(id)) friends++;
      const score = friends * 1000 + inst.playerCount;
      if (score > bestScore) {
        best = inst;
        bestScore = score;
      }
    }
    return best;
  }

  private createInstance(neighborhood: NeighborhoodRecord, world: WorldMap): Promise<LiveInstance> {
    // Coalesce simultaneous first joins into one new instance.
    const pending = this.creating.get(neighborhood.id);
    if (pending) return pending;
    const promise = (async () => {
      const id = randomUUID();
      const capacity = this.opts.capacityOverride ?? neighborhood.capacity;
      try {
        await this.opts.backend.openInstance(id, neighborhood.id, this.serverId, capacity);
      } catch (err) {
        log('warn', 'open_instance_failed', { err: (err as Error).message });
        throw new JoinRejected('backend_unavailable', 'Could not open a session right now');
      }
      const inst = new LiveInstance(id, neighborhood, world, capacity, Date.now());
      this.instances.set(id, inst);
      log('info', 'instance_opened', { instance: id, neighborhood: neighborhood.id, capacity });
      return inst;
    })();
    this.creating.set(neighborhood.id, promise);
    return promise.finally(() => this.creating.delete(neighborhood.id));
  }

  private async getNeighborhood(id: string): Promise<NeighborhoodRecord | null> {
    const cached = this.neighborhoodCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = await this.opts.backend.getNeighborhood(id);
    if (value) this.neighborhoodCache.set(id, { value, at: Date.now() });
    return value;
  }

  private async handleReauth(conn: Conn, token: string): Promise<void> {
    try {
      const v = await this.opts.verifier.verify(token);
      if (conn.userId && v.userId !== conn.userId) return this.reject(conn, 'auth_failed', 'Token belongs to a different player');
      conn.tokenExpiresAt = v.expiresAt;
    } catch (err) {
      this.reject(conn, err instanceof AuthError ? err.code : 'auth_failed', 'Could not refresh sign-in');
    }
  }

  private handleLeave(conn: Conn): void {
    if (conn.seat && conn.instance && conn.seat.conn === conn.adapter) {
      this.removeSeat(conn.instance, conn.seat.userId, 'left');
    }
    if (!conn.closed) {
      conn.closed = true;
      conn.ws.close(CLOSE_CODES.left, 'left');
    }
  }

  private removeSeat(instance: LiveInstance, userId: string, reason: 'left' | 'timeout' | 'moved'): void {
    const seat = instance.removeSeat(userId, Date.now());
    if (!seat) return;
    if (this.seatsByUser.get(userId)?.seat === seat) this.seatsByUser.delete(userId);
    instance.broadcast(encode({ t: 'player_left', id: userId, reason }));
    log('info', 'player_left', { user: userId, instance: instance.id, reason });
    void this.safely('clear_presence', () => this.opts.backend.clearPresence(userId, instance.id));
  }

  // ---------------------------------------------------------------------------------------------
  // Loops
  // ---------------------------------------------------------------------------------------------

  private scheduleTick(): void {
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.tickTimer = setTimeout(() => {
      const now = performance.now();
      let steps = 0;
      while (now >= this.nextTickAt && steps < 5) {
        this.stepAll();
        this.nextTickAt += TICK_MS;
        steps++;
      }
      if (now - this.nextTickAt > 250) this.nextTickAt = now + TICK_MS; // fell far behind: skip ahead
      if (!this.stopping) this.scheduleTick();
    }, delay);
  }

  private stepAll(): void {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      for (const seat of inst.seats.values()) {
        if (seat.conn === null && seat.disconnectedAt !== null && now - seat.disconnectedAt > this.opts.graceMs) {
          this.removeSeat(inst, seat.userId, 'timeout');
        }
      }
      inst.step();
      if (inst.tick % SNAPSHOT_EVERY === 0) inst.broadcastSnapshot();
      if (inst.playerCount === 0 && inst.emptySince !== null && now - inst.emptySince > this.opts.emptyTtlMs) {
        this.instances.delete(inst.id);
        log('info', 'instance_closed', { instance: inst.id });
        void this.safely('close_instance', () => this.opts.backend.closeInstance(inst.id));
      }
    }
  }

  private checkTokens(): void {
    const now = Date.now();
    for (const conn of this.conns) {
      if (conn.seat && !conn.closed && conn.tokenExpiresAt > 0 && conn.tokenExpiresAt < now) {
        // The seat is kept; the client reconnects with a fresh token and resumes.
        this.reject(conn, 'token_expired', 'Sign-in expired; reconnecting');
      }
    }
  }

  /** WebSocket-level ping so dead iPad connections (Wi-Fi drop, sleep) are noticed quickly. */
  private keepalive(): void {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.instances.size === 0) return;
    await this.safely('heartbeat', () =>
      this.opts.backend.heartbeat(
        this.serverId,
        [...this.instances.values()].map((i) => ({ id: i.id, player_count: i.playerCount })),
      ),
    );
  }

  private async reap(): Promise<void> {
    await this.safely('reap', async () => {
      const n = await this.opts.backend.reapStaleInstances(45);
      if (n > 0) log('info', 'reaped_stale_instances', { count: n });
    });
  }

  /** Registry/presence writes are best-effort: gameplay continues if the database blips. */
  private async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log('warn', 'backend_write_failed', { what, err: (err as Error).message });
    }
  }
}
