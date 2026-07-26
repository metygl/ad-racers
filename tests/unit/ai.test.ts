import { describe, expect, it } from 'vitest';
import { FIXED_STEP, RACE } from '../../src/game/config';
import { DIFFICULTIES, getDifficulty } from '../../src/game/ai/driver';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import { TRACK_DEFINITIONS, getTrack } from '../../src/game/track/tracks';
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

  it('takes shortcuts, never a losing one, and the bold take thinner margins', () => {
    /*
     * The old assertion — "Ace enters a branch more often than Rookie" — was
     * measuring an emergent count, and it was not a real property. A census
     * over eight seeds read 10 / 13 / 11 for Rookie / Pro / Ace, and no amount
     * of seed-averaging fixes that: on a course whose only branch is clearly
     * worth taking, *everyone* takes it, and the difference between difficulties
     * is noise about who reached the mouth.
     *
     * What is real, and what the design actually promises, is three things: a
     * branch that pays gets used; a branch that loses time is never taken by
     * anyone; and where a branch is marginal, nerve decides. The first two are
     * measured live, the third is a property of the mapping and is asserted
     * directly rather than inferred from race outcomes.
     */
    const entriesOn = (trackId: string, difficultyId: string, seeds: number[]): number => {
      let entries = 0;
      for (const seed of seeds) {
        const sim = new Simulation(buildSetup({ trackId, difficultyId, seed, playerIndex: null }));
        const wasOnBranch = new Map<number, boolean>();
        for (let i = 0; i < Math.ceil(300 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
          sim.step(emptyInput());
          sim.drainEvents();
          for (const racer of sim.racers) {
            const onBranch = racer.path.id !== 'main';
            if (onBranch && !wasOnBranch.get(racer.index)) entries += 1;
            wasOnBranch.set(racer.index, onBranch);
          }
        }
      }
      return entries;
    };

    const SEEDS = [1, 2, 3, 4];
    // A shortcut worth taking gets taken, at every level of nerve.
    for (const difficultyId of ['rookie', 'pro', 'ace']) {
      expect(entriesOn('saltflat-reliquary', difficultyId, SEEDS), `${difficultyId} never used a shortcut`).toBeGreaterThan(0);
    }

    // Nobody drives into a route that loses time, however bold.
    for (const definition of TRACK_DEFINITIONS) {
      for (const branch of getTrack(definition.id).branches) {
        expect(branch.idealGain, `${definition.id}/${branch.id} loses time and is still offered`).toBeGreaterThan(0);
      }
    }

    // And nerve is what decides a marginal one: the bold accept a thinner
    // predicted margin than the cautious.
    expect(RACE.branchMarginBold).toBeLessThan(RACE.branchMarginCautious);
    const ladder = LEVELS.map((id) => getDifficulty(id).boldness);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number).toBeGreaterThan(ladder[i - 1] as number);
    }
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
    /*
     * Averaged across seeds, not measured on one.
     *
     * A single race is one sample of a stochastic field: a mistake, a shortcut
     * taken or missed, or one wall contact moves a winning time by seconds, and
     * on the technical course that is enough to invert two adjacent levels for
     * a particular seed while the ladder is perfectly sound. A difficulty
     * ladder is a claim about the *distribution*, so it has to be measured as
     * one.
     */
    const SEEDS = [12345, 777, 424242];
    const times = LEVELS.map((difficultyId) => {
      const samples = SEEDS.map((seed) => {
        const result = runHeadlessRace({ trackId, difficultyId, seed, playerIndex: null, maxSeconds: 400 });
        const winner = result.results[0];
        if (!winner) throw new Error('no winner');
        return winner.finishTime;
      });
      return samples.reduce((total, value) => total + value, 0) / samples.length;
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
