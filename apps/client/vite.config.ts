import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';

const supabaseTarget = process.env.SUPABASE_PROXY_TARGET || 'http://127.0.0.1:54321';
const gameTarget = process.env.GAME_PROXY_TARGET || 'http://127.0.0.1:2567';

// In development and on the local Wi-Fi test, the iPad talks to ONE origin (this server):
// Supabase and the game server are proxied, so only port 5173 needs to be reachable.
const proxy: Record<string, ProxyOptions> = {
  '/auth/v1': { target: supabaseTarget, changeOrigin: true },
  '/rest/v1': { target: supabaseTarget, changeOrigin: true },
  '/realtime/v1': { target: supabaseTarget, changeOrigin: true, ws: true },
  '/game': { target: gameTarget, changeOrigin: true, ws: true },
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset URLs work at any path (GitHub Pages project sites, LAN, localhost).
  base: './',
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: ['safari15', 'es2022'],
    chunkSizeWarningLimit: 1200,
  },
});
