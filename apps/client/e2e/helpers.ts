import { devices, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readLocalSupabase } from '../../../scripts/supabase-env.mjs';
import type { DriveDebug } from '../src/ui/drive.ts';

const { MAILPIT_URL } = readLocalSupabase();

async function codeFor(email: string, since: number): Promise<string> {
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as { messages: { Created: string; Snippet: string; To: { Address: string }[] }[] };
      const code = body.messages
        .filter((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && Date.parse(m.Created) >= since - 5000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0]
        ?.Snippet.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in code for ${email}`);
}

/** Signs in through the real UI with a fresh email and waits for the home screen. */
export async function signIn(page: Page, label: string): Promise<string> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await page.goto('/');
  await page.getByTestId('email').fill(email);
  const since = Date.now();
  await page.getByTestId('send-code').tap();
  await page.getByTestId('code').fill(await codeFor(email, since));
  await page.getByTestId('verify-code').tap();
  await expect(page.getByTestId('balance')).toBeVisible();
  return email;
}

export const debug = (page: Page) => page.evaluate(() => window.__guildhoodDebug?.drive ?? null) as Promise<DriveDebug | null>;

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

  async move(points: { x: number; y: number; id: number }[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
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
