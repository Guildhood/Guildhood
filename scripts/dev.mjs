#!/usr/bin/env node
// Starts Guildhood against the local Supabase stack (`npx supabase start` first).
//
//   npm run dev   Development on this computer: http://localhost:5173 (hot reload).
//   npm run lan   Two-iPad test: production build served to your Wi-Fi. iPads open the printed
//                 http://<this-computer>:5173 address. Sign-in codes are printed here.
//
// Only port 5173 needs to be reachable from the iPads: the web server proxies Supabase and the
// game server, which stay bound to this computer.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalSupabase } from './supabase-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lan = process.argv.includes('--lan');
const PORT = 5173;

let env;
try {
  env = readLocalSupabase();
} catch (err) {
  console.error(String(err.message));
  process.exit(1);
}

const children = [];
let stopping = false;

function prefixed(name, stream, out) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      out.write(`[${name}] ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
}

function run(name, args, extraEnv) {
  const child = spawn('npx', args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixed(name, child.stdout, process.stdout);
  prefixed(name, child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[${name}] exited with code ${code}; stopping.`);
      stop(1);
    }
  });
  children.push(child);
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const clientEnv = {
  VITE_SAME_ORIGIN_BACKEND: '1',
  VITE_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_PROXY_TARGET: env.SUPABASE_URL,
  GAME_PROXY_TARGET: 'http://127.0.0.1:2567',
};

run('game', ['tsx', 'apps/server/src/main.ts'], {
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  PORT: '2567',
  HOST: '127.0.0.1',
});

const viteConfig = ['--config', 'apps/client/vite.config.ts'];
if (lan) {
  console.log('Building the client for the Wi-Fi test…');
  const build = spawnSync('npx', ['vite', 'build', ...viteConfig], { cwd: root, env: { ...process.env, ...clientEnv }, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
  run('web', ['vite', 'preview', ...viteConfig, '--host', '0.0.0.0', '--port', String(PORT)], clientEnv);
} else {
  run('web', ['vite', ...viteConfig, '--port', String(PORT)], clientEnv);
}

const lanAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address);

setTimeout(() => {
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Guildhood is running.');
  console.log(`  On this computer: http://localhost:${PORT}`);
  if (lan) {
    for (const a of lanAddresses) console.log(`  On your iPads:     http://${a}:${PORT}`);
    if (!lanAddresses.length) console.log('  No Wi-Fi address found: connect this computer to the same Wi-Fi as the iPads.');
  }
  console.log(`  Sign-in emails:   ${env.MAILPIT_URL} (codes are also printed below)`);
  console.log('  Stop with Ctrl+C.');
  console.log('────────────────────────────────────────────────────────────\n');
}, 2500);

// Print new sign-in codes from the local mail catcher so testers don't need a second screen.
const seen = new Set();
let primed = false;
setInterval(async () => {
  try {
    const res = await fetch(`${env.MAILPIT_URL}/api/v1/messages?limit=20`);
    if (!res.ok) return;
    const body = await res.json();
    for (const m of (body.messages ?? []).slice().reverse()) {
      if (seen.has(m.ID)) continue;
      seen.add(m.ID);
      if (!primed) continue;
      const code = String(m.Snippet ?? '').match(/\b(\d{6})\b/)?.[1];
      const to = m.To?.[0]?.Address ?? 'unknown';
      if (code) console.log(`\n  ✉  Sign-in code for ${to}: ${code}\n`);
    }
    primed = true;
  } catch {
    /* mail catcher not reachable yet */
  }
}, 1500);
