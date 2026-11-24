import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ClientConfig } from './config.ts';

export function createSupabase(config: ClientConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'guildhood-auth',
    },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

/** A current access token, refreshed first if it is about to expire. */
export async function freshAccessToken(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return null;
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs - Date.now() < 60_000) {
    const refreshed = await supabase.auth.refreshSession();
    return refreshed.data.session?.access_token ?? null;
  }
  return session.access_token;
}

/** Turns Postgres/RPC error text into something a player can act on. */
export function friendlyError(message: string | undefined): string {
  const m = message ?? '';
  const known: Record<string, string> = {
    invalid_friend_code: 'Friend codes are 8 letters and numbers, like ABCD-2345.',
    friend_code_not_found: 'No driver has that friend code.',
    cannot_friend_self: 'That’s your own friend code.',
    too_many_pending_requests: 'You have too many requests waiting. Cancel some first.',
    not_in_session: 'Start driving first, then invite friends to join you.',
    not_friends: 'You can only invite players on your friends list.',
    profiles_display_name_format: 'Names are 3–20 letters, numbers, spaces, - or _, starting and ending with a letter or number.',
    request_not_found: 'That request is no longer waiting.',
  };
  for (const [key, text] of Object.entries(known)) if (m.includes(key)) return text;
  if (/fetch|network|Failed to/i.test(m)) return 'Can’t reach Guildhood right now. Check your Wi-Fi and try again.';
  return 'Something went wrong. Please try again.';
}
