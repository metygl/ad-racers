import { describe, expect, it } from 'vitest';
import { FIXED_STEP } from '../../src/game/config';
import { DIFFICULTIES } from '../../src/game/ai/driver';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import { TRACK_DEFINITIONS } from '../../src/game/track/tracks';
import { buildSetup, runHeadlessRace } from '../support/headless';

/**
 * Opponent quality.
 *
 * These are the assertions that stop the AI regressing into the two failure
 * modes that ruin a racing game: cars that cannot finish, and cars that only
 * win because the game let them. Every one of them was written after watching
 * the AI actually do the thing it is checking for.
 */

const TRACKS = TRACK_DEFINITIONS.map((d) => [d.name, d.id] as const);
const LEVELS = DIFFICULTIES.map((d) => d.id);

describe('AI navigation', () => {
  it.each(TRACKS)('%s: every opponent finishes at every difficulty', (_name, trackId) => {
    for (const difficultyId of LEVELS) {
      const result = runHeadlessRace({ trackId, difficultyId, playerIndex: null, maxSeconds: 400 });
      expect(result.finished, `${trackId}/${difficultyId} did not finish`).toBe(true);
      const laps = TRACK_DEFINITIONS.find((d) => d.id === trackId)?.laps ?? 3;
      for (const racer of result.results) {
        expect(
          racer.lapTimes.length,
          `${racer.profileId} on ${trackId}/${difficultyId} completed only ${racer.lapTimes.length} laps`,
        ).toBeGreaterThanOrEqual(laps);
      }
    }
  });

  it.each(TRACKS)('%s: a lone opponent stays on the road', (_name, trackId) => {
    const sim = new Simulation(buildSetup({ trackId, difficultyId: 'ace', playerIndex: null, entries: 1 }));
    const racer = sim.racers[0];
    if (!racer) throw new Error('no racer');
    let off = 0;
    let samples = 0;
    for (let i = 0; i < Math.ceil(300 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
      sim.step(emptyInput());
      sim.drainEvents();
      if (sim.phase !== 'running') continue;
      samples += 1;
      if (!racer.onTrack) off += 1;
    }
    expect(racer.finished).toBe(true);
    // Some running wide is racing; a quarter of the lap on the grass is a bug.
    expect(off / samples, `${trackId}: opponent spent ${((100 * off) / samples).toFixed(0)}% off-track`).toBeLessThan(0.12);
  });

  it.each(TRACKS)('%s: nobody gets permanently stuck', (_name, trackId) => {
    const result = runHeadlessRace({ trackId, difficultyId: 'pro', playerIndex: null, maxSeconds: 400 });
    // Respawns are the safety net, not the plan. A handful across a whole race
    // is acceptable; a stream of them means the AI cannot drive the course.
    const respawns = result.events.filter((e) => e.type === 'respawn').length;
    expect(respawns).toBeLessThan(6);
    for (const racer of result.sim.racers) expect(racer.wedgeTimer).toBeLessThan(6);
  });

  it('obeys checkpoints: no opponent ever finishes with missing checkpoints', () => {
    for (const [, trackId] of TRACKS) {
      const result = runHeadlessRace({ trackId, difficultyId: 'ace', playerIndex: null, maxSeconds: 400 });
      const track = result.sim.track;
      for (const racer of result.results) {
        // Finishing N laps requires exactly N × checkpointCount gates, in order.
        expect(racer.checkpointsPassed).toBeGreaterThanOrEqual(racer.lapsCompleted * track.checkpoints.length);
      }
    }
  });

  it('uses shortcuts, and more often at higher difficulty', () => {
    // Count *entries*, not frames spent on the branch: a slower field spends
    // longer on a shortcut without choosing it any more often.
    const branchEntries = (difficultyId: string): number => {
      const sim = new Simulation(buildSetup({ trackId: 'saltflat-reliquary', difficultyId, playerIndex: null }));
      const wasOnBranch = new Map<number, boolean>();
      let entries = 0;
      for (let i = 0; i < Math.ceil(300 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
        sim.step(emptyInput());
        sim.drainEvents();
        for (const racer of sim.racers) {
          const onBranch = racer.path.id !== 'main';
          if (onBranch && !wasOnBranch.get(racer.index)) entries += 1;
          wasOnBranch.set(racer.index, onBranch);
        }
      }
      return entries;
    };
    const rookie = branchEntries('rookie');
    const ace = branchEntries('ace');
    expect(ace).toBeGreaterThan(0);
    expect(ace).toBeGreaterThan(rookie);
  });
});

describe('difficulty', () => {
  it('offers at least three levels', () => {
    expect(DIFFICULTIES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(DIFFICULTIES.map((d) => d.id)).size).toBe(DIFFICULTIES.length);
  });

  it('orders the levels by pace, reaction and mistake rate', () => {
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      const easier = DIFFICULTIES[i - 1];
      const harder = DIFFICULTIES[i];
      if (!easier || !harder) throw new Error('missing difficulty');
      expect(harder.pace).toBeGreaterThan(easier.pace);
      expect(harder.reaction).toBeLessThan(easier.reaction);
      expect(harder.mistakeRate).toBeLessThan(easier.mistakeRate);
      expect(harder.aggression).toBeGreaterThan(easier.aggression);
    }
  });

  it.each(TRACKS)('%s: each level is measurably faster than the one below', (_name, trackId) => {
    const times = LEVELS.map((difficultyId) => {
      const result = runHeadlessRace({ trackId, difficultyId, playerIndex: null, maxSeconds: 400 });
      const winner = result.results[0];
      if (!winner) throw new Error('no winner');
      return winner.finishTime;
    });

    for (let i = 1; i < times.length; i++) {
      const slower = times[i - 1] as number;
      const faster = times[i] as number;
      expect(faster, `${trackId}: ${LEVELS[i]} was not faster than ${LEVELS[i - 1]}`).toBeLessThan(slower);
    }

    const rookie = times[0] as number;
    const ace = times[times.length - 1] as number;
    // A spread this size is the difference between "a bit quicker" and "a
    // different race". Below 6% the settings are decorative.
    expect((rookie - ace) / rookie).toBeGreaterThan(0.06);
  });

  it('does not let a lower difficulty be harder by accident on any course', () => {
    for (const [, trackId] of TRACKS) {
      const rookie = runHeadlessRace({ trackId, difficultyId: 'rookie', playerIndex: null, maxSeconds: 400 });
      const ace = runHeadlessRace({ trackId, difficultyId: 'ace', playerIndex: null, maxSeconds: 400 });
      const rookieBest = Math.min(...rookie.results.map((r) => r.bestLap));
      const aceBest = Math.min(...ace.results.map((r) => r.bestLap));
      expect(aceBest).toBeLessThan(rookieBest);
    }
  });
});
