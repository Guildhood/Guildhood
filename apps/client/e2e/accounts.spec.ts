// Phase 2: accounts, verification, recovery, onboarding, profile, session lifecycle, deletion.
import { expect, test, type Page } from '@playwright/test';
import { POSTGRES, run } from '../../../tests/support/db.ts';
import {
  PASSWORD,
  authState,
  captureConsole,
  newIpad,
  onboard,
  readEmail,
  register,
  serviceClient,
  signIn,
  signUpAndOnboard,
  startRegistration,
  uniqueEmail,
  uniqueUsername,
} from './helpers.ts';

const storedSession = (page: Page) => page.evaluate(() => localStorage.getItem('guildhood-auth'));
const accessToken = async (page: Page) => JSON.parse((await storedSession(page))!).access_token as string;
const userIdOf = async (page: Page) => JSON.parse((await storedSession(page))!).user.id as string;

test.describe('registration and verification', () => {
  test('validates input, requires verification, survives a relaunch mid-way, and verifies by code', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('go-create').tap();
    await page.getByTestId('create-submit').tap();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByText('Please agree to the Terms and Privacy policy to continue.')).toBeVisible();

    const { email, since } = await startRegistration(page, 'reg');
    await expect(page.getByTestId('masked-email')).toHaveText(`${email[0]}•••@example.test`);

    await page.reload(); // app closed during registration
    await expect(page.getByTestId('verify-email')).toBeVisible();

    await page.getByTestId('code').fill('000000');
    await page.getByTestId('verify-submit').tap();
    await expect(page.getByTestId('form-error')).toContainText('wrong or has expired');
    const { code } = await readEmail(email, since);
    await page.getByTestId('code').fill(code!);
    await page.getByTestId('verify-submit').tap();
    await expect(page.getByTestId('onboarding')).toBeVisible();
  });

  test('verifies by link with the app open, and with the app not running', async ({ page, browser }) => {
    const first = await startRegistration(page, 'linkopen');
    const link1 = (await readEmail(first.email, first.since)).link!;
    await page.goto(link1); // same tab
    await expect(page.getByTestId('onboarding')).toBeVisible();
    expect(page.url()).not.toContain('token_hash');

    // Register on one iPad, then open the link where Guildhood is not running at all.
    const registering = await newIpad(browser);
    const second = await startRegistration(registering, 'linkcold');
    await registering.context().close();
    const link2 = (await readEmail(second.email, second.since)).link!;
    const cold = await newIpad(browser);
    await cold.goto(link2);
    await expect(cold.getByTestId('onboarding')).toBeVisible();
    await cold.context().close();
  });

  test('a link opened in another tab signs in the tab that was waiting', async ({ page, context, baseURL }) => {
    // Supabase Auth refuses IP-address redirect hosts, so at a numeric LAN address the link lands on
    // the configured site URL (another origin, separate storage) and cannot sign in this tab. That
    // is the documented Wi-Fi limitation (docs/authentication.md); the 6-digit code covers it.
    test.skip(/^https?:\/\/(?!127\.0\.0\.1)\d+\.\d+\.\d+\.\d+/.test(baseURL ?? ''), 'links cannot return to an IP-address host');
    const { email, since } = await startRegistration(page, 'twotabs');
    const link = (await readEmail(email, since)).link!;
    const other = await context.newPage();
    await other.goto(link);
    await expect(other.getByTestId('onboarding')).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // first tab comes back
    await expect(page.getByTestId('onboarding')).toBeVisible();
  });

  test('used, malformed, and unsupported links are refused with a clear message', async ({ page, browser }) => {
    const { email, since } = await startRegistration(page, 'usedlink');
    const link = (await readEmail(email, since)).link!;
    await page.goto(link);
    await expect(page.getByTestId('onboarding')).toBeVisible();

    const fresh = await newIpad(browser);
    await fresh.goto(link); // second use
    await expect(fresh.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'link_expired');
    await fresh.goto('/?type=signup&token_hash=%3Cscript%3E');
    await expect(fresh.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'link_invalid');
    expect(fresh.url()).not.toContain('token_hash');
    await fresh.goto('/?type=magiclink&token_hash=abcdefghijklmnopqrstuvwxyz');
    await expect(fresh.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'link_invalid');
    await fresh.context().close();
  });
});

test.describe('sign-in and sessions', () => {
  test('wrong password, offline, success, and session restoration on relaunch', async ({ page, context }) => {
    const { email } = await signUpAndOnboard(page, 'signin');
    await page.getByTestId('sign-out').tap();
    await expect(page.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'signed_out');

    await signIn(page, email, 'Wrongpass999');
    await expect(page.getByTestId('form-error')).toContainText('don’t match');

    await context.setOffline(true);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByTestId('sign-in-submit').tap();
    await expect(page.getByTestId('form-error')).toContainText('Can’t reach Guildhood');
    await context.setOffline(false);
    await page.getByTestId('sign-in-submit').tap();
    await expect(page.getByTestId('home')).toBeVisible();

    await page.reload(); // relaunch
    await expect(page.getByTestId('home')).toBeVisible();
    expect(await authState(page)).toBe('AUTHENTICATED_READY');
  });

  test('signing in before verifying leads to the verification step', async ({ page }) => {
    const { email } = await startRegistration(page, 'unverified');
    await page.evaluate(() => localStorage.clear());
    await signIn(page, email, PASSWORD);
    await expect(page.getByTestId('verify-email')).toBeVisible();
  });

  test('sign-out clears the account, and the next account never sees the previous profile', async ({ page }) => {
    const a = await signUpAndOnboard(page, 'alpha', 'Alpha Person');
    await page.getByTestId('sign-out').tap();
    await expect(page.getByTestId('welcome')).toBeVisible();
    expect(await storedSession(page)).toBeNull();
    expect(await page.content()).not.toContain('Alpha Person');

    await signUpAndOnboard(page, 'bravo', 'Bravo Person');
    await expect(page.getByTestId('home-display-name')).toHaveText('Bravo Person');
    const html = await page.content();
    expect(html).not.toContain('Alpha Person');
    expect(html).not.toContain(a.username);
  });

  test('a session revoked while account settings are open ends there, without leaving account data on screen', async ({ page }) => {
    const { email } = await signUpAndOnboard(page, 'revoked');
    await page.getByTestId('open-account').tap();
    await expect(page.getByTestId('account-email')).toHaveText(email);
    await serviceClient().auth.admin.signOut(await accessToken(page), 'global'); // e.g. password changed on another device
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('session-expired')).toBeVisible();
    expect(await page.content()).not.toContain(email);
    expect(await storedSession(page)).toBeNull();
    // Signing in again from that screen: a mistake keeps the screen and the message.
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Wrongpass999');
    await page.getByTestId('sign-in-submit').tap();
    await expect(page.getByTestId('form-error')).toContainText('don’t match');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByTestId('sign-in-submit').tap();
    await expect(page.getByTestId('home')).toBeVisible();
  });
});

test.describe('onboarding and profile', () => {
  test('usernames are unique (any case) and reserved; onboarding resumes at the right step after a relaunch', async ({ page, browser }) => {
    const taken = uniqueUsername('taken');
    const other = await newIpad(browser);
    await register(other, 'owner');
    await onboard(other, taken);
    await other.context().close();

    await register(page, 'resume');
    await page.getByTestId('username').fill(taken.toUpperCase());
    await expect(page.getByTestId('username-status')).toHaveText('That username is taken.');
    await page.getByTestId('onboarding-continue').tap();
    await expect(page.getByTestId('form-error')).toHaveText('That username is taken. Try another.');
    await page.getByTestId('username').fill('Admin');
    await expect(page.getByTestId('username-status')).toHaveText('That username is reserved.');

    await page.getByTestId('username').fill(uniqueUsername('mine'));
    await page.getByTestId('onboarding-continue').tap();
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    await page.reload(); // app closed during onboarding
    await expect(page.getByTestId('onboarding-step')).toHaveText('Step 2 of 4');
    await page.getByTestId('display-name-input').fill('Resumed Driver');
    await page.getByTestId('onboarding-continue').tap();
    await expect(page.getByTestId('avatar-moon_plum')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('onboarding-step')).toHaveText('Step 3 of 4');
    await page.getByTestId('avatar-moon_plum').tap();
    await page.getByTestId('onboarding-continue').tap();
    await page.getByTestId('onboarding-continue').tap();
    await expect(page.getByTestId('home-display-name')).toHaveText('Resumed Driver');
    await page.reload(); // returning player skips onboarding
    await expect(page.getByTestId('home')).toBeVisible();
  });

  test('a save during network loss is never reported as saved, and can be retried', async ({ page, context }) => {
    await signUpAndOnboard(page, 'offsave');
    await page.getByTestId('open-profile').tap();
    await page.getByTestId('edit-bio').fill('Saved after the Wi-Fi came back');
    await page.getByTestId('visibility-public').tap();
    await context.setOffline(true);
    await page.getByTestId('save-profile').tap();
    await expect(page.getByTestId('save-status')).toContainText('Not saved');
    await context.setOffline(false);
    await page.getByTestId('save-profile').tap();
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
    await page.reload();
    await page.getByTestId('open-profile').tap();
    await expect(page.getByTestId('edit-bio')).toHaveValue('Saved after the Wi-Fi came back');
    await expect(page.getByTestId('visibility-public')).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('password recovery', () => {
  test('neutral confirmation, code entry, survives closing the app, and the new password works', async ({ page }) => {
    const { email } = await signUpAndOnboard(page, 'recover');
    await page.getByTestId('sign-out').tap();
    await page.getByTestId('go-sign-in').tap();
    await page.getByTestId('go-recovery').tap();

    // Unknown address: same confirmation as a real one.
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('nobody'));
    await page.getByTestId('recovery-submit').tap();
    await expect(page.getByTestId('recovery-sent')).toContainText('If an account exists');
    await page.getByRole('button', { name: 'Use a different email' }).tap();

    await page.getByLabel('Email', { exact: true }).fill(email);
    const since = Date.now();
    await page.getByTestId('recovery-submit').tap();
    await expect(page.getByTestId('recovery-sent')).toContainText('If an account exists');
    await page.reload(); // closed the app while waiting for the email
    await expect(page.getByTestId('recovery-sent')).toBeVisible();
    const { code } = await readEmail(email, since);
    await page.getByTestId('code').fill(code!);
    await page.getByTestId('recovery-code-submit').tap();
    await expect(page.getByTestId('reset-password')).toBeVisible();
    await page.reload(); // closed the app before choosing a password
    await expect(page.getByTestId('reset-password')).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill('Fresh456pass');
    await page.getByLabel('Confirm new password', { exact: true }).fill('Fresh456pass');
    await page.getByTestId('reset-submit').tap();
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('notice-toast')).toContainText('password has been changed');

    await page.getByTestId('sign-out').tap();
    await signIn(page, email, PASSWORD);
    await expect(page.getByTestId('form-error')).toContainText('don’t match');
    await signIn(page, email, 'Fresh456pass');
    await expect(page.getByTestId('home')).toBeVisible();
  });

  test('a recovery link works once; an expired one offers a new reset', async ({ page, browser }) => {
    const { email } = await signUpAndOnboard(page, 'reclink');
    const userId = await userIdOf(page);
    await page.getByTestId('sign-out').tap();

    let since = Date.now();
    await serviceClient().auth.resetPasswordForEmail(email, { redirectTo: new URL('/', page.url()).toString() });
    const link = (await readEmail(email, since)).link!;
    const viaLink = await newIpad(browser);
    await viaLink.goto(link);
    await expect(viaLink.getByTestId('reset-password')).toBeVisible();
    await viaLink.context().close();

    since = Date.now();
    await new Promise((r) => setTimeout(r, 1100));
    await serviceClient().auth.resetPasswordForEmail(email, { redirectTo: new URL('/', page.url()).toString() });
    const stale = (await readEmail(email, since)).link!;
    await run(POSTGRES, `update auth.users set recovery_sent_at = now() - interval '2 hours' where id = $1`, [userId]);
    await run(POSTGRES, `update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = $1`, [userId]).catch(() => {});
    const expired = await newIpad(browser);
    await expired.goto(stale);
    await expect(expired.getByTestId('recovery')).toBeVisible();
    await expect(expired.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'link_expired');
    await expired.context().close();
  });
});

test.describe('restriction and deletion', () => {
  test('a restricted account sees its status and cannot play or edit', async ({ page }) => {
    await signUpAndOnboard(page, 'banned');
    const userId = await userIdOf(page);
    const { error } = await serviceClient().rpc('server_add_restriction', {
      p_user_id: userId,
      p_restriction_type: 'suspended',
      p_reason_code: 'cheating',
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      p_note: 'Internal: telemetry case 42',
    });
    expect(error).toBeNull();
    await page.reload();
    await expect(page.getByTestId('restricted')).toBeVisible();
    await expect(page.getByTestId('restriction-text')).toContainText('cheating');
    expect(await page.content()).not.toContain('telemetry case 42');
  });

  test('deletion needs the right password, removes the account, and the old password no longer works', async ({ page }) => {
    const { email, username } = await signUpAndOnboard(page, 'deleteme');
    await page.getByTestId('open-account').tap();
    await page.getByTestId('open-delete').tap();
    await expect(page.getByTestId('delete-submit')).toBeDisabled();
    await page.getByTestId('delete-password').fill('Wrongpass999');
    await page.getByTestId('delete-confirm').fill('DELETE');
    await page.getByTestId('delete-submit').tap();
    await expect(page.getByTestId('delete-error')).toHaveText('That password isn’t right.');
    await expect(page.getByTestId('delete-account')).toBeVisible(); // not shown as deleted

    await page.getByTestId('delete-password').fill(PASSWORD);
    await page.getByTestId('delete-submit').tap();
    await expect(page.getByTestId('welcome')).toBeVisible();
    await expect(page.getByTestId('auth-notice')).toHaveAttribute('data-kind', 'account_deleted');
    expect(await storedSession(page)).toBeNull();
    expect(await page.content()).not.toContain(username);

    await signIn(page, email, PASSWORD);
    await expect(page.getByTestId('form-error')).toContainText('don’t match');
  });
});

test.describe('input, accessibility, and logging', () => {
  test('fields are labelled, Return advances between fields, and nothing sensitive reaches the console', async ({ page }) => {
    const lines = captureConsole(page);
    await page.goto('/');
    await page.getByTestId('go-create').tap();
    for (const label of ['Email', 'Confirm password']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();

    await page.getByLabel('Email', { exact: true }).fill('focus@example.test');
    await page.getByLabel('Email', { exact: true }).press('Enter');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await page.getByLabel('Password', { exact: true }).fill('Visible123');
    await page.getByRole('button', { name: 'Show password' }).tap();
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');

    const { email } = await signUpAndOnboard(page, 'logs');
    const all = lines.join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(email);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(all).not.toContain('token_hash=');
  });
});
