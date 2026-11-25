import type { SupabaseClient } from '@supabase/supabase-js';
import { BIO_MAX, USERNAME_MAX, bioProblem, displayNameProblem, normalizeUsername, usernameFormatProblem, type ProfileVisibility } from '@guildhood/shared';
import type { AccountUser, AuthManager, OwnProfile } from '../auth/manager.ts';
import { h } from './dom.ts';
import { field, passwordField, setBusy } from './forms.ts';
import { RESULT_TEXT, maskEmail } from './messages.ts';
import { avatarPicker, profileErrorText, usernameChecker, usernameFormatText } from './onboarding.ts';
import type { Screen } from './screen.ts';

function header(title: string, onBack: () => void, testId: string): HTMLElement {
  return h('div', { class: 'settings-header' }, h('button', { type: 'button', class: 'secondary', text: 'Back', 'data-testid': `${testId}-back`, onClick: onBack }), h('h1', { text: title }));
}

const VISIBILITY_TEXT: Record<ProfileVisibility, [string, string]> = {
  public: ['Everyone', 'Any signed-in player can see your profile card.'],
  friends: ['Friends', 'Only your friends can see your profile card.'],
  private: ['Only me', 'Nobody else can see your profile card.'],
};

/** Edit display name, username, avatar, bio, and visibility. Nothing shows as saved until the server confirms it. */
export class ProfileSettingsScreen implements Screen {
  readonly el: HTMLElement;
  private dirty = false;

  constructor(manager: AuthManager, supabase: SupabaseClient, profile: OwnProfile, onBack: () => void) {
    let base = { ...profile };
    let avatar = profile.avatar_asset_id;
    let visibility = profile.profile_visibility;
    const display = field({ label: 'Display name', value: profile.display_name, maxlength: 40, autocomplete: 'nickname', testId: 'edit-display-name' });
    const username = field({ label: 'Username', value: profile.username ?? '', maxlength: USERNAME_MAX + 4, testId: 'edit-username' });
    const usernameStatus = h('div', { class: 'hint', 'aria-live': 'polite' });
    username.wrap.insertBefore(usernameStatus, username.wrap.lastChild);
    usernameChecker(supabase, username.input, usernameStatus, profile.username);
    const bioId = 'bio-input';
    const bio = h('textarea', { id: bioId, rows: '3', maxlength: String(BIO_MAX + 20), 'data-testid': 'edit-bio' });
    bio.value = profile.bio ?? '';
    const bioCount = h('div', { class: 'hint' });
    const bioError = h('div', { class: 'error', role: 'alert' });
    const countBio = () => (bioCount.textContent = `${[...bio.value.trim()].length}/${BIO_MAX}`);
    countBio();
    const visibilityGroup = h('div', { class: 'choice-group', role: 'radiogroup', 'aria-label': 'Who can see your profile' });
    for (const v of ['public', 'friends', 'private'] as ProfileVisibility[]) {
      const btn = h(
        'button',
        { type: 'button', class: `choice${v === visibility ? ' selected' : ''}`, role: 'radio', 'aria-checked': String(v === visibility), 'data-testid': `visibility-${v}` },
        h('strong', { text: VISIBILITY_TEXT[v][0] }),
        h('span', { text: VISIBILITY_TEXT[v][1] }),
      );
      btn.addEventListener('click', () => {
        visibility = v;
        for (const b of visibilityGroup.children) {
          b.classList.toggle('selected', b === btn);
          b.setAttribute('aria-checked', String(b === btn));
        }
        markDirty();
      });
      visibilityGroup.append(btn);
    }

    const status = h('div', { class: 'save-status', role: 'status', 'aria-live': 'polite', 'data-testid': 'save-status' });
    const save = h('button', { type: 'button', text: 'Save changes', 'data-testid': 'save-profile', disabled: true });
    const discard = h('button', { type: 'button', class: 'secondary', text: 'Discard', disabled: true });

    const changes = () => {
      const c: Record<string, unknown> = {};
      if (display.input.value.trim() !== base.display_name) c.display_name = display.input.value.trim();
      if (avatar !== base.avatar_asset_id) c.avatar_asset_id = avatar;
      if ((bio.value.trim() || null) !== (base.bio ?? null)) c.bio = bio.value.trim();
      if (visibility !== base.profile_visibility) c.profile_visibility = visibility;
      const name = normalizeUsername(username.input.value);
      return { profile: c, username: name !== (base.username ?? '') ? name : null };
    };
    const markDirty = () => {
      const c = changes();
      this.dirty = Object.keys(c.profile).length > 0 || c.username !== null;
      save.disabled = !this.dirty;
      discard.disabled = !this.dirty;
      status.className = 'save-status';
      status.textContent = this.dirty ? 'Unsaved changes' : '';
    };
    for (const el of [display.input, username.input, bio]) el.addEventListener('input', markDirty);
    bio.addEventListener('input', countBio);

    save.addEventListener('click', async () => {
      const c = changes();
      // Validate locally first (the server validates again).
      const dn = displayNameProblem(display.input.value.trim());
      display.setError(dn === 'length' ? 'Use 2–30 characters.' : dn === 'characters' ? 'Use plain text only.' : null);
      const un = c.username ? usernameFormatText(usernameFormatProblem(c.username)) : null;
      username.setError(un);
      const bp = bioProblem(bio.value.trim());
      bioError.textContent = bp === 'length' ? `Up to ${BIO_MAX} characters.` : bp === 'characters' ? 'Use plain text only.' : '';
      if (dn || un || bp) return;

      setBusy(save, true, 'Saving…');
      status.className = 'save-status';
      status.textContent = 'Saving…';
      let latest: Partial<OwnProfile> | null = null;
      let failure: { message?: string } | null = null;
      if (c.username) {
        const r = await supabase.rpc('claim_username', { p_username: c.username });
        if (r.error) failure = r.error;
        else {
          latest = r.data as Partial<OwnProfile>;
          base = { ...base, ...latest };
        }
      }
      if (!failure && Object.keys(c.profile).length) {
        const r = await supabase.rpc('update_my_profile', { p_changes: c.profile });
        if (r.error) failure = r.error;
        else {
          latest = r.data as Partial<OwnProfile>;
          base = { ...base, ...latest };
        }
      }
      setBusy(save, false);
      if (latest) manager.profileChanged({ ...base });
      if (failure) {
        markDirty(); // whatever did not save is still shown as unsaved
        status.className = 'save-status bad';
        status.textContent = `Not saved. ${profileErrorText(failure)}`;
        return;
      }
      markDirty();
      status.className = 'save-status good';
      status.textContent = 'Saved';
    });
    discard.addEventListener('click', () => {
      display.input.value = base.display_name;
      username.input.value = base.username ?? '';
      bio.value = base.bio ?? '';
      avatar = base.avatar_asset_id;
      visibility = base.profile_visibility;
      onBack(); // simplest faithful reset: leave and re-open shows committed values
    });

    this.el = h(
      'div',
      { class: 'settings form-screen', 'data-testid': 'profile-settings' },
      header('Profile', () => {
        if (this.dirty && !confirm('Discard unsaved changes?')) return;
        onBack();
      }, 'profile'),
      h(
        'div',
        { class: 'settings-body' },
        h('section', { class: 'panel' }, h('h2', { text: 'Avatar' }), avatarPicker(avatar, (id) => { avatar = id; markDirty(); })),
        h('section', { class: 'panel' }, display.wrap, username.wrap, h('div', { class: 'field' }, h('label', { for: bioId, text: 'Bio (optional)' }), bio, bioCount, bioError)),
        h('section', { class: 'panel' }, h('h2', { text: 'Who can see your profile' }), visibilityGroup, h('p', { class: 'muted small', text: 'Your display name and avatar still appear to friends and to players driving with you.' })),
      ),
      h('div', { class: 'settings-footer' }, status, discard, save),
    );
  }
  unmount(): void {}
}

/** Account: email, password reset, privacy, sign out, delete, legal. */
export class AccountSettingsScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, supabase: SupabaseClient, user: AccountUser, nav: { back(): void; deleteAccount(): void }) {
    const resetStatus = h('div', { class: 'muted', role: 'status', 'data-testid': 'reset-status' });
    const reset = h('button', { type: 'button', class: 'secondary', text: 'Send password reset email', 'data-testid': 'send-reset' });
    reset.addEventListener('click', async () => {
      setBusy(reset, true, 'Sending…');
      const r = await manager.requestPasswordReset(user.email);
      setBusy(reset, false);
      resetStatus.textContent = r.ok ? `We sent a code and a link to ${maskEmail(user.email)}. Sign out and choose “Forgot password?” to enter the code, or open the link.` : RESULT_TEXT[r.code];
    });

    const allow = h('input', { type: 'checkbox', id: 'allow-requests', 'data-testid': 'allow-friend-requests' });
    const privacyStatus = h('div', { class: 'muted small', role: 'status' });
    void supabase.from('profile_private').select('privacy_settings').eq('user_id', user.id).maybeSingle().then(({ data }) => {
      allow.checked = (data?.privacy_settings as { allow_friend_requests?: boolean } | undefined)?.allow_friend_requests !== false;
    });
    allow.addEventListener('change', async () => {
      const wanted = allow.checked;
      allow.disabled = true;
      privacyStatus.textContent = 'Saving…';
      const { error } = await supabase.rpc('update_my_privacy_settings', { p_settings: { allow_friend_requests: wanted } });
      allow.disabled = false;
      if (error) {
        allow.checked = !wanted;
        privacyStatus.textContent = profileErrorText(error);
      } else privacyStatus.textContent = 'Saved';
    });

    this.el = h(
      'div',
      { class: 'settings form-screen', 'data-testid': 'account-settings' },
      header('Account', nav.back, 'account'),
      h(
        'div',
        { class: 'settings-body' },
        h('section', { class: 'panel' }, h('h2', { text: 'Sign-in' }), h('div', {}, 'Email: ', h('strong', { 'data-testid': 'account-email', text: user.email })), reset, resetStatus),
        h('section', { class: 'panel' }, h('h2', { text: 'Privacy' }), h('div', { class: 'checkbox-row' }, allow, h('label', { for: 'allow-requests', text: 'Allow friend requests' })), privacyStatus),
        h(
          'section',
          { class: 'panel' },
          h('button', { type: 'button', class: 'secondary', text: 'Sign out', 'data-testid': 'account-sign-out', onClick: () => void manager.signOut() }),
          h('p', { class: 'legal' }, h('a', { href: './privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy policy' }), ' · ', h('a', { href: './terms.html', target: '_blank', rel: 'noopener', text: 'Terms' })),
        ),
        h('section', { class: 'panel danger-zone' }, h('h2', { text: 'Delete account' }), h('p', { class: 'muted', text: 'Permanently delete your Guildhood account and its data.' }), h('button', { type: 'button', class: 'danger', text: 'Delete account…', 'data-testid': 'open-delete', onClick: nav.deleteAccount })),
      ),
    );
  }
  unmount(): void {}
}

/** Consequences, password, typed confirmation, then the trusted deletion request. */
export class DeleteAccountScreen implements Screen {
  readonly el: HTMLElement;
  constructor(manager: AuthManager, user: AccountUser, onBack: () => void) {
    const password = passwordField({ label: 'Your password', autocomplete: 'current-password', testId: 'delete-password' });
    const typed = field({ label: 'Type DELETE to confirm', testId: 'delete-confirm' });
    const error = h('div', { class: 'error form-error', role: 'alert', 'data-testid': 'delete-error' });
    const submit = h('button', { type: 'submit', class: 'danger', text: 'Delete my account', 'data-testid': 'delete-submit', disabled: true });
    const update = () => (submit.disabled = !(password.input.value && typed.input.value.trim() === 'DELETE'));
    password.input.addEventListener('input', update);
    typed.input.addEventListener('input', update);
    const form = h('form', { class: 'stack' }, password.wrap, typed.wrap, error, submit);
    form.noValidate = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      error.textContent = '';
      setBusy(submit, true, 'Deleting…');
      const r = await manager.deleteAccount(password.input.value);
      if (r.ok) return; // the manager has signed out; this screen is gone
      setBusy(submit, false);
      update();
      error.textContent = RESULT_TEXT[r.code];
      if (r.code === 'invalid_password') password.input.select();
    });
    this.el = h(
      'div',
      { class: 'settings form-screen', 'data-testid': 'delete-account' },
      header('Delete account', onBack, 'delete'),
      h(
        'div',
        { class: 'settings-body narrow' },
        h(
          'section',
          { class: 'panel' },
          h('h2', { text: 'This can’t be undone' }),
          h('p', {}, 'Deleting ', h('strong', { text: user.email }), ' permanently removes:'),
          h(
            'ul',
            { class: 'consequences' },
            h('li', { text: 'Your profile, username, avatar, and settings' }),
            h('li', { text: 'Your friends, friend requests, and invites' }),
            h('li', { text: 'Your cars, Marks, and history' }),
          ),
          h('p', { class: 'muted small', text: 'Friends will see “A deleted player” on old notifications. A minimal security record that the account existed and was deleted is kept (see the Privacy policy). Your username becomes available to others.' }),
          form,
        ),
      ),
    );
  }
  unmount(): void {}
}
