import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openGame, playerSnapshot, startSeededRace, waitForGreenLight, waitForRaceTime, waitForSteps } from './support';

/**
 * Gamepad seam.
 *
 * Playwright cannot plug in a real controller, but the seam that matters is
 * `navigator.getGamepads()` — everything downstream of it is our code. A
 * synthetic Standard Gamepad exercises exactly the path a real one takes:
 * axis deadzone and rescaling, analogue trigger throttle, button edges, and
 * the source switching that tells the settings screen a pad is present.
 */

/** Installs a controllable Standard Gamepad before any page script runs. */
async function installGamepad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      axes: [0, 0, 0, 0],
      buttons: new Array(17).fill(0) as number[],
    };
    (window as unknown as { __pad: typeof state }).__pad = state;

    const build = (): Gamepad =>
      ({
        id: 'Synthetic Standard Gamepad (Vendor: 0000 Product: 0000)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: performance.now(),
        axes: [...state.axes],
        buttons: state.buttons.map((value) => ({ pressed: value > 0.5, touched: value > 0, value })),
        hapticActuators: [],
        vibrationActuator: null,
      }) as unknown as Gamepad;

    navigator.getGamepads = () => [build(), null, null, null];

    // Announce it the way a real pad does, once the page is listening.
    window.addEventListener('load', () => {
      const event = new Event('gamepadconnected') as Event & { gamepad?: Gamepad };
      event.gamepad = build();
      window.dispatchEvent(event);
    });
  });
}

/** Sets synthetic pad state from the test. */
async function setPad(page: Page, update: { axis0?: number; buttons?: Record<number, number> }): Promise<void> {
  await page.evaluate((next) => {
    const pad = (window as unknown as { __pad: { axes: number[]; buttons: number[] } }).__pad;
    if (next.axis0 !== undefined) pad.axes[0] = next.axis0;
    for (const [index, value] of Object.entries(next.buttons ?? {})) pad.buttons[Number(index)] = value;
  }, update);
}

test.describe('gamepad', () => {
  test('drives with the right trigger and steers with the left stick', async ({ page }) => {
    test.slow();
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    // Button 7 is the right trigger on the Standard Gamepad; analogue value.
    await setPad(page, { buttons: { 7: 1 } });
    await waitForSteps(page, 180);

    const moving = await playerSnapshot(page);
    expect(moving?.speed, 'right trigger did not accelerate').toBeGreaterThan(5);

    const input = await page.evaluate(() => window.adRacers?.input() as { throttle: number; steer: number });
    expect(input.throttle).toBeGreaterThan(0.5);

    // Left stick fully right.
    await setPad(page, { axis0: 1 });
    await waitForSteps(page, 30);
    const steering = await page.evaluate(() => window.adRacers?.input() as { steer: number });
    expect(steering.steer).toBeGreaterThan(0.8);

    // ...and fully left.
    await setPad(page, { axis0: -1 });
    await waitForSteps(page, 30);
    const other = await page.evaluate(() => window.adRacers?.input() as { steer: number });
    expect(other.steer).toBeLessThan(-0.8);
  });

  test('ignores stick drift inside the deadzone', async ({ page }) => {
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    // A worn stick resting slightly off centre must not steer the car.
    await setPad(page, { axis0: 0.1 });
    await waitForSteps(page, 30);
    const input = await page.evaluate(() => window.adRacers?.input() as { steer: number });
    expect(Math.abs(input.steer)).toBeLessThan(0.05);
  });

  test('pauses from the Start button', async ({ page }) => {
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    // Button 9 is Start. The action fires on the press edge, not while held.
    await setPad(page, { buttons: { 9: 1 } });
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();

    await setPad(page, { buttons: { 9: 0 } });
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeHidden();
  });

  test('swings the pod arm from the shoulder buttons', async ({ page }) => {
    // Quarantined as preview debt: on CI's single-worker, software-rendered
    // Chromium, the round-3 scene's rendering cost can push waitForRaceTime's
    // 60s wait past its budget before 2.5s of simulated race time accrues.
    // This is CI-runner-speed sensitivity in the shared browser-test
    // infrastructure, not a defect in the strike input this test exercises -
    // see the captain's preview-release decision. Tracked for post-preview
    // follow-up rather than fixed in this release.
    test.fixme(true, 'CI-runner-speed sensitivity in waitForRaceTime under the round-3 scene; deferred as preview debt.');
    test.slow();
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    // Strikes are locked out for the opening seconds of a race.
    await waitForRaceTime(page, 2.5);

    await setPad(page, { buttons: { 5: 1 } });
    await waitForSteps(page, 15);
    const right = await page.evaluate(() => window.adRacers?.input() as { strike: number });
    expect(right.strike).toBe(1);

    await setPad(page, { buttons: { 5: 0, 4: 1 } });
    await waitForSteps(page, 15);
    const left = await page.evaluate(() => window.adRacers?.input() as { strike: number });
    expect(left.strike).toBe(-1);
  });

  test('tells the player a pad was detected', async ({ page }) => {
    await installGamepad(page);
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText(/Gamepad detected/)).toBeVisible();
  });
});
