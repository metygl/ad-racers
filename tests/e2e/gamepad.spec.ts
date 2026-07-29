import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  noticesSeen,
  openGame,
  playerSnapshot,
  skipRaceTime,
  startSeededRace,
  strikeState,
  waitForGreenLight,
  waitForSteps,
  watchNotices,
} from './support';

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
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    /*
     * Past the countdown and the strike grace without paying to render them.
     *
     * This wait used to be `waitForRaceTime(page, 2.5)`, which is 5.5 s of
     * simulated time - the 3 s countdown plus the 2 s grace - and the loop can
     * only advance 67 ms of race per drawn frame. On CI's software WebGL that
     * came to most of the helper's whole 60 s budget, spent on a stretch of
     * race this test asserts nothing about, and the test was quarantined for
     * timing out on it. See `skipRaceTime`.
     */
    await skipRaceTime(page, 5.5);

    /*
     * And the assertion is the *swing*, not the input object.
     *
     * Reading `input().strike` only proved the button reached the mapping. What
     * the player is promised is that the right shoulder swings the pod arm to
     * their right, so that is what is checked - through the simulation, on the
     * racer's own strike state.
     */
    await setPad(page, { buttons: { 5: 1 } });
    await waitForSteps(page, 8);
    const right = await strikeState(page);
    expect(right.phase, 'the right shoulder did not start a swing').not.toBe('idle');
    expect(right.side, 'the right shoulder swung the wrong way').toBe(1);

    // Release, let the arm reset, and the other shoulder is an opposite swing.
    await setPad(page, { buttons: { 5: 0 } });
    await skipRaceTime(page, 2);
    await setPad(page, { buttons: { 4: 1 } });
    await waitForSteps(page, 8);
    const left = await strikeState(page);
    expect(left.phase, 'the left shoulder did not start a swing').not.toBe('idle');
    expect(left.side, 'the left shoulder swung the wrong way').toBe(-1);
  });

  test('a held shoulder is one swing, not one request per step', async ({ page }) => {
    test.slow();
    await installGamepad(page);
    await openGame(page);
    await startSeededRace(page);
    await skipRaceTime(page, 5.5);

    /*
     * The live review's highest-severity interaction defect, from the pad's
     * side: one 100 ms press produced twelve `Already swinging` refusals and
     * twelve refusal sounds, because a held control was handed to the
     * simulation as a fresh request on every fixed step. A physical press is
     * one request on every device; see `InputManager.poll`.
     *
     * The hold runs through the *real* loop rather than `skipRaceTime`, because
     * the thing under test is the feedback the player receives and that only
     * exists on drawn frames.
     */
    await watchNotices(page);
    await setPad(page, { buttons: { 5: 1 } });
    await waitForSteps(page, 8);
    const swinging = await strikeState(page);
    expect(swinging.phase, 'the shoulder did not start a swing').not.toBe('idle');

    // Hold right through windup, active, recovery and the whole cooldown.
    await waitForSteps(page, 220);
    const afterHold = await strikeState(page);
    /*
     * Idle *and* off cooldown is what proves there was no second swing: a swing
     * re-arms the 1.5 s cooldown, so a re-trigger anywhere in the last 1.8 s
     * would still be showing time on the clock here.
     */
    expect(afterHold.phase, 'a held shoulder was still swinging after the cooldown').toBe('idle');
    expect(afterHold.cooldown, 'a held shoulder started a second swing').toBe(0);

    const notices = await noticesSeen(page);
    expect(notices.filter((text) => /Already swinging|still resetting/.test(text)), 'refusal storm').toHaveLength(0);

    // Releasing and pressing again is a new request, and does swing again.
    await setPad(page, { buttons: { 5: 0 } });
    await waitForSteps(page, 4);
    await setPad(page, { buttons: { 5: 1 } });
    await waitForSteps(page, 8);
    expect((await strikeState(page)).phase, 'a fresh press did not swing').not.toBe('idle');
  });

  test('tells the player a pad was detected', async ({ page }) => {
    await installGamepad(page);
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText(/Gamepad detected/)).toBeVisible();
  });
});
