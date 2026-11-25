// Phase 2: authentication flows against the real local Supabase Auth (GoTrue) and mail catcher.
import { randomUUID } from 'node:crypto';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { TERMS_VERSION, TEST_PASSWORD, anonClient, deleteAuthUsers, readEmail, registerPlayer, serviceClient } from '../support/auth.ts';
import { localEnv } from '../support/env.ts';
import { POSTGRES, closeDb, run } from '../support/db.ts';

const userIds: string[] = [];
afterAll(async () => {
  await deleteAuthUsers(userIds);
  await closeDb();
});

const newEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;
const tokenHashOf = (link: string | null) => new URL(link!).searchParams.get('token_hash')!;

/** A Map-backed storage, standing in for the browser's localStorage across "app launches". */
function memoryStorage(): SupportedStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
function appClient(storage: SupportedStorage) {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = localEnv();
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage, storageKey: 'guildhood-auth', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

describe('registration and email verification', () => {
  it('signs up with a password, cannot sign in before verifying, and verifies by code', async () => {
    const email = newEmail('reg');
    const c = anonClient();
    const since = Date.now();
    const up = await c.auth.signUp({ email, password: TEST_PASSWORD, options: { data: { terms_version: TERMS_VERSION } } });
    expect(up.error).toBeNull();
    expect(up.data.session).toBeNull(); // verification required
    userIds.push(up.data.user!.id);

    expect((await anonClient().auth.signInWithPassword({ email, password: TEST_PASSWORD })).error?.code).toBe('email_not_confirmed');

    const mail = await readEmail(email, since);
    expect(mail.subject).toBe('Confirm your Guildhood account');
    expect(mail.code).toMatch(/^\d{6}$/);
    const v = await c.auth.verifyOtp({ email, token: mail.code!, type: 'signup' });
    expect(v.error).toBeNull();
    expect(v.data.session).not.toBeNull();
    expect((await anonClient().auth.signInWithPassword({ email, password: TEST_PASSWORD })).error).toBeNull();
  });

  it('verifies by the emailed link (token hash) as well, once only', async () => {
    const email = newEmail('link');
    const since = Date.now();
    const up = await anonClient().auth.signUp({ email, password: TEST_PASSWORD, options: { emailRedirectTo: 'http://localhost:5173/' } });
    userIds.push(up.data.user!.id);
    const { link } = await readEmail(email, since);
    expect(link).toMatch(/^http:\/\/localhost:5173\/\?type=signup&token_hash=/);
    const ok = await anonClient().auth.verifyOtp({ token_hash: tokenHashOf(link), type: 'signup' });
    expect(ok.error).toBeNull();
    const again = await anonClient().auth.verifyOtp({ token_hash: tokenHashOf(link), type: 'signup' });
    expect(again.error?.code).toBe('otp_expired');
  });

  it('rejects weak passwords and malformed or wrong-flow links', async () => {
    expect((await anonClient().auth.signUp({ email: newEmail('weak'), password: 'short1' })).error?.code).toBe('weak_password');
    expect((await anonClient().auth.signUp({ email: newEmail('weak'), password: 'lettersonly' })).error?.code).toBe('weak_password');
    expect((await anonClient().auth.verifyOtp({ token_hash: 'not-a-real-token', type: 'signup' })).error?.code).toBe('otp_expired');

    const email = newEmail('flow');
    const since = Date.now();
    const up = await anonClient().auth.signUp({ email, password: TEST_PASSWORD });
    userIds.push(up.data.user!.id);
    const { link } = await readEmail(email, since);
    // A verification link presented as a password-recovery link is refused.
    expect((await anonClient().auth.verifyOtp({ token_hash: tokenHashOf(link), type: 'recovery' })).error?.code).toBe('otp_expired');
  });

  it('resending sends a fresh code that verifies', async () => {
    const email = newEmail('resend');
    const up = await anonClient().auth.signUp({ email, password: TEST_PASSWORD });
    userIds.push(up.data.user!.id);
    await new Promise((r) => setTimeout(r, 1100)); // local resend cooldown is 1 s (production: 60 s)
    const since = Date.now();
    expect((await anonClient().auth.resend({ type: 'signup', email })).error).toBeNull();
    const { code } = await readEmail(email, since);
    expect((await anonClient().auth.verifyOtp({ email, token: code!, type: 'signup' })).error).toBeNull();
  });
});

describe('sign-in, sign-out, and sessions', () => {
  it('rejects wrong passwords and unknown accounts with the same error', async () => {
    const p = await registerPlayer('signin');
    userIds.push(p.userId);
    expect((await anonClient().auth.signInWithPassword({ email: p.email, password: 'Wrongpass123' })).error?.code).toBe('invalid_credentials');
    expect((await anonClient().auth.signInWithPassword({ email: newEmail('ghost'), password: TEST_PASSWORD })).error?.code).toBe('invalid_credentials');
  });

  it('restores a persisted session on the next launch and refreshes it', async () => {
    const p = await registerPlayer('restore');
    userIds.push(p.userId);
    const storage = memoryStorage();
    expect((await appClient(storage).auth.signInWithPassword({ email: p.email, password: p.password })).error).toBeNull();
    expect([...storage.data.keys()]).toContain('guildhood-auth');
    expect(JSON.stringify([...storage.data.values()])).not.toContain(p.password);

    const relaunched = appClient(storage); // new client, same storage = app reopened
    const { data } = await relaunched.auth.getSession();
    expect(data.session?.user.id).toBe(p.userId);
    const refreshed = await relaunched.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect((await relaunched.auth.getUser()).data.user?.id).toBe(p.userId);
  });

  it('sign-out revokes the refresh token and clears stored session data', async () => {
    const p = await registerPlayer('signout');
    userIds.push(p.userId);
    const storage = memoryStorage();
    const c = appClient(storage);
    const { data } = await c.auth.signInWithPassword({ email: p.email, password: p.password });
    const refreshToken = data.session!.refresh_token;
    expect((await c.auth.signOut()).error).toBeNull();
    expect(storage.data.size).toBe(0);
    expect((await anonClient().auth.refreshSession({ refresh_token: refreshToken })).error?.code).toBe('refresh_token_not_found');
  });

  // The client's AuthManager (apps/client/src/auth/manager.ts) relies on exactly these SDK
  // behaviors to tell "session expired" apart from "offline".
  it('a revoked session: validating it clears storage and emits SIGNED_OUT', async () => {
    const p = await registerPlayer('expire');
    userIds.push(p.userId);
    const storage = memoryStorage();
    const c = appClient(storage);
    const events: string[] = [];
    c.auth.onAuthStateChange((e) => events.push(e));
    const { data } = await c.auth.signInWithPassword({ email: p.email, password: p.password });
    await serviceClient().auth.admin.signOut(data.session!.access_token, 'global'); // e.g. signed out everywhere
    const user = await c.auth.getUser();
    expect(user.error?.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain('SIGNED_OUT');
    expect(storage.data.size).toBe(0);
  });

  it('a revoked session: refreshing returns a non-retryable auth error and leaves storage to the app', async () => {
    const p = await registerPlayer('expire2');
    userIds.push(p.userId);
    const storage = memoryStorage();
    const c = appClient(storage);
    const { data } = await c.auth.signInWithPassword({ email: p.email, password: p.password });
    await serviceClient().auth.admin.signOut(data.session!.access_token, 'global');
    const refresh = await c.auth.refreshSession();
    expect(refresh.error?.name).toBe('AuthApiError');
    expect(refresh.error?.code).toBe('refresh_token_not_found');
    expect(storage.data.size).toBeGreaterThan(0); // the app must clear it (signOut scope local)
    await c.auth.signOut({ scope: 'local' });
    expect(storage.data.size).toBe(0);
  });

  it('network failures surface as retryable errors and keep the stored session', async () => {
    const p = await registerPlayer('offline');
    userIds.push(p.userId);
    const storage = memoryStorage();
    const { SUPABASE_PUBLISHABLE_KEY } = localEnv();
    expect((await appClient(storage).auth.signInWithPassword({ email: p.email, password: p.password })).error).toBeNull();
    // Same stored session, but the backend is unreachable (closed port).
    const offline = createClient('http://127.0.0.1:9', SUPABASE_PUBLISHABLE_KEY, {
      auth: { storage, storageKey: 'guildhood-auth', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const r = await offline.auth.refreshSession();
    expect(r.error?.name).toBe('AuthRetryableFetchError');
    expect(storage.data.size).toBeGreaterThan(0);
  });
});

describe('password recovery', () => {
  it('gives the same neutral response for unknown emails', async () => {
    const r = await anonClient().auth.resetPasswordForEmail(newEmail('nobody'), { redirectTo: 'http://localhost:5173/' });
    expect(r.error).toBeNull();
  });

  it('recovers by link, sets a new password, and notifies the owner', async () => {
    const p = await registerPlayer('recover');
    userIds.push(p.userId);
    const since = Date.now();
    await anonClient().auth.resetPasswordForEmail(p.email, { redirectTo: 'http://localhost:5173/' });
    const mail = await readEmail(p.email, since);
    expect(mail.subject).toBe('Reset your Guildhood password');
    expect(mail.link).toMatch(/^http:\/\/localhost:5173\/\?type=recovery&token_hash=/);

    const c = anonClient();
    const v = await c.auth.verifyOtp({ token_hash: tokenHashOf(mail.link), type: 'recovery' });
    expect(v.error).toBeNull();
    const changedSince = Date.now();
    expect((await c.auth.updateUser({ password: 'Brandnew456' })).error).toBeNull();
    expect((await readEmail(p.email, changedSince)).subject).toBe('Your Guildhood password was changed');
    expect((await anonClient().auth.signInWithPassword({ email: p.email, password: p.password })).error?.code).toBe('invalid_credentials');
    expect((await anonClient().auth.signInWithPassword({ email: p.email, password: 'Brandnew456' })).error).toBeNull();
    // The link was single-use.
    expect((await anonClient().auth.verifyOtp({ token_hash: tokenHashOf(mail.link), type: 'recovery' })).error?.code).toBe('otp_expired');
  });

  it('recovers by the 6-digit code too (for the Home Screen app, which cannot receive links)', async () => {
    const p = await registerPlayer('reccode');
    userIds.push(p.userId);
    const since = Date.now();
    await anonClient().auth.resetPasswordForEmail(p.email);
    const { code } = await readEmail(p.email, since);
    const c = anonClient();
    expect((await c.auth.verifyOtp({ email: p.email, token: code!, type: 'recovery' })).error).toBeNull();
    expect((await c.auth.updateUser({ password: 'Viacode789' })).error).toBeNull();
  });

  it('refuses an expired recovery link', async () => {
    const p = await registerPlayer('expired');
    userIds.push(p.userId);
    const since = Date.now();
    await anonClient().auth.resetPasswordForEmail(p.email, { redirectTo: 'http://localhost:5173/' });
    const { link } = await readEmail(p.email, since);
    // Age the request past the 1-hour validity window.
    await run(POSTGRES, `update auth.users set recovery_sent_at = now() - interval '2 hours' where id = $1`, [p.userId]);
    await run(POSTGRES, `update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = $1`, [p.userId]).catch(() => {});
    expect((await anonClient().auth.verifyOtp({ token_hash: tokenHashOf(link), type: 'recovery' })).error?.code).toBe('otp_expired');
  });
});
