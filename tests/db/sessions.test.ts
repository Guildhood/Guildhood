import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  POSTGRES,
  SERVICE,
  STARTER_NEIGHBORHOOD_ID,
  asUser,
  closeDb,
  createUser,
  deleteUsers,
  failure,
  one,
  run,
  type TestUser,
} from '../support/db.ts';

const created: TestUser[] = [];
const instances: string[] = [];
async function user(label = 'sess') {
  const u = await createUser(label);
  created.push(u);
  return u;
}

afterAll(async () => {
  await run(POSTGRES, 'update session_presence set instance_id = null where instance_id = any($1::uuid[])', [instances]);
  await run(POSTGRES, 'delete from session_instances where id = any($1::uuid[])', [instances]);
  await deleteUsers(created);
  await closeDb();
});

async function befriend(a: TestUser, b: TestUser) {
  await run(POSTGRES, 'select private.make_friends($1, $2)', [a.id, b.id]);
}

async function openInstance(serverId = 'test-server') {
  const id = randomUUID();
  instances.push(id);
  await run(SERVICE, 'select public.server_open_instance($1, $2, $3, 8)', [id, STARTER_NEIGHBORHOOD_ID, serverId]);
  return id;
}

const overview = async (u: TestUser) => (await one(asUser(u), 'select public.get_social_overview() as o')).o;

describe('live session registry (server-only writes)', () => {
  it('clients cannot create or modify instances or presence', async () => {
    const a = await user();
    expect(
      await failure(asUser(a), `insert into session_instances (id, neighborhood_id, server_id, capacity) values (gen_random_uuid(), $1, 'evil', 8)`, [
        STARTER_NEIGHBORHOOD_ID,
      ]),
    ).toMatch(/permission denied/);
    expect(await failure(asUser(a), `insert into session_presence (user_id) values ($1)`, [a.id])).toMatch(/permission denied/);
    expect(await failure(asUser(a), `select public.server_open_instance(gen_random_uuid(), $1, 'evil', 8)`, [STARTER_NEIGHBORHOOD_ID])).toMatch(
      /permission denied/,
    );
  });

  it('friends see where you are; strangers do not', async () => {
    const a = await user('a');
    const b = await user('b');
    const stranger = await user('s');
    await befriend(a, b);
    const inst = await openInstance();
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, inst]);

    expect((await overview(b)).friends).toMatchObject([
      { user_id: a.id, online: true, instance_id: inst, neighborhood_name: 'Copperleaf Commons', capacity: 8 },
    ]);
    expect((await run(asUser(b), 'select instance_id from session_presence where user_id = $1', [a.id])).rows).toEqual([{ instance_id: inst }]);
    expect((await run(asUser(stranger), 'select 1 from session_presence where user_id = $1', [a.id])).rowCount).toBe(0);
  });

  it('clear_presence only clears the instance the player is still in', async () => {
    const a = await user();
    const old = await openInstance();
    const current = await openInstance();
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, old]);
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, current]);
    await run(SERVICE, 'select public.server_clear_presence($1, $2)', [a.id, old]);
    expect((await one(POSTGRES, 'select instance_id from session_presence where user_id = $1', [a.id])).instance_id).toBe(current);
    await run(SERVICE, 'select public.server_clear_presence($1, $2)', [a.id, current]);
    expect((await one(POSTGRES, 'select instance_id from session_presence where user_id = $1', [a.id])).instance_id).toBeNull();
  });

  it('heartbeats only update instances owned by the reporting server', async () => {
    const mine = await openInstance('server-a');
    const theirs = await openInstance('server-b');
    const n = await one(SERVICE, 'select public.server_heartbeat($1, $2) as n', [
      'server-a',
      JSON.stringify([
        { id: mine, player_count: 3 },
        { id: theirs, player_count: 7 },
      ]),
    ]);
    expect(n.n).toBe(1);
    const rows = await run(POSTGRES, 'select id, player_count from session_instances where id = any($1::uuid[])', [[mine, theirs]]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.player_count]))).toEqual({ [mine]: 3, [theirs]: 0 });
  });

  it('a stale heartbeat shows friends offline, and reaping closes the instance and clears presence', async () => {
    const a = await user('a');
    const b = await user('b');
    await befriend(a, b);
    const inst = await openInstance('crashed-server');
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, inst]);
    await run(POSTGRES, `update session_instances set last_heartbeat_at = now() - interval '2 minutes' where id = $1`, [inst]);

    expect((await overview(b)).friends).toMatchObject([{ user_id: a.id, online: false, instance_id: null }]);

    const reaped = await one(SERVICE, 'select public.server_reap_stale_instances(45) as n');
    expect(reaped.n).toBeGreaterThanOrEqual(1);
    expect((await one(POSTGRES, 'select status from session_instances where id = $1', [inst])).status).toBe('closed');
    expect((await one(POSTGRES, 'select instance_id from session_presence where user_id = $1', [a.id])).instance_id).toBeNull();
  });

  it('closing an instance clears everyone’s presence in it', async () => {
    const a = await user();
    const inst = await openInstance();
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, inst]);
    await run(SERVICE, 'select public.server_close_instance($1)', [inst]);
    expect((await one(POSTGRES, 'select instance_id from session_presence where user_id = $1', [a.id])).instance_id).toBeNull();
    // Closed instances cannot receive presence.
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, inst]);
    expect((await one(POSTGRES, 'select instance_id from session_presence where user_id = $1', [a.id])).instance_id).toBeNull();
  });
});

describe('session invites', () => {
  it('requires friendship and a live instance, and is throttled', async () => {
    const a = await user('a');
    const b = await user('b');
    const stranger = await user('s');
    await befriend(a, b);

    expect(await failure(asUser(a), 'select public.invite_friend_to_session($1)', [b.id])).toMatch(/not_in_session/);

    const inst = await openInstance();
    await run(SERVICE, 'select public.server_set_presence($1, $2)', [a.id, inst]);
    expect(await failure(asUser(a), 'select public.invite_friend_to_session($1)', [stranger.id])).toMatch(/not_friends/);

    expect((await one(asUser(a), 'select public.invite_friend_to_session($1) as r', [b.id])).r).toEqual({ status: 'sent' });
    expect((await one(asUser(a), 'select public.invite_friend_to_session($1) as r', [b.id])).r).toEqual({ status: 'throttled' });

    const invites = await run(asUser(b), `select payload from notifications where user_id = $1 and kind = 'session_invite'`, [b.id]);
    expect(invites.rows).toHaveLength(1);
    expect(invites.rows[0]!.payload).toMatchObject({ instance_id: inst, from_user: a.id, neighborhood_id: STARTER_NEIGHBORHOOD_ID });
  });
});
