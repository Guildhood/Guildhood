import { expect, test } from '@playwright/test';
import { debug, driveWithTouch, newIpad, signUpAndOnboard, waitLive } from './helpers.ts';

test.describe('two iPads', () => {
  test('friends add each other over Realtime, drive together, and see each other move', async ({ browser }) => {
    const a = await newIpad(browser);
    const b = await newIpad(browser);
    await signUpAndOnboard(a, 'ipad-a');
    await signUpAndOnboard(b, 'ipad-b');

    // B adds A by friend code; A is told in real time (no reload).
    const aCode = (await a.getByTestId('friend-code').textContent())!;
    await b.getByTestId('add-friend-code').fill(aCode);
    await b.getByTestId('add-friend').tap();
    await expect(a.getByTestId('friend-request-toast')).toBeVisible({ timeout: 15_000 });
    await expect(a.getByTestId('incoming-request')).toBeVisible();
    await a.getByTestId('accept-request').tap();
    await expect(b.getByTestId('friend')).toBeVisible({ timeout: 15_000 });

    // A starts driving; B sees A online and joins A's session.
    await a.getByTestId('drive').tap();
    const aLive = await waitLive(a);
    await expect(b.locator('[data-testid="friend"][data-online="true"]')).toBeVisible({ timeout: 20_000 });
    await b.getByTestId('join-friend').tap();
    const bLive = await waitLive(b);
    expect(bLive.instanceId).toBe(aLive.instanceId);
    await expect(a.getByTestId('joined-toast')).toBeVisible();
    await expect(a.getByTestId('player-count')).toHaveText('2 drivers here');

    // B drives with touch; A's iPad receives B's car moving.
    const bId = bLive.selfId!;
    const seenBefore = (await debug(a))!.lastCars.find((c) => c.id === bId)!;
    expect(seenBefore).toBeTruthy();
    await driveWithTouch(b, 2000);
    await expect
      .poll(async () => {
        const car = (await debug(a))!.lastCars.find((c) => c.id === bId);
        return car ? Math.hypot(car.x - seenBefore.x, car.z - seenBefore.z) : 0;
      })
      .toBeGreaterThan(5);

    // B leaves; A sees it.
    await b.getByTestId('leave').tap();
    await expect(a.getByTestId('player-count')).toHaveText('1 driver here');
    await a.context().close();
    await b.context().close();
  });

  test('a driver invites a friend, who joins from the invite', async ({ browser }) => {
    const a = await newIpad(browser);
    const b = await newIpad(browser);
    await signUpAndOnboard(a, 'inv-a');
    await signUpAndOnboard(b, 'inv-b');
    const bCode = (await b.getByTestId('friend-code').textContent())!;
    await a.getByTestId('add-friend-code').fill(bCode);
    await a.getByTestId('add-friend').tap();
    await expect(b.getByTestId('incoming-request')).toBeVisible({ timeout: 20_000 });
    await b.getByTestId('accept-request').tap();

    await a.getByTestId('drive').tap();
    const aLive = await waitLive(a);
    await a.getByTestId('invite').tap();
    await a.getByTestId('invite-friend').tap();

    const invite = b.getByTestId('invite-toast');
    await expect(invite).toBeVisible({ timeout: 15_000 });
    await invite.getByRole('button', { name: 'Join' }).tap();
    const bLive = await waitLive(b);
    expect(bLive.instanceId).toBe(aLive.instanceId);
    await a.context().close();
    await b.context().close();
  });
});
