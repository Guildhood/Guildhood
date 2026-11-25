import { devices, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readEmail, serviceClient } from '../../../tests/support/auth.ts';
import type { DriveDebug } from '../src/ui/drive.ts';

export const PASSWORD = 'Goodpass123';
export { readEmail, serviceClient };

export const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
export const uniqueUsername = (label: string) => `${label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8)}_${Math.random().toString(36).slice(2, 8)}`;

/** Create account through the real UI, up to the verify-email screen. Returns when the email was sent. */
export async function startRegistration(page: Page, label: string, password = PASSWORD): Promise<{ email: string; since: number }> {
  const email = uniqueEmail(label);
  await page.goto('/');
  await page.getByTestId('go-create').tap();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByTestId('agree-terms').check();
  const since = Date.now();
  await page.getByTestId('create-submit').tap();
  await expect(page.getByTestId('verify-email')).toBeVisible();
  return { email, since };
}

/** Full registration with the emailed 6-digit code; ends on the onboarding screen. */
export async function register(page: Page, label: string): Promise<{ email: string; password: string }> {
  const { email, since } = await startRegistration(page, label);
  const { code } = await readEmail(email, since);
  await page.getByTestId('code').fill(code!);
  await page.getByTestId('verify-submit').tap();
  await expect(page.getByTestId('onboarding')).toBeVisible();
  return { email, password: PASSWORD };
}

export async function onboard(page: Page, username: string, displayName = 'Test Driver', avatar = 'leaf_moss'): Promise<void> {
  await page.getByTestId('username').fill(username);
  await page.getByTestId('onboarding-continue').tap();
  await page.getByTestId('display-name-input').fill(displayName);
  await page.getByTestId('onboarding-continue').tap();
  await page.getByTestId(`avatar-${avatar}`).tap();
  await page.getByTestId('onboarding-continue').tap();
  await expect(page.getByTestId('review')).toBeVisible();
  await page.getByTestId('onboarding-continue').tap();
  await expect(page.getByTestId('home')).toBeVisible();
}

/** Register, verify, and finish onboarding through the UI. */
export async function signUpAndOnboard(page: Page, label: string, displayName = 'Test Driver'): Promise<{ email: string; password: string; username: string }> {
  const creds = await register(page, label);
  const username = uniqueUsername(label);
  await onboard(page, username, displayName);
  return { ...creds, username };
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('go-sign-in').tap();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByTestId('sign-in-submit').tap();
}

export const debug = (page: Page) => page.evaluate(() => window.__guildhoodDebug?.drive ?? null) as Promise<DriveDebug | null>;
export const authState = (page: Page) => page.evaluate(() => window.__guildhoodDebug?.auth?.state ?? null);

export async function waitLive(page: Page): Promise<DriveDebug> {
  await page.waitForFunction(() => window.__guildhoodDebug?.drive?.status === 'live', null, { timeout: 30_000 });
  return (await debug(page))!;
}

/** Real multi-touch through the Chrome DevTools Protocol (each finger is its own touch point). */
export class Fingers {
  private constructor(private readonly cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>) {}

  static async on(page: Page): Promise<Fingers> {
    return new Fingers(await page.context().newCDPSession(page));
  }

  async press(points: { x: number; y: number; id: number }[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  }

  async release(): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

export async function center(page: Page, testId: string, dx = 0): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 };
}

/** Holds the gas pedal (and optionally steers) with two fingers for `ms`. */
export async function driveWithTouch(page: Page, ms: number, steerDx = 0): Promise<void> {
  const fingers = await Fingers.on(page);
  const gas = await center(page, 'gas');
  const points = [{ ...gas, id: 1 }];
  if (steerDx) points.push({ ...(await center(page, 'steer-pad', steerDx)), id: 2 });
  await fingers.press(points);
  await page.waitForTimeout(ms);
  await fingers.release();
}

/** A fresh emulated iPad (separate cookies/storage = a separate player). */
export async function newIpad(browser: Browser): Promise<Page> {
  const { defaultBrowserType: _ignored, ...ipad } = devices['iPad Pro 11 landscape'];
  const ctx = await browser.newContext({ ...ipad, deviceScaleFactor: 1, baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173' });
  return ctx.newPage();
}

/** Collects everything the page writes to its console, to check nothing sensitive is logged. */
export function captureConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  return lines;
}
