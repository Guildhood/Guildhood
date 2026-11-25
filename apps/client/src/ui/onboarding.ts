import type { SupabaseClient } from '@supabase/supabase-js';
import { AVATARS, USERNAME_MAX, displayNameProblem, normalizeUsername, usernameFormatProblem } from '@guildhood/shared';
import { isNetworkFailure, type AuthManager, type OwnProfile } from '../auth/manager.ts';
import { renderAvatar } from './avatars.ts';
import { brand, clear, h } from './dom.ts';
import { field, setBusy, wireFormKeys } from './forms.ts';
import type { Screen } from './screen.ts';

type Step = 'username' | 'display_name' | 'avatar' | 'review';
const STEPS: Step[] = ['username', 'display_name', 'avatar', 'review'];
const STEP_TITLES: Record<Step, string> = {
  username: 'Choose a username',
  display_name: 'What should other drivers call you?',
  avatar: 'Pick an avatar',
  review: 'Check your profile',
};

/** Player-facing text for profile-function errors (raw database errors are never shown). */
export function profileErrorText(err: { message?: string } | null | undefined): string {
  const m = err?.message ?? '';
  if (isNetworkFailure(err)) return 'Couldn’t save because Guildhood is unreachable. Check your connection and try again.';
  if (m.includes('username_taken')) return 'That username is taken. Try another.';
  if (m.includes('username_reserved')) return 'That username is reserved. Try another.';
  if (m.includes('username_invalid_format')) return 'Usernames are 3–20 letters, numbers, or underscores.';
  if (m.includes('display_name_invalid')) return 'Display names are 2–30 characters of plain text.';
  if (m.includes('avatar_invalid')) return 'Pick one of the avatars shown.';
  if (m.includes('bio_invalid')) return 'Bios are up to 160 characters of plain text.';
  if (m.includes('account_restricted')) return 'This account is restricted and can’t be changed right now.';
  return 'Couldn’t save. Please try again.';
}

export function usernameFormatText(problem: ReturnType<typeof usernameFormatProblem>): string | null {
  if (problem === 'too_short') return 'At least 3 characters.';
  if (problem === 'too_long') return `At most ${USERNAME_MAX} characters.`;
  if (problem === 'characters') return 'Use only letters a–z, numbers, and underscores.';
  return null;
}

/** Live availability check (format locally, then the server for taken/reserved). */
export function usernameChecker(supabase: SupabaseClient, input: HTMLInputElement, status: HTMLElement, current: string | null) {
  let timer: number | undefined;
  let seq = 0;
  const check = () => {
    window.clearTimeout(timer);
    const name = normalizeUsername(input.value);
    status.className = 'hint';
    if (!name || name === current) {
      status.textContent = name === current && current ? 'This is your current username.' : '3–20 letters, numbers, or underscores.';
      return;
    }
    const problem = usernameFormatText(usernameFormatProblem(name));
    if (problem) {
      status.textContent = problem;
      status.className = 'hint bad';
      return;
    }
    status.textContent = 'Checking…';
    const mine = ++seq;
    timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc('check_username', { p_username: name });
      if (mine !== seq) return;
      if (error) {
        status.textContent = 'Couldn’t check right now; we’ll check again when you save.';
        return;
      }
      const r = data as { available: boolean; reason: string | null };
      status.textContent = r.available ? `@${name} is available.` : r.reason === 'reserved' ? 'That username is reserved.' : r.reason === 'taken' ? 'That username is taken.' : 'Usernames are 3–20 letters, numbers, or underscores.';
      status.className = r.available ? 'hint good' : 'hint bad';
    }, 350);
  };
  input.addEventListener('input', check);
  check();
}

export function avatarPicker(selected: string | null, onPick: (id: string) => void): HTMLElement {
  const grid = h('div', { class: 'avatar-grid', role: 'radiogroup', 'aria-label': 'Avatar' });
  const buttons: HTMLButtonElement[] = [];
  for (const a of AVATARS) {
    const btn = h('button', {
      type: 'button',
      class: `avatar-option${a.id === selected ? ' selected' : ''}`,
      role: 'radio',
      'aria-checked': String(a.id === selected),
      'aria-label': a.name,
      'data-testid': `avatar-${a.id}`,
    });
    btn.append(renderAvatar(a.id, 56), h('span', { text: a.name }));
    btn.addEventListener('click', () => {
      for (const b of buttons) {
        b.classList.toggle('selected', b === btn);
        b.setAttribute('aria-checked', String(b === btn));
      }
      onPick(a.id);
    });
    buttons.push(btn);
    grid.append(btn);
  }
  return grid;
}

export class OnboardingScreen implements Screen {
  readonly el: HTMLElement;
  private readonly body = h('div', { class: 'stack' });
  private readonly progress = h('div', { class: 'steps', 'aria-hidden': 'true' });
  private readonly stepLabel = h('div', { class: 'muted', 'data-testid': 'onboarding-step' });
  private viewing: Step;

  constructor(
    private readonly manager: AuthManager,
    private readonly supabase: SupabaseClient,
    private profile: OwnProfile,
  ) {
    this.viewing = (profile.onboarding_step ?? 'review') as Step;
    this.el = h(
      'div',
      { class: 'center-screen form-screen', 'data-testid': 'onboarding' },
      h('div', { class: 'card wide' }, brand(), this.progress, this.stepLabel, this.body, h('button', { type: 'button', class: 'link', text: 'Sign out', onClick: () => void manager.signOut() })),
    );
    this.render();
  }

  /** Called when the manager publishes a newer profile (after a save). */
  update(profile: OwnProfile): void {
    this.profile = profile;
    const furthest = STEPS.indexOf((profile.onboarding_step ?? 'review') as Step);
    if (STEPS.indexOf(this.viewing) < furthest) this.viewing = STEPS[furthest]!;
    this.render();
  }

  private go(step: Step): void {
    this.viewing = step;
    this.render();
  }

  private async save(fn: () => PromiseLike<{ data: unknown; error: { message?: string } | null }>, button: HTMLButtonElement, error: HTMLElement): Promise<void> {
    error.textContent = '';
    setBusy(button, true, 'Saving…');
    const { data, error: err } = await fn();
    setBusy(button, false);
    if (err) {
      error.textContent = profileErrorText(err);
      return;
    }
    // The manager republishes the profile; update() then moves to the next unfinished step (or,
    // after editing an earlier step, back to review). Completing onboarding leaves this screen.
    this.manager.profileChanged({ ...this.profile, ...(data as Partial<OwnProfile>) });
  }

  private render(): void {
    const idx = STEPS.indexOf(this.viewing);
    clear(this.progress);
    STEPS.forEach((_, i) => this.progress.append(h('span', { class: i <= idx ? 'on' : '' })));
    this.stepLabel.textContent = `Step ${idx + 1} of ${STEPS.length}`;
    const back = idx > 0 ? h('button', { type: 'button', class: 'secondary', text: 'Back', onClick: () => this.go(STEPS[idx - 1]!) }) : null;
    const error = h('div', { class: 'error', role: 'alert', 'data-testid': 'form-error' });
    const title = h('h1', { text: STEP_TITLES[this.viewing] });
    const submit = h('button', { type: 'submit', text: this.viewing === 'review' ? 'Finish' : 'Continue', 'data-testid': 'onboarding-continue' });
    const form = h('form', { class: 'stack' });

    if (this.viewing === 'username') {
      const name = field({ label: 'Username', value: this.profile.username ?? '', maxlength: USERNAME_MAX + 4, testId: 'username' });
      const status = h('div', { class: 'hint', 'aria-live': 'polite', 'data-testid': 'username-status' });
      name.wrap.insertBefore(status, name.wrap.lastChild);
      usernameChecker(this.supabase, name.input, status, this.profile.username);
      form.append(h('p', { class: 'muted', text: 'Your unique @name. Friends can find you by it. Letters, numbers, and underscores; 3–20 characters.' }), name.wrap);
      wireFormKeys(form, [name.input]);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = normalizeUsername(name.input.value);
        const problem = usernameFormatText(usernameFormatProblem(value));
        name.setError(problem);
        if (problem) return;
        void this.save(() => this.supabase.rpc('claim_username', { p_username: value }), submit, error);
      });
    } else if (this.viewing === 'display_name') {
      const name = field({ label: 'Display name', value: this.profile.display_name, maxlength: 40, autocomplete: 'nickname', testId: 'display-name-input' });
      form.append(h('p', { class: 'muted', text: 'Shown above your car and in friends lists. 2–30 characters; doesn’t need to be unique.' }), name.wrap);
      wireFormKeys(form, [name.input]);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = name.input.value.trim();
        const problem = displayNameProblem(value);
        name.setError(problem === 'length' ? 'Use 2–30 characters.' : problem === 'characters' ? 'Use plain text only.' : null);
        if (problem) return;
        void this.save(() => this.supabase.rpc('update_my_profile', { p_changes: { display_name: value } }), submit, error);
      });
    } else if (this.viewing === 'avatar') {
      let chosen = this.profile.avatar_asset_id;
      const pickError = h('div', { class: 'error', role: 'alert' });
      form.append(avatarPicker(chosen, (id) => (chosen = id)), pickError);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!chosen) {
          pickError.textContent = 'Pick an avatar to continue.';
          return;
        }
        const id = chosen;
        void this.save(() => this.supabase.rpc('update_my_profile', { p_changes: { avatar_asset_id: id } }), submit, error);
      });
    } else {
      const p = this.profile;
      form.append(
        h(
          'div',
          { class: 'review', 'data-testid': 'review' },
          renderAvatar(p.avatar_asset_id, 72),
          h('div', {}, h('div', { class: 'name big-name', text: p.display_name }), h('div', { class: 'muted', text: `@${p.username ?? ''}` })),
        ),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'link', text: 'Change username', onClick: () => this.go('username') }),
          h('button', { type: 'button', class: 'link', text: 'Change display name', onClick: () => this.go('display_name') }),
          h('button', { type: 'button', class: 'link', text: 'Change avatar', onClick: () => this.go('avatar') }),
        ),
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.save(() => this.supabase.rpc('complete_onboarding'), submit, error);
      });
    }
    form.append(error, h('div', { class: 'row' }, back, submit));
    this.body.replaceChildren(title, form);
  }

  unmount(): void {}
}
