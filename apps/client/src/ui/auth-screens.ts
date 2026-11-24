import { passwordChecks } from '@guildhood/shared';
import type { AuthManager, Notice, Restriction } from '../auth/manager.ts';
import { brand, h } from './dom.ts';
import { field, isEmail, passwordChecklist, passwordField, setBusy, wireFormKeys } from './forms.ts';
import { RESTRICTION_REASONS, RESULT_TEXT, maskEmail, noticeText } from './messages.ts';
import type { Screen } from './screen.ts';

export type AuthRoute = 'welcome' | 'sign-in' | 'create' | 'recovery';

export interface AuthNav {
  go(route: AuthRoute, opts?: { email?: string }): void;
  /** Only for the restricted screen: open account deletion. */
  deleteAccount?(): void;
}

const RESEND_COOLDOWN_S = 60;

/** Scrollable, keyboard-aware card layout shared by every auth screen. */
function shell(testId: string, ...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'center-screen form-screen', 'data-testid': testId }, h('div', { class: 'card' }, brand(), ...children));
}

function noticeBanner(notice: Notice | undefined): HTMLElement | null {
  if (!notice) return null;
  const good = notice.kind === 'signed_out' || notice.kind === 'account_deleted' || notice.kind === 'password_updated' || notice.kind === 'email_confirmed';
  return h('div', { class: `notice ${good ? 'good' : 'warn'}`, role: 'status', 'data-testid': 'auth-notice', dataset: { kind: notice.kind }, text: noticeText(notice) });
}

function legalLinks(): HTMLElement {
  return h(
    'p',
    { class: 'legal' },
    h('a', { href: './privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy policy' }),
    ' · ',
    h('a', { href: './terms.html', target: '_blank', rel: 'noopener', text: 'Terms' }),
  );
}

function formError(): HTMLElement {
  return h('div', { class: 'error form-error', role: 'alert', 'data-testid': 'form-error' });
}

/** A countdown button for "resend". */
function cooldownButton(label: string, testId: string, sentAt: number, onClick: () => Promise<boolean>): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: 'secondary', 'data-testid': testId });
  let until = sentAt + RESEND_COOLDOWN_S * 1000;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `${label} (${left}s)` : label;
    if (left > 0) setTimeout(tick, 1000);
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (await onClick()) until = Date.now() + RESEND_COOLDOWN_S * 1000;
    tick();
  });
  tick();
  return btn;
}

// -------------------------------------------------------------------------------------------------

export class WelcomeScreen implements Screen {
  readonly el: HTMLElement;
  constructor(nav: AuthNav, notice?: Notice) {
    this.el = shell(
      'welcome',
      noticeBanner(notice),
      h('p', { class: 'tagline', text: 'Drive your neighborhood. Gather your Guild.' }),
      h('button', { class: 'big', text: 'Create account', 'data-testid': 'go-create', onClick: () => nav.go('create') }),
      h('button', { class: 'secondary big', text: 'Sign in', 'data-testid': 'go-sign-in', onClick: () => nav.go('sign-in') }),
      legalLinks(),
    );
  }
  unmount(): void {}
}

export class SignInScreen implements Screen {
  readonly el: HTMLElement;
  private readonly email;
  constructor(manager: AuthManager, nav: AuthNav, opts: { notice?: Notice; email?: string; expired?: boolean } = {}) {
    this.email = field({ label: 'Email', type: 'email', autocomplete: 'username', inputmode: 'email', value: opts.email, testId: 'email' });
    const password = passwordField({ label: 'Password', autocomplete: 'current-password', testId: 'password' });
    const error = formError();
    const submit = h('button', { type: 'submit', text: 'Sign in', 'data-testid': 'sign-in-submit' });
    const form = h('form', { class: 'stack' }, this.email.wrap, password.wrap, error, submit);
    wireFormKeys(form, [this.email.input, password.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const email = this.email.input.value.trim();
      this.email.setError(isEmail(email) ? null : 'Enter your email address.');
      password.setError(password.input.value ? null : 'Enter your password.');
      if (!isEmail(email) || !password.input.value) return;
      setBusy(submit, true, 'Signing in…');
      const r = await manager.signIn(email, password.input.value);
      setBusy(submit, false);
      if (!r.ok && r.code !== 'email_not_confirmed') error.textContent = RESULT_TEXT[r.code];
    });
    this.el = shell(
      opts.expired ? 'session-expired' : 'sign-in',
      opts.expired ? h('div', { class: 'notice warn', role: 'status', text: 'Your session has ended. Please sign in again.' }) : noticeBanner(opts.notice),
      h('h1', { text: 'Sign in' }),
      form,
      h('button', { type: 'button', class: 'link', text: 'Forgot password?', 'data-testid': 'go-recovery', onClick: () => nav.go('recovery', { email: this.email.input.value.trim() }) }),
      h('p', { class: 'muted center' }, 'New to Guildhood? ', h('button', { type: 'button', class: 'link', text: 'Create an account', 'data-testid': 'go-create', onClick: () => nav.go('create') })),
      legalLinks(),
    );
  }
  unmount(): void {}
}

export class CreateAccountScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, nav: AuthNav) {
    const email = field({ label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email', testId: 'email' });
    const password = passwordField({ label: 'Password', autocomplete: 'new-password', testId: 'password' });
    const confirm = passwordField({ label: 'Confirm password', autocomplete: 'new-password', testId: 'confirm-password' });
    const checklist = passwordChecklist(password.input);
    const termsId = 'terms-agree';
    const terms = h('input', { type: 'checkbox', id: termsId, 'data-testid': 'agree-terms' });
    const termsError = h('div', { class: 'error', role: 'alert' });
    const termsRow = h(
      'div',
      { class: 'checkbox-row' },
      terms,
      h(
        'label',
        { for: termsId },
        'I agree to the ',
        h('a', { href: './terms.html', target: '_blank', rel: 'noopener', text: 'Terms' }),
        ' and ',
        h('a', { href: './privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy policy' }),
        '.',
      ),
    );
    const error = formError();
    const submit = h('button', { type: 'submit', text: 'Create account', 'data-testid': 'create-submit' });
    const form = h('form', { class: 'stack' }, email.wrap, password.wrap, checklist, confirm.wrap, termsRow, termsError, error, submit);
    wireFormKeys(form, [email.input, password.input, confirm.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const addr = email.input.value.trim();
      const checks = passwordChecks(password.input.value);
      const strong = checks.length && checks.letter && checks.digit;
      email.setError(isEmail(addr) ? null : 'Enter a valid email address.');
      password.setError(strong ? null : 'Your password needs at least 8 characters, with letters and numbers.');
      confirm.setError(confirm.input.value === password.input.value ? null : 'The passwords don’t match.');
      termsError.textContent = terms.checked ? '' : 'Please agree to the Terms and Privacy policy to continue.';
      if (!isEmail(addr) || !strong || confirm.input.value !== password.input.value || !terms.checked) {
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
      setBusy(submit, true, 'Creating account…');
      const r = await manager.signUp(addr, password.input.value);
      setBusy(submit, false);
      if (!r.ok) error.textContent = RESULT_TEXT[r.code];
    });
    this.el = shell(
      'create-account',
      h('h1', { text: 'Create your account' }),
      form,
      h('p', { class: 'muted center' }, 'Already have an account? ', h('button', { type: 'button', class: 'link', text: 'Sign in', 'data-testid': 'go-sign-in', onClick: () => nav.go('sign-in') })),
    );
  }
  unmount(): void {}
}

export class VerifyEmailScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, nav: AuthNav, email: string, sentAt: number) {
    const code = field({ label: '6-digit code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, testId: 'code' });
    code.input.classList.add('code-input');
    const error = formError();
    const status = h('div', { class: 'muted', role: 'status' });
    const submit = h('button', { type: 'submit', text: 'Confirm email', 'data-testid': 'verify-submit' });
    const form = h('form', { class: 'stack' }, code.wrap, error, submit);
    wireFormKeys(form, [code.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const token = code.input.value.replace(/\D/g, '');
      if (token.length !== 6) {
        code.setError('Enter the 6-digit code from the email.');
        return;
      }
      code.setError(null);
      setBusy(submit, true, 'Checking…');
      const r = await manager.verifySignupCode(token);
      setBusy(submit, false);
      if (!r.ok) error.textContent = RESULT_TEXT[r.code];
    });
    const resend = cooldownButton('Send a new code', 'resend', sentAt, async () => {
      const r = await manager.resendVerification();
      status.textContent = r.ok ? 'We sent a new code and link. Use the newest email.' : RESULT_TEXT[r.code];
      return r.ok;
    });
    this.el = shell(
      'verify-email',
      h('h1', { text: 'Check your email' }),
      h('p', {}, 'We sent a 6-digit code and a link to ', h('strong', { 'data-testid': 'masked-email', text: maskEmail(email) }), '. Enter the code below, or open the link on this iPad.'),
      form,
      resend,
      status,
      h('p', { class: 'muted small', text: 'Already have a Guildhood account with this email? Sign in instead. Codes and links expire after 1 hour.' }),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { type: 'button', class: 'link', text: 'Use a different email', 'data-testid': 'restart-registration', onClick: () => { manager.cancelVerification(); nav.go('create'); } }),
        h('button', { type: 'button', class: 'link', text: 'Back to sign in', onClick: () => { manager.cancelVerification(); nav.go('sign-in', { email }); } }),
      ),
    );
  }
  unmount(): void {}
}

/** Request a reset, then enter the emailed code (or open the link). */
export class RecoveryRequestScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'stack' });
  constructor(private readonly manager: AuthManager, private readonly nav: AuthNav, opts: { email?: string; notice?: Notice } = {}) {
    this.el = shell('recovery', noticeBanner(opts.notice), h('h1', { text: 'Reset your password' }), this.body);
    const pending = manager.pendingRecoveryEmail();
    if (pending && !opts.notice) this.showSent(pending, Date.now() - RESEND_COOLDOWN_S * 1000);
    else this.showRequest(opts.email ?? pending ?? '');
  }

  private showRequest(prefill: string): void {
    const email = field({ label: 'Email', type: 'email', autocomplete: 'username', inputmode: 'email', value: prefill, testId: 'email' });
    const error = formError();
    const submit = h('button', { type: 'submit', text: 'Send reset email', 'data-testid': 'recovery-submit' });
    const form = h('form', { class: 'stack' }, h('p', { class: 'muted', text: 'Enter the email you signed up with. We’ll send a code and a link to choose a new password.' }), email.wrap, error, submit);
    wireFormKeys(form, [email.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const addr = email.input.value.trim();
      email.setError(isEmail(addr) ? null : 'Enter a valid email address.');
      if (!isEmail(addr)) return;
      setBusy(submit, true, 'Sending…');
      const r = await this.manager.requestPasswordReset(addr);
      setBusy(submit, false);
      if (!r.ok) error.textContent = RESULT_TEXT[r.code];
      else this.showSent(addr, Date.now());
    });
    this.body.replaceChildren(form, h('button', { type: 'button', class: 'link', text: 'Back to sign in', onClick: () => { this.manager.clearRecoveryRequest(); this.nav.go('sign-in', { email: email.input.value.trim() }); } }));
  }

  private showSent(addr: string, sentAt: number): void {
    const code = field({ label: '6-digit code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, testId: 'code' });
    code.input.classList.add('code-input');
    const error = formError();
    const status = h('div', { class: 'muted', role: 'status' });
    const submit = h('button', { type: 'submit', text: 'Continue', 'data-testid': 'recovery-code-submit' });
    const form = h('form', { class: 'stack' }, code.wrap, error, submit);
    wireFormKeys(form, [code.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = code.input.value.replace(/\D/g, '');
      if (token.length !== 6) {
        code.setError('Enter the 6-digit code from the email.');
        return;
      }
      code.setError(null);
      setBusy(submit, true, 'Checking…');
      const r = await this.manager.verifyRecoveryCode(addr, token);
      setBusy(submit, false);
      if (!r.ok) error.textContent = RESULT_TEXT[r.code];
    });
    this.body.replaceChildren(
      // Neutral: never reveals whether the address has an account.
      h('p', { 'data-testid': 'recovery-sent' }, 'If an account exists for ', h('strong', { text: maskEmail(addr) }), ', we’ve sent a 6-digit code and a link. They expire in 1 hour.'),
      form,
      cooldownButton('Send again', 'recovery-resend', sentAt, async () => {
        const r = await this.manager.requestPasswordReset(addr);
        status.textContent = r.ok ? 'Sent again. Use the newest email.' : RESULT_TEXT[r.code];
        return r.ok;
      }),
      status,
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'link', text: 'Use a different email', onClick: () => { this.manager.clearRecoveryRequest(); this.showRequest(''); } }),
        h('button', { type: 'button', class: 'link', text: 'Back to sign in', onClick: () => this.nav.go('sign-in', { email: addr }) }),
      ),
    );
  }
  unmount(): void {}
}

export class ResetPasswordScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, email: string) {
    const password = passwordField({ label: 'New password', autocomplete: 'new-password', testId: 'new-password' });
    const confirm = passwordField({ label: 'Confirm new password', autocomplete: 'new-password', testId: 'confirm-password' });
    const error = formError();
    const submit = h('button', { type: 'submit', text: 'Save new password', 'data-testid': 'reset-submit' });
    const form = h('form', { class: 'stack' }, password.wrap, passwordChecklist(password.input), confirm.wrap, error, submit);
    wireFormKeys(form, [password.input, confirm.input]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const c = passwordChecks(password.input.value);
      const strong = c.length && c.letter && c.digit;
      password.setError(strong ? null : 'Your password needs at least 8 characters, with letters and numbers.');
      confirm.setError(confirm.input.value === password.input.value ? null : 'The passwords don’t match.');
      if (!strong || confirm.input.value !== password.input.value) return;
      setBusy(submit, true, 'Saving…');
      const r = await manager.completePasswordReset(password.input.value);
      setBusy(submit, false);
      if (!r.ok) error.textContent = RESULT_TEXT[r.code];
    });
    this.el = shell(
      'reset-password',
      h('h1', { text: 'Choose a new password' }),
      h('p', { class: 'muted' }, 'For ', h('strong', { text: maskEmail(email) }), '.'),
      form,
      h('button', { type: 'button', class: 'link', text: 'Cancel and sign out', 'data-testid': 'reset-cancel', onClick: () => void manager.cancelRecovery() }),
    );
  }
  unmount(): void {}
}

export class RestrictedScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, nav: AuthNav, r: Restriction) {
    const until = r.expires_at ? new Date(r.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
    this.el = shell(
      'restricted',
      h('h1', { text: r.restriction_type === 'banned' ? 'This account is banned' : 'This account is suspended' }),
      h('p', { 'data-testid': 'restriction-text', text: `Guildhood restricted this account for ${RESTRICTION_REASONS[r.reason_code] ?? RESTRICTION_REASONS.other}.${until ? ` The suspension ends ${until}.` : ''}` }),
      h('p', { class: 'muted', text: 'While restricted you can’t play or change your profile. You can still sign out or delete your account.' }),
      h('button', { class: 'secondary', text: 'Sign out', 'data-testid': 'sign-out', onClick: () => void manager.signOut() }),
      nav.deleteAccount ? h('button', { class: 'link danger-text', text: 'Delete my account', onClick: () => nav.deleteAccount?.() }) : null,
      legalLinks(),
    );
  }
  unmount(): void {}
}

export class BackendErrorScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, code: 'backend_unavailable' | 'unexpected') {
    const retry = h('button', { text: 'Try again', 'data-testid': 'retry' });
    retry.addEventListener('click', async () => {
      setBusy(retry, true, 'Trying…');
      await manager.retry();
      setBusy(retry, false);
    });
    this.el = shell(
      'backend-error',
      h('h1', { text: code === 'backend_unavailable' ? 'Can’t reach Guildhood' : 'Something went wrong' }),
      h('p', { text: code === 'backend_unavailable' ? 'You’re still signed in. Check your connection, then try again.' : 'We couldn’t load your account. Please try again.' }),
      retry,
      h('button', { class: 'link', text: 'Sign out', onClick: () => void manager.signOut() }),
    );
  }
  unmount(): void {}
}

export class LoadingScreen implements Screen {
  readonly el: HTMLElement;
  constructor(message: string) {
    this.el = h('div', { class: 'center-screen', 'data-testid': 'loading' }, h('div', { class: 'card center' }, brand(), h('div', { class: 'spinner dark' }), h('p', { class: 'muted', text: message })));
  }
  unmount(): void {}
}
