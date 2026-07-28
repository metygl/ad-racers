import { expect } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * Shared helpers for the browser tests.
 *
 * The game exposes `window.adRacers` (see `src/main.ts`) so a test can start a
 * seeded race and read the simulation without driving a car for two minutes in
 * real time. Everything else goes through the page the way a player would.
 */

export interface RacerSnapshot {
  position: number;
  lapsCompleted: number;
  finished: boolean;
  speed: number;
  onTrack: boolean;
  surge: number;
}

declare global {
  interface Window {
    adRacers?: {
      startRace: (seed: number) => void;
      simulation: () => unknown;
      settings: () => Record<string, unknown>;
      screen: () => string;
      input: () => Record<string, unknown>;
      advance: (seconds: number) => void;
      skipToFinish: () => void;
    };
  }
}

/** Collects console errors and page errors for the life of a test. */
export function watchForErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { errors };
}

/** Loads the game and waits for the title screen to be interactive. */
export async function openGame(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Race', exact: true })).toBeVisible();
  await page.waitForFunction(() => typeof window.adRacers === 'object');
}

/** Which screen the app believes it is showing. */
export async function currentScreen(page: Page): Promise<string> {
  return page.evaluate(() => window.adRacers?.screen() ?? 'unknown');
}

/** Clicks through title → controls (first run) → setup. */
export async function goToSetup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Race', exact: true }).click();
  const controlsContinue = page.getByRole('button', { name: 'Continue' });
  if (await controlsContinue.isVisible().catch(() => false)) await controlsContinue.click();
  await expect(page.getByRole('heading', { name: 'Race setup' })).toBeVisible();
}

/** Starts a race with a fixed seed, bypassing the menus. */
export async function startSeededRace(page: Page, seed = 4242): Promise<void> {
  await page.evaluate((value) => window.adRacers?.startRace(value), seed);
  await expect(page.getByTestId('hud')).toBeVisible();
}

/**
 * Waits until the race clock has advanced past `seconds` of *simulated* time.
 *
 * Never wait on the wall clock for this. The game loop caps how many fixed
 * steps a single frame may catch up, so on a slow renderer — CI's software
 * WebGL, for instance — simulated time deliberately runs behind real time.
 * That is the engine behaving correctly, and a test that assumes otherwise is
 * simply wrong rather than merely flaky.
 */
export async function waitForRaceTime(page: Page, seconds: number): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const sim = window.adRacers?.simulation() as { raceTime: number; phase: string } | null;
      return sim !== null && sim.phase !== 'countdown' && sim.raceTime >= target;
    },
    seconds,
    { timeout: 60_000 },
  );
}

/**
 * Advances the race by `seconds` of simulated time, immediately.
 *
 * For the parts of a race a test has to get *past* rather than observe - the
 * three-second countdown, the two-second strike grace. Waiting those out
 * through the render loop is the single most expensive thing a browser test
 * here can do, because simulated time is capped at eight fixed steps per drawn
 * frame: under CI's software WebGL that is roughly nine seconds of wall clock
 * per second of race, and it is what pushed the gamepad shoulder-button test
 * over `waitForRaceTime`'s budget and into quarantine.
 *
 * Use `waitForRaceTime` or `waitForSteps` instead wherever the loop's own
 * behaviour is the thing under test.
 */
export async function skipRaceTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate((value) => window.adRacers?.advance(value), seconds);
}

/** Waits until the countdown has finished and the race is under way. */
export async function waitForGreenLight(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window.adRacers?.simulation() as { phase: string } | null)?.phase === 'running',
    undefined,
    { timeout: 60_000 },
  );
}

/** Advances `steps` simulation steps of wall time, whatever the frame rate. */
export async function waitForSteps(page: Page, steps: number): Promise<void> {
  const from = await page.evaluate(() => (window.adRacers?.simulation() as { steps: number }).steps);
  await page.waitForFunction(
    (target) => ((window.adRacers?.simulation() as { steps: number } | null)?.steps ?? 0) >= target,
    from + steps,
    { timeout: 60_000 },
  );
}

export interface StrikeSnapshot {
  phase: string;
  side: number;
  cooldown: number;
}

/** The player's pod-arm state machine, which is what a strike request drives. */
export async function strikeState(page: Page): Promise<StrikeSnapshot> {
  return page.evaluate(() => {
    const sim = window.adRacers?.simulation() as
      | { racers: { isPlayer: boolean; strike: { phase: string; side: number; cooldown: number } }[] }
      | null;
    const player = sim?.racers.find((racer) => racer.isPlayer);
    return {
      phase: player?.strike.phase ?? 'none',
      side: player?.strike.side ?? 0,
      cooldown: player?.strike.cooldown ?? 0,
    };
  });
}

/**
 * Records every notice the HUD *creates*, not the four it shows.
 *
 * The round-3 live review measured the held-strike defect exactly this way and
 * it is the only way to see it: the HUD caps the visible stack at four, so a
 * hundred duplicate refusals and one look identical on screen while the audio
 * engine plays a hundred sounds. Counting creations is counting the events.
 */
export async function watchNotices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __notices?: string[] };
    store.__notices = [];
    const root = document.querySelector('.hud__notifications');
    if (!root) return;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) store.__notices?.push(node.textContent ?? '');
        }
      }
    }).observe(root, { childList: true });
  });
}

/** Everything `watchNotices` has seen since it was installed. */
export async function noticesSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __notices?: string[] }).__notices ?? []);
}

/** Reads a snapshot of the player's simulation state. */
export async function playerSnapshot(page: Page): Promise<RacerSnapshot | null> {
  return page.evaluate(() => {
    const sim = window.adRacers?.simulation() as
      | { player?: { position: number; lapsCompleted: number; finished: boolean; velocity: { x: number; z: number }; onTrack: boolean; surge: number } | null }
      | null;
    const player = sim?.player;
    if (!player) return null;
    return {
      position: player.position,
      lapsCompleted: player.lapsCompleted,
      finished: player.finished,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      onTrack: player.onTrack,
      surge: player.surge,
    };
  });
}

/**
 * Holds a key for a while, which is how a browser test "drives". Playwright's
 * `press` is a tap; a racing game needs the key held.
 */
export async function holdKey(page: Page, key: string, milliseconds: number): Promise<void> {
  await page.keyboard.down(key);
  await waitForSteps(page, Math.max(1, Math.ceil((milliseconds / 1000) * 120)));
  await page.keyboard.up(key);
}

/** Measures frame timing over a window, in milliseconds. */
export async function measureFrames(page: Page, frames = 120): Promise<{ median: number; p95: number; fps: number }> {
  return page.evaluate(
    (count) =>
      new Promise<{ median: number; p95: number; fps: number }>((resolve) => {
        const samples: number[] = [];
        let last = performance.now();
        let seen = 0;
        const tick = (): void => {
          const now = performance.now();
          samples.push(now - last);
          last = now;
          seen += 1;
          if (seen < count) {
            requestAnimationFrame(tick);
            return;
          }
          const sorted = [...samples].sort((a, b) => a - b);
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          resolve({
            median: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            fps: 1000 / mean,
          });
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}
