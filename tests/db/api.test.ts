// End-to-end checks through the real Supabase stack: Auth (email code), the Data API, and Realtime.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { anonClient, deleteAuthUsers, serviceClient, signInWithEmailCode, type SignedInPlayer } from '../support/auth.ts';
import { STARTER_NEIGHBORHOOD_ID } from '../support/db.ts';

const players: SignedInPlayer[] = [];
const channels: RealtimeChannel[] = [];
async function player(label: string) {
  const p = await signInWithEmailCode(label);
  players.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(channels.map((c) => c.unsubscribe()));
  await deleteAuthUsers(players.map((p) => p.userId));
});

function waitFor<T>(register: (resolve: (v: T) => void) => void, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    register((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

// SUBSCRIBED fires before the database change feed is attached; Realtime confirms the latter with
// a "system" message from the postgres_changes extension. Wait for that, retrying transport
// failures (Realtime restarts briefly after `supabase db reset`).
async function subscribed(make: () => RealtimeChannel, client: { removeChannel(c: RealtimeChannel): unknown }): Promise<void> {
  const deadline = Date.now() + 75_000;
  for (;;) {
    const channel = make();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('postgres_changes never became ready')), 15_000);
        channel.on('system', {}, (msg: { extension?: string; status?: string }) => {
          if (msg.extension === 'postgres_changes' && msg.status === 'ok') {
            clearTimeout(timer);
            resolve();
          }
        });
        channel.subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timer);
            reject(err ?? new Error(status));
          }
        });
      });
      channels.push(channel);
      return;
    } catch (err) {
      await client.removeChannel(channel);
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

describe('Data API as a signed-in player', () => {
  it('email-code sign-in yields a starter account readable only by its owner', async () => {
    const a = await player('api-a');
    const { data: wallet } = await a.client.from('wallets').select('balance').single();
    expect(wallet).toEqual({ balance: 500 });
    const { data: cars } = await a.client.from('player_vehicles').select('model_id');
    expect(cars).toEqual([{ model_id: 'sprout_hatch' }]);
  });

  it('rejects forged balance updates and server-only RPCs over HTTP', async () => {
    const a = await player('api-b');
    const upd = await a.client.from('wallets').update({ balance: 1_000_000 }).eq('user_id', a.userId);
    expect(upd.error?.message).toMatch(/permission denied/);

    const rpc = await a.client.rpc('server_get_player', { p_user_id: a.userId });
    expect(rpc.error?.message).toMatch(/permission denied/);

    const anon = await anonClient().rpc('server_set_presence', { p_user_id: a.userId, p_instance_id: a.userId });
    expect(anon.error).not.toBeNull();

    const { data: wallet } = await a.client.from('wallets').select('balance').single();
    expect(wallet).toEqual({ balance: 500 });
  });

  it('the server secret key can call server-only RPCs', async () => {
    const a = await player('api-c');
    const { data, error } = await serviceClient().rpc('server_get_player', { p_user_id: a.userId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ user_id: a.userId, neighborhood_ids: [STARTER_NEIGHBORHOOD_ID] });
  });
});

describe('Realtime notifications', () => {
  it('delivers a friend request to the recipient only', { timeout: 150_000 }, async () => {
    const a = await player('rt-a');
    const b = await player('rt-b');
    const eavesdropper = await player('rt-c');

    let deliveredToB: ((v: Record<string, unknown>) => void) | undefined;
    let deliveredToC: ((v: Record<string, unknown>) => void) | undefined;
    const gotB = waitFor<Record<string, unknown>>((r) => (deliveredToB = r), 15_000);
    const gotC = waitFor<Record<string, unknown>>((r) => (deliveredToC = r), 6_000);

    await subscribed(
      () =>
        b.client
          .channel(`notes-${b.userId}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${b.userId}` }, (p) =>
            deliveredToB?.(p.new),
          ),
      b.client,
    );
    // No filter: RLS alone must stop C from seeing B's rows.
    await subscribed(
      () =>
        eavesdropper.client
          .channel(`notes-eaves-${eavesdropper.userId}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (p) => deliveredToC?.(p.new)),
      eavesdropper.client,
    );

    const { data: code } = await b.client.from('profiles').select('friend_code').single();
    const sent = await a.client.rpc('send_friend_request', { p_friend_code: code!.friend_code });
    expect(sent.error).toBeNull();

    const note = await gotB;
    expect(note).not.toBe('timeout');
    expect(note).toMatchObject({ kind: 'friend_request', user_id: b.userId });
    expect(await gotC).toBe('timeout');
  });
});
