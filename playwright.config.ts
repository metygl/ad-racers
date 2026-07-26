import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests.
 *
 * Run against the production build rather than the dev server: the thing worth
 * testing is what actually ships, including the base path and the hashed asset
 * names. `--enable-unsafe-swiftshader` gives CI a software WebGL implementation
 * so the renderer is genuinely exercised rather than skipped.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: 'http://127.0.0.1:41731/ad-racers/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'desktop',
      testIgnore: /touch\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
        },
      },
    },
    {
      // A real coarse pointer with touch points, which is what the game checks
      // before offering thumb controls — a narrow desktop window is not a phone.
      name: 'mobile',
      testMatch: /touch\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        // A 2.6× device scale factor means four times the pixels, which under
        // software WebGL is the difference between slow and unusable. The
        // layout under test is CSS pixels either way.
        deviceScaleFactor: 1,
        launchOptions: {
          args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
        },
      },
    },
  ],

  webServer: {
    // `vite preview` serves the built site at the same base path production
    // uses. The port is deliberately obscure and the server is never reused:
    // a common port such as 4173 is very likely to already be serving somebody
    // else's dev server, and Playwright will happily test that instead.
    // Bound explicitly to 127.0.0.1: `vite preview` defaults to `localhost`,
    // which on macOS resolves to ::1 first, and the readiness probe then waits
    // on an IPv4 address nothing is listening on.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 41731 --strictPort',
    url: 'http://127.0.0.1:41731/ad-racers/',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
