import './styles.css';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JoinSpec } from '@guildhood/shared';
import { STARTER_NEIGHBORHOOD_ID, loadConfig, type ClientConfig } from './config.ts';
import { createSupabase } from './supabase.ts';
import { DriveScreen } from './ui/drive.ts';
import { HomeScreen } from './ui/home.ts';
import { NotConfiguredScreen } from './ui/not-configured.ts';
import type { Screen } from './ui/screen.ts';
import { SignInScreen } from './ui/sign-in.ts';

class App {
  private screen: Screen | null = null;
  private readonly supabase: SupabaseClient | null;
  private userId: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly config: ClientConfig,
  ) {
    this.supabase = config.configured ? createSupabase(config) : null;
  }

  async start(): Promise<void> {
    if (!this.supabase) {
      this.show(new NotConfiguredScreen());
      return;
    }
    this.supabase.auth.onAuthStateChange((event, session) => {
      // Defer: calling Supabase from inside this callback can deadlock its auth lock.
      setTimeout(() => {
        if (event === 'SIGNED_OUT') {
          this.userId = null;
          this.goSignIn();
        } else if (event === 'TOKEN_REFRESHED' && session && this.screen instanceof DriveScreen) {
          this.screen.tokenRefreshed(session.access_token);
        }
      }, 0);
    });
    const { data } = await this.supabase.auth.getSession();
    if (data.session) {
      this.userId = data.session.user.id;
      this.goHome();
    } else {
      this.goSignIn();
    }
  }

  private show(next: Screen): void {
    this.screen?.unmount();
    this.root.replaceChildren(next.el);
    this.screen = next;
    next.mounted?.();
  }

  private goSignIn(): void {
    const sb = this.supabase!;
    this.show(
      new SignInScreen(
        sb,
        async () => {
          const { data } = await sb.auth.getSession();
          this.userId = data.session?.user.id ?? null;
          if (this.userId) this.goHome();
        },
        this.config.localMailHint,
      ),
    );
  }

  private goHome(): void {
    const sb = this.supabase!;
    this.show(
      new HomeScreen({
        supabase: sb,
        userId: this.userId!,
        drive: (join) => this.goDrive(join),
        signOut: () => void sb.auth.signOut(),
      }),
    );
  }

  private goDrive(join: JoinSpec): void {
    this.show(
      new DriveScreen({
        supabase: this.supabase!,
        gameServerUrl: this.config.gameServerUrl,
        neighborhoodId: STARTER_NEIGHBORHOOD_ID,
        join,
        exit: () => this.goHome(),
        driveAnyway: () => this.goDrive({ mode: 'auto' }),
      }),
    );
  }
}

// iOS Safari still fires gesture events for pinch-zoom despite user-scalable=no.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

void new App(document.getElementById('app')!, loadConfig()).start();
