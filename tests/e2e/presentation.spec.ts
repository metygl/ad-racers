import { expect, test } from '@playwright/test';
import {
  currentScreen,
  goToSetup,
  measureFrames,
  openGame,
  startSeededRace,
  waitForGreenLight,
  waitForSteps,
  watchForErrors,
} from './support';

/**
 * Responsive layout, accessibility and failure states.
 *
 * The viewports are the ones the brief calls out, and the assertions are the
 * ones that actually catch layout defects: nothing may cause horizontal page
 * overflow, and nothing interactive may end up off-screen or under the fold
 * with no way to reach it.
 */

const VIEWPORTS = [
  { name: '320 (small phone)', width: 320, height: 640 },
  { name: '390 (phone)', width: 390, height: 844 },
  { name: '768 (tablet)', width: 768, height: 1024 },
  { name: '1024 (small laptop)', width: 1024, height: 768 },
  { name: '1440 (desktop)', width: 1440, height: 900 },
];

test.describe('responsive layout', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: title and setup fit without page overflow`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openGame(page);

      const overflow = async (): Promise<number> =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      // The race canvas must never make the page scroll sideways.
      expect(await overflow()).toBeLessThanOrEqual(1);

      // Every control on the title screen is inside the viewport.
      for (const name of ['Race', 'Settings', 'Controls']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        expect(box, `${name} has no box at ${viewport.name}`).not.toBeNull();
        if (!box) continue;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        // Comfortable target size, on every viewport.
        expect(box.height).toBeGreaterThanOrEqual(40);
      }

      await goToSetup(page);
      expect(await overflow()).toBeLessThanOrEqual(1);

      // The start button is reachable, scrolling the menu if it has to.
      const start = page.getByRole('button', { name: 'Start race' });
      await start.scrollIntoViewIfNeeded();
      await expect(start).toBeVisible();
      const startBox = await start.boundingBox();
      expect(startBox?.x ?? 0).toBeGreaterThanOrEqual(0);
      expect((startBox?.x ?? 0) + (startBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
    });

    test(`${viewport.name}: the HUD stays on screen during a race`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openGame(page);
      await startSeededRace(page);
      await waitForGreenLight(page);

      const hud = page.getByTestId('hud');
      await expect(hud).toBeVisible();

      for (const selector of ['.hud__panel--position', '.hud__panel--lap', '.hud__panel--speed', '.hud__time']) {
        const box = await page.locator(selector).boundingBox();
        expect(box, `${selector} missing at ${viewport.name}`).not.toBeNull();
        if (!box) continue;
        expect(box.x, `${selector} clipped left at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
        expect(box.y, `${selector} clipped top at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width, `${selector} clipped right at ${viewport.name}`).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.y + box.height, `${selector} clipped bottom at ${viewport.name}`).toBeLessThanOrEqual(viewport.height + 1);
      }

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(1);
    });
  }

  test('survives a resize mid-race without losing the race', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    const before = await page.evaluate(() => (window.adRacers?.simulation() as { steps: number }).steps);

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForSteps(page, 30);
    await page.setViewportSize({ width: 1024, height: 768 });
    await waitForSteps(page, 30);

    const after = await page.evaluate(() => (window.adRacers?.simulation() as { steps: number }).steps);
    expect(after).toBeGreaterThan(before);
    expect(await currentScreen(page)).toBe('race');
    await expect(page.getByTestId('hud')).toBeVisible();

    // The canvas backing store followed the viewport.
    const size = await page.evaluate(() => {
      const canvas = document.getElementById('scene') as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height, css: canvas.clientWidth };
    });
    expect(size.css).toBeLessThanOrEqual(1024);
    expect(size.width).toBeGreaterThan(0);
  });
});

test.describe('accessibility', () => {
  test('is navigable with the keyboard alone', async ({ page }) => {
    await openGame(page);

    // The skip link is the first stop, as it should be.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to the game' })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeFocused();

    // Enter activates it, and focus lands inside the next screen.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Continue|Back/ }).first()).toBeVisible();
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(['BUTTON', 'INPUT', 'A']).toContain(focusedTag);
  });

  test('traps focus inside the pause dialog', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();

    // Tab all the way round; focus must never leave the dialog.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog?.contains(document.activeElement) ?? false;
      });
      expect(inside, `focus escaped the pause dialog after ${i + 1} tabs`).toBe(true);
    }
  });

  test('labels the HUD readouts for assistive technology', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await expect(page.getByRole('meter', { name: 'Surge' })).toHaveAttribute('aria-valuenow', /\d+/);
    // A live region carries lap and position changes without moving focus.
    await expect(page.locator('[role="status"][aria-live="polite"]')).toHaveCount(1);
    // The canvas is decorative: everything it shows is also text.
    await expect(page.locator('#scene')).toHaveAttribute('aria-hidden', 'true');
  });

  test('gives every setting a real, labelled control', async ({ page }) => {
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await expect(page.getByRole('slider', { name: 'Master volume' })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Music and ambience' })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Effects' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Mute everything' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Reduced motion' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Graphics quality' })).toBeVisible();
  });

  test('rebuilds the menu world when quality changes', async ({ page }) => {
    await openGame(page);
    await page.locator('#scene').evaluate((canvas) => {
      (canvas as HTMLCanvasElement & { originalCanvas?: boolean }).originalCanvas = true;
    });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('label[for="seg-graphics-quality-low"]').click();
    await expect
      .poll(() =>
        page.locator('#scene').evaluate(
          (canvas) => (canvas as HTMLCanvasElement & { originalCanvas?: boolean }).originalCanvas ?? false,
        ),
      )
      .toBe(false);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
  });

  test('rolls back a quality setting when context creation fails', async ({ page }) => {
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('label[for="seg-graphics-quality-medium"]').click();
    await page.evaluate(() => {
      const prototype = HTMLCanvasElement.prototype;
      const original = prototype.getContext;
      let fail = true;
      prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
        if (fail && this !== document.querySelector('#scene')) {
          fail = false;
          throw new Error('injected context failure');
        }
        return (original as (...values: unknown[]) => RenderingContext | null).apply(this, args);
      } as HTMLCanvasElement['getContext'];
    });

    await page.locator('label[for="seg-graphics-quality-low"]').click();
    await expect(page.getByRole('radio', { name: 'Medium' })).toBeChecked();
    expect(await page.evaluate(() => window.adRacers?.settings().quality)).toBe('medium');

    await page.locator('label[for="seg-graphics-quality-low"]').click();
    await expect(page.getByRole('radio', { name: 'Low' })).toBeChecked();
    expect(await page.evaluate(() => window.adRacers?.settings().quality)).toBe('low');
  });

  test('cancels key capture when settings returns to pause', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Change the key for Accelerate' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.keyboard.press('KeyQ');
    expect(await page.evaluate(() => window.adRacers?.settings().bindings)).toMatchObject({
      accelerate: ['KeyW', 'ArrowUp'],
    });
  });

  test('honours the reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGame(page);

    // The preference is picked up as the default for the in-game setting.
    const reduced = await page.evaluate(() => window.adRacers?.settings().reducedMotion);
    expect(reduced).toBe(true);
    await expect(page.locator('html')).toHaveClass(/reduced-motion/);

    await startSeededRace(page);
    await waitForGreenLight(page);
    // Speed streaks are removed entirely rather than merely slowed.
    const streaksShown = await page.evaluate(() => {
      const node = document.querySelector('.speedlines');
      return node ? getComputedStyle(node).display !== 'none' : false;
    });
    expect(streaksShown).toBe(false);
  });

  test('applies a high-contrast preference', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await openGame(page);
    await expect(page.locator('html')).toHaveClass(/high-contrast/);
  });

  test('remains usable at 200% browser zoom', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openGame(page);
    // Emulating zoom by halving the CSS viewport is the same problem the layout
    // has to solve, and is what Playwright can actually drive.
    await page.setViewportSize({ width: 640, height: 400 });

    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
  });
});

test.describe('failure states', () => {
  test('explains itself when WebGL is unavailable', async ({ page }) => {
    // Deny WebGL before any script runs, exactly as a locked-down browser would.
    await page.addInitScript(() => {
      const prototype = HTMLCanvasElement.prototype as unknown as {
        getContext: (this: HTMLCanvasElement, id: string, ...rest: unknown[]) => unknown;
      };
      const original = prototype.getContext;
      prototype.getContext = function patched(this: HTMLCanvasElement, contextId: string, ...rest: unknown[]) {
        if (contextId.startsWith('webgl')) return null;
        return original.call(this, contextId, ...rest);
      };
    });

    await page.goto('./');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: /cannot run|could not start/i })).toBeVisible();
    // An honest message, not a blank canvas.
    await expect(page.getByRole('alert')).toContainText(/WebGL/i);
  });

  test('reports a lost graphics context and offers a way out', async ({ page }) => {
    await openGame(page);
    await startSeededRace(page);
    await waitForGreenLight(page);

    await page.evaluate(() => {
      const canvas = document.getElementById('scene') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const lose = (gl)?.getExtension('WEBGL_lose_context') as
        | { loseContext: () => void }
        | null;
      if (lose) lose.loseContext();
      else canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });

    await expect(page.getByRole('heading', { name: 'Graphics interrupted' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload the game' })).toBeVisible();
  });

  test('keeps working when local storage is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    const watcher = watchForErrors(page);
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
    expect(watcher.errors).toEqual([]);
  });
});

test.describe('settings persistence', () => {
  test('remembers a changed setting across a reload', async ({ page }) => {
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();

    const mute = page.getByRole('checkbox', { name: 'Mute everything' });
    await mute.check();
    await page.getByRole('button', { name: 'Back' }).click();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
    await page.waitForFunction(() => typeof window.adRacers === 'object');

    const muted = await page.evaluate(() => {
      const audio = window.adRacers?.settings().audio as { muted: boolean } | undefined;
      return audio?.muted;
    });
    expect(muted).toBe(true);
  });

  test('clears stored data on request', async ({ page }) => {
    await openGame(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('checkbox', { name: 'Mute everything' }).check();
    await page.getByRole('button', { name: 'Clear settings and best times' }).click();

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const muted = await page.evaluate(() => {
      const audio = window.adRacers?.settings().audio as { muted: boolean } | undefined;
      return audio?.muted;
    });
    expect(muted).toBe(false);
  });
});

test.describe('audio', () => {
  test('creates no audio context before a user gesture', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __audioContexts: number }).__audioContexts = 0;
      const Original = window.AudioContext;
      window.AudioContext = class extends Original {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          (window as unknown as { __audioContexts: number }).__audioContexts += 1;
        }
      };
    });

    await openGame(page);
    await measureFrames(page, 120);
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)).toBe(0);

    // ...and exactly one once the player asks for a race.
    await page.getByRole('button', { name: 'Race', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts)).toBe(1);
  });
});
