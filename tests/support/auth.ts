import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { localEnv } from './env.ts';

/**
 * Reads the newest sign-in code sent to `email` from the local Mailpit inbox. Uses the plain
 * message list (not the search index, which can lag right after the stack starts).
 */
export async function readSignInCode(email: string, since: number, timeoutMs = 45_000): Promise<string> {
  const { MAILPIT_URL } = localEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as { messages: { Created: string; Snippet: string; To: { Address: string }[] }[] };
      const code = body.messages
        .filter((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && Date.parse(m.Created) >= since - 5000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0]
        ?.Snippet.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in code arrived for ${email}`);
}

export function anonClient(): SupabaseClient {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = localEnv();
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function serviceClient(): SupabaseClient {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = localEnv();
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface SignedInPlayer {
  client: SupabaseClient;
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  username: string | null;
}

export const TEST_PASSWORD = 'Testpass123';
export const TERMS_VERSION = '2026-11-24';

/** Returns the newest email (subject, code, link) sent to `email` since `since`. */
export async function readEmail(email: string, since: number, timeoutMs = 45_000): Promise<{ subject: string; code: string | null; link: string | null }> {
  const { MAILPIT_URL } = localEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as { messages: { ID: string; Created: string; Subject: string; Snippet: string; To: { Address: string }[] }[] };
      const m = body.messages
        .filter((x) => x.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && Date.parse(x.Created) >= since - 5000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
      if (m) {
        const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}`)).json()) as { HTML: string };
        const href = full.HTML.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
        return { subject: m.Subject, code: m.Snippet.match(/\b(\d{6})\b/)?.[1] ?? null, link: href };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email arrived for ${email}`);
}

/**
 * Registers through the real player flow: email + password sign-up (accepting the current terms),
 * then the 6-digit verification code from the email. Optionally completes onboarding.
 */
export async function registerPlayer(label = 'player', opts: { onboard?: boolean } = {}): Promise<SignedInPlayer> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const client = anonClient();
  const since = Date.now();
  const { error: signUpError } = await client.auth.signUp({ email, password: TEST_PASSWORD, options: { data: { terms_version: TERMS_VERSION } } });
  if (signUpError) throw signUpError;
  const { code } = await readEmail(email, since);
  const { data, error } = await client.auth.verifyOtp({ email, token: code!, type: 'signup' });
  if (error) throw error;
  if (!data.session || !data.user) throw new Error('verifyOtp returned no session');
  let username: string | null = null;
  if (opts.onboard) {
    username = `${label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8)}_${data.user.id.slice(0, 8)}`;
    await completeOnboarding(client, username);
  }
  return { client, userId: data.user.id, email, password: TEST_PASSWORD, accessToken: data.session.access_token, username };
}

export async function completeOnboarding(client: SupabaseClient, username: string, displayName = 'Test Driver', avatar = 'leaf_moss'): Promise<void> {
  for (const [fn, args] of [
    ['claim_username', { p_username: username }],
    ['update_my_profile', { p_changes: { display_name: displayName } }],
    ['update_my_profile', { p_changes: { avatar_asset_id: avatar } }],
    ['complete_onboarding', {}],
  ] as const) {
    const { error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
  }
}

export async function deleteAuthUsers(ids: string[]): Promise<void> {
  const admin = serviceClient();
  await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
}
