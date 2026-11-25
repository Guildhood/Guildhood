// Phase 2: account restrictions, audit privacy, privileged-function grants, and the database side
// of account deletion (the Edge Function itself is tested in account-deletion.test.ts).
import { afterAll, describe, expect, it } from 'vitest';
import { ANON, POSTGRES, SERVICE, asUser, closeDb, createUser, deleteUsers, failure, one, onboard, run, type TestUser } from '../support/db.ts';

const created: TestUser[] = [];
async function user(label = 'mod') {
  const u = await createUser(label);
  created.push(u);
  return u;
}
afterAll(async () => {
  await deleteUsers(created);
  await closeDb();
});

const status = async (u: TestUser) => (await one(asUser(u), 'select public.get_my_account_status() as s')).s;
const restrict = async (u: TestUser, type = 'suspended', expires: string | null = "now() + interval '1 day'") =>
  (await one(SERVICE, `select public.server_add_restriction($1, $2, 'harassment', ${expires ?? 'null'}, 'Internal evidence: message ids 1,2,3') as id`, [u.id, type])).id as string;

describe('account restrictions', () => {
  it('clients cannot read or write restrictions, moderator notes, or audit events', async () => {
    const u = await user();
    await restrict(u);
    for (const sql of [
      'select * from account_restrictions',
      `insert into account_restrictions (user_id, restriction_type, reason_code) values ('${u.id}', 'banned', 'other')`,
      'delete from account_restrictions',
      'select * from private.moderation_notes',
      'select * from private.audit_events',
    ]) {
      expect(await failure(asUser(u), sql), sql).toMatch(/permission denied/);
      expect(await failure(ANON, sql), sql).toMatch(/permission denied/);
    }
  });

  it('players see their own status without notes; restricted players cannot mutate', async () => {
    const u = await user();
    const other = await user();
    expect(await status(u)).toEqual({ status: 'active' });
    const id = await restrict(u);
    const s = await status(u);
    expect(s).toMatchObject({ status: 'restricted', restriction_type: 'suspended', reason_code: 'harassment' });
    expect(JSON.stringify(s)).not.toMatch(/evidence|message ids/i);
    expect(await status(other)).toEqual({ status: 'active' });

    for (const sql of [
      "select public.claim_username('restricted_x')",
      `select public.update_my_profile('{"display_name": "Sneaky"}')`,
      "select public.send_friend_request('ABCDEFGH')",
    ]) {
      expect(await failure(asUser(u), sql), sql).toMatch(/account_restricted/);
    }
    // Reading their own data still works (they can see why, sign out, or delete their account).
    expect((await run(asUser(u), 'select id from profiles where id = $1', [u.id])).rowCount).toBe(1);

    await run(SERVICE, `select public.server_lift_restriction($1, 'Appeal accepted')`, [id]);
    expect(await status(u)).toEqual({ status: 'active' });
    const events = await run(POSTGRES, `select event_type from private.audit_events where user_id = $1 and event_type like 'restriction%' order by id`, [u.id]);
    expect(events.rows.map((r) => r.event_type)).toEqual(['restriction_added', 'restriction_lifted']);
  });

  it('expired restrictions no longer apply', async () => {
    const u = await user();
    await run(POSTGRES, `insert into account_restrictions (user_id, restriction_type, reason_code, effective_at, expires_at)
                         values ($1, 'suspended', 'spam', now() - interval '2 days', now() - interval '1 day')`, [u.id]);
    expect(await status(u)).toEqual({ status: 'active' });
  });

  it('the game server sees eligibility in the player loadout', async () => {
    const u = await user();
    let p = (await one(SERVICE, 'select public.server_get_player($1) as p', [u.id])).p;
    expect(p).toMatchObject({ onboarding_complete: false, restriction: null, username: null });
    await onboard(u, `elig_${u.id.slice(0, 6)}`);
    await restrict(u, 'banned', null);
    p = (await one(SERVICE, 'select public.server_get_player($1) as p', [u.id])).p;
    expect(p).toMatchObject({ onboarding_complete: true, restriction: { restriction_type: 'banned', expires_at: null } });
  });

  it('privileged functions reject players and anonymous callers', async () => {
    const u = await user();
    for (const call of [
      `public.server_add_restriction('${u.id}', 'banned', 'other', null, 'x')`,
      `public.server_lift_restriction('${u.id}', 'x')`,
      `public.server_begin_account_deletion('${u.id}', 'r1')`,
      `public.server_finish_account_deletion('${u.id}', 'r1')`,
      `public.server_get_player('${u.id}')`,
    ]) {
      expect(await failure(asUser(u), `select ${call}`), call).toMatch(/permission denied/);
      expect(await failure(ANON, `select ${call}`), call).toMatch(/permission denied/);
    }
  });
});

describe('account deletion (database side)', () => {
  it('removes the player’s traces from others’ data, cascades their own rows, and keeps a minimal audit trail', async () => {
    const leaving = await user('leaving');
    const friend = await user('friend');
    await onboard(leaving, `bye_${leaving.id.slice(0, 6)}`);
    await run(asUser(leaving), 'select public.claim_username($1)', [`bye2_${leaving.id.slice(0, 6)}`]);
    const friendCode = (await one(POSTGRES, 'select friend_code from profiles where id = $1', [friend.id])).friend_code;
    await run(asUser(leaving), 'select public.send_friend_request($1)', [friendCode]);
    await run(POSTGRES, `insert into notifications (user_id, kind, payload) values ($1, 'session_invite', $2)`, [
      friend.id,
      JSON.stringify({ from_user: leaving.id, from_name: 'Leaving', instance_id: leaving.id }),
    ]);

    const begun = (await one(SERVICE, `select public.server_begin_account_deletion($1, 'req-1') as r`, [leaving.id])).r;
    expect(begun).toMatchObject({ status: 'ready', invites_removed: 1, notifications_anonymized: 1 });
    const inbox = await run(POSTGRES, 'select kind, payload from notifications where user_id = $1', [friend.id]);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]!.payload).toMatchObject({ from_name: 'A deleted player' });
    expect(JSON.stringify(inbox.rows[0]!.payload)).not.toContain(leaving.id);

    expect(await failure(SERVICE, `select public.server_finish_account_deletion($1, 'req-1')`, [leaving.id])).toMatch(/deletion_incomplete/);

    await run(POSTGRES, 'delete from auth.users where id = $1', [leaving.id]); // what Auth's admin delete does
    await run(SERVICE, `select public.server_finish_account_deletion($1, 'req-1')`, [leaving.id]);
    await run(SERVICE, `select public.server_finish_account_deletion($1, 'req-1')`, [leaving.id]); // retry-safe

    for (const [table, col] of [
      ['profiles', 'id'], ['profile_private', 'user_id'], ['wallets', 'user_id'], ['wallet_ledger', 'user_id'],
      ['player_vehicles', 'owner_id'], ['neighborhood_memberships', 'user_id'], ['notifications', 'user_id'],
      ['friend_requests', 'from_user'], ['session_presence', 'user_id'], ['account_restrictions', 'user_id'],
    ] as const) {
      expect((await run(POSTGRES, `select 1 from ${table} where ${col} = $1`, [leaving.id])).rowCount, table).toBe(0);
    }
    const audit = await run(POSTGRES, 'select event_type, details from private.audit_events where user_id = $1 order by id', [leaving.id]);
    const types = audit.rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['profile_created', 'username_changed', 'account_deletion_requested', 'account_deleted']));
    expect(types.filter((t) => t === 'account_deleted')).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toMatch(/bye_|bye2_/); // usernames stripped from the retained trail
  });

  it('beginning deletion for an account that no longer exists is a safe no-op', async () => {
    const r = (await one(SERVICE, `select public.server_begin_account_deletion(gen_random_uuid(), 'req-x') as r`)).r;
    expect(r).toEqual({ status: 'not_found' });
  });
});
