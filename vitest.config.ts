import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    /*
     * The simulation tests run whole races headlessly, and some run nine of
     * them to check every crew can reach a podium. That is deliberate: a race
     * simulated end to end is the only assertion that actually proves the AI
     * can drive the course. They are still fast in absolute terms — a full
     * three-lap race with six cars takes about a second — but a handful of
     * tests legitimately need more than the default budget.
     */
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/game/**', 'src/audio/synth.ts'],
      reporter: ['text-summary'],
    },
  },
});
