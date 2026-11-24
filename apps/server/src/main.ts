import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSupabaseVerifier } from './auth.ts';
import { SupabaseBackend } from './backend.ts';
import { GameServer } from './game-server.ts';
import { log } from './log.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See docs/deployment.md.`);
    process.exit(1);
  }
  return v;
}

const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '');
const issuer = process.env.SUPABASE_JWT_ISSUER || `${supabaseUrl}/auth/v1`;

const server = new GameServer({
  port: Number(process.env.PORT || 2567),
  host: process.env.HOST || '0.0.0.0',
  serverId: process.env.SERVER_ID || `gs-${hostname().slice(0, 40)}-${randomUUID().slice(0, 6)}`,
  backend: new SupabaseBackend(supabaseUrl, required('SUPABASE_SECRET_KEY')),
  verifier: createSupabaseVerifier({
    issuer,
    jwksUrl: process.env.SUPABASE_JWKS_URL || `${issuer}/.well-known/jwks.json`,
    hs256Secret: process.env.SUPABASE_JWT_SECRET || undefined,
  }),
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : null,
});

await server.start();

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log('info', 'shutdown_requested', { signal });
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
