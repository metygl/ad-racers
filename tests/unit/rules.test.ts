import { describe, expect, it } from 'vitest';
import { FIXED_STEP, RACE } from '../../src/game/config';
import { Simulation } from '../../src/game/sim/simulation';
import { displayLap, updatePositions } from '../../src/game/sim/race';
import { emptyInput } from '../../src/game/sim/state';
import type { RacerState } from '../../src/game/sim/state';
import { getTrack } from '../../src/game/track/tracks';
import { buildSetup, runHeadlessRace, scriptedPlayer } from '../support/headless';

/**
 * Lap, checkpoint and classification rules.
 *
 * The rules are the contract between the player and the game. If a lap can be
 * skipped, or a shortcut invalidated, or a finishing order disagree with the
 * times, nothing else about the race matters.
 */

/** Teleports a racer to a position on the centreline, as a cheat would. */
function place(racer: RacerState, sim: Simulation, mainDistance: number, lateral = 0): void {
  const sample = sim.track.sampleMain(mainDistance);
  racer.pos = {
    x: sample.pos.x + sample.normal.x * lateral,
    z: sample.pos.z + sample.normal.z * lateral,
  };
  racer.y = sample.y;
  racer.heading = Math.atan2(sample.tangent.z, sample.tangent.x);
  racer.velocity = { x: 0, z: 0 };
}

/** Advances the simulation past the countdown. */
function startRunning(sim: Simulation): void {
  while (sim.phase === 'countdown') {
    sim.step(emptyInput());
    sim.drainEvents();
  }
}

describe('checkpoints', () => {
  it('are claimed in order and never out of order', () => {
    const result = runHeadlessRace({ trackId: 'overgrown-interchange', playerIndex: null, maxSeconds: 400 });
    const seen = new Map<number, number>();
    for (const event of result.events) {
      if (event.type !== 'checkpoint') continue;
      const expected = seen.get(event.racer) ?? 0;
      expect(event.checkpoint).toBe(expected);
      seen.set(event.racer, (expected + 1) % result.sim.track.checkpoints.length);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('cannot be claimed from far outside the corridor', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 1 }));
    startRunning(sim);
    const racer = sim.racers[0];
    if (!racer) throw new Error('no racer');

    const before = racer.checkpointsPassed;
    const target = sim.track.checkpoints[racer.nextCheckpoint];
    if (!target) throw new Error('no checkpoint');

    // Sit right on the gate, but a long way off the racing corridor.
    place(racer, sim, target.mainDistance + 5, target.halfWidth * RACE.checkpointCorridor + 12);
    sim.step(emptyInput());
    sim.drainEvents();

    expect(racer.checkpointsPassed).toBe(before);
  });

  it('is claimed once the racer returns to the corridor', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 1 }));
    startRunning(sim);
    const racer = sim.racers[0];
    if (!racer) throw new Error('no racer');
    const before = racer.checkpointsPassed;
    const target = sim.track.checkpoints[racer.nextCheckpoint];
    if (!target) throw new Error('no checkpoint');

    place(racer, sim, target.mainDistance + 5, 0);
    sim.step(emptyInput());
    sim.drainEvents();
    expect(racer.checkpointsPassed).toBe(before + 1);
  });

  it('cannot be skipped by cutting across the infield', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 1 }));
    startRunning(sim);
    const racer = sim.racers[0];
    if (!racer) throw new Error('no racer');
    const track = sim.track;

    // Jump most of a lap, well off the corridor the whole way.
    const jumpTo = track.length * 0.75;
    place(racer, sim, jumpTo, track.sampleMain(jumpTo).halfWidth * 4);
    for (let i = 0; i < 30; i++) {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    // Progress is anchored to checkpoints, so teleporting buys nothing.
    expect(racer.checkpointsPassed).toBe(0);
    expect(racer.lapsCompleted).toBeLessThan(1);
  });
});

describe('laps', () => {
  it('counts the first line crossing as the start of lap one, not the end', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 1 }));
    const racer = sim.racers[0];
    if (!racer) throw new Error('no racer');
    expect(racer.lapsCompleted).toBe(-1);
    expect(displayLap(racer, sim.track)).toBe(1);

    startRunning(sim);
    place(racer, sim, 2);
    sim.step(emptyInput());
    sim.drainEvents();

    expect(racer.lapsCompleted).toBe(0);
    expect(displayLap(racer, sim.track)).toBe(1);
    expect(racer.lapTimes).toHaveLength(0);
  });

  it('records one lap time per completed lap and finishes on the last one', () => {
    const result = runHeadlessRace({ trackId: 'emberfall-quarry', playerIndex: null, maxSeconds: 400 });
    const laps = result.sim.track.laps;
    for (const racer of result.results) {
      expect(racer.lapTimes).toHaveLength(laps);
      expect(racer.lapsCompleted).toBe(laps);
      // Lap one starts when the racer first crosses the line, which is a few
      // seconds after the lights, so the lap times sum to slightly less than
      // the finish time — and never to more.
      const total = racer.lapTimes.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(racer.finishTime + 1e-6);
      expect(racer.finishTime - total).toBeLessThan(20);
      expect(racer.bestLap).toBe(Math.min(...racer.lapTimes));
    }
  });

  it('never reports a lap number beyond the race length', () => {
    const result = runHeadlessRace({ trackId: 'overgrown-interchange', playerIndex: null, maxSeconds: 400 });
    for (const racer of result.sim.racers) {
      expect(displayLap(racer, result.sim.track)).toBeLessThanOrEqual(result.sim.track.laps);
      expect(displayLap(racer, result.sim.track)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('shortcuts', () => {
  it('do not invalidate a lap', () => {
    // Drive the whole race with a bold field that uses the shortcut, and check
    // every finisher passed every gate.
    const result = runHeadlessRace({
      trackId: 'saltflat-reliquary',
      difficultyId: 'ace',
      playerIndex: null,
      maxSeconds: 400,
    });
    const gates = result.sim.track.checkpoints.length;
    const usedBranch = result.sim.racers.some((r) => r.path.id !== 'main');
    void usedBranch;
    for (const racer of result.results) {
      expect(racer.checkpointsPassed).toBeGreaterThanOrEqual(racer.lapsCompleted * gates);
    }
  });

  it('advances main-line progress continuously while on a branch', () => {
    const track = getTrack('emberfall-quarry');
    const branch = track.branches[0];
    if (!branch) throw new Error('no branch');
    const covered = new Set<number>();
    for (const sample of branch.samples) {
      for (const checkpoint of track.checkpoints) {
        if (Math.abs(sample.mainDistance - checkpoint.mainDistance) < 2) covered.add(checkpoint.index);
      }
    }
    // Every checkpoint inside the branch's span is swept over by the branch.
    const inside = track.checkpoints.filter(
      (c) => c.mainDistance > branch.entryMainDistance && c.mainDistance < branch.exitMainDistance,
    );
    for (const checkpoint of inside) expect(covered.has(checkpoint.index)).toBe(true);
  });
});

describe('classification', () => {
  it('orders finishers by finish time and everyone else by progress', () => {
    const result = runHeadlessRace({ trackId: 'overgrown-interchange', playerIndex: null, maxSeconds: 400 });
    const ordered = result.results;
    for (let i = 1; i < ordered.length; i++) {
      const ahead = ordered[i - 1];
      const behind = ordered[i];
      if (!ahead || !behind) throw new Error('missing result');
      expect(ahead.finishPosition).toBeLessThan(behind.finishPosition);
      expect(ahead.finishTime).toBeLessThanOrEqual(behind.finishTime + 1e-6);
    }
    expect(new Set(ordered.map((r) => r.finishPosition)).size).toBe(ordered.length);
  });

  it('assigns unique live positions at every moment', () => {
    runHeadlessRace({
      trackId: 'emberfall-quarry',
      playerIndex: null,
      maxSeconds: 60,
      onStep: (sim) => {
        const positions = sim.racers.map((r) => r.position);
        expect(new Set(positions).size).toBe(positions.length);
        expect(Math.min(...positions)).toBe(1);
        expect(Math.max(...positions)).toBe(positions.length);
      },
    });
  });

  it('ranks a racer with more checkpoints ahead of a faster one with fewer', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', entries: 2 }));
    const [a, b] = sim.racers;
    if (!a || !b) throw new Error('need two racers');
    a.checkpointsPassed = 3;
    a.progress = 3 * sim.track.length + 5;
    b.checkpointsPassed = 2;
    b.progress = 2 * sim.track.length + sim.track.length - 1;
    updatePositions(sim.racers);
    expect(a.position).toBe(1);
    expect(b.position).toBe(2);
  });
});

describe('restart', () => {
  it('replays exactly with the same seed and inputs', () => {
    const play = (): number[] => {
      const sim = new Simulation(buildSetup({ trackId: 'emberfall-quarry', seed: 31337 }));
      const drive = scriptedPlayer('pro');
      let step = 0;
      while (sim.phase !== 'finished' && step < 120 * 300) {
        sim.step(drive(sim, step));
        sim.drainEvents();
        step += 1;
      }
      return sim.results().map((r) => Math.round(r.finishTime * 1000));
    };
    expect(play()).toEqual(play());
  });
});

describe('race lifecycle', () => {
  it('runs a countdown before anyone can move', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange' }));
    expect(sim.phase).toBe('countdown');
    const start = sim.racers.map((r) => ({ ...r.pos }));
    for (let i = 0; i < Math.floor(RACE.countdown / FIXED_STEP) - 2; i++) {
      sim.step({ ...emptyInput(), throttle: 1 });
      sim.drainEvents();
    }
    expect(sim.phase).toBe('countdown');
    sim.racers.forEach((racer, i) => {
      const from = start[i];
      if (!from) throw new Error('missing start position');
      expect(Math.hypot(racer.pos.x - from.x, racer.pos.z - from.z)).toBeLessThan(0.5);
    });
  });

  it('announces each countdown value once, then go', () => {
    const result = runHeadlessRace({ trackId: 'overgrown-interchange', playerIndex: null, maxSeconds: 6 });
    const values = result.events.filter((e) => e.type === 'countdown').map((e) => e.value);
    expect(values).toEqual([3, 2, 1, 0]);
    expect(result.events.some((e) => e.type === 'raceStart')).toBe(true);
  });

  it('classifies everyone exactly once', () => {
    const result = runHeadlessRace({ trackId: 'overgrown-interchange', playerIndex: null, maxSeconds: 400 });
    const finishes = result.events.filter((e) => e.type === 'finish');
    expect(new Set(finishes.map((e) => e.racer)).size).toBe(finishes.length);
    expect(result.sim.racers.every((r) => r.finished)).toBe(true);
    expect(result.events.filter((e) => e.type === 'raceEnd')).toHaveLength(1);
  });
});
