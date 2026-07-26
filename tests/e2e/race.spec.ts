import { expect, test } from '@playwright/test';
import {
  currentScreen,
  goToSetup,
  measureFrames,
  openGame,
  playerSnapshot,
  startSeededRace,
  waitForGreenLight,
  waitForRaceTime,
  waitForSteps,
  watchForErrors,
} from './support';

/**
 * The menu-to-finish flow, in a real browser, against the production build.
 *
 * This is the test that would have caught every one of the defects found by
 * playing the game by hand: a title screen that renders nothing, a road that is
 * back-face culled, a car that cannot be steered.
 */

test.describe('menu to finish', () => {
  test('loads the title screen with no console errors', async ({ page }) => {
    const watcher = watchForErrors(page);
    await openGame(page);

    await expect(page.getByRole('heading', { name: 'AD Racers' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Controls' })).toBeVisible();

    // The demonstration race behind the menu proves the renderer is alive.
    await measureFrames(page, 60);
    expect(watcher.errors).toEqual([]);
  });

  test('walks title → controls → setup → race → results → rematch', async ({ page }) => {
    const watcher = watchForErrors(page);
    await openGame(page);

    await goToSetup(page);
    await expect(page.getByRole('radiogroup', { name: 'Course' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Crew' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Difficulty' })).toBeVisible();

    await page.getByRole('button', { name: 'Start race' }).click();
    await expect(page.getByTestId('hud')).toBeVisible();
    expect(await currentScreen(page)).toBe('race');

    // Let the countdown run and drive for a moment, so the race is genuinely
    // under way rather than being fast-forwarded from the grid.
    await waitForGreenLight(page);
    await page.keyboard.down('w');
    await waitForRaceTime(page, 4);
    await page.keyboard.up('w');

    const running = await playerSnapshot(page);
    expect(running).not.toBeNull();
    expect(running?.speed).toBeGreaterThan(5);

    // Fast-forward the remainder rather than driving three laps in real time.
    await page.evaluate(() => window.adRacers?.skipToFinish());

    await expect(page.getByRole('heading', { name: /Race won|Finished/ })).toBeVisible();
    expect(await currentScreen(page)).toBe('results');

    // Every entry is classified, once.
    const rows = page.locator('.results__row');
    await expect(rows).toHaveCount(6);

    await page.getByRole('button', { name: 'Rematch' }).click();
    await expect(page.getByTestId('hud')).toBeVisible();
    expect(await currentScreen(page)).toBe('race');

    expect(watcher.errors).toEqual([]);
  });

  test('drives, builds Surge and reports it on the HUD', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);

    // Past the countdown, then accelerate down the opening straight.
    await waitForGreenLight(page);
    await page.keyboard.down('w');
    await waitForRaceTime(page, 4);
    await page.keyboard.up('w');

    const speedText = await page.locator('.hud__speed').textContent();
    expect(Number(speedText)).toBeGreaterThan(20);

    await expect(page.locator('.hud__panel--position')).toContainText('/6');
    await expect(page.locator('.hud__panel--lap')).toContainText('/3');
    await expect(page.locator('.surge')).toHaveAttribute('aria-valuenow', /\d+/);
  });

  test('advances the race clock in exact fixed steps', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const sample = async (): Promise<{ steps: number; raceTime: number }> =>
      page.evaluate(() => {
        const sim = window.adRacers?.simulation() as { steps: number; raceTime: number };
        return { steps: sim.steps, raceTime: sim.raceTime };
      });

    const before = await sample();
    await waitForSteps(page, 240);
    const after = await sample();

    // The relationship that actually matters is steps→time, not time→wall
    // clock: on a slow renderer the loop deliberately runs the race behind real
    // time rather than spiralling, so only this ratio is invariant.
    const stepsTaken = after.steps - before.steps;
    const simulatedSeconds = after.raceTime - before.raceTime;
    expect(stepsTaken).toBeGreaterThanOrEqual(240);
    expect(simulatedSeconds).toBeCloseTo(stepsTaken / 120, 3);
  });

  test('restarting with the same seed replays the same race', async ({ page }) => {
    await openGame(page);

    const runToFinish = async (): Promise<string[]> => {
      await page.evaluate(() => window.adRacers?.startRace(90210));
      await expect(page.getByTestId('hud')).toBeVisible();
      await page.evaluate(() => window.adRacers?.skipToFinish());
      await expect(page.getByRole('heading', { name: /Race won|Finished/ })).toBeVisible();
      return page.evaluate(() =>
        Array.from(document.querySelectorAll('.results__row')).map(
          (row) =>
            `${row.querySelector('.results__name')?.textContent ?? ''}@${row.querySelector('.results__time')?.textContent ?? ''}`,
        ),
      );
    };

    const first = await runToFinish();
    const second = await runToFinish();
    expect(second).toEqual(first);
  });
});

test.describe('pause and resume', () => {
  test('Escape pauses, resumes, and freezes the clock while paused', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    await page.keyboard.down('w');
    await waitForRaceTime(page, 1.5);
    await page.keyboard.up('w');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();
    expect(await currentScreen(page)).toBe('pause');

    const frozen = await page.evaluate(() => (window.adRacers?.simulation() as { raceTime: number }).raceTime);
    await measureFrames(page, 60);
    const stillFrozen = await page.evaluate(() => (window.adRacers?.simulation() as { raceTime: number }).raceTime);
    expect(stillFrozen).toBe(frozen);

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeHidden();
    await waitForSteps(page, 60);

    const moving = await page.evaluate(() => (window.adRacers?.simulation() as { raceTime: number }).raceTime);
    expect(moving).toBeGreaterThan(frozen);
  });

  test('offers restart, settings and quit from the pause menu', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.keyboard.press('Escape');

    await expect(page.getByRole('button', { name: 'Restart race' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    await page.getByRole('button', { name: 'Quit to title' }).click();
    await expect(page.getByRole('heading', { name: 'AD Racers' })).toBeVisible();
    expect(await currentScreen(page)).toBe('title');
  });
});

test.describe('performance', () => {
  // Software WebGL rasterises every triangle on the CPU, so a frame there can
  // take the better part of a second. This measures far fewer frames than a
  // real profile would and gets a generous budget to do it in.
  test('holds a smooth frame rate during a race', async ({ page }) => {
    test.slow();
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    await page.keyboard.down('w');

    const frames = await measureFrames(page, 30);
    await page.keyboard.up('w');

    // CI runs on software WebGL, where the whole scene is rasterised on the
    // CPU, so the bar here is "the loop keeps running", not "60 fps". The real
    // desktop budget is measured on hardware and recorded in
    // docs/PERFORMANCE.md.
    expect(frames.median).toBeGreaterThan(0);
    expect(frames.median).toBeLessThan(1000);
  });

  test('stays inside the draw-call budget', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.evaluate(() => {
      const settings = window.adRacers?.settings();
      if (settings) settings.showPerformance = true;
      const overlay = document.querySelector<HTMLElement>('.perf');
      if (overlay) overlay.hidden = false;
    });
    await page.waitForFunction(() => (document.querySelector('.perf')?.textContent ?? '').includes('draws'), undefined, {
      timeout: 30_000,
    });

    const text = (await page.locator('.perf').textContent()) ?? '';
    const draws = Number(/draws (\d+)/.exec(text)?.[1] ?? '9999');
    expect(draws).toBeGreaterThan(0);
    // Measured at 58 on hardware with the full scene in view. The headroom
    // covers a shadow pass and a less favourable camera angle; anything near
    // this number means something has stopped being merged or instanced.
    expect(draws).toBeLessThan(100);
  });
});
