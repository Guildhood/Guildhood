import './styles.css';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JoinSpec } from '@guildhood/shared';
import { AuthManager, type AuthState, type Connectivity } from './auth/manager.ts';
import { STARTER_NEIGHBORHOOD_ID, loadConfig, type ClientConfig } from './config.ts';
import { createSupabase } from './supabase.ts';
import {
  BackendErrorScreen,
  CreateAccountScreen,
  LoadingScreen,
  RecoveryRequestScreen,
  ResetPasswordScreen,
  RestrictedScreen,
  SignInScreen,
  VerifyEmailScreen,
  WelcomeScreen,
  type AuthNav,
  type AuthRoute,
} from './ui/auth-screens.ts';
import { DriveScreen } from './ui/drive.ts';
import { HomeScreen } from './ui/home.ts';
import { installKeyboardAvoidance } from './ui/keyboard.ts';
import { noticeText } from './ui/messages.ts';
import { NotConfiguredScreen } from './ui/not-configured.ts';
import { OnboardingScreen } from './ui/onboarding.ts';
import type { Screen } from './ui/screen.ts';
import { AccountSettingsScreen, DeleteAccountScreen, ProfileSettingsScreen } from './ui/settings.ts';
import { toast } from './ui/toast.ts';

type ReadyRoute = { name: 'home' } | { name: 'profile' } | { name: 'account' } | { name: 'delete' } | { name: 'drive'; join: JoinSpec };

/**
 * Chooses the screen for the current auth state. Each screen has a key that includes the account
 * id, so a different account always gets fresh screens (nothing from the previous player can
 * remain visible), while updates for the same screen are applied in place (typing is never lost).
 */
class App {
  private screen: Screen | null = null;
  private key = '';
  private authRoute: AuthRoute = 'welcome';
  private authEmail: string | undefined;
  private readyRoute: ReadyRoute = { name: 'home' };
  private restrictedDeleting = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly manager: AuthManager,
    private readonly supabase: SupabaseClient,
    private readonly config: ClientConfig,
  ) {
    // Relaunched while waiting for a password-reset email: go straight back to code entry.
    if (manager.pendingRecoveryEmail()) this.authRoute = 'recovery';
    manager.subscribe((s) => this.render(s));
    manager.onConnectivity((c) => this.showConnectivity(c));
    manager.onTokenRefreshed((token) => {
      if (this.screen instanceof DriveScreen) this.screen.tokenRefreshed(token);
    });
    this.showConnectivity(manager.connectivity);
  }

  private nav: AuthNav = {
    go: (route, opts) => {
      this.authRoute = route;
      this.authEmail = opts?.email;
      if (this.manager.state.kind === 'SESSION_EXPIRED' || this.manager.state.kind === 'AWAITING_VERIFICATION') return; // manager moves on
      this.render(this.manager.state, true);
    },
    deleteAccount: () => {
      this.restrictedDeleting = true;
      this.render(this.manager.state, true);
    },
  };

  private goReady(route: ReadyRoute): void {
    this.readyRoute = route;
    this.render(this.manager.state, true);
  }

  private show(key: string, make: () => Screen, force = false): void {
    if (!force && key === this.key && this.screen) return;
    this.screen?.unmount();
    const next = make();
    this.root.replaceChildren(next.el);
    this.screen = next;
    this.key = key;
    next.mounted?.();
  }

  render(s: AuthState, force = false): void {
    const m = this.manager;
    switch (s.kind) {
      case 'INITIALIZING':
        return this.show('loading', () => new LoadingScreen('Loading…'));
      case 'AUTHENTICATING':
        // Keep the form the player is using (it shows its own busy state); a link shows a spinner.
        if (this.key.startsWith('auth:')) return;
        return this.show('loading:link', () => new LoadingScreen('Checking your link…'));
      case 'SIGNED_OUT': {
        this.readyRoute = { name: 'home' };
        this.restrictedDeleting = false;
        const notice = s.notice;
        if (notice && 'flow' in notice && notice.flow === 'recovery' && !force) this.authRoute = 'recovery';
        const route = this.authRoute;
        const key = `auth:${route}:${notice?.kind ?? ''}`;
        return this.show(key, () => {
          if (route === 'sign-in') return new SignInScreen(m, this.nav, { notice, email: this.authEmail });
          if (route === 'create') return new CreateAccountScreen(m, this.nav);
          if (route === 'recovery') return new RecoveryRequestScreen(m, this.nav, { email: this.authEmail, notice });
          return new WelcomeScreen(this.nav, notice);
        }, force);
      }
      case 'AWAITING_VERIFICATION':
        this.authRoute = 'welcome';
        return this.show(`auth:verify:${s.email}`, () => new VerifyEmailScreen(m, this.nav, s.email, Date.now()));
      case 'SESSION_EXPIRED':
        this.authRoute = 'sign-in';
        return this.show('auth:expired', () => new SignInScreen(m, this.nav, { expired: true }));
      case 'RECOVERY_IN_PROGRESS':
        return this.show(`auth:reset:${s.user.id}`, () => new ResetPasswordScreen(m, s.user.email));
      case 'ERROR':
        return this.show(`error:${s.code}`, () => new BackendErrorScreen(m, s.code), true);
      case 'ACCOUNT_RESTRICTED':
        if (this.restrictedDeleting) {
          return this.show(`restricted-delete:${s.user.id}`, () => new DeleteAccountScreen(m, s.user, () => { this.restrictedDeleting = false; this.render(m.state, true); }));
        }
        return this.show(`restricted:${s.user.id}`, () => new RestrictedScreen(m, this.nav, s.restriction), force);
      case 'AUTHENTICATED_NEEDS_PROFILE': {
        const key = `onboarding:${s.user.id}`;
        if (this.key === key && this.screen instanceof OnboardingScreen) return this.screen.update(s.profile);
        return this.show(key, () => new OnboardingScreen(m, this.supabase, s.profile));
      }
      case 'AUTHENTICATED_READY': {
        if (s.notice) toast(noticeText(s.notice), { testId: 'notice-toast' });
        const r = this.readyRoute;
        const key = `ready:${s.user.id}:${r.name}`;
        // Republished state for the same account and route: update in place, never remount
        // (that would lose what the player is typing).
        if (this.key === key && !force) {
          if (this.screen instanceof HomeScreen) this.screen.updateProfile(s.profile);
          return;
        }
        return this.show(key, () => {
          if (r.name === 'profile') return new ProfileSettingsScreen(m, this.supabase, s.profile, () => this.goReady({ name: 'home' }));
          if (r.name === 'account') {
            return new AccountSettingsScreen(m, this.supabase, s.user, { back: () => this.goReady({ name: 'home' }), deleteAccount: () => this.goReady({ name: 'delete' }) });
          }
          if (r.name === 'delete') return new DeleteAccountScreen(m, s.user, () => this.goReady({ name: 'account' }));
          if (r.name === 'drive') {
            return new DriveScreen({
              supabase: this.supabase,
              gameServerUrl: this.config.gameServerUrl,
              neighborhoodId: STARTER_NEIGHBORHOOD_ID,
              join: r.join,
              exit: () => this.goReady({ name: 'home' }),
              driveAnyway: () => this.goReady({ name: 'drive', join: { mode: 'auto' } }),
            });
          }
          return new HomeScreen({
            supabase: this.supabase,
            userId: s.user.id,
            profile: s.profile,
            user: s.user,
            drive: (join) => this.goReady({ name: 'drive', join }),
            openProfile: () => this.goReady({ name: 'profile' }),
            openAccount: () => this.goReady({ name: 'account' }),
            signOut: () => void m.signOut(),
          });
        }, true);
      }
    }
  }

  private showConnectivity(c: Connectivity): void {
    const banner = document.getElementById('net-banner');
    if (!banner) return;
    banner.hidden = c === 'online';
    banner.dataset.state = c;
    banner.textContent =
      c === 'offline' ? 'You’re offline. You’re still signed in; Guildhood will reconnect when you’re back online.'
      : c === 'unreachable' ? 'Can’t reach Guildhood right now. You’re still signed in.'
      : '';
  }
}

// iOS Safari still fires gesture events for pinch-zoom despite user-scalable=no.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

const config = loadConfig();
const root = document.getElementById('app')!;
if (!config.configured) {
  root.replaceChildren(new NotConfiguredScreen().el);
} else {
  installKeyboardAvoidance();
  const supabase = createSupabase(config);
  const manager = new AuthManager(supabase);
  new App(root, manager, supabase, config);
  void manager.start();
}
