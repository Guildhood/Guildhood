// Phase 2: the delete-account Edge Function, called over HTTP exactly as the app calls it.
import { afterAll, describe, expect, it } from 'vitest';
import { anonClient, deleteAuthUsers, registerPlayer, serviceClient } from '../support/auth.ts';
import { localEnv } from '../support/env.ts';
import { POSTGRES, closeDb, one, run } from '../support/db.ts';

const userIds: string[] = [];
afterAll(async () => {
  await deleteAuthUsers(userIds);
  await closeDb();
});

const fnUrl = () => `${localEnv().SUPABASE_URL}/functions/v1/delete-account`;
async function callDelete(token: string | null, body: unknown) {
  const res = await fetch(fnUrl(), {
    method: 'POST',
    headers: {
      apikey: localEnv().SUPABASE_PUBLISHABLE_KEY,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('delete-account Edge Function', () => {
  it('requires a valid session and a well-formed request', async () => {
    expect((await callDelete(null, { password: 'x' })).body).toMatchObject({ error: 'not_authenticated' });
    expect(await callDelete('not.a.jwt', { password: 'x' })).toMatchObject({ status: 401, body: { error: 'session_expired' } });
    const p = await registerPlayer('delbad');
    userIds.push(p.userId);
    expect(await callDelete(p.accessToken, '{oops')).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect(await callDelete(p.accessToken, { password: '' })).toMatchObject({ status: 400, body: { error: 'bad_request' } });
  });

  it('refuses a wrong password and limits attempts per account', async () => {
    const p = await registerPlayer('delpw', { onboard: true });
    userIds.push(p.userId);
    for (let i = 0; i < 5; i++) {
      expect(await callDelete(p.accessToken, { password: 'Wrongpass999' })).toMatchObject({ status: 403, body: { error: 'invalid_password' } });
    }
    // Even the right password is refused once the limit is reached.
    expect(await callDelete(p.accessToken, { password: p.password })).toMatchObject({ status: 429, body: { error: 'too_many_attempts' } });
    expect((await one(POSTGRES, 'select count(*)::int as n from profiles where id = $1', [p.userId])).n).toBe(1);
  });

  it('deletes the account and its data, is retry-safe, and leaves no way back in', async () => {
    const leaving = await registerPlayer('delok', { onboard: true });
    const friend = await registerPlayer('delfr', { onboard: true });
    userIds.push(friend.userId);
    const { data: code } = await friend.client.from('profiles').select('friend_code').single();
    expect((await leaving.client.rpc('send_friend_request', { p_friend_code: code!.friend_code })).error).toBeNull();
    const refreshToken = (await leaving.client.auth.getSession()).data.session!.refresh_token;

    const first = await callDelete(leaving.accessToken, { password: leaving.password });
    expect(first).toMatchObject({ status: 200, body: { status: 'deleted' } });

    // Gone from Auth and from every table that belonged to the player.
    expect((await serviceClient().auth.admin.getUserById(leaving.userId)).error).not.toBeNull();
    for (const [table, col] of [['profiles', 'id'], ['wallets', 'user_id'], ['player_vehicles', 'owner_id'], ['friend_requests', 'from_user'], ['profile_private', 'user_id']] as const) {
      expect((await run(POSTGRES, `select 1 from ${table} where ${col} = $1`, [leaving.userId])).rowCount, table).toBe(0);
    }
    // The friend's inbox no longer names them.
    const inbox = await run(POSTGRES, `select payload from notifications where user_id = $1`, [friend.userId]);
    expect(JSON.stringify(inbox.rows)).not.toContain(leaving.userId);
    // A minimal audit trail remains.
    const audit = await run(POSTGRES, `select event_type from private.audit_events where user_id = $1`, [leaving.userId]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['account_deletion_requested', 'account_deleted']));

    // A retry after a lost response is answered as success, without duplicating the record.
    expect(await callDelete(leaving.accessToken, { password: leaving.password })).toMatchObject({ status: 200, body: { status: 'deleted', already_deleted: true } });
    expect((await one(POSTGRES, `select count(*)::int as n from private.audit_events where user_id = $1 and event_type = 'account_deleted'`, [leaving.userId])).n).toBe(1);

    // No way back in: password sign-in, the old refresh token, and the old access token all fail.
    expect((await anonClient().auth.signInWithPassword({ email: leaving.email, password: leaving.password })).error?.code).toBe('invalid_credentials');
    expect((await anonClient().auth.refreshSession({ refresh_token: refreshToken })).error).not.toBeNull();
    const stale = leaving.client; // still holds the (unexpired) access token
    expect((await stale.auth.getUser()).error).not.toBeNull();
    const reads = await stale.from('wallets').select('balance');
    expect(reads.data ?? []).toEqual([]);
    expect((await stale.rpc('claim_username', { p_username: 'zombie_player' })).error).not.toBeNull();
  });

  it('the same email can register again as a brand-new account', async () => {
    const first = await registerPlayer('again');
    await callDelete(first.accessToken, { password: first.password });
    const { data, error } = await anonClient().auth.signUp({ email: first.email, password: 'Another123' });
    expect(error).toBeNull();
    expect(data.user?.id).not.toBe(first.userId);
    if (data.user) userIds.push(data.user.id);
  });
});
