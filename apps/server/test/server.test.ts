// Integration tests: real game server, real WebSocket clients, real Supabase (Auth, Data API, Postgres).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_CODES, TICK_DT, VEHICLE_SPECS, WORLDS, stepCar, type CarState } from '@guildhood/shared';
import { deleteAuthUsers, registerPlayer, serviceClient, type SignedInPlayer } from '../../../tests/support/auth.ts';
import { POSTGRES, SERVICE, closeDb, one, run } from '../../../tests/support/db.ts';
import type { GameServer } from '../src/game-server.ts';
import { STARTER, TestClient, driveFor, flaky, realBackend, sleep, startServer } from './helpers.ts';

const players: SignedInPlayer[] = [];
const servers: GameServer[] = [];
const clients: TestClient[] = [];

async function player(label: string): Promise<SignedInPlayer> {
  const p = await registerPlayer(label, { onboard: true });
  players.push(p);
  return p;
}

async function server(overrides: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer(overrides);
  servers.push(s.server);
  return s;
}

async function client(url: string): Promise<TestClient> {
  const c = await TestClient.connect(url);
  clients.push(c);
  return c;
}

async function join(url: string, p: SignedInPlayer, joinSpec: unknown = { mode: 'auto' }) {
  const c = await client(url);
  c.hello(p.accessToken, joinSpec);
  const welcome = await c.waitFor('welcome');
  return { c, welcome };
}

async function befriend(a: SignedInPlayer, b: SignedInPlayer) {
  await run(POSTGRES, 'select private.make_friends($1, $2)', [a.userId, b.userId]);
}

async function rejected(url: string, p: SignedInPlayer | string, joinSpec: unknown = { mode: 'auto' }, nb = STARTER) {
  const c = await client(url);
  c.hello(typeof p === 'string' ? p : p.accessToken, joinSpec, nb);
  const err = await c.waitFor('error');
  const closed = await c.closed;
  return { code: err.code, close: closed.code };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 6_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

const presence = async (userId: string) =>
  (await run(POSTGRES, 'select instance_id from session_presence where user_id = $1', [userId])).rows[0]?.instance_id ?? null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.kill();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

afterAll(async () => {
  await deleteAuthUsers(players.map((p) => p.userId));
  await closeDb();
});

describe('admission', () => {
  it('rejects garbage and tampered tokens', async () => {
    const { url } = await server();
    const a = await player('adm-a');
    expect(await rejected(url, 'x'.repeat(64))).toEqual({ code: 'auth_failed', close: CLOSE_CODES.auth_failed });

    // Same signature, different subject: the signature check must fail.
    const [h, payload, sig] = a.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    claims.sub = randomUUID();
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(await rejected(url, forged)).toEqual({ code: 'auth_failed', close: CLOSE_CODES.auth_failed });
  });

  it('rejects silent, malformed, and wrong-version clients', async () => {
    const { url } = await server({ helloTimeoutMs: 300 });
    const silent = await client(url);
    expect((await silent.closed).code).toBe(CLOSE_CODES.bad_message);

    const garbage = await client(url);
    garbage.send('{"t":"teleport"}');
    expect((await garbage.closed).code).toBe(CLOSE_CODES.bad_message);

    const a = await player('adm-b');
    const old = await client(url);
    old.send({ t: 'hello', v: 99, token: a.accessToken, neighborhoodId: STARTER, join: { mode: 'auto' } });
    expect((await old.closed).code).toBe(CLOSE_CODES.unsupported_version);
  });

  it('loads identity and the owned car from the database, and records presence', async () => {
    const { url, server: gs } = await server();
    const a = await player('adm-c');
    // Recolor through the real Data API as the player (RLS-protected column update).
    const { data: car } = await a.client.from('player_vehicles').select('id').single();
    const { error } = await a.client.from('player_vehicles').update({ color_index: 3 }).eq('id', car!.id);
    expect(error).toBeNull();
    const { data: profile } = await a.client.from('profiles').select('display_name').single();

    const { welcome } = await join(url, a);
    expect(welcome.selfId).toBe(a.userId);
    expect(welcome.players).toEqual([{ id: a.userId, name: profile!.display_name, model: 'sprout_hatch', color: 3 }]);
    expect(welcome.cars).toHaveLength(1);
    expect(welcome.mapKey).toBe('copperleaf_v1');

    const registry = await one(POSTGRES, 'select server_id, status, neighborhood_id from session_instances where id = $1', [welcome.instanceId]);
    expect(registry).toEqual({ server_id: gs.serverId, status: 'open', neighborhood_id: STARTER });
    expect(await until(() => presence(a.userId), (v) => v === welcome.instanceId)).toBe(welcome.instanceId);
  });

  it('refuses players without an owned active car', async () => {
    const { url } = await server();
    const a = await player('adm-d');
    await run(POSTGRES, 'update profiles set active_vehicle_id = null where id = $1', [a.userId]);
    expect(await rejected(url, a)).toEqual({ code: 'no_vehicle', close: CLOSE_CODES.no_vehicle });
  });

  it('refuses neighborhoods the player does not belong to, or that do not exist', async () => {
    const { url } = await server();
    const a = await player('adm-e');
    const other = randomUUID();
    await run(POSTGRES, `insert into neighborhoods (id, slug, name, map_key) values ($1, $2, 'Test Annex', 'copperleaf_v1')`, [
      other,
      `annex-${other.slice(0, 8)}`,
    ]);
    try {
      expect(await rejected(url, a, { mode: 'auto' }, other)).toEqual({ code: 'not_member', close: CLOSE_CODES.not_member });
      expect(await rejected(url, a, { mode: 'auto' }, randomUUID())).toEqual({
        code: 'neighborhood_closed',
        close: CLOSE_CODES.neighborhood_closed,
      });
    } finally {
      await run(POSTGRES, 'delete from neighborhoods where id = $1', [other]);
    }
  });
});

describe('authoritative driving', () => {
  it('moves the car from inputs alone and ignores client-sent state', async () => {
    const { url, server: gs } = await server();
    const a = await player('drv-a');
    const { c, welcome } = await join(url, a);
    const start = welcome.cars[0]!;

    const end = Date.now() + 1500;
    let seq = 0;
    while (Date.now() < end) {
      // Extra fields (position, speed, balance) are not part of the protocol and are dropped.
      c.send({ t: 'input', seq: ++seq, steer: 0, throttle: 1, brake: 0, x: 9999, z: 9999, vx: 500, balance: 1e9 });
      await sleep(1000 / 30);
    }
    const snap = await c.waitFor('snap', (s) => s.ack >= seq - 3);
    const me = snap.cars.find((x) => x.id === a.userId)!;
    const moved = Math.hypot(me.x - start.x, me.z - start.z);
    expect(moved).toBeGreaterThan(5);
    expect(Math.abs(me.x)).toBeLessThan(100);
    expect(Math.abs(me.z)).toBeLessThan(100);
    const authoritative = gs.carOf(a.userId)!;
    expect(Math.hypot(authoritative.car.x - me.x, authoritative.car.z - me.z)).toBeLessThan(5);
  });

  it('cannot be sped up by flooding inputs: at most one input runs per tick', async () => {
    const { url, server: gs } = await server();
    const a = await player('drv-b');
    const { c, welcome } = await join(url, a);
    const startTick = gs.carOf(a.userId)!.tick;
    const start = welcome.cars[0]!;
    for (let i = 1; i <= 100; i++) c.drive({ throttle: 1 });
    await sleep(600);
    const now = gs.carOf(a.userId)!;

    // Best case for an honest client: full throttle on every tick that elapsed.
    let ideal: CarState = { x: start.x, z: start.z, heading: start.h, vx: start.vx, vz: start.vz };
    for (let t = startTick; t < now.tick; t++) ideal = stepCar(ideal, { steer: 0, throttle: 1, brake: 0 }, VEHICLE_SPECS.sprout_hatch!, WORLDS.copperleaf_v1!, TICK_DT);
    const maxDist = Math.hypot(ideal.x - start.x, ideal.z - start.z);
    const actual = Math.hypot(now.car.x - start.x, now.car.z - start.z);
    expect(actual).toBeLessThanOrEqual(maxDist + 0.01);
    // 100 banked inputs did not buy 100 ticks of driving.
    let hundred: CarState = { x: start.x, z: start.z, heading: start.h, vx: start.vx, vz: start.vz };
    for (let t = 0; t < 100; t++) hundred = stepCar(hundred, { steer: 0, throttle: 1, brake: 0 }, VEHICLE_SPECS.sprout_hatch!, WORLDS.copperleaf_v1!, TICK_DT);
    expect(actual).toBeLessThan(Math.hypot(hundred.x - start.x, hundred.z - start.z) / 3);
  });

  it('brakes a car whose client goes silent instead of repeating its last input forever', async () => {
    const { url, server: gs } = await server();
    const a = await player('drv-d');
    const { c } = await join(url, a);
    await driveFor(c, 700, { throttle: 1 });
    await sleep(2500); // socket open, no inputs (e.g. Safari backgrounded)
    const car = gs.carOf(a.userId)!.car;
    expect(Math.hypot(car.vx, car.vz)).toBeLessThan(0.5);
  });

  it('closes connections that flood messages', async () => {
    const { url } = await server({ rateLimit: { perSecond: 30, burst: 40 } });
    const a = await player('drv-c');
    const { c } = await join(url, a);
    for (let i = 0; i < 200; i++) c.send({ t: 'ping', id: i });
    expect((await c.closed).code).toBe(CLOSE_CODES.rate_limited);
  });
});

describe('friends driving together', () => {
  it('a friend joins the same instance and both see each other move; strangers cannot target it', async () => {
    const { url } = await server();
    const a = await player('fr-a');
    const b = await player('fr-b');
    const stranger = await player('fr-s');
    await befriend(a, b);

    const A = await join(url, a);
    const B = await join(url, b, { mode: 'friend', friendId: a.userId });
    expect(B.welcome.instanceId).toBe(A.welcome.instanceId);
    expect(B.welcome.players.map((p) => p.id).sort()).toEqual([a.userId, b.userId].sort());
    expect((await A.c.waitFor('player_joined')).player.id).toBe(b.userId);

    // B drives; A's snapshots show B's car moving.
    const firstSeen = (await A.c.waitFor('snap', (s) => s.cars.some((x) => x.id === b.userId))).cars.find((x) => x.id === b.userId)!;
    await driveFor(B.c, 1200, { throttle: 1 });
    const later = (await A.c.waitFor('snap', (s) => {
      const car = s.cars.find((x) => x.id === b.userId);
      return !!car && Math.hypot(car.x - firstSeen.x, car.z - firstSeen.z) > 5;
    })).cars.find((x) => x.id === b.userId)!;
    expect(later.c).toBe(1);

    expect(await rejected(url, stranger, { mode: 'instance', instanceId: A.welcome.instanceId })).toEqual({
      code: 'not_allowed',
      close: CLOSE_CODES.not_allowed,
    });
    expect(await rejected(url, stranger, { mode: 'friend', friendId: a.userId })).toEqual({ code: 'not_allowed', close: CLOSE_CODES.not_allowed });
  });

  it('auto-join prefers the instance where friends are', async () => {
    const { url } = await server();
    const a = await player('fr-c');
    const b = await player('fr-d');
    await befriend(a, b);
    const A = await join(url, a);
    const B = await join(url, b);
    expect(B.welcome.instanceId).toBe(A.welcome.instanceId);
  });

  it('a full instance refuses targeted joins and auto-join opens another instance', async () => {
    const { url } = await server({ capacityOverride: 2 });
    const [a, b, c] = [await player('cap-a'), await player('cap-b'), await player('cap-c')];
    await befriend(a, b);
    await befriend(a, c);
    const A = await join(url, a);
    await join(url, b, { mode: 'friend', friendId: a.userId });
    expect(await rejected(url, c, { mode: 'friend', friendId: a.userId })).toEqual({ code: 'instance_full', close: CLOSE_CODES.instance_full });
    const C = await join(url, c);
    expect(C.welcome.instanceId).not.toBe(A.welcome.instanceId);
  });

  it('reports a friend who is not driving', async () => {
    const { url } = await server();
    const a = await player('fr-e');
    const b = await player('fr-f');
    await befriend(a, b);
    expect(await rejected(url, b, { mode: 'friend', friendId: a.userId })).toEqual({
      code: 'friend_not_online',
      close: CLOSE_CODES.friend_not_online,
    });
  });
});

describe('disconnects and reconnects', () => {
  it('holds the seat during the grace period and resumes the same car on reconnect', async () => {
    const { url } = await server({ graceMs: 10_000 });
    const a = await player('rc-a');
    const b = await player('rc-b');
    await befriend(a, b);
    const A = await join(url, a);
    const B = await join(url, b, { mode: 'friend', friendId: a.userId });
    await driveFor(A.c, 800, { throttle: 1 });

    A.c.kill(); // Wi-Fi drop: no close handshake
    const held = await B.c.waitFor('snap', (s) => s.cars.some((x) => x.id === a.userId && x.c === 0));
    const heldCar = held.cars.find((x) => x.id === a.userId)!;

    const again = await join(url, a);
    expect(again.welcome.resumed).toBe(true);
    expect(again.welcome.instanceId).toBe(A.welcome.instanceId);
    const resumedCar = again.welcome.cars.find((x) => x.id === a.userId)!;
    expect(Math.hypot(resumedCar.x - heldCar.x, resumedCar.z - heldCar.z)).toBeLessThan(15);
    await B.c.waitFor('snap', (s) => s.cars.some((x) => x.id === a.userId && x.c === 1));
    expect(await presence(a.userId)).toBe(A.welcome.instanceId);

    // Driving continues on the resumed connection.
    const before = (await again.c.waitFor('snap')).cars.find((x) => x.id === a.userId)!;
    const lastSeq = await driveFor(again.c, 800, { throttle: 1 });
    const after = (await again.c.waitFor('snap', (s) => s.ack >= lastSeq - 2)).cars.find((x) => x.id === a.userId)!;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(3);
  });

  it('frees the seat and clears presence when the grace period runs out', async () => {
    const { url } = await server({ graceMs: 700 });
    const a = await player('rc-c');
    const b = await player('rc-d');
    await befriend(a, b);
    const A = await join(url, a);
    const B = await join(url, b, { mode: 'friend', friendId: a.userId });
    await until(() => presence(a.userId), (v) => v === A.welcome.instanceId);
    A.c.kill();
    const left = await B.c.waitFor('player_left', (m) => m.id === a.userId);
    expect(left.reason).toBe('timeout');
    expect(await until(() => presence(a.userId), (v) => v === null)).toBeNull();
  });

  it('a second screen replaces the first connection instead of duplicating the car', async () => {
    const { url } = await server();
    const a = await player('rc-e');
    const first = await join(url, a);
    const second = await join(url, a);
    expect((await first.c.waitFor('error')).code).toBe('replaced');
    expect((await first.c.closed).code).toBe(CLOSE_CODES.replaced);
    expect(second.welcome.resumed).toBe(true);
    expect(second.welcome.cars).toHaveLength(1);
  });

  it('leaving is immediate and clears presence', async () => {
    const { url } = await server();
    const a = await player('rc-f');
    const b = await player('rc-g');
    await befriend(a, b);
    const A = await join(url, a);
    const B = await join(url, b, { mode: 'friend', friendId: a.userId });
    A.c.send({ t: 'leave' });
    expect((await A.c.closed).code).toBe(CLOSE_CODES.left);
    expect((await B.c.waitFor('player_left', (m) => m.id === a.userId)).reason).toBe('left');
    expect(await until(() => presence(a.userId), (v) => v === null)).toBeNull();
  });

  it('a token for a different player is refused on refresh', async () => {
    const { url } = await server();
    const a = await player('rc-h');
    const b = await player('rc-i');
    const A = await join(url, a);
    A.c.send({ t: 'auth', token: b.accessToken });
    expect((await A.c.closed).code).toBe(CLOSE_CODES.auth_failed);
  });
});

describe('failure handling', () => {
  it('fails closed for new joins during a database outage while existing players keep driving', async () => {
    const backend = flaky(realBackend());
    const { url } = await server({ backend });
    const a = await player('fail-a');
    const b = await player('fail-b');
    const A = await join(url, a);

    backend.down = true;
    expect(await rejected(url, b)).toEqual({ code: 'backend_unavailable', close: CLOSE_CODES.backend_unavailable });
    const before = A.welcome.cars[0]!;
    const lastSeq = await driveFor(A.c, 800, { throttle: 1 });
    const snap = await A.c.waitFor('snap', (s) => s.ack >= lastSeq - 2);
    const me = snap.cars.find((x) => x.id === a.userId)!;
    expect(Math.hypot(me.x - before.x, me.z - before.z)).toBeGreaterThan(1.5);

    backend.down = false;
    const B = await join(url, b);
    expect(B.welcome.instanceId).toBe(A.welcome.instanceId);
  });

  it('closes empty instances in the registry', async () => {
    const { url } = await server({ emptyTtlMs: 300 });
    const a = await player('fail-c');
    const A = await join(url, a);
    A.c.send({ t: 'leave' });
    const status = await until(
      async () => (await one(POSTGRES, 'select status from session_instances where id = $1', [A.welcome.instanceId])).status,
      (s) => s === 'closed',
    );
    expect(status).toBe('closed');
  });

  it('shutdown tells clients and closes instances in the registry', async () => {
    const started = await startServer();
    const a = await player('fail-d');
    const A = await join(started.url, a);
    await started.server.stop();
    expect((await A.c.closed).code).toBe(CLOSE_CODES.server_shutdown);
    expect((await one(POSTGRES, 'select status from session_instances where id = $1', [A.welcome.instanceId])).status).toBe('closed');
    expect(await presence(a.userId)).toBeNull();
  });
});

describe('account eligibility (Phase 2)', () => {
  it('refuses players who have not finished their profile', async () => {
    const { url } = await server();
    const p = await registerPlayer('elig-a'); // verified, signed in, onboarding not done
    players.push(p);
    expect(await rejected(url, p)).toEqual({ code: 'profile_incomplete', close: CLOSE_CODES.profile_incomplete });
  });

  it('refuses restricted accounts at the handshake', async () => {
    const { url } = await server();
    const p = await player('elig-b');
    await run(SERVICE, `select public.server_add_restriction($1, 'suspended', 'cheating', now() + interval '1 hour', null)`, [p.userId]);
    expect(await rejected(url, p)).toEqual({ code: 'account_restricted', close: CLOSE_CODES.account_restricted });
  });

  it('removes a player restricted while driving, and others see them leave', async () => {
    const { url } = await server({ eligibilityCheckMs: 300 });
    const a = await player('elig-c');
    const b = await player('elig-d');
    await befriend(a, b);
    const A = await join(url, a);
    const B = await join(url, b, { mode: 'friend', friendId: a.userId });
    await run(SERVICE, `select public.server_add_restriction($1, 'banned', 'cheating', null, null)`, [a.userId]);
    expect((await A.c.closed).code).toBe(CLOSE_CODES.account_restricted);
    expect((await B.c.waitFor('player_left', (m) => m.id === a.userId)).reason).toBe('kicked');
  });

  it('removes a player whose account is deleted while driving', async () => {
    const { url } = await server({ eligibilityCheckMs: 300 });
    const a = await player('elig-e');
    const A = await join(url, a);
    await serviceClient().auth.admin.deleteUser(a.userId);
    expect((await A.c.closed).code).toBe(CLOSE_CODES.auth_failed);
  });

  it('never writes access tokens to its logs', async () => {
    const lines: string[] = [];
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')].map((spy) =>
      spy.mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
    );
    try {
      const { url } = await server();
      const a = await player('elig-f');
      const A = await join(url, a);
      A.c.send({ t: 'auth', token: a.accessToken });
      expect(await rejected(url, 'x'.repeat(64))).toMatchObject({ code: 'auth_failed' });
      A.c.send({ t: 'leave' });
      await A.c.closed;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const p of players) expect(all).not.toContain(p.accessToken.split('.')[2]!);
    expect(all).not.toContain('x'.repeat(64));
  });
});
