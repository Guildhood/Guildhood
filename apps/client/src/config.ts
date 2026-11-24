import { GAME_WS_PATH } from '@guildhood/shared';

/**
 * Where the backend lives.
 *  - Local development and the Wi-Fi iPad test: VITE_SAME_ORIGIN_BACKEND=1. Supabase and the game
 *    server are reached through this page's own origin (the dev server proxies them).
 *  - Hosted builds (GitHub Pages): VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and
 *    VITE_GAME_SERVER_URL point at cloud services. Without them the build reports that it is not
 *    connected to a game server rather than pretending to work.
 */
export interface ClientConfig {
  configured: boolean;
  supabaseUrl: string;
  supabaseKey: string;
  gameServerUrl: string;
  sameOriginBackend: boolean;
  /** Shown on the sign-in screen for local testing (codes go to the local mail viewer). */
  localMailHint: boolean;
}

export function loadConfig(): ClientConfig {
  const env = import.meta.env;
  const sameOrigin = env.VITE_SAME_ORIGIN_BACKEND === '1';
  const wsOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined) || (sameOrigin ? location.origin : '');
  const supabaseKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) || '';
  const gameServerUrl = (env.VITE_GAME_SERVER_URL as string | undefined) || (sameOrigin ? `${wsOrigin}${GAME_WS_PATH}` : '');
  return {
    configured: Boolean(supabaseUrl && supabaseKey && gameServerUrl),
    supabaseUrl,
    supabaseKey,
    gameServerUrl,
    sameOriginBackend: sameOrigin,
    localMailHint: sameOrigin,
  };
}

/** The starter neighborhood every player belongs to (seeded by migration). */
export const STARTER_NEIGHBORHOOD_ID = 'a1000000-0000-4000-8000-000000000001';
