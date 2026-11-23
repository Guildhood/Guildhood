import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { readLocalSupabase } from '../../scripts/supabase-env.mjs';

// End-to-end tests drive the production build in emulated iPads (touch, iPad viewport) against the
// real game server and the real local Supabase stack (`npx supabase start` must be running).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = readLocalSupabase();
const ipad = devices['iPad Pro 11 landscape'];

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...ipad,
    browserName: 'chromium',
    deviceScaleFactor: 1,
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
  },
  webServer: [
    {
      command: 'npx tsx apps/server/src/main.ts',
      cwd: repo,
      url: 'http://127.0.0.1:2567/healthz',
      reuseExistingServer: !process.env.CI,
      env: { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY, PORT: '2567', HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    },
    {
      command: 'npx vite build --config apps/client/vite.config.ts && npx vite preview --config apps/client/vite.config.ts --port 5173 --strictPort',
      cwd: repo,
      url: 'http://127.0.0.1:5173',
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SAME_ORIGIN_BACKEND: '1',
        VITE_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_PROXY_TARGET: env.SUPABASE_URL,
        GAME_PROXY_TARGET: 'http://127.0.0.1:2567',
      },
    },
  ],
});
