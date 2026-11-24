import type { SupabaseClient } from '@supabase/supabase-js';
import { friendlyError } from '../supabase.ts';
import { brand, clear, h } from './dom.ts';
import type { Screen } from './screen.ts';

/** Email one-time-code sign-in (no passwords, no links to tap on another device). */
export class SignInScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private email = '';

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly onSignedIn: () => void,
    private readonly localMailHint: boolean,
  ) {
    this.body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    this.el = h('div', { class: 'center-screen', 'data-testid': 'sign-in' }, h('div', { class: 'card' }, brand(), this.body));
    this.showEmail();
  }

  private showEmail(): void {
    clear(this.body);
    const input = h('input', {
      type: 'email',
      inputmode: 'email',
      autocomplete: 'email',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'you@example.com',
      'aria-label': 'Email address',
      'data-testid': 'email',
      value: this.email,
    });
    const error = h('div', { class: 'error', role: 'alert' });
    const send = h('button', { type: 'submit', text: 'Send sign-in code', 'data-testid': 'send-code' });
    const form = h(
      'form',
      {
        style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        onSubmit: async (e: Event) => {
          e.preventDefault();
          const email = input.value.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            error.textContent = 'Enter a valid email address.';
            return;
          }
          send.disabled = true;
          error.textContent = '';
          const { error: err } = await this.supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
          send.disabled = false;
          if (err) {
            error.textContent = /rate|security purposes/i.test(err.message)
              ? 'Please wait a moment before asking for another code.'
              : friendlyError(err.message);
            return;
          }
          this.email = email;
          this.showCode();
        },
      },
      h('p', { class: 'muted', style: { margin: '0' }, text: 'Sign in with your email. We’ll send you a 6-digit code.' }),
      input,
      error,
      send,
    );
    this.body.append(form);
  }

  private showCode(): void {
    clear(this.body);
    const input = h('input', {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      pattern: '[0-9]*',
      maxlength: '6',
      placeholder: '123456',
      'aria-label': 'Six-digit code',
      'data-testid': 'code',
      style: { letterSpacing: '8px', fontSize: '28px', textAlign: 'center' },
    });
    const error = h('div', { class: 'error', role: 'alert' });
    const verify = h('button', { type: 'submit', text: 'Sign in', 'data-testid': 'verify-code' });
    const form = h(
      'form',
      {
        style: { display: 'flex', flexDirection: 'column', gap: '12px' },
        onSubmit: async (e: Event) => {
          e.preventDefault();
          const token = input.value.replace(/\D/g, '');
          if (token.length !== 6) {
            error.textContent = 'Enter the 6-digit code from the email.';
            return;
          }
          verify.disabled = true;
          const { error: err } = await this.supabase.auth.verifyOtp({ email: this.email, token, type: 'email' });
          verify.disabled = false;
          if (err) {
            error.textContent = /expired|invalid/i.test(err.message) ? 'That code is wrong or expired. Try again or get a new code.' : friendlyError(err.message);
            return;
          }
          this.onSignedIn();
        },
      },
      h('p', { class: 'muted', style: { margin: '0' } }, 'Enter the code sent to ', h('strong', { text: this.email }), '.'),
      this.localMailHint
        ? h('p', {
            class: 'muted',
            style: { margin: '0', fontSize: '15px' },
            text: 'Local test server: the code is printed in the terminal running “npm run lan”.',
          })
        : null,
      input,
      error,
      verify,
      h('button', { type: 'button', class: 'ghost', text: 'Use a different email', onClick: () => this.showEmail() }),
    );
    this.body.append(form);
    setTimeout(() => input.focus(), 50);
  }

  unmount(): void {}
}
