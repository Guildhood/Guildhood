import { brand, h } from './dom.ts';
import type { Screen } from './screen.ts';

/** Shown by builds that have no backend configured (e.g. a GitHub Pages build without settings). */
export class NotConfiguredScreen implements Screen {
  readonly el = h(
    'div',
    { class: 'center-screen', 'data-testid': 'not-configured' },
    h(
      'div',
      { class: 'card' },
      brand(),
      h('h2', { style: { margin: '0' }, text: 'Not connected to a game server' }),
      h('p', {
        class: 'muted',
        text: 'This copy of Guildhood was built without a game server or account service, so you can’t sign in or drive here yet.',
      }),
      h('p', {
        class: 'muted',
        text: 'If you run this deployment: set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and VITE_GAME_SERVER_URL as repository variables and redeploy. For local Wi-Fi play, see docs/RUNNING.md.',
      }),
    ),
  );
  unmount(): void {}
}
