import { describe, expect, it } from 'vitest';
import { Rng, hashSeed } from '../../src/core/rng';
import { FIXED_STEP } from '../../src/game/config';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { ControlInput } from '../../src/game/sim/state';
import { TRACK_DEFINITIONS } from '../../src/game/track/tracks';
import { buildSetup, runHeadlessRace } from '../support/headless';

/**
 * Determinism is the property everything else in the test suite leans on: if
 * the same seed and the same inputs did not produce the same race, none of the
 * AI, fairness or rules assertions would mean anything from one run to the
 * next. It is also what makes "restart" a genuine retry rather than a reroll.
 */

/** A repeatable, non-trivial input script for the player entry. */
function scriptedInputs(step: number): ControlInput {
  const t = step * FIXED_STEP;
  return {
    ...emptyInput(),
    throttle: 1,
    steer: Math.sin(t * 0.7) * 0.6 + Math.sin(t * 0.23) * 0.3,
    brake: Math.sin(t * 0.31) > 0.85,
    drift: Math.sin(t * 0.53) > 0.4,
    boost: Math.sin(t * 0.17) > 0.6,
    strike: Math.sin(t * 1.1) > 0.95 ? 1 : 0,
    respawn: false,
  };
}

function fingerprint(seed: number, steps: number): string {
  const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', seed }));
  for (let i = 0; i < steps; i++) {
    sim.step(scriptedInputs(i));
    sim.drainEvents();
  }
  return sim.racers
    .map((r) =>
      [
        r.pos.x.toFixed(9),
        r.pos.z.toFixed(9),
        r.y.toFixed(9),
        r.heading.toFixed(9),
        r.velocity.x.toFixed(9),
        r.velocity.z.toFixed(9),
        r.surge.toFixed(9),
        r.progress.toFixed(6),
        r.checkpointsPassed,
        r.strikesLanded,
      ].join(','),
    )
    .join('|');
}

describe('deterministic simulation', () => {
  it('produces identical state from the same seed and inputs', () => {
    expect(fingerprint(97531, 2400)).toBe(fingerprint(97531, 2400));
  });

  it('produces different state from a different seed', () => {
    expect(fingerprint(97531, 2400)).not.toBe(fingerprint(97532, 2400));
  });

  it('replays a whole race identically, including the finishing order', () => {
    const options = { trackId: 'saltflat-reliquary', seed: 8642, playerIndex: null, maxSeconds: 400 } as const;
    const a = runHeadlessRace(options);
    const b = runHeadlessRace(options);

    expect(a.finished).toBe(true);
    expect(a.results.map((r) => r.profileId)).toEqual(b.results.map((r) => r.profileId));
    expect(a.results.map((r) => r.finishTime)).toEqual(b.results.map((r) => r.finishTime));
    expect(a.sim.steps).toBe(b.sim.steps);
  });

  it('never calls Math.random inside the simulation', () => {
    const original = Math.random;
    let calls = 0;
    Math.random = () => {
      calls += 1;
      return original();
    };
    try {
      runHeadlessRace({ trackId: 'emberfall-quarry', playerIndex: null, maxSeconds: 40 });
    } finally {
      Math.random = original;
    }
    expect(calls).toBe(0);
  });

  it('is unaffected by how many steps a frame batches', () => {
    // The loop caps catch-up steps, so a stuttering frame runs several steps at
    // once. That must not change the outcome.
    const single = new Simulation(buildSetup({ trackId: 'emberfall-quarry', seed: 555 }));
    const batched = new Simulation(buildSetup({ trackId: 'emberfall-quarry', seed: 555 }));
    for (let i = 0; i < 1200; i++) {
      single.step(scriptedInputs(i));
      single.drainEvents();
    }
    for (let frame = 0; frame < 300; frame++) {
      for (let sub = 0; sub < 4; sub++) batched.step(scriptedInputs(frame * 4 + sub));
      batched.drainEvents();
    }
    expect(batched.racers.map((r) => r.progress)).toEqual(single.racers.map((r) => r.progress));
  });
});

describe('Rng', () => {
  it('is reproducible and restorable', () => {
    const a = new Rng(1234);
    const first = Array.from({ length: 50 }, () => a.next());
    const b = new Rng(1234);
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(first);

    const state = a.getState();
    const after = Array.from({ length: 20 }, () => a.next());
    const restored = new Rng(0);
    restored.setState(state);
    expect(Array.from({ length: 20 }, () => restored.next())).toEqual(after);
  });

  it('stays inside [0, 1) and is not obviously biased', () => {
    const rng = new Rng(99);
    const buckets = new Array(10).fill(0);
    const samples = 100_000;
    for (let i = 0; i < samples; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      buckets[Math.floor(value * 10)] += 1;
    }
    // Each decile should hold roughly a tenth of the samples. A 15% tolerance
    // is loose enough never to flake and tight enough to catch a broken stream.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(samples * 0.085);
      expect(count).toBeLessThan(samples * 0.115);
    }
  });

  it('separates adjacent seeds', () => {
    const a = new Rng(1).next();
    const b = new Rng(2).next();
    const c = new Rng(3).next();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('hashes distinct strings to distinct seeds', () => {
    const seeds = new Set(TRACK_DEFINITIONS.map((t) => hashSeed(t.id)));
    expect(seeds.size).toBe(TRACK_DEFINITIONS.length);
    expect(hashSeed('same')).toBe(hashSeed('same'));
    expect(hashSeed('same', 1)).not.toBe(hashSeed('same', 2));
  });
});
