import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // The simulation tests run whole races headlessly; a few of them are
    // intentionally long-running so they exercise real race durations.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/game/**', 'src/audio/synth.ts'],
      reporter: ['text-summary'],
    },
  },
});
