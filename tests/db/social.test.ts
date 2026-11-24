import { afterAll, describe, expect, it } from 'vitest';
import { POSTGRES, asUser, closeDb, createUser, deleteUsers, failure, one, run, type TestUser } from '../support/db.ts';

const created: TestUser[] = [];
async function user(label = 'social') {
  const u = await createUser(label);
  created.push(u);
  return u;
}

afterAll(async () => {
  await deleteUsers(created);
  await closeDb();
});

const codeOf = async (u: TestUser) => (await one(POSTGRES, 'select friend_code from profiles where id = $1', [u.id])).friend_code as string;
const send = async (from: TestUser, code: string) =>
  (await one(asUser(from), 'select public.send_friend_request($1) as r', [code])).r as { status: string; request_id: string | null };
const respond = async (u: TestUser, requestId: string, accept: boolean) =>
  (await one(asUser(u), 'select public.respond_friend_request($1, $2) as r', [requestId, accept])).r as { status: string };
const overview = async (u: TestUser) => (await one(asUser(u), 'select public.get_social_overview() as o')).o;
const canSeeProfile = async (viewer: TestUser, target: TestUser) =>
  (await run(asUser(viewer), 'select 1 from profiles where id = $1', [target.id])).rowCount === 1;

describe('friend requests', () => {
  it('send by code (case- and dash-insensitive), notify, accept, and become friends', async () => {
    const a = await user('a');
    const b = await user('b');
    const c = await user('c');
    const code = await codeOf(b);

    const sent = await send(a, `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(sent.status).toBe('sent');

    // B is notified; nobody else can read that notification.
    const notes = await run(asUser(b), `select kind, payload from notifications where user_id = $1`, [b.id]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({ kind: 'friend_request', payload: { from_user: a.id } });
    expect((await run(asUser(a), 'select 1 from notifications where user_id = $1', [b.id])).rowCount).toBe(0);

    // Pending counterparts can see each other's profile; a stranger cannot.
    expect(await canSeeProfile(a, b)).toBe(true);
    expect(await canSeeProfile(b, a)).toBe(true);
    expect(await canSeeProfile(c, a)).toBe(false);

    expect((await overview(b)).incoming).toMatchObject([{ user_id: a.id, request_id: sent.request_id }]);
    expect((await overview(a)).outgoing).toMatchObject([{ user_id: b.id }]);

    // Only the recipient can respond.
    expect(await failure(asUser(a), 'select public.respond_friend_request($1, true)', [sent.request_id])).toMatch(/request_not_found/);
    expect((await respond(b, sent.request_id!, true)).status).toBe('accepted');

    expect((await overview(a)).friends).toMatchObject([{ user_id: b.id, online: false }]);
    expect((await overview(b)).friends).toMatchObject([{ user_id: a.id, online: false }]);
    const accepted = await run(asUser(a), `select payload from notifications where user_id = $1 and kind = 'friend_request_accepted'`, [a.id]);
    expect(accepted.rows).toHaveLength(1);

    expect((await send(a, code)).status).toBe('already_friends');
  });

  it('a request in the opposite direction auto-accepts the pending one', async () => {
    const a = await user('a');
    const b = await user('b');
    await send(a, await codeOf(b));
    expect((await send(b, await codeOf(a))).status).toBe('accepted');
    expect((await overview(a)).friends).toHaveLength(1);
  });

  it('rejects self, unknown, malformed, and duplicate requests', async () => {
    const a = await user('a');
    const b = await user('b');
    expect(await failure(asUser(a), 'select public.send_friend_request($1)', [await codeOf(a)])).toMatch(/cannot_friend_self/);
    expect(await failure(asUser(a), 'select public.send_friend_request($1)', ['ZZZZZZZZ'])).toMatch(/friend_code_not_found/);
    expect(await failure(asUser(a), 'select public.send_friend_request($1)', ['short'])).toMatch(/invalid_friend_code/);
    expect((await send(a, await codeOf(b))).status).toBe('sent');
    expect((await send(a, await codeOf(b))).status).toBe('already_pending');
  });

  it('concurrent opposite requests end as exactly one friendship', async () => {
    const a = await user('a');
    const b = await user('b');
    const [ca, cb] = [await codeOf(a), await codeOf(b)];
    await Promise.all([send(a, cb), send(b, ca)]);
    const n = await one(POSTGRES, 'select count(*)::int as n from friendships where user_low = least($1::uuid, $2::uuid) and user_high = greatest($1::uuid, $2::uuid)', [
      a.id,
      b.id,
    ]);
    expect(n.n).toBe(1);
  });

  it('decline and cancel leave no friendship', async () => {
    const a = await user('a');
    const b = await user('b');
    const c = await user('c');
    const r1 = await send(a, await codeOf(b));
    expect((await respond(b, r1.request_id!, false)).status).toBe('declined');
    const r2 = await send(a, await codeOf(c));
    expect((await one(asUser(a), 'select public.cancel_friend_request($1) as r', [r2.request_id])).r).toEqual({ status: 'cancelled' });
    expect(await failure(asUser(c), 'select public.cancel_friend_request($1)', [r2.request_id])).toMatch(/request_not_found/);
    expect((await overview(a)).friends).toHaveLength(0);
    expect(await canSeeProfile(a, b)).toBe(false);
  });

  it('removing a friend hides their profile again', async () => {
    const a = await user('a');
    const b = await user('b');
    await send(a, await codeOf(b));
    await send(b, await codeOf(a));
    expect(await canSeeProfile(a, b)).toBe(true);
    await run(asUser(a), 'select public.remove_friend($1)', [b.id]);
    expect(await canSeeProfile(a, b)).toBe(false);
    expect(await failure(asUser(a), 'select public.remove_friend($1)', [b.id])).toMatch(/not_friends/);
  });

  it('clients cannot write friendships, requests, or notifications directly', async () => {
    const a = await user('a');
    const b = await user('b');
    expect(await failure(asUser(a), 'insert into friendships (user_low, user_high) values (least($1::uuid,$2::uuid), greatest($1::uuid,$2::uuid))', [a.id, b.id])).toMatch(
      /permission denied/,
    );
    expect(await failure(asUser(a), `insert into friend_requests (from_user, to_user, status) values ($2, $1, 'accepted')`, [a.id, b.id])).toMatch(
      /permission denied/,
    );
    expect(await failure(asUser(a), `insert into notifications (user_id, kind) values ($1, 'session_invite')`, [b.id])).toMatch(/permission denied/);
  });

  it('mark_notifications_read only touches the caller’s notifications', async () => {
    const a = await user('a');
    const b = await user('b');
    await send(a, await codeOf(b));
    const note = await one(POSTGRES, 'select id from notifications where user_id = $1', [b.id]);
    expect((await one(asUser(a), 'select public.mark_notifications_read($1) as n', [[note.id]])).n).toBe(0);
    expect((await one(asUser(b), 'select public.mark_notifications_read($1) as n', [[note.id]])).n).toBe(1);
  });
});
