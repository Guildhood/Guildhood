#!/usr/bin/env node
// Reads `supabase status` for the running local stack and writes .env.local with the values the
// game server, tests, and dev scripts need. Run after `npx supabase start`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readLocalSupabase() {
  let raw;
  try {
    raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      'Local Supabase is not running. Start Docker, then run `npx supabase start` in the repo root.\n' +
        String(err.stderr || err.message),
    );
  }
  const start = raw.indexOf('{');
  const s = JSON.parse(raw.slice(start));
  return {
    SUPABASE_URL: s.API_URL,
    SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY || s.ANON_KEY,
    SUPABASE_SECRET_KEY: s.SECRET_KEY || s.SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: s.DB_URL,
    MAILPIT_URL: s.MAILPIT_URL || s.INBUCKET_URL,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = readLocalSupabase();
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path.join(root, '.env.local'), body + '\n');
  console.log('Wrote .env.local for local Supabase at ' + env.SUPABASE_URL);
}
