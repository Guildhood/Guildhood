import { expect, test } from '@playwright/test';
import { center, debug, driveWithTouch, signUpAndOnboard, waitLive } from './helpers.ts';

test.describe('one iPad', () => {
  test('a new account starts with the starter car, Marks, and its chosen profile', async ({ page }) => {
    const { username } = await signUpAndOnboard(page, 'solo', 'Solo Driver');
    await expect(page.getByTestId('balance')).toHaveText('500 Marks');
    await expect(page.getByTestId('car-name')).toHaveText('Sprout Hatch');
    await expect(page.getByTestId('friend-code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    await expect(page.getByTestId('neighborhood-name')).toHaveText('Copperleaf Commons');
    await expect(page.getByTestId('home-display-name')).toHaveText('Solo Driver');
    await expect(page.getByTestId('home-username')).toHaveText(`@${username}`);
  });

  test('renaming (profile settings) and repainting persist across reloads', async ({ page }) => {
    await signUpAndOnboard(page, 'paint');
    await page.getByTestId('open-profile').tap();
    await page.getByTestId('edit-display-name').fill('Lantern Lou');
    await page.getByTestId('save-profile').tap();
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
    await page.getByTestId('profile-back').tap();
    await expect(page.getByTestId('home-display-name')).toHaveText('Lantern Lou');
    await page.getByTestId('swatch-4').tap();
    await expect(page.getByTestId('swatch-4')).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await expect(page.getByTestId('home-display-name')).toHaveText('Lantern Lou');
    await expect(page.getByTestId('swatch-4')).toHaveAttribute('aria-checked', 'true');
  });

  test('background refreshes keep what the player is typing', async ({ page }) => {
    await signUpAndOnboard(page, 'typing');
    const field = page.getByTestId('add-friend-code');
    await field.fill('ABCD');
    await page.getByTestId('swatch-2').tap(); // re-renders the garage and top bar
    await expect(page.getByTestId('swatch-2')).toHaveAttribute('aria-checked', 'true');
    await expect(field).toHaveValue('ABCD');
    // App returns to the foreground: the account is revalidated and republished; home updates in place.
    const refreshed = page.waitForResponse((r) => r.url().includes('get_my_account_status'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
    await page.waitForTimeout(300);
    await expect(field).toHaveValue('ABCD');
    // Same for unsaved edits in profile settings.
    await page.getByTestId('open-profile').tap();
    await page.getByTestId('edit-display-name').fill('Half Typed');
    const again = page.waitForResponse((r) => r.url().includes('get_my_account_status'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await again;
    await page.waitForTimeout(300);
    await expect(page.getByTestId('edit-display-name')).toHaveValue('Half Typed');
    await expect(page.getByTestId('save-status')).toHaveText('Unsaved changes');
  });

  test('drives with two-finger touch controls under server authority', async ({ page }) => {
    await signUpAndOnboard(page, 'drive');
    await page.getByTestId('drive').tap();
    const start = await waitLive(page);
    const before = start.serverCar ?? (await debug(page))!.serverCar;
    await driveWithTouch(page, 2500, 90); // gas + steer right
    await page.waitForTimeout(400);
    const after = (await debug(page))!;
    expect(after.serverCar).not.toBeNull();
    const moved = Math.hypot(after.serverCar!.x - (before?.x ?? 0), after.serverCar!.z - (before?.z ?? 0));
    expect(moved).toBeGreaterThan(5);
    expect(after.serverCar!.h).not.toBeCloseTo(before?.h ?? 0, 2);
    // Client prediction agrees with the server once inputs stop.
    await page.waitForTimeout(1500);
    const settled = (await debug(page))!;
    expect(Math.hypot(settled.predicted!.x - settled.serverCar!.x, settled.predicted!.z - settled.serverCar!.z)).toBeLessThan(1);

    await page.getByTestId('leave').tap();
    await expect(page.getByTestId('home')).toBeVisible();
  });

  test('recovers from a network drop and keeps the same seat', async ({ page, context }) => {
    await signUpAndOnboard(page, 'drop');
    await page.getByTestId('drive').tap();
    const first = await waitLive(page);

    // Chromium's offline emulation does not cut WebSockets that are already open, so go offline
    // (reconnect attempts fail) and sever the live socket, as a real Wi-Fi drop would.
    await context.setOffline(true);
    await page.evaluate(() => window.__guildhoodDebug?.dropConnection?.());
    await expect(page.getByTestId('reconnecting')).toBeVisible({ timeout: 15_000 });
    // Controls are disabled while reconnecting.
    await page.waitForTimeout(2500);
    expect((await debug(page))!.status).toBe('reconnecting');
    await context.setOffline(false);

    await expect(page.getByTestId('reconnecting')).toBeHidden({ timeout: 30_000 });
    const again = (await debug(page))!;
    expect(again.status).toBe('live');
    expect(again.instanceId).toBe(first.instanceId);
    expect(again.resumed).toBe(true);
    expect(again.welcomes).toBe(2);
  });

  test('detects a silent Wi-Fi drop (no close event) and resumes when the network returns', async ({ page, context }) => {
    await signUpAndOnboard(page, 'silent');
    await page.getByTestId('drive').tap();
    const first = await waitLive(page);
    await context.setOffline(true); // traffic stops; the socket never reports closing
    await expect(page.getByTestId('reconnecting')).toBeVisible({ timeout: 15_000 });
    await context.setOffline(false);
    await expect(page.getByTestId('reconnecting')).toBeHidden({ timeout: 30_000 });
    const again = (await debug(page))!;
    expect(again.status).toBe('live');
    expect(again.instanceId).toBe(first.instanceId);
    expect(again.resumed).toBe(true);
  });

  test('asks to rotate in portrait and fits controls to the landscape screen', async ({ page }) => {
    await signUpAndOnboard(page, 'layout');
    await page.getByTestId('drive').tap();
    await waitLive(page);
    const vp = page.viewportSize()!;
    for (const id of ['gas', 'brake', 'steer-pad', 'leave', 'invite']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.y, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(vp.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(vp.height);
    }
    // Steering and pedals do not overlap, so two thumbs never fight.
    const steer = (await page.getByTestId('steer-pad').boundingBox())!;
    const brake = (await page.getByTestId('brake').boundingBox())!;
    expect(steer.x + steer.width).toBeLessThan(brake.x);

    await expect(page.locator('#rotate')).toBeHidden();
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await expect(page.locator('#rotate')).toBeVisible();
    await page.setViewportSize(vp);
    await expect(page.locator('#rotate')).toBeHidden();
    expect(await center(page, 'gas')).toBeTruthy();
  });
});
