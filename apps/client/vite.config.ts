import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

const supabaseTarget = process.env.SUPABASE_PROXY_TARGET || 'http://127.0.0.1:54321';
const gameTarget = process.env.GAME_PROXY_TARGET || 'http://127.0.0.1:2567';

// In development and on the local Wi-Fi test, the iPad talks to ONE origin (this server):
// Supabase and the game server are proxied, so only port 5173 needs to be reachable.
const proxy: Record<string, ProxyOptions> = {
  '/auth/v1': { target: supabaseTarget, changeOrigin: true },
  '/rest/v1': { target: supabaseTarget, changeOrigin: true },
  '/realtime/v1': { target: supabaseTarget, changeOrigin: true, ws: true },
  '/functions/v1': { target: supabaseTarget, changeOrigin: true },
  '/game': { target: gameTarget, changeOrigin: true, ws: true },
};

/**
 * Content-Security-Policy for production builds: scripts only from this site, network access only
 * to this site and the configured Supabase project and game server. Limits what injected script
 * could do with the session stored in localStorage (see docs/security.md).
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'guildhood-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const origins = new Set<string>(["'self'"]);
      for (const raw of [process.env.VITE_SUPABASE_URL, process.env.VITE_GAME_SERVER_URL]) {
        if (!raw) continue;
        const u = new URL(raw);
        const host = u.host;
        const secure = u.protocol === 'https:' || u.protocol === 'wss:';
        origins.add(`${secure ? 'https' : 'http'}://${host}`);
        origins.add(`${secure ? 'wss' : 'ws'}://${host}`);
      }
      // Same-origin builds (LAN test) also need ws: to this page's own host, which 'self' does not
      // cover in every browser.
      if (process.env.VITE_SAME_ORIGIN_BACKEND === '1') origins.add('ws:').add('wss:');
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        `connect-src ${[...origins].join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ');
      return html.replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <title>`);
    },
  };
}

export default defineConfig({
  plugins: [contentSecurityPolicy()],
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
