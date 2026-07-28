import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  currentScreen,
  goToSetup,
  measureFrames,
  openGame,
  playerSnapshot,
  skipRaceTime,
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

    /*
     * Drive for a moment through the real loop, so the race is genuinely under
     * way rather than fast-forwarded from the grid - but do not pay to render
     * the three-second countdown first. Simulated time advances at most 67 ms
     * per drawn frame, so under software WebGL the countdown alone can cost
     * ten seconds of the test's budget and it is not what is under test here.
     */
    await waitForGreenLight(page);
    await skipRaceTime(page, 0.5);
    await page.keyboard.down('w');
    await waitForRaceTime(page, 2);
    await page.keyboard.up('w');

    const running = await playerSnapshot(page);
    expect(running).not.toBeNull();
    expect(running?.speed).toBeGreaterThan(5);

    // Fast-forward the remainder rather than driving three laps in real time.
    await page.evaluate(() => window.adRacers?.skipToFinish());

    await expect(page.getByRole('heading', { name: /Race won|Finished|Classified|Did not finish/i })).toBeVisible();
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

    // Past the countdown, then accelerate down the opening straight. The
    // acceleration is driven for real; only the countdown is skipped.
    await waitForGreenLight(page);
    await page.keyboard.down('w');
    await waitForRaceTime(page, 2);
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

  test('resolves the field on a fast step budget once the player finishes', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const before = await page.evaluate(() => (window.adRacers?.simulation() as { steps: number }).steps);

    // Force the player across the line while the field is still mid-race, the
    // same state a real finish leaves behind, without waiting out a real lap.
    await page.evaluate(() => {
      const sim = window.adRacers?.simulation() as { player: { finished: boolean } | null } | null;
      if (sim?.player) sim.player.finished = true;
    });

    // Once resolvingAfterPlayer is true, the loop is meant to run hundreds of
    // steps a frame on a deterministic budget rather than one paced by real
    // elapsed time (RESOLVE_STEPS_PER_FRAME in App.ts) — a regression here
    // means the field finishes behind the player in real time again, which
    // used to cost up to the 75s post-race timeout.
    await page.waitForFunction(
      (target) => ((window.adRacers?.simulation() as { steps: number } | null)?.steps ?? 0) >= target,
      before + 1000,
      { timeout: 5_000 },
    );
  });

  test('stops accelerated resolve on the race-ending step', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    await waitForRaceTime(page, 0.5);

    const result = await page.evaluate(async () => {
      const sim = window.adRacers?.simulation() as
        | {
            player: { finished: boolean } | null;
            racers: Array<{
              isPlayer: boolean;
              pos: { x: number; z: number };
              velocity: { x: number; z: number };
            }>;
            finishedCount: number;
            postRaceTimer: number;
            steps: number;
            phase: string;
          }
        | null;
      if (!sim?.player) throw new Error('Race simulation is unavailable');
      const rival = sim.racers.find((racer) => !racer.isPlayer);
      if (!rival) throw new Error('Rival simulation is unavailable');

      sim.player.finished = true;
      sim.finishedCount = 1;
      sim.postRaceTimer = 75;
      const before = sim.steps;
      await new Promise(requestAnimationFrame);
      const snapshot = () => ({
        steps: sim.steps,
        phase: sim.phase,
        pos: { ...rival.pos },
        velocity: { ...rival.velocity },
      });
      const atRaceEnd = snapshot();
      for (let frame = 0; frame < 4; frame += 1) await new Promise(requestAnimationFrame);
      return { stepsToFinish: atRaceEnd.steps - before, atRaceEnd, afterHoldFrames: snapshot() };
    });

    expect(result.stepsToFinish).toBe(1);
    expect(result.atRaceEnd.phase).toBe('finished');
    expect(result.afterHoldFrames).toEqual(result.atRaceEnd);
  });

  test('restarting with the same seed replays the same race', async ({ page }) => {
    await openGame(page);

    const runToFinish = async (): Promise<string[]> => {
      await page.evaluate(() => window.adRacers?.startRace(90210));
      await expect(page.getByTestId('hud')).toBeVisible();
      await page.evaluate(() => window.adRacers?.skipToFinish());
      await expect(page.getByRole('heading', { name: /Race won|Finished|Classified|Did not finish/i })).toBeVisible();
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
    await waitForRaceTime(page, 1);
    await page.keyboard.up('w');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();
    expect(await currentScreen(page)).toBe('pause');

    const frozen = await page.evaluate(() => (window.adRacers?.simulation() as { raceTime: number }).raceTime);
    // Multiple rendered frames prove the app loop remains active while the
    // simulation is paused. Keep this window short: under CI's software WebGL,
    // waiting for 60 frames can consume most of the test-wide timeout without
    // adding confidence to the clock-freeze assertion.
    await measureFrames(page, 10);
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
    const postPasses = Number(/\+(\d+) post/.exec(text)?.[1] ?? '-1');

    /*
     * The floor matters as much as the ceiling.
     *
     * The overlay used to read `renderer.info` at the end of the frame, which —
     * once a post chain was added — described the final full-screen triangle
     * and nothing else. It reported one draw call for the whole game, and this
     * assertion quietly became "1 < 100". A world drawn in fewer than ten calls
     * is not a world; it is a broken measurement.
     */
    expect(draws).toBeGreaterThan(10);
    // Measured at 58 on hardware with the full scene in view. The headroom
    // covers a shadow pass and a less favourable camera angle; anything near
    // this number means something has stopped being merged or instanced.
    expect(draws).toBeLessThan(100);
    // The post chain is a fixed, small number of full-screen passes. If this
    // grows, it grew by someone adding a pass rather than by the scene changing.
    expect(postPasses).toBeGreaterThanOrEqual(0);
    expect(postPasses).toBeLessThanOrEqual(4);
  });
});

/*
 * Race-surface transitions.
 *
 * Every one of these reproduces a defect found in live production play, where
 * an ordinary menu action left the player in a running race with no HUD and, on
 * a phone, no controls at all. They assert the *surface*, not the screen name:
 * the screen said "race" the whole time it was broken.
 */
test.describe('race surface transitions', () => {
  const surface = async (page: Page) =>
    page.evaluate(() => ({
      screen: window.adRacers?.screen(),
      hudHidden: document.querySelector<HTMLElement>('.hud')?.hidden ?? true,
      uiHidden: document.querySelector<HTMLElement>('.ui')?.hidden ?? true,
      uiChildren: document.querySelector('.ui')?.children.length ?? -1,
    }));

  test('Pause → Settings → Back → Resume returns a complete race surface', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Resume' }).click();

    const state = await surface(page);
    expect(state.screen).toBe('race');
    // The HUD must come back. It used to stay hidden for the rest of the race.
    expect(state.hudHidden).toBe(false);
    expect(state.uiHidden).toBe(true);
    expect(state.uiChildren).toBe(0);
  });

  test('Pause → Settings → Back → Escape also returns a complete race surface', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.keyboard.press('Escape');

    const state = await surface(page);
    expect(state.screen).toBe('race');
    expect(state.hudHidden).toBe(false);
  });

  test('a restored graphics context returns a complete race surface', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
      const ext = (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context');
      ext?.loseContext();
      setTimeout(() => ext?.restoreContext(), 60);
    });
    await page.getByRole('button', { name: 'Resume' }).click({ timeout: 20_000 });

    const state = await surface(page);
    expect(state.screen).toBe('race');
    expect(state.hudHidden).toBe(false);
  });

  test('keyboard radio selection is the race that actually starts', async ({ page }) => {
    await openGame(page);
    await goToSetup(page);

    // Native arrow-key navigation inside the crew radiogroup. The input manager
    // used to preventDefault these on every screen, so the selection appeared
    // to change and the started race ignored it.
    await page.getByRole('radio', { name: /Thornline/i }).first().focus();
    await page.keyboard.press('ArrowRight');
    const chosen = await page.evaluate(
      () => document.querySelector<HTMLInputElement>('input[name="racer"]:checked')?.id ?? '',
    );
    expect(chosen).not.toBe('racer-thornline');

    await page.getByRole('button', { name: /Start (race|circuit)/ }).click();
    await expect(page.getByTestId('hud')).toBeVisible();
    const playerId = await page.evaluate(() => {
      const sim = window.adRacers?.simulation() as { player?: { profileId: string } } | null;
      return sim?.player?.profileId ?? '';
    });
    expect(`racer-${playerId}`).toBe(chosen);
  });
});

/*
 * Corrections to the round-3 preview, exercised the way a player meets them.
 *
 * Every one of these reproduces something a live review or the pipeline found
 * in the shipped preview and asserts the corrected behaviour through the real
 * browser flow, because that is where each of them was found.
 */
test.describe('preview corrections', () => {
  test('Back pauses a race once, and a second Back is allowed to leave', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    /*
     * A single Back must not throw a race away - it pauses instead, absorbed by
     * one pushed history entry. But the guard used to re-push on *every*
     * popstate, including the ones that arrived while already paused, so Back
     * could never leave the page and every press grew the history stack. The
     * player could not escape by holding it either.
    */
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();

    // A second, deliberate Back from the pause dialog is not re-armed.
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Paused' })).toHaveCount(0);
    expect(page.url(), 'the second Back did not leave the paused race').toBe('about:blank');

    // And the guard never stacks: racing repeatedly adds at most one entry.
    await openGame(page);
    const beforeRestart = await page.evaluate(() => history.length);
    await page.evaluate(() => window.adRacers?.startRace(99));
    await page.evaluate(() => window.adRacers?.startRace(98));
    await page.evaluate(() => window.adRacers?.startRace(97));
    const afterThreeRaces = await page.evaluate(() => history.length);
    expect(afterThreeRaces - beforeRestart, 'each race pushed its own history entry').toBeLessThanOrEqual(1);
  });

  test('finishing retires the race Back guard', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.evaluate(() => window.adRacers?.skipToFinish());
    await expect(page.getByRole('heading', { name: /Race won|Finished|Classified|Did not finish/i })).toBeVisible();

    await page.goBack();
    expect(page.url(), 'Back on results was absorbed by the race guard').toBe('about:blank');
  });

  test('quitting retires the race Back guard', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Quit to title' }).click();
    await expect(page.getByRole('heading', { name: 'AD Racers' })).toBeVisible();

    await page.goBack();
    expect(page.url(), 'Back on the title was absorbed by the race guard').toBe('about:blank');
  });

  test('resuming with the key that confirmed it does not hop', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);
    await skipRaceTime(page, 1);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();

    /*
     * Space activates the focused button *and* is the hop. Resuming with it
     * used to hand the still-recorded press straight to the simulation, so the
     * skiff hopped the instant the dialog closed.
     */
    await page.getByRole('button', { name: 'Resume' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeHidden();

    const hopped = await page.evaluate(() => {
      const sim = window.adRacers?.simulation() as { racers: { isPlayer: boolean; airborne: boolean }[] } | null;
      return sim?.racers.find((racer) => racer.isPlayer)?.airborne ?? false;
    });
    expect(hopped, 'confirming Resume launched the skiff').toBe(false);
    expect(await page.evaluate(() => (window.adRacers?.input() as { hop: boolean }).hop)).toBe(false);
  });

  test('classifies a racer on pace rather than calling it a DNF', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.evaluate(() => window.adRacers?.skipToFinish());
    await expect(page.getByRole('heading', { name: /Race won|Finished|Classified|Did not finish/i })).toBeVisible();

    /*
     * The player is fast-forwarded from the grid, so the field finishes and the
     * player is classified on the progress they made. Whatever that comes to,
     * the screen must not turn a projected time back into "DNF" - which is what
     * it did, beside a best lap two seconds off the winner's.
     */
    const outcome = await page.evaluate(() => {
      const sim = window.adRacers?.simulation() as
        | { racers: { isPlayer: boolean; completed: boolean; projected: boolean }[] }
        | null;
      const player = sim?.racers.find((racer) => racer.isPlayer);
      const row = document.querySelector('.results__row--player .results__time')?.textContent ?? '';
      return { completed: player?.completed ?? false, projected: player?.projected ?? false, row };
    });

    if (outcome.projected) {
      expect(outcome.row, 'a projected finish was rendered as DNF').not.toBe('DNF');
      expect(outcome.row).toMatch(/≈/);
      await expect(page.locator('.results__legend')).toContainText('Projected finish');
    } else if (outcome.completed) {
      expect(outcome.row).not.toBe('DNF');
    }
  });
});
