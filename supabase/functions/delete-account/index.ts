// Guildhood account deletion (Supabase Edge Function, Deno). See docs/account-deletion.md.
//
// POST /functions/v1/delete-account
//   Authorization: Bearer <player access token>
//   Body: {"password": "<current password>"}
//
// The only place a player's account is deleted. It runs on Supabase infrastructure with the
// service-role key, which never reaches a client. Steps:
//   1. Identify the caller from their access token (Supabase Auth validates signature, expiry,
//      and that the session still exists). The body carries no user id: nothing to impersonate.
//   2. Confirm identity by checking the password again (rate-limited per account).
//   3. Remove the player's traces from other players' data and record the request.
//   4. Delete the Auth user (hard delete); the database cascades all of the player's own rows.
//   5. Record completion.
// Every step tolerates retries, so a client that never saw the response can safely ask again.
//
// No third-party imports: plain fetch against the Auth and Data APIs keeps this small and auditable.

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? firstKey('SUPABASE_PUBLISHABLE_KEYS');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? firstKey('SUPABASE_SECRET_KEYS');
const ENVIRONMENT = Deno.env.get('GUILDHOOD_ENVIRONMENT') ?? 'local';
// Browser origins allowed to call this function cross-origin (the GitHub Pages site). Same-origin
// calls through the local dev proxy need no CORS. Empty = no cross-origin access.
const ALLOWED_ORIGINS = (Deno.env.get('GUILDHOOD_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function firstKey(name: string): string {
  try {
    const map = JSON.parse(Deno.env.get(name) ?? '{}') as Record<string, string>;
    return map.default ?? Object.values(map)[0] ?? '';
  } catch {
    return '';
  }
}

type SafeCode =
  | 'not_authenticated'
  | 'session_expired'
  | 'bad_request'
  | 'invalid_password'
  | 'too_many_attempts'
  | 'auth_unavailable'
  | 'deletion_failed'
  | 'method_not_allowed';

/** Structured log line. Never includes tokens, passwords, emails, or request bodies. */
function log(
  event: string,
  fields: { request_id: string; started: number; status: number; safe_error_code?: SafeCode; user_id?: string; stage?: string },
) {
  console.log(
    JSON.stringify({
      event_type: event,
      request_id: fields.request_id,
      timestamp: new Date().toISOString(),
      environment: ENVIRONMENT,
      status: fields.status,
      safe_error_code: fields.safe_error_code ?? null,
      // Which step failed (fixed labels only; never error text that could carry request data).
      stage: fields.stage ?? null,
      duration_ms: Math.round(performance.now() - fields.started),
      // Pseudonymous account id only; acceptable for this backend's logs (see docs/security.md).
      user_id: fields.user_id ?? null,
    }),
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    vary: 'origin',
  };
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed with ${res.status}`);
  const text = await res.text(); // functions returning void answer 204 with no body
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const cors = corsHeaders(req.headers.get('origin'));
  let stage = 'start';
  const reply = (status: number, body: Record<string, unknown>, code?: SafeCode, userId?: string) => {
    log('account_deletion', { request_id: requestId, started, status, safe_error_code: code, user_id: userId, stage: code ? stage : undefined });
    return new Response(JSON.stringify({ ...body, request_id: requestId }), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors },
    });
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, 'method_not_allowed');
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) return reply(503, { error: 'auth_unavailable' }, 'auth_unavailable');

  const token = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return reply(401, { error: 'not_authenticated' }, 'not_authenticated');

  let password: unknown;
  try {
    password = ((await req.json()) as { password?: unknown }).password;
  } catch {
    return reply(400, { error: 'bad_request' }, 'bad_request');
  }
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
    return reply(400, { error: 'bad_request' }, 'bad_request');
  }

  // 1. Who is calling? Auth checks the token's signature, expiry, and session.
  let userRes: Response;
  try {
    userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` } });
  } catch {
    return reply(503, { error: 'auth_unavailable' }, 'auth_unavailable');
  }
  if (!userRes.ok) {
    const body = (await userRes.json().catch(() => ({}))) as { error_code?: string; code?: string };
    const code = body.error_code ?? body.code;
    if (code === 'user_not_found') {
      // The token is genuine (Auth verified its signature) but the account is already gone: an
      // earlier attempt succeeded and its response was lost. Make sure completion is recorded.
      const sub = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
      try {
        await rpc('server_finish_account_deletion', { p_user_id: sub, p_request_id: requestId });
      } catch {
        /* completion already recorded or will be on the next retry */
      }
      return reply(200, { status: 'deleted', already_deleted: true }, undefined, sub);
    }
    if (userRes.status >= 500) return reply(503, { error: 'auth_unavailable' }, 'auth_unavailable');
    return reply(401, { error: 'session_expired' }, 'session_expired');
  }
  const user = (await userRes.json()) as { id: string; email?: string };

  try {
    // 2. Identity confirmation: the current password, at most 5 failures per 15 minutes.
    stage = 'attempt_limit';
    if ((await rpc('server_deletion_attempt_allowed', { p_user_id: user.id })) !== true) {
      return reply(429, { error: 'too_many_attempts' }, 'too_many_attempts', user.id);
    }
    stage = 'password_check';
    const pw = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    });
    if (pw.status === 400) {
      stage = 'record_failed_attempt';
      await rpc('server_record_failed_deletion_attempt', { p_user_id: user.id });
      return reply(403, { error: 'invalid_password' }, 'invalid_password', user.id);
    }
    if (pw.status === 429) return reply(429, { error: 'too_many_attempts' }, 'too_many_attempts', user.id);
    if (!pw.ok) return reply(503, { error: 'auth_unavailable' }, 'auth_unavailable', user.id);
    // The check created a session; end it right away (the account is about to go anyway).
    const confirm = (await pw.json()) as { access_token?: string };
    if (confirm.access_token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, authorization: `Bearer ${confirm.access_token}` },
      }).catch(() => {});
    }

    // 3. Clean up traces in other players' data; record the request.
    stage = 'begin';
    await rpc('server_begin_account_deletion', { p_user_id: user.id, p_request_id: requestId });

    // 4. Hard-delete the Auth user. Sessions and refresh tokens go with it; every application row
    //    owned by the player cascades from auth.users.
    stage = 'auth_delete';
    const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ should_soft_delete: false }),
    });
    if (!del.ok && del.status !== 404) throw new Error(`admin delete failed with ${del.status}`);

    // 5. Record completion (verifies nothing of the account remains).
    stage = 'finish';
    await rpc('server_finish_account_deletion', { p_user_id: user.id, p_request_id: requestId });
    return reply(200, { status: 'deleted' }, undefined, user.id);
  } catch {
    return reply(500, { error: 'deletion_failed' }, 'deletion_failed', user.id);
  }
});
