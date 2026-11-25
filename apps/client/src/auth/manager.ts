import { isAuthRetryableFetchError, type AuthError, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { TERMS_VERSION } from '@guildhood/shared';
import { logEvent, newRequestId } from '../log.ts';
import { appReturnUrl, parseAuthCallback, withoutAuthParams, type AuthLinkFlow } from './callback.ts';

/**
 * The one place that decides who the player is and what they may see. Screens render from
 * `state`; they never read the Supabase session directly. Network connectivity is tracked
 * separately (`connectivity`) so "offline" is never mistaken for "signed out".
 */

export interface AccountUser {
  id: string;
  email: string;
}

export interface OwnProfile {
  id: string;
  username: string | null;
  display_name: string;
  avatar_asset_id: string | null;
  bio: string | null;
  profile_visibility: 'public' | 'friends' | 'private';
  onboarding_step: 'username' | 'display_name' | 'avatar' | 'review' | null;
  onboarding_completed_at: string | null;
  friend_code: string;
}

export interface Restriction {
  restriction_type: 'suspended' | 'banned';
  reason_code: string;
  effective_at: string;
  expires_at: string | null;
}

export type Notice =
  | { kind: 'link_expired' | 'link_invalid' | 'link_network'; flow: AuthLinkFlow | null }
  | { kind: 'signed_out' | 'account_deleted' | 'password_updated' | 'email_confirmed' };

export type AuthState =
  | { kind: 'INITIALIZING' }
  | { kind: 'SIGNED_OUT'; notice?: Notice }
  | { kind: 'AUTHENTICATING' }
  | { kind: 'AWAITING_VERIFICATION'; email: string }
  | { kind: 'AUTHENTICATED_NEEDS_PROFILE'; user: AccountUser; profile: OwnProfile }
  | { kind: 'AUTHENTICATED_READY'; user: AccountUser; profile: OwnProfile; notice?: Notice }
  | { kind: 'RECOVERY_IN_PROGRESS'; user: AccountUser }
  | { kind: 'SESSION_EXPIRED' }
  | { kind: 'ACCOUNT_RESTRICTED'; user: AccountUser; restriction: Restriction }
  | { kind: 'ERROR'; code: 'backend_unavailable' | 'unexpected' };

export type Connectivity = 'online' | 'offline' | 'unreachable';

/** Safe, player-facing outcome codes (mapped to text in ui/messages.ts). */
export type ResultCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'same_password'
  | 'rate_limited'
  | 'code_invalid'
  | 'email_invalid'
  | 'signup_disabled'
  | 'network'
  | 'session_expired'
  | 'invalid_password'
  | 'too_many_attempts'
  | 'deletion_failed'
  | 'unexpected';

export type Result = { ok: true } | { ok: false; code: ResultCode };

const PROFILE_COLUMNS = 'id, username, display_name, avatar_asset_id, bio, profile_visibility, onboarding_step, onboarding_completed_at, friend_code';
const STORAGE_KEY = 'guildhood-auth';
const PENDING_KEY = 'guildhood.pendingVerification';
const RECOVERY_KEY = 'guildhood.recoveryUser';
const RECOVERY_REQUEST_KEY = 'guildhood.recoveryRequest';

const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage full: flows still work in this session */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function isNetworkFailure(err: unknown): boolean {
  if (!err) return false;
  if (isAuthRetryableFetchError(err)) return true;
  const msg = String((err as { message?: string }).message ?? err);
  return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg);
}

function classify(err: AuthError | Error | null | undefined): ResultCode {
  if (!err) return 'unexpected';
  if (isNetworkFailure(err)) return 'network';
  const code = (err as AuthError).code ?? '';
  const status = (err as AuthError).status ?? 0;
  if (code === 'invalid_credentials') return 'invalid_credentials';
  if (code === 'email_not_confirmed') return 'email_not_confirmed';
  if (code === 'weak_password') return 'weak_password';
  if (code === 'same_password') return 'same_password';
  if (code === 'otp_expired') return 'code_invalid';
  if (code === 'email_address_invalid' || code === 'validation_failed') return 'email_invalid';
  if (code === 'signup_disabled') return 'signup_disabled';
  if (code.startsWith('over_') || status === 429) return 'rate_limited';
  return 'unexpected';
}

const toAccountUser = (u: User): AccountUser => ({ id: u.id, email: u.email ?? '' });

export class AuthManager {
  state: AuthState = { kind: 'INITIALIZING' };
  connectivity: Connectivity = navigator.onLine === false ? 'offline' : 'online';
  private readonly listeners = new Set<(s: AuthState) => void>();
  private readonly connectivityListeners = new Set<(c: Connectivity) => void>();
  private readonly tokenListeners = new Set<(token: string) => void>();
  private readonly cleanups = new Set<() => void>();
  private currentUserId: string | null = null;
  private signingOut = false;
  private busy = false;

  constructor(readonly supabase: SupabaseClient) {}

  // ----------------------------------------------------------------------------------------------
  // Subscriptions
  // ----------------------------------------------------------------------------------------------

  subscribe(fn: (s: AuthState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnectivity(fn: (c: Connectivity) => void): () => void {
    this.connectivityListeners.add(fn);
    return () => this.connectivityListeners.delete(fn);
  }

  /** Fresh access tokens as Supabase rotates them (the game server connection needs them). */
  onTokenRefreshed(fn: (token: string) => void): () => void {
    this.tokenListeners.add(fn);
    return () => this.tokenListeners.delete(fn);
  }

  /** Registers cleanup for account-scoped resources (subscriptions, caches); runs on sign-out or account switch. */
  onAccountCleanup(fn: () => void): () => void {
    this.cleanups.add(fn);
    return () => this.cleanups.delete(fn);
  }

  private set(next: AuthState): void {
    this.state = next;
    window.__guildhoodDebug = { ...(window.__guildhoodDebug ?? { drive: null }), auth: { state: next.kind, userId: this.currentUserId } };
    for (const fn of this.listeners) fn(next);
  }

  private setConnectivity(c: Connectivity): void {
    if (c === this.connectivity) return;
    this.connectivity = c;
    for (const fn of this.connectivityListeners) fn(c);
  }

  // ----------------------------------------------------------------------------------------------
  // Startup and app lifecycle
  // ----------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.supabase.auth.onAuthStateChange((event, session) => {
      // Defer: calling Supabase from inside this callback can deadlock its auth lock.
      setTimeout(() => void this.onAuthEvent(event, session), 0);
    });
    window.addEventListener('online', () => {
      this.setConnectivity('online');
      void this.revalidate();
    });
    window.addEventListener('offline', () => this.setConnectivity('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.revalidate();
    });

    const callback = parseAuthCallback(location.href);
    if (callback.kind !== 'none') history.replaceState(history.state, '', withoutAuthParams(location.href));
    if (callback.kind === 'link') {
      await this.consumeLink(callback.flow, callback.tokenHash);
      return;
    }
    const notice: Notice | undefined =
      callback.kind === 'invalid' ? { kind: callback.reason === 'expired' ? 'link_expired' : 'link_invalid', flow: callback.flow } : undefined;
    await this.restore(notice);
  }

  /** Resolves the persisted session (if any) into a state. Never signs out because of a network problem. */
  private async restore(notice?: Notice): Promise<void> {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) {
      if (isNetworkFailure(error)) {
        this.setConnectivity('unreachable');
        this.set({ kind: 'ERROR', code: 'backend_unavailable' });
      } else {
        await this.expire();
      }
      return;
    }
    const session = data.session;
    if (session) {
      if (store.get<string>(RECOVERY_KEY) === session.user.id) {
        this.adopt(session.user);
        this.set({ kind: 'RECOVERY_IN_PROGRESS', user: toAccountUser(session.user) });
        return;
      }
      await this.loadAccount(session.user, notice);
      return;
    }
    const pending = store.get<{ email: string }>(PENDING_KEY);
    if (pending?.email) {
      this.set({ kind: 'AWAITING_VERIFICATION', email: pending.email });
      return;
    }
    this.set({ kind: 'SIGNED_OUT', notice });
  }

  /** Foreground, back online: confirm the session is still valid and the account still eligible. */
  async revalidate(): Promise<void> {
    const kind = this.state.kind;
    if (kind === 'AWAITING_VERIFICATION' || kind === 'SIGNED_OUT' || kind === 'SESSION_EXPIRED') {
      // Verified (or signed in) in another tab while this one was in the background?
      const { data } = await this.supabase.auth.getSession();
      if (data.session && !this.busy) await this.loadAccount(data.session.user, kind === 'AWAITING_VERIFICATION' ? { kind: 'email_confirmed' } : undefined);
      return;
    }
    if (kind === 'INITIALIZING' || kind === 'AUTHENTICATING' || this.busy) return;
    const { data, error } = await this.supabase.auth.getUser();
    if (error) {
      if (isNetworkFailure(error)) {
        this.setConnectivity('unreachable');
        return;
      }
      await this.expire();
      return;
    }
    this.setConnectivity('online');
    if (kind === 'RECOVERY_IN_PROGRESS') return;
    await this.loadAccount(data.user);
  }

  private async onAuthEvent(event: string, session: Session | null): Promise<void> {
    if (event === 'TOKEN_REFRESHED' && session) {
      for (const fn of this.tokenListeners) fn(session.access_token);
      return;
    }
    if (event === 'SIGNED_OUT') {
      // Our own sign-out and deletion handle their transitions; anything else means the session
      // ended underneath us (revoked, expired refresh token, account removed).
      if (this.signingOut || this.busy) return;
      const k = this.state.kind;
      if (k !== 'SIGNED_OUT' && k !== 'AWAITING_VERIFICATION' && k !== 'SESSION_EXPIRED' && k !== 'INITIALIZING') {
        this.cleanupAccount();
        this.set({ kind: 'SESSION_EXPIRED' });
      }
      return;
    }
    if (event === 'SIGNED_IN' && session && !this.busy) {
      const k = this.state.kind;
      // Signed in from another tab (e.g. a verification link opened in Safari).
      if (k === 'SIGNED_OUT' || k === 'AWAITING_VERIFICATION' || k === 'SESSION_EXPIRED') await this.loadAccount(session.user);
    }
  }

  private adopt(user: User): void {
    if (this.currentUserId && this.currentUserId !== user.id) this.cleanupAccount();
    this.currentUserId = user.id;
  }

  /** Loads profile and account status and moves to the matching state. */
  async loadAccount(user: User, notice?: Notice): Promise<void> {
    this.adopt(user);
    store.remove(PENDING_KEY);
    store.remove(RECOVERY_REQUEST_KEY);
    const requestId = newRequestId();
    const started = performance.now();
    const [profile, status] = await Promise.all([
      this.supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).maybeSingle(),
      this.supabase.rpc('get_my_account_status'),
    ]);
    const failure = profile.error ?? status.error;
    if (failure || !profile.data) {
      const network = isNetworkFailure(failure);
      logEvent('account_load_failed', { request_id: requestId, safe_error_code: network ? 'network' : (failure?.code ?? 'no_profile'), duration_ms: Math.round(performance.now() - started) });
      if (network) this.setConnectivity('unreachable');
      if (!network && failure && /jwt|401|PGRST30/i.test(`${failure.code} ${failure.message}`)) {
        await this.expire();
        return;
      }
      this.set({ kind: 'ERROR', code: network ? 'backend_unavailable' : 'unexpected' });
      return;
    }
    this.setConnectivity('online');
    const account = toAccountUser(user);
    const st = status.data as { status: string } & Partial<Restriction>;
    if (st.status === 'restricted') {
      this.set({ kind: 'ACCOUNT_RESTRICTED', user: account, restriction: st as Restriction });
      return;
    }
    const p = profile.data as OwnProfile;
    if (!p.onboarding_completed_at) this.set({ kind: 'AUTHENTICATED_NEEDS_PROFILE', user: account, profile: p });
    else this.set({ kind: 'AUTHENTICATED_READY', user: account, profile: p, notice });
  }

  /** Retry after ERROR (e.g. the backend was unreachable). */
  async retry(): Promise<void> {
    await this.restore();
  }

  /** Screens report profile changes so the state (and every screen) shows committed data. */
  profileChanged(profile: OwnProfile): void {
    const s = this.state;
    if (s.kind !== 'AUTHENTICATED_NEEDS_PROFILE' && s.kind !== 'AUTHENTICATED_READY') return;
    if (profile.onboarding_completed_at) this.set({ kind: 'AUTHENTICATED_READY', user: s.user, profile });
    else this.set({ kind: 'AUTHENTICATED_NEEDS_PROFILE', user: s.user, profile });
  }

  // ----------------------------------------------------------------------------------------------
  // Registration and verification
  // ----------------------------------------------------------------------------------------------

  private async guarded(fn: () => Promise<Result>): Promise<Result> {
    if (this.busy) return { ok: false, code: 'unexpected' };
    this.busy = true;
    try {
      return await fn();
    } catch (err) {
      return { ok: false, code: isNetworkFailure(err) ? 'network' : 'unexpected' };
    } finally {
      this.busy = false;
    }
  }

  signUp(email: string, password: string): Promise<Result> {
    return this.guarded(async () => {
      const previous = this.state;
      this.set({ kind: 'AUTHENTICATING' });
      const { data, error } = await this.supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: appReturnUrl(location.href), data: { terms_version: TERMS_VERSION } },
      });
      if (error) {
        this.set(previous.kind === 'AUTHENTICATING' ? { kind: 'SIGNED_OUT' } : previous);
        return { ok: false, code: classify(error) };
      }
      if (data.session) {
        await this.loadAccount(data.session.user);
        return { ok: true };
      }
      store.set(PENDING_KEY, { email, sentAt: Date.now() });
      this.set({ kind: 'AWAITING_VERIFICATION', email });
      return { ok: true };
    });
  }

  async resendVerification(): Promise<Result> {
    if (this.state.kind !== 'AWAITING_VERIFICATION') return { ok: false, code: 'unexpected' };
    const { error } = await this.supabase.auth.resend({ type: 'signup', email: this.state.email, options: { emailRedirectTo: appReturnUrl(location.href) } });
    return error ? { ok: false, code: classify(error) } : { ok: true };
  }

  verifySignupCode(code: string): Promise<Result> {
    return this.guarded(async () => {
      if (this.state.kind !== 'AWAITING_VERIFICATION') return { ok: false, code: 'unexpected' };
      const email = this.state.email;
      const { data, error } = await this.supabase.auth.verifyOtp({ email, token: code, type: 'signup' });
      if (error || !data.user) return { ok: false, code: classify(error) };
      await this.loadAccount(data.user, { kind: 'email_confirmed' });
      return { ok: true };
    });
  }

  /** "Use a different email": abandon this registration and start again. */
  cancelVerification(): void {
    store.remove(PENDING_KEY);
    this.set({ kind: 'SIGNED_OUT' });
  }

  private async consumeLink(flow: AuthLinkFlow, tokenHash: string): Promise<void> {
    this.busy = true;
    this.set({ kind: 'AUTHENTICATING' });
    const before = (await this.supabase.auth.getSession()).data.session;
    const { data, error } = await this.supabase.auth.verifyOtp({ token_hash: tokenHash, type: flow });
    this.busy = false;
    if (error || !data.user) {
      const network = isNetworkFailure(error);
      logEvent('auth_link_rejected', { safe_error_code: network ? 'network' : (error?.code ?? 'unknown'), flow });
      const notice: Notice = { kind: network ? 'link_network' : 'link_expired', flow };
      // Already signed in (e.g. the link was used once already): carry on, mention the link.
      if (before) await this.loadAccount(before.user, notice);
      else {
        const pending = store.get<{ email: string }>(PENDING_KEY);
        if (flow === 'signup' && pending?.email) this.set({ kind: 'AWAITING_VERIFICATION', email: pending.email });
        else this.set({ kind: 'SIGNED_OUT', notice });
      }
      return;
    }
    if (flow === 'recovery') {
      this.enterRecovery(data.user);
      return;
    }
    await this.loadAccount(data.user, { kind: 'email_confirmed' });
  }

  // ----------------------------------------------------------------------------------------------
  // Sign-in, recovery, sign-out
  // ----------------------------------------------------------------------------------------------

  signIn(email: string, password: string): Promise<Result> {
    return this.guarded(async () => {
      const previous = this.state;
      this.set({ kind: 'AUTHENTICATING' });
      const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        const code = classify(error);
        if (code === 'email_not_confirmed') {
          store.set(PENDING_KEY, { email, sentAt: Date.now() });
          this.set({ kind: 'AWAITING_VERIFICATION', email });
        } else {
          if (code === 'network') this.setConnectivity('unreachable');
          // Stay on the screen the player used (e.g. "session ended, sign in again") so the error
          // and what they typed remain.
          this.set(previous.kind === 'SESSION_EXPIRED' ? previous : { kind: 'SIGNED_OUT' });
        }
        return { ok: false, code };
      }
      await this.loadAccount(data.user);
      return { ok: true };
    });
  }

  /** Always reports success for unknown emails (the response must not reveal who has an account). */
  async requestPasswordReset(email: string): Promise<Result> {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email, { redirectTo: appReturnUrl(location.href) });
    if (error) {
      const code = classify(error);
      if (code === 'network' || code === 'rate_limited') return { ok: false, code };
    }
    store.set(RECOVERY_REQUEST_KEY, { email, sentAt: Date.now() });
    return { ok: true };
  }

  /**
   * The email a reset was last requested for, while its code can still be valid (1 hour), so a
   * player who closed the app while waiting for the email returns to "enter the code".
   */
  pendingRecoveryEmail(): string | null {
    const req = store.get<{ email: string; sentAt: number }>(RECOVERY_REQUEST_KEY);
    if (!req?.email) return null;
    if (Date.now() - (req.sentAt ?? 0) > 60 * 60_000) {
      store.remove(RECOVERY_REQUEST_KEY);
      return null;
    }
    return req.email;
  }

  clearRecoveryRequest(): void {
    store.remove(RECOVERY_REQUEST_KEY);
  }

  verifyRecoveryCode(email: string, code: string): Promise<Result> {
    return this.guarded(async () => {
      const { data, error } = await this.supabase.auth.verifyOtp({ email, token: code, type: 'recovery' });
      if (error || !data.user) return { ok: false, code: classify(error) };
      this.enterRecovery(data.user);
      return { ok: true };
    });
  }

  private enterRecovery(user: User): void {
    this.adopt(user);
    store.remove(RECOVERY_REQUEST_KEY);
    // Survives closing the app mid-recovery: on relaunch the player returns to "choose a password".
    store.set(RECOVERY_KEY, user.id);
    this.set({ kind: 'RECOVERY_IN_PROGRESS', user: toAccountUser(user) });
  }

  completePasswordReset(newPassword: string): Promise<Result> {
    return this.guarded(async () => {
      const { data, error } = await this.supabase.auth.updateUser({ password: newPassword });
      if (error || !data.user) {
        const code = classify(error);
        if (!isNetworkFailure(error) && (error?.status === 401 || error?.status === 403)) {
          await this.expire();
          return { ok: false, code: 'session_expired' };
        }
        return { ok: false, code };
      }
      store.remove(RECOVERY_KEY);
      await this.loadAccount(data.user, { kind: 'password_updated' });
      return { ok: true };
    });
  }

  async cancelRecovery(): Promise<void> {
    await this.signOut();
  }

  /** Signs out on this device. Works offline: local session data is cleared regardless. */
  async signOut(notice: Notice = { kind: 'signed_out' }): Promise<void> {
    this.signingOut = true;
    try {
      this.cleanupAccount();
      const { error } = await this.supabase.auth.signOut({ scope: 'local' });
      if (error) this.clearStoredSession();
      store.remove(RECOVERY_KEY);
      store.remove(PENDING_KEY);
      this.set({ kind: 'SIGNED_OUT', notice });
    } finally {
      this.signingOut = false;
    }
  }

  private async expire(): Promise<void> {
    this.signingOut = true;
    try {
      this.cleanupAccount();
      const { error } = await this.supabase.auth.signOut({ scope: 'local' });
      if (error) this.clearStoredSession();
      store.remove(RECOVERY_KEY);
      this.set({ kind: 'SESSION_EXPIRED' });
    } finally {
      this.signingOut = false;
    }
  }

  private clearStoredSession(): void {
    for (const key of [STORAGE_KEY, `${STORAGE_KEY}-code-verifier`, `${STORAGE_KEY}-user`]) store.remove(key);
  }

  private cleanupAccount(): void {
    for (const fn of [...this.cleanups]) {
      try {
        fn();
      } catch {
        /* a failing cleanup must not block sign-out */
      }
    }
    this.cleanups.clear();
    void this.supabase.removeAllChannels();
    this.currentUserId = null;
  }

  // ----------------------------------------------------------------------------------------------
  // Account deletion (performed by the trusted delete-account Edge Function)
  // ----------------------------------------------------------------------------------------------

  deleteAccount(password: string): Promise<Result> {
    return this.guarded(async () => {
      const requestId = newRequestId();
      const started = performance.now();
      const { data, error } = await this.supabase.functions.invoke<{ status?: string }>('delete-account', { body: { password } });
      let code: ResultCode | null = null;
      if (error) {
        const response = (error as { context?: Response }).context;
        const body = response && typeof response.json === 'function' ? ((await response.json().catch(() => ({}))) as { error?: string }) : {};
        code =
          body.error === 'invalid_password' ? 'invalid_password'
          : body.error === 'too_many_attempts' ? 'too_many_attempts'
          : body.error === 'session_expired' ? 'session_expired'
          : response ? 'deletion_failed'
          : 'network';
      } else if (data?.status !== 'deleted') {
        code = 'deletion_failed';
      }
      logEvent('account_deletion', { request_id: requestId, safe_error_code: code, duration_ms: Math.round(performance.now() - started) });
      if (code === 'session_expired') {
        await this.expire();
        return { ok: false, code };
      }
      if (code) return { ok: false, code };
      // Confirmed by the backend: the account is gone. Clear everything local.
      await this.signOut({ kind: 'account_deleted' });
      return { ok: true };
    });
  }
}
