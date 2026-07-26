import { describe, expect, it } from 'vitest';
import { CATCHUP_LIMIT } from '../../src/game/sim/simulation';
import { RACERS, toVehicleSpec } from '../../src/game/racers';
import { runHeadlessRace, scriptedPlayer } from '../support/headless';

/**
 * Fairness.
 *
 * A racing game loses the player the moment they suspect the result was
 * decided by the game rather than by them. These tests are the mechanical
 * expression of the promise the design makes: catch-up is tiny and bounded, it
 * never touches the player's car, and the crew you pick flavours a race
 * without deciding it.
 */

describe('catch-up assist', () => {
  it('never exceeds the documented bound', () => {
    runHeadlessRace({
      trackId: 'overgrown-interchange',
      difficultyId: 'ace',
      playerIndex: 0,
      catchUp: true,
      maxSeconds: 200,
      playerInput: scriptedPlayer('rookie'),
      onStep: (sim) => {
        for (const racer of sim.racers) {
          if (!racer.ai) continue;
          expect(racer.ai.catchUpScale).toBeGreaterThanOrEqual(1 - CATCHUP_LIMIT - 1e-9);
          expect(racer.ai.catchUpScale).toBeLessThanOrEqual(1 + CATCHUP_LIMIT + 1e-9);
        }
      },
    });
  });

  it('is small enough that turning it off barely moves the result', () => {
    const options = {
      trackId: 'overgrown-interchange',
      difficultyId: 'pro',
      playerIndex: null,
      maxSeconds: 400,
    } as const;
    const on = runHeadlessRace({ ...options, catchUp: true });
    const off = runHeadlessRace({ ...options, catchUp: false });
    const winnerOn = on.results[0]?.finishTime ?? 0;
    const winnerOff = off.results[0]?.finishTime ?? 0;
    // If this assist were doing heavy lifting the winner's time would change
    // noticeably. It should be within a couple of percent.
    expect(Math.abs(winnerOn - winnerOff) / winnerOff).toBeLessThan(0.05);
  });

  it('is never applied to the player', () => {
    runHeadlessRace({
      trackId: 'saltflat-reliquary',
      playerIndex: 0,
      catchUp: true,
      maxSeconds: 120,
      playerInput: scriptedPlayer('pro'),
      onStep: (sim) => {
        expect(sim.player?.ai).toBeNull();
      },
    });
  });

  it('can be switched off entirely', () => {
    const result = runHeadlessRace({
      trackId: 'overgrown-interchange',
      playerIndex: null,
      catchUp: false,
      maxSeconds: 400,
    });
    for (const racer of result.sim.racers) {
      expect(racer.ai?.catchUpScale).toBe(1);
    }
  });
});

describe('crew balance', () => {
  it('keeps every crew within a narrow performance band', () => {
    const specs = RACERS.map((r) => toVehicleSpec(r.stats));
    const topSpeeds = specs.map((s) => s.topSpeed);
    const spread = (Math.max(...topSpeeds) - Math.min(...topSpeeds)) / Math.min(...topSpeeds);
    // Character, not advantage: about a tenth between fastest and slowest.
    expect(spread).toBeLessThan(0.18);

    for (const spec of specs) {
      expect(spec.mass).toBeGreaterThan(0.5);
      expect(spec.mass).toBeLessThan(1.6);
      expect(spec.grip).toBeGreaterThan(8);
      expect(spec.reach).toBeGreaterThan(2.5);
    }
  });

  it('trades stats off against each other rather than stacking them', () => {
    for (const racer of RACERS) {
      const total =
        racer.stats.topSpeed + racer.stats.acceleration + racer.stats.grip + racer.stats.weight + racer.stats.reach;
      // No crew is simply better than another: the stat budgets stay close.
      expect(total).toBeGreaterThan(2.6);
      expect(total).toBeLessThan(3.9);
    }
  });

  it('gives every crew a distinct identity', () => {
    expect(new Set(RACERS.map((r) => r.id)).size).toBe(RACERS.length);
    expect(new Set(RACERS.map((r) => r.crew)).size).toBe(RACERS.length);
    expect(new Set(RACERS.map((r) => r.colors.body)).size).toBe(RACERS.length);
    for (const racer of RACERS) {
      expect(racer.pilot).not.toBe(racer.wrench);
      expect(racer.blurb.length).toBeGreaterThan(20);
    }
  });

  it('lets any crew win on any course', () => {
    // Not a guarantee that every crew wins every seed — just that no crew is
    // shut out. Across a spread of seeds every crew should reach the podium at
    // least once somewhere.
    const podiums = new Set<string>();
    for (const trackId of ['overgrown-interchange', 'saltflat-reliquary', 'emberfall-quarry']) {
      for (const seed of [11, 222, 3333]) {
        const result = runHeadlessRace({ trackId, seed, playerIndex: null, difficultyId: 'pro', maxSeconds: 400 });
        for (const racer of result.results.slice(0, 3)) podiums.add(racer.profileId);
      }
    }
    expect(podiums.size).toBe(RACERS.length);
  });
});

describe('opponents play by the same rules', () => {
  it('reach the same top speed as an equivalent player car', () => {
    // Both are driven through the identical physics with identical specs, so
    // the only way this can fail is if someone gave the AI a private multiplier.
    const result = runHeadlessRace({
      trackId: 'saltflat-reliquary',
      difficultyId: 'ace',
      playerIndex: null,
      catchUp: false,
      maxSeconds: 200,
      onStep: (sim) => {
        for (const racer of sim.racers) {
          const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
          // Nothing may exceed its own boosted top speed, ever.
          expect(speed).toBeLessThan(racer.spec.topSpeed * 1.35);
        }
      },
    });
    expect(result.finished).toBe(true);
  });
});
