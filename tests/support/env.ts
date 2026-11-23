import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalSupabase } from '../../scripts/supabase-env.mjs';

export interface LocalEnv {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  SUPABASE_DB_URL: string;
  MAILPIT_URL: string;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let cached: LocalEnv | undefined;

/** Connection details for the local Supabase stack: env vars, then .env.local, then `supabase status`. */
export function localEnv(): LocalEnv {
  if (cached) return cached;
  const keys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL', 'MAILPIT_URL'] as const;
  const fromProcess = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (keys.every((k) => fromProcess[k])) {
    cached = fromProcess as unknown as LocalEnv;
    return cached;
  }
  const file = path.join(root, '.env.local');
  if (existsSync(file)) {
    const parsed = Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    if (keys.every((k) => parsed[k])) {
      cached = parsed as unknown as LocalEnv;
      return cached;
    }
  }
  cached = readLocalSupabase() as LocalEnv;
  return cached;
}
