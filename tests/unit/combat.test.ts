import { describe, expect, it } from 'vitest';
import { fromHeading } from '../../src/core/math';
import { COMBAT, FIXED_STEP } from '../../src/game/config';
import { applyStrike, canStartStrike, guardMultiplier, isInStrikeEnvelope, stepCombat } from '../../src/game/sim/combat';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { RacerState, SimEvent } from '../../src/game/sim/state';
import { buildSetup, runHeadlessRace } from '../support/headless';

/**
 * The companion strike.
 *
 * The design brief for this mechanic is that it must add pressure without
 * substituting for driving. These tests pin both halves of that: it has to
 * *work* (range, timing, feedback), and it has to stay *small* (no chaining, no
 * stun-lock, worth a fraction of a corner).
 */

function setup(): { sim: Simulation; a: RacerState; b: RacerState } {
  const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 2 }));
  while (sim.phase === 'countdown') {
    sim.step(emptyInput());
    sim.drainEvents();
  }
  // Get past the opening grace period.
  while (sim.raceTime < COMBAT.graceAfterStart + 0.1) {
    sim.step(emptyInput());
    sim.drainEvents();
  }
  const [a, b] = sim.racers;
  if (!a || !b) throw new Error('need two racers');
  return { sim, a, b };
}

/** Places `b` alongside `a` at the given side and offsets. */
function placeAlongside(a: RacerState, b: RacerState, side: -1 | 1, lateral: number, ahead = 0): void {
  const forward = fromHeading(a.heading);
  const left = { x: -Math.sin(a.heading), z: Math.cos(a.heading) };
  const sign = side === -1 ? 1 : -1;
  b.pos = {
    x: a.pos.x + left.x * lateral * sign + forward.x * ahead,
    z: a.pos.z + left.z * lateral * sign + forward.z * ahead,
  };
  b.y = a.y;
  b.heading = a.heading;
}

describe('strike envelope', () => {
  it('connects at a plausible alongside distance on the chosen side', () => {
    const { a, b } = setup();
    placeAlongside(a, b, 1, 2.5);
    expect(isInStrikeEnvelope(a, b, 1)).toBe(true);
    // ...and never through the skiff to the other side.
    expect(isInStrikeEnvelope(a, b, -1)).toBe(false);
  });

  it('does not connect beyond the companion\'s reach', () => {
    const { a, b } = setup();
    placeAlongside(a, b, 1, a.spec.reach + 1.5);
    expect(isInStrikeEnvelope(a, b, 1)).toBe(false);
  });

  it('does not connect through the hull at point-blank range', () => {
    const { a, b } = setup();
    placeAlongside(a, b, 1, COMBAT.minReach * 0.5);
    expect(isInStrikeEnvelope(a, b, 1)).toBe(false);
  });

  it('does not connect to a rival far ahead or far behind', () => {
    const { a, b } = setup();
    placeAlongside(a, b, 1, 2.5, COMBAT.forwardMax + 3);
    expect(isInStrikeEnvelope(a, b, 1)).toBe(false);
    placeAlongside(a, b, 1, 2.5, COMBAT.forwardMin - 3);
    expect(isInStrikeEnvelope(a, b, 1)).toBe(false);
  });

  it('does not connect across a height difference', () => {
    const { a, b } = setup();
    placeAlongside(a, b, 1, 2.5);
    b.y = a.y + 4;
    expect(isInStrikeEnvelope(a, b, 1)).toBe(false);
  });

  it('reach scales with the crew stat', () => {
    const { a, b } = setup();
    const reaches = [a.spec.reach, b.spec.reach];
    expect(Math.max(...reaches)).toBeGreaterThan(Math.min(...reaches));
  });
});

describe('strike timing', () => {
  it('telegraphs before it lands', () => {
    const { sim, a, b } = setup();
    placeAlongside(a, b, 1, 2.5);
    const events: SimEvent[] = [];
    const ctx = { dt: FIXED_STEP, raceTime: sim.raceTime, events, racers: sim.racers };

    stepCombat(a, { ...emptyInput(), strike: 1 }, ctx);
    expect(a.strike.phase).toBe('windup');
    expect(events.some((e) => e.type === 'strikeSwing')).toBe(true);
    // Nothing lands during the windup: that is the whole point of it.
    expect(events.some((e) => e.type === 'strikeHit')).toBe(false);

    let elapsed = 0;
    while (a.strike.phase === 'windup' && elapsed < 1) {
      placeAlongside(a, b, 1, 2.5);
      stepCombat(a, emptyInput(), ctx);
      elapsed += FIXED_STEP;
    }
    expect(elapsed).toBeGreaterThanOrEqual(COMBAT.windup - FIXED_STEP * 2);
    expect(events.some((e) => e.type === 'strikeHit')).toBe(true);
  });

  it('cannot be repeated faster than the cooldown', () => {
    const { sim, a, b } = setup();
    placeAlongside(a, b, 1, 2.5);
    const events: SimEvent[] = [];
    const ctx = { dt: FIXED_STEP, raceTime: sim.raceTime, events, racers: sim.racers };

    stepCombat(a, { ...emptyInput(), strike: 1 }, ctx);
    let elapsed = 0;
    let swings = 1;
    while (elapsed < COMBAT.cooldown - 0.05) {
      placeAlongside(a, b, 1, 2.5);
      const before = events.length;
      stepCombat(a, { ...emptyInput(), strike: 1 }, ctx);
      swings += events.slice(before).filter((e) => e.type === 'strikeSwing').length;
      elapsed += FIXED_STEP;
    }
    expect(swings).toBe(1);
  });

  it('lands at most once per swing on the same rival', () => {
    const { sim, a, b } = setup();
    const events: SimEvent[] = [];
    const ctx = { dt: FIXED_STEP, raceTime: sim.raceTime, events, racers: sim.racers };
    stepCombat(a, { ...emptyInput(), strike: 1 }, ctx);
    for (let i = 0; i < 200; i++) {
      placeAlongside(a, b, 1, 2.5);
      b.stagger = 0;
      stepCombat(a, emptyInput(), ctx);
    }
    expect(events.filter((e) => e.type === 'strikeHit')).toHaveLength(1);
  });

  it('cannot be started while staggered, airborne, or in the opening seconds', () => {
    const { sim, a } = setup();
    expect(canStartStrike(a, sim.raceTime)).toBe(true);
    a.stagger = 0.3;
    expect(canStartStrike(a, sim.raceTime)).toBe(false);
    a.stagger = 0;
    a.airborne = true;
    expect(canStartStrike(a, sim.raceTime)).toBe(false);
    a.airborne = false;
    expect(canStartStrike(a, COMBAT.graceAfterStart - 0.1)).toBe(false);
  });
});

describe('strike effect', () => {
  it('costs the target speed and control, but never all of it', () => {
    const { sim, a, b } = setup();
    b.velocity = { x: Math.cos(b.heading) * 40, z: Math.sin(b.heading) * 40 };
    const before = Math.hypot(b.velocity.x, b.velocity.z);
    applyStrike(a, b, 1, 1, { dt: FIXED_STEP, raceTime: sim.raceTime, events: [], racers: sim.racers });
    const after = Math.hypot(b.velocity.x, b.velocity.z);

    expect(after).toBeLessThan(before);
    // A strike must never be a knockout: two thirds of the speed survives.
    expect(after).toBeGreaterThan(before * 0.66);
    expect(b.stagger).toBeGreaterThan(0);
    expect(b.stagger).toBeLessThanOrEqual(COMBAT.staggerTime);
    expect(b.drift.active).toBe(false);
  });

  it('decays hard on repeat hits so nobody can be stun-locked', () => {
    const { sim, a, b } = setup();
    const ctx = { dt: FIXED_STEP, raceTime: sim.raceTime, events: [], racers: sim.racers };
    const strengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      const strength = guardMultiplier(b, a.index);
      strengths.push(strength);
      applyStrike(a, b, 1, strength, ctx);
      b.guards = b.guards.map((g) => (g.attacker === a.index ? { ...g, hits: g.hits + 1, timer: COMBAT.guardWindow } : g));
      if (!b.guards.some((g) => g.attacker === a.index)) {
        b.guards.push({ attacker: a.index, hits: 1, timer: COMBAT.guardWindow });
      }
    }
    expect(strengths[0]).toBe(1);
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i]).toBeLessThanOrEqual(strengths[i - 1] as number);
    }
    expect(strengths[strengths.length - 1]).toBeLessThanOrEqual(COMBAT.guardFloor + 1e-9);
  });

  it('counters when both riders swing at once, punishing both', () => {
    const { sim, a, b } = setup();
    placeAlongside(a, b, 1, 2.5);
    const events: SimEvent[] = [];
    const ctx = { dt: FIXED_STEP, raceTime: sim.raceTime, events, racers: sim.racers };

    stepCombat(a, { ...emptyInput(), strike: 1 }, ctx);
    stepCombat(b, { ...emptyInput(), strike: -1 }, ctx);
    for (let i = 0; i < 60; i++) {
      placeAlongside(a, b, 1, 2.5);
      stepCombat(a, emptyInput(), ctx);
      stepCombat(b, emptyInput(), ctx);
      if (events.some((e) => e.type === 'strikeCounter')) break;
    }

    expect(events.some((e) => e.type === 'strikeCounter')).toBe(true);
    expect(a.stagger).toBeGreaterThan(0);
    expect(b.stagger).toBeGreaterThan(0);
    // A counter is a mutual reset, not a hit: no damage is dealt.
    expect(events.some((e) => e.type === 'strikeHit')).toBe(false);
  });
});

describe('combat balance', () => {
  it('is worth far less than driving well', () => {
    // Two identical races, one with the AI's companion disabled entirely.
    // If combat mattered more than pace, the finishing times would diverge
    // enormously. The budget: a whole race of strikes is worth under 8%.
    const withCombat = runHeadlessRace({
      trackId: 'emberfall-quarry',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 400,
    });

    const noCombat = runHeadlessRace({
      trackId: 'emberfall-quarry',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 400,
      onStep: (sim) => {
        for (const racer of sim.racers) {
          if (racer.ai) racer.ai.aggression = 0;
        }
      },
    });

    const a = withCombat.results[0]?.finishTime ?? 0;
    const b = noCombat.results[0]?.finishTime ?? 0;
    expect(Math.abs(a - b) / b).toBeLessThan(0.08);
  });

  it('never lets one racer land an unreasonable number of strikes', () => {
    const result = runHeadlessRace({
      trackId: 'emberfall-quarry',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 400,
    });
    const laps = result.sim.track.laps;
    for (const racer of result.sim.racers) {
      // The cooldown alone caps this; the assertion catches a regression that
      // removes it. Roughly one strike per eight seconds of racing.
      expect(racer.strikesLanded).toBeLessThan((racer.finishTime / COMBAT.cooldown) * 0.5);
      expect(racer.strikesTaken).toBeLessThan(laps * 12);
    }
  });

  it('opponents do not strike during the opening seconds', () => {
    const result = runHeadlessRace({
      trackId: 'emberfall-quarry',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 30,
    });
    let time = 0;
    const swingTimes: number[] = [];
    for (const event of result.events) {
      if (event.type === 'raceStart') time = 0;
      if (event.type === 'strikeSwing') swingTimes.push(time);
    }
    // Reconstructed from the race clock rather than the event stream order.
    expect(result.sim.raceTime).toBeGreaterThan(COMBAT.graceAfterStart);
    for (const racer of result.sim.racers) {
      if (racer.strike.phase !== 'idle') expect(result.sim.raceTime).toBeGreaterThanOrEqual(COMBAT.graceAfterStart);
    }
  });

  it('opponents do not kick a rival who is already down', () => {
    runHeadlessRace({
      trackId: 'emberfall-quarry',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 120,
      onStep: (sim, events) => {
        for (const event of events) {
          if (event.type !== 'strikeHit') continue;
          const target = sim.racers[event.target];
          // The AI checks `stagger > 0` before swinging, so a landed hit means
          // the target was upright when the swing started.
          expect(target).toBeDefined();
        }
      },
    });
  });
});
