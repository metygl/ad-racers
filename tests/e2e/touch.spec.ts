import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openGame, playerSnapshot, startSeededRace, waitForGreenLight, waitForSteps } from './support';

/**
 * Touch controls, on a device that actually has a touchscreen.
 *
 * The game only offers thumb pads when there is a genuine coarse pointer *and*
 * touch points — a narrow desktop window is not a phone, and putting pads over
 * a keyboard player's HUD would be worse than showing nothing. This project
 * runs with a real mobile device profile so that check passes honestly.
 */

test.describe('touch controls', () => {
  test('are not offered on the menus, only in a race', async ({ page }) => {
    await openGame(page);
    await expect(page.getByTestId('touch-controls')).toBeHidden();

    await startSeededRace(page);
    await expect(page.getByTestId('touch-controls')).toBeVisible();
  });

  test('auto-throttle means a player only has to steer', async ({ page }) => {
    test.slow();
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    await waitForSteps(page, 180);

    // No input at all from the test: the skiff should already be moving.
    const snapshot = await playerSnapshot(page);
    expect(snapshot?.speed, 'auto-throttle did not engage').toBeGreaterThan(5);
  });

  test('the steering strip is a real slider and steers the skiff', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const steer = page.getByRole('slider', { name: 'Steering' });
    await expect(steer).toBeVisible();

    const box = await steer.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // A press towards the right-hand end of the strip is full right lock.
    await page.dispatchEvent('.touch__steer', 'pointerdown', {
      pointerId: 1,
      clientX: box.x + box.width * 0.95,
      clientY: box.y + box.height / 2,
      isPrimary: true,
    });
    await waitForSteps(page, 30);

    const input = await page.evaluate(() => window.adRacers?.input() as { steer: number });
    expect(input.steer).toBeGreaterThan(0.5);
    await expect(steer).toHaveAttribute('aria-valuenow', /[1-9]\d*/);
  });

  test('the action pads are reachable, sized and labelled', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (!viewport) return;

    for (const label of ['Brake', 'Drift', 'Surge', 'Left', 'Right', 'Pause']) {
      const pad = page.getByRole('button', { name: label, exact: true });
      await expect(pad, `${label} pad missing`).toBeVisible();
      const box = await pad.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      if (!box) continue;
      // Comfortably above the 44 px minimum target, and fully on screen.
      expect(box.width, `${label} too narrow`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${label} too short`).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  });

  test('the pads drive the simulation', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.dispatchEvent('.touch__pad--brake', 'pointerdown', { pointerId: 2, isPrimary: true });
    await waitForSteps(page, 30);
    expect((await page.evaluate(() => window.adRacers?.input() as { brake: boolean })).brake).toBe(true);

    await page.dispatchEvent('.touch__pad--brake', 'pointerup', { pointerId: 2, isPrimary: true });
    await waitForSteps(page, 30);
    expect((await page.evaluate(() => window.adRacers?.input() as { brake: boolean })).brake).toBe(false);
  });

  test('the touch pause button opens the pause dialog', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();
  });

  test('the HUD is not covered by the pads', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const speed = await page.locator('.hud__panel--speed').boundingBox();
    const steerStrip = await page.locator('.touch__steer').boundingBox();
    expect(speed).not.toBeNull();
    expect(steerStrip).not.toBeNull();
    if (!speed || !steerStrip) return;

    // The speed readout must sit clear of the steering strip; a thumb over the
    // speedometer is a HUD that does not exist.
    expect(speed.y + speed.height, 'speed readout overlaps the steering strip').toBeLessThanOrEqual(steerStrip.y + 2);
  });
});

/*
 * The complete touch journey.
 *
 * Reproduces the critical defect where restarting from the pause menu removed
 * the only source of throttle: the restarted race reported `throttle=0`, there
 * was no throttle control on screen, and the HUD then told the player to press
 * a key their device does not have. A touch player could not finish.
 */
test.describe('touch journey', () => {
  const inputState = async (page: Page) =>
    page.evaluate(() => window.adRacers?.input() as { throttle: number; brake: boolean } | undefined);

  test('restart preserves the automatic throttle', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    expect((await inputState(page))?.throttle).toBe(1);

    await page.getByRole('button', { name: 'Pause' }).tap();
    await page.getByRole('button', { name: 'Restart race' }).click();
    await waitForGreenLight(page);

    // The whole defect in one assertion.
    expect((await inputState(page))?.throttle).toBe(1);
    await expect(page.getByTestId('touch-controls')).toBeVisible();
  });

  test('offers Recover and Camera, and names controls the device has', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await expect(page.getByRole('button', { name: 'Recover' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change camera' })).toBeVisible();

    // The stuck prompt must not name a keyboard key on a phone.
    const prompt = await page.evaluate(() => {
      const hud = document.querySelector('.hud__warning');
      return hud?.textContent ?? '';
    });
    expect(prompt).not.toMatch(/press R/i);
  });

  test('brake cuts the auto-throttle so reverse is reachable', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const brake = page.getByRole('button', { name: 'Brake' });
    const box = await brake.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const held = await inputState(page);
    await page.mouse.up();

    expect(held?.brake).toBe(true);
    // With the throttle still open, braking never reached reverse.
    expect(held?.throttle).toBe(0);
  });

  test('no control overlaps the HUD it has to be read alongside', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const boxes = await page.evaluate(() => {
      const pick = (selector: string): { name: string; r: DOMRect } | null => {
        const node = document.querySelector(selector);
        return node ? { name: selector, r: node.getBoundingClientRect().toJSON() as DOMRect } : null;
      };
      const controls = [...document.querySelectorAll('.touch__pad, .touch__icon, .touch__steer')].map((node) => ({
        name: node.className,
        r: node.getBoundingClientRect().toJSON() as DOMRect,
      }));
      const hud = ['.hud__panel--lap', '.hud__panel--time', '.minimap', '.hud__panel--speed']
        .map(pick)
        .filter((x): x is { name: string; r: DOMRect } => x !== null);
      return { controls, hud };
    });

    const overlaps = (a: DOMRect, b: DOMRect): boolean =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const collisions: string[] = [];
    for (const control of boxes.controls) {
      for (const panel of boxes.hud) {
        if (overlaps(control.r, panel.r)) collisions.push(`${control.name} over ${panel.name}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});
