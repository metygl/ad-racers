import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_POINTS,
  applyRoundResult,
  createCircuit,
  isComplete,
  playerPlace,
  playerStanding,
  pointsFor,
  sortStandings,
} from '../../src/game/circuit';
import { SPEED_CLASSES } from '../../src/game/config';
import { RACERS } from '../../src/game/racers';
import { defaultSave, recordCircuit, unlockedSpeedClasses } from '../../src/core/storage';
import { TRACK_DEFINITIONS } from '../../src/game/track/tracks';

/**
 * The championship.
 *
 * These assert the three properties the design rests on: a win is worth a win
 * but not a lockout, everybody scores, and a tie is settled by something that
 * happened on the road.
 */

const ENTRIES = RACERS.map((r) => r.id);

function circuit(): ReturnType<typeof createCircuit> {
  return createCircuit({
    seed: 1234,
    difficultyId: 'pro',
    speedClassId: 'reclaim',
    playerProfileId: ENTRIES[0] as string,
    entries: ENTRIES,
  });
}

/** A round result where the field finishes in the given order of profile ids. */
function round(order: readonly string[]): { profileId: string; position: number; time: number }[] {
  return order.map((profileId, index) => ({ profileId, position: index + 1, time: 100 + index * 2 }));
}

describe('scoring', () => {
  it('pays every finishing position', () => {
    for (let position = 1; position <= RACERS.length; position++) {
      expect(pointsFor(position)).toBeGreaterThan(0);
    }
  });

  it('pays strictly more for a better finish', () => {
    for (let i = 1; i < CIRCUIT_POINTS.length; i++) {
      expect(CIRCUIT_POINTS[i - 1] as number).toBeGreaterThan(CIRCUIT_POINTS[i] as number);
    }
  });

  it('keeps a win worth a win without making it a lockout', () => {
    // The whole design rests on this ratio. A single round must never be worth
    // more than the rest of the championship put together, or a bad first round
    // ends the evening — and the gap at the front must still be worth racing for.
    const rounds = TRACK_DEFINITIONS.length;
    const winEverything = pointsFor(1) * rounds;
    const secondEverywhere = pointsFor(2) * rounds;
    expect(winEverything).toBeGreaterThan(secondEverywhere);
    expect(pointsFor(1) - pointsFor(2)).toBeLessThan(pointsFor(1) * 0.35);
    // Winning one round and finishing last in the rest must not beat finishing
    // second everywhere.
    const oneHeroicDrive = pointsFor(1) + pointsFor(RACERS.length) * (rounds - 1);
    expect(oneHeroicDrive).toBeLessThan(secondEverywhere);
  });
});

describe('a championship', () => {
  it('runs one round per shipped course, in order', () => {
    const state = circuit();
    expect(state.rounds).toHaveLength(TRACK_DEFINITIONS.length);
    expect(state.rounds.map((r) => r.trackId)).toEqual(TRACK_DEFINITIONS.map((t) => t.id));
    expect(new Set(state.rounds.map((r) => r.seed)).size).toBe(state.rounds.length);
  });

  it('is reproducible from its seed, so a restarted round is a real retry', () => {
    const a = circuit();
    const b = circuit();
    expect(a.rounds).toEqual(b.rounds);
  });

  it('accumulates points and completes after the last round', () => {
    let state = circuit();
    expect(isComplete(state)).toBe(false);
    for (let i = 0; i < TRACK_DEFINITIONS.length; i++) {
      state = applyRoundResult(state, round(ENTRIES));
      expect(state.currentRound).toBe(i + 1);
    }
    expect(isComplete(state)).toBe(true);

    const winner = state.standings[0];
    expect(winner?.profileId).toBe(ENTRIES[0]);
    expect(winner?.points).toBe(pointsFor(1) * TRACK_DEFINITIONS.length);
    expect(winner?.finishes).toHaveLength(TRACK_DEFINITIONS.length);
    // Everybody scored, including the back marker.
    for (const standing of state.standings) expect(standing.points).toBeGreaterThan(0);
  });

  it('lets a consistent driver beat an inconsistent one', () => {
    let state = circuit();
    const [steady, spiky, ...rest] = ENTRIES as [string, string, ...string[]];
    // `spiky` wins the opener then finishes last twice; `steady` is second every
    // time. Consistency has to win, because the driving model rewards a clean
    // line and the scoring must not contradict it.
    state = applyRoundResult(state, round([spiky, steady, ...rest]));
    state = applyRoundResult(state, round([...rest, steady, spiky].slice(-RACERS.length)));
    state = applyRoundResult(state, round([...rest, steady, spiky].slice(-RACERS.length)));

    const steadyPoints = state.standings.find((s) => s.profileId === steady)?.points ?? 0;
    const spikyPoints = state.standings.find((s) => s.profileId === spiky)?.points ?? 0;
    expect(steadyPoints).toBeGreaterThan(spikyPoints);
  });

  it('breaks a points tie on best finish, then on total time', () => {
    const base = { finishes: [] as number[] };
    const sorted = sortStandings([
      { ...base, profileId: 'slow', points: 20, bestFinish: 2, totalTime: 300 },
      { ...base, profileId: 'quick', points: 20, bestFinish: 2, totalTime: 250 },
      { ...base, profileId: 'winner', points: 20, bestFinish: 1, totalTime: 400 },
    ]);
    expect(sorted.map((s) => s.profileId)).toEqual(['winner', 'quick', 'slow']);
  });

  it('charges a finite penalty for a racer the timeout classified', () => {
    let state = circuit();
    const results = round(ENTRIES);
    const last = results[results.length - 1];
    if (last) last.time = Infinity;
    state = applyRoundResult(state, results);
    for (const standing of state.standings) expect(Number.isFinite(standing.totalTime)).toBe(true);
  });

  it('reports the player’s place and standing', () => {
    let state = circuit();
    state = applyRoundResult(state, round([...ENTRIES].reverse()));
    expect(playerPlace(state)).toBe(ENTRIES.length);
    expect(playerStanding(state)?.profileId).toBe(ENTRIES[0]);
  });
});

describe('speed class unlocks', () => {
  it('opens only the first class on a fresh save', () => {
    const save = defaultSave();
    const unlocked = unlockedSpeedClasses(save, SPEED_CLASSES.map((c) => c.id));
    expect([...unlocked]).toEqual([SPEED_CLASSES[0]?.id]);
  });

  it('opens the next class after a podium in the one below', () => {
    const save = defaultSave();
    const ids = SPEED_CLASSES.map((c) => c.id);
    recordCircuit(save, 'pro', ids[0] as string, { place: 3, points: 30, totalTime: 300 });
    const unlocked = unlockedSpeedClasses(save, ids);
    expect(unlocked.has(ids[1] as string)).toBe(true);
    // ...and no further: unlocks are one step at a time.
    expect(unlocked.has(ids[2] as string)).toBe(false);
  });

  it('does not open anything for a fourth place', () => {
    const save = defaultSave();
    const ids = SPEED_CLASSES.map((c) => c.id);
    recordCircuit(save, 'ace', ids[0] as string, { place: 4, points: 20, totalTime: 300 });
    expect(unlockedSpeedClasses(save, ids).has(ids[1] as string)).toBe(false);
  });

  it('keeps only the better of two championship results', () => {
    const save = defaultSave();
    expect(recordCircuit(save, 'pro', 'reclaim', { place: 4, points: 20, totalTime: 300 })).toBe(true);
    expect(recordCircuit(save, 'pro', 'reclaim', { place: 6, points: 10, totalTime: 200 })).toBe(false);
    expect(save.circuits['pro:reclaim']?.place).toBe(4);
    expect(recordCircuit(save, 'pro', 'reclaim', { place: 1, points: 40, totalTime: 320 })).toBe(true);
    expect(save.circuits['pro:reclaim']?.place).toBe(1);
  });
});
