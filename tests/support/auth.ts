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
  accessToken: string;
}

/** Signs in through the real player flow: request an email code, read it, verify it. */
export async function signInWithEmailCode(label = 'player'): Promise<SignedInPlayer> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const client = anonClient();
  const since = Date.now();
  const { error: otpError } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (otpError) throw otpError;
  const token = await readSignInCode(email, since);
  const { data, error } = await client.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
  if (!data.session || !data.user) throw new Error('verifyOtp returned no session');
  return { client, userId: data.user.id, email, accessToken: data.session.access_token };
}

export async function deleteAuthUsers(ids: string[]): Promise<void> {
  const admin = serviceClient();
  await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
}
