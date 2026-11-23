#!/usr/bin/env node
// Waits until the local Supabase stack can actually serve Guildhood: Auth answers, a sign-in email
// reaches the mail catcher, and Realtime attaches a database change feed. Containers report
// "healthy" before all of that is true (especially right after `supabase start` or `db reset`).
import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from './supabase-env.mjs';

const env = readLocalSupabase();
const deadline = Date.now() + 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn) {
  const started = Date.now();
  for (;;) {
    try {
      if (await fn()) {
        console.log(`ready: ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        return;
      }
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      console.error(`Timed out waiting for ${label}`);
      process.exit(1);
    }
    await sleep(1000);
  }
}

const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

await until('auth', async () => (await fetch(`${env.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } })).ok);

// Sign in a throwaway player through the real email-code flow (this also proves mail delivery).
const email = `warmup-${Date.now()}@example.test`;
let code = null;
await until('sign-in email delivery', async () => {
  const since = Date.now();
  const { error } = await client.auth.signInWithOtp({ email });
  if (error) return false;
  for (let i = 0; i < 20 && !code; i++) {
    const body = await (await fetch(`${env.MAILPIT_URL}/api/v1/messages?limit=50`)).json();
    const m = body.messages?.find((x) => x.To?.some((t) => t.Address === email) && Date.parse(x.Created) >= since - 5000);
    code = m?.Snippet?.match(/\b(\d{6})\b/)?.[1] ?? null;
    if (!code) await sleep(500);
  }
  return Boolean(code);
});
const { data: auth, error: verifyError } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
if (verifyError || !auth.user) {
  console.error('Sign-in with the emailed code failed:', verifyError?.message);
  process.exit(1);
}

// The same subscription the game uses: the player's own notifications.
await until('realtime change feed', async () => {
  // A fresh connection per attempt: a socket that failed while Realtime was restarting can stay
  // in its reconnect backoff long after the service is back.
  const rt = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await rt.realtime.setAuth(auth.session.access_token);
  const channel = rt.channel(`warmup-${Date.now()}`);
  const ok = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    channel.on('system', {}, (msg) => {
      if (process.env.DEBUG_WAIT) console.log("system", JSON.stringify(msg));
      if (msg.extension === 'postgres_changes') {
        clearTimeout(timer);
        resolve(msg.status === 'ok');
      }
    });
    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${auth.user.id}` }, () => {})
      .subscribe((status, err) => {
        if (process.env.DEBUG_WAIT) console.log("status", status, err?.message ?? "");
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          resolve(false);
        }
      });
  });
  await rt.removeChannel(channel);
  rt.realtime.disconnect();
  return ok;
});

// Remove the throwaway player.
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
await admin.auth.admin.deleteUser(auth.user.id);
process.exit(0);
