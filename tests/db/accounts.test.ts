import { afterAll, describe, expect, it } from 'vitest';
import {
  ANON,
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
async function user(label?: string) {
  const u = await createUser(label);
  created.push(u);
  return u;
}

afterAll(async () => {
  await deleteUsers(created);
  await closeDb();
});

describe('new account bootstrap', () => {
  it('creates a profile, wallet, starter car, ledger entry, and starter-neighborhood membership', async () => {
    const u = await user();
    const p = await one(asUser(u), 'select display_name, friend_code, active_vehicle_id from profiles where id = $1', [u.id]);
    expect(p.friend_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(p.display_name).toBe(`Driver-${p.friend_code.slice(0, 4)}`);

    const w = await one(asUser(u), 'select balance from wallets where user_id = $1', [u.id]);
    expect(Number(w.balance)).toBe(500);

    const ledger = await run(asUser(u), 'select delta, balance_after, reason from wallet_ledger where user_id = $1', [u.id]);
    expect(ledger.rows).toEqual([{ delta: '500', balance_after: '500', reason: 'starter_pack' }]);

    const cars = await run(asUser(u), 'select id, model_id, acquired_via from player_vehicles where owner_id = $1', [u.id]);
    expect(cars.rows).toHaveLength(1);
    expect(cars.rows[0]).toMatchObject({ model_id: 'sprout_hatch', acquired_via: 'starter_pack' });
    expect(p.active_vehicle_id).toBe(cars.rows[0]!.id);

    const m = await run(asUser(u), 'select neighborhood_id from neighborhood_memberships where user_id = $1', [u.id]);
    expect(m.rows).toEqual([{ neighborhood_id: STARTER_NEIGHBORHOOD_ID }]);
  });

  it('starter pack grant is idempotent, including under concurrent replays', async () => {
    const u = await user();
    await Promise.all(Array.from({ length: 12 }, () => run(POSTGRES, 'select private.grant_starter_pack($1)', [u.id])));
    const counts = await one(
      POSTGRES,
      `select (select count(*) from player_vehicles where owner_id = $1)::int as cars,
              (select count(*) from wallet_ledger where user_id = $1)::int as entries,
              (select balance from wallets where user_id = $1) as balance`,
      [u.id],
    );
    expect(counts).toEqual({ cars: 1, entries: 1, balance: '500' });
  });
});

describe('row level security: reads', () => {
  it('players cannot read strangers’ profiles, wallets, ledgers, cars, or memberships', async () => {
    const a = await user('a');
    const b = await user('b');
    for (const [table, col] of [
      ['profiles', 'id'],
      ['wallets', 'user_id'],
      ['wallet_ledger', 'user_id'],
      ['player_vehicles', 'owner_id'],
      ['neighborhood_memberships', 'user_id'],
    ] as const) {
      const r = await run(asUser(a), `select * from ${table} where ${col} = $1`, [b.id]);
      expect(r.rows, table).toHaveLength(0);
    }
  });

  it('anonymous requests can read only the vehicle catalog', async () => {
    const catalog = await run(ANON, 'select id from vehicle_models');
    expect(catalog.rows.map((r) => r.id)).toContain('sprout_hatch');
    for (const table of ['profiles', 'wallets', 'wallet_ledger', 'player_vehicles', 'neighborhoods', 'notifications', 'session_presence']) {
      expect(await failure(ANON, `select * from ${table}`), table).toMatch(/permission denied/);
    }
  });

  it('signed-in players can read neighborhoods', async () => {
    const u = await user();
    const r = await run(asUser(u), 'select slug, map_key from neighborhoods');
    expect(r.rows).toContainEqual({ slug: 'copperleaf-commons', map_key: 'copperleaf_v1' });
  });
});

describe('row level security: writes', () => {
  it('players cannot change balances, ledger, or ownership directly', async () => {
    const u = await user();
    expect(await failure(asUser(u), 'update wallets set balance = 999999 where user_id = $1', [u.id])).toMatch(/permission denied/);
    expect(
      await failure(
        asUser(u),
        `insert into wallet_ledger (user_id, delta, balance_after, reason, idempotency_key) values ($1, 100, 600, 'admin_adjustment', 'forged-key-123')`,
        [u.id],
      ),
    ).toMatch(/permission denied/);
    expect(
      await failure(asUser(u), `insert into player_vehicles (owner_id, model_id, acquired_via, grant_key) values ($1, 'sprout_hatch', 'admin', 'forged-car-1')`, [u.id]),
    ).toMatch(/permission denied/);
    expect(await failure(asUser(u), 'delete from player_vehicles where owner_id = $1', [u.id])).toMatch(/permission denied/);
    expect(await failure(asUser(u), `update player_vehicles set owner_id = owner_id where owner_id = $1`, [u.id])).toMatch(/permission denied/);
    expect(await failure(asUser(u), `update profiles set friend_code = 'AAAAAAAA' where id = $1`, [u.id])).toMatch(/permission denied/);
    expect(await failure(asUser(u), `insert into neighborhood_memberships (neighborhood_id, user_id) values ($1, $2)`, [STARTER_NEIGHBORHOOD_ID, u.id])).toMatch(
      /permission denied/,
    );
  });

  it('players can rename themselves within the allowed format, and only themselves', async () => {
    const a = await user('a');
    const b = await user('b');
    await run(asUser(a), `update profiles set display_name = 'Road Runner 7' where id = $1`, [a.id]);
    expect((await one(asUser(a), 'select display_name from profiles where id = $1', [a.id])).display_name).toBe('Road Runner 7');

    expect(await failure(asUser(a), `update profiles set display_name = 'x' where id = $1`, [a.id])).toMatch(/profiles_display_name_format/);
    expect(await failure(asUser(a), `update profiles set display_name = '<script>' where id = $1`, [a.id])).toMatch(/profiles_display_name_format/);

    const r = await run(asUser(a), `update profiles set display_name = 'Hijacked' where id = $1`, [b.id]);
    expect(r.rowCount).toBe(0);
  });

  it('active vehicle must be a car the player owns', async () => {
    const a = await user('a');
    const b = await user('b');
    const bCar = await one(POSTGRES, 'select id from player_vehicles where owner_id = $1', [b.id]);
    expect(await failure(asUser(a), 'update profiles set active_vehicle_id = $2 where id = $1', [a.id, bCar.id])).toMatch(
      /profiles_active_vehicle_owned/,
    );
  });

  it('players can recolor only their own cars, within the palette', async () => {
    const a = await user('a');
    const b = await user('b');
    const aCar = await one(POSTGRES, 'select id from player_vehicles where owner_id = $1', [a.id]);
    const bCar = await one(POSTGRES, 'select id from player_vehicles where owner_id = $1', [b.id]);
    await run(asUser(a), 'update player_vehicles set color_index = 5 where id = $1', [aCar.id]);
    expect((await one(asUser(a), 'select color_index from player_vehicles where id = $1', [aCar.id])).color_index).toBe(5);
    expect(await failure(asUser(a), 'update player_vehicles set color_index = 99 where id = $1', [aCar.id])).toMatch(/check constraint/);
    expect((await run(asUser(a), 'update player_vehicles set color_index = 1 where id = $1', [bCar.id])).rowCount).toBe(0);
  });
});

describe('function privileges', () => {
  it('clients cannot call private wallet functions or server-only RPCs', async () => {
    const u = await user();
    expect(
      await failure(asUser(u), `select * from private.apply_wallet_delta($1, 1000000, 'admin_adjustment', 'self-grant-0001')`, [u.id]),
    ).toMatch(/permission denied/);
    expect(await failure(asUser(u), 'select private.grant_starter_pack($1)', [u.id])).toMatch(/permission denied/);
    for (const call of [
      'server_get_player($1)',
      'server_get_neighborhood($1)',
      'server_set_presence($1, $1)',
      'server_clear_presence($1, $1)',
      'server_close_instance($1)',
    ]) {
      expect(await failure(asUser(u), `select public.${call}`, [u.id]), call).toMatch(/permission denied/);
      expect(await failure(ANON, `select public.${call}`, [u.id]), call).toMatch(/permission denied/);
    }
    expect(await failure(asUser(u), `select public.server_reap_stale_instances(10)`)).toMatch(/permission denied/);
  });

  it('the service role can load a player loadout from the database', async () => {
    const u = await user();
    const r = await one(SERVICE, 'select public.server_get_player($1) as p', [u.id]);
    expect(r.p).toMatchObject({
      user_id: u.id,
      vehicle: { model_id: 'sprout_hatch', color_index: 0 },
      friend_ids: [],
      neighborhood_ids: [STARTER_NEIGHBORHOOD_ID],
    });
    const missing = await one(SERVICE, 'select public.server_get_player(gen_random_uuid()) as p');
    expect(missing.p).toBeNull();
  });
});
