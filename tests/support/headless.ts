import { FIXED_STEP, getSpeedClass } from '../../src/game/config';
import { DIFFICULTIES, driveAi, getDifficulty } from '../../src/game/ai/driver';
import { RACERS } from '../../src/game/racers';
import { Simulation } from '../../src/game/sim/simulation';
import type { RaceSetup } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { ControlInput, RacerState, SimEvent } from '../../src/game/sim/state';
import { getTrack } from '../../src/game/track/tracks';

/**
 * Headless race harness.
 *
 * The simulation has no renderer, DOM or timing dependency, so a whole race
 * can be run inside a unit test in a fraction of a second. This is the single
 * most valuable piece of test infrastructure in the project: it is what lets
 * "does the AI finish every course from every grid slot" be an assertion
 * rather than a hope.
 */

export interface HeadlessOptions {
  trackId: string;
  difficultyId?: string;
  /** Speed class id; defaults to the base class. */
  speedClassId?: string;
  seed?: number;
  /** Number of entries; defaults to the full field. */
  entries?: number;
  /** Which entry is the player, or `null` for an all-AI race. */
  playerIndex?: number | null;
  catchUp?: boolean;
  /** Produces the player's input each step. Defaults to sitting still. */
  playerInput?: (sim: Simulation, step: number) => ControlInput;
  /** Hard limit on simulated seconds. */
  maxSeconds?: number;
  /** Called after each step, for assertions that need per-step visibility. */
  onStep?: (sim: Simulation, events: SimEvent[]) => void;
}

export interface HeadlessResult {
  sim: Simulation;
  /** Simulated seconds elapsed, including the countdown. */
  elapsed: number;
  finished: boolean;
  results: RacerState[];
  events: SimEvent[];
}

export function buildSetup(options: HeadlessOptions): RaceSetup {
  const count = options.entries ?? RACERS.length;
  const playerIndex = options.playerIndex === undefined ? 0 : options.playerIndex;
  return {
    track: getTrack(options.trackId),
    entries: RACERS.slice(0, count).map((r, i) => ({ profileId: r.id, isPlayer: i === playerIndex })),
    difficulty: getDifficulty(options.difficultyId ?? 'pro'),
    speedClass: getSpeedClass(options.speedClassId ?? 'reclaim'),
    seed: options.seed ?? 12345,
    catchUp: options.catchUp ?? true,
  };
}

export function runHeadlessRace(options: HeadlessOptions): HeadlessResult {
  const sim = new Simulation(buildSetup(options));
  const maxSteps = Math.ceil((options.maxSeconds ?? 420) / FIXED_STEP);
  const collected: SimEvent[] = [];

  let step = 0;
  for (; step < maxSteps && sim.phase !== 'finished'; step++) {
    const input = options.playerInput ? options.playerInput(sim, step) : emptyInput();
    sim.step(input);
    const events = sim.drainEvents();
    collected.push(...events);
    options.onStep?.(sim, events);
  }

  return {
    sim,
    elapsed: step * FIXED_STEP,
    finished: sim.phase === 'finished',
    results: sim.results(),
    events: collected,
  };
}

/**
 * A competent scripted player: follows the racing line, brakes for corners and
 * drifts. Used where a test needs the player entry to actually race rather
 * than sit on the grid — for example when checking that a human-driven car can
 * beat Rookie and lose to Ace.
 *
 * It borrows the AI brain at a fixed competence so the "player" is a stable
 * reference point across runs, but it is fed through the ordinary player input
 * path, so the simulation treats it exactly like a human.
 */
export function scriptedPlayer(skill = 'pro'): (sim: Simulation, step: number) => ControlInput {
  const brains = new WeakMap<RacerState, NonNullable<RacerState['ai']>>();
  return (sim) => {
    const player = sim.player;
    if (!player) return emptyInput();

    let brain = brains.get(player);
    if (!brain) {
      brain = referenceBrain(skill);
      brains.set(player, brain);
    }

    // `driveAi` only reads `racer.ai`, so lending the player a brain for the
    // duration of the call is safe and keeps the harness free of a duplicate
    // driving model that could drift out of step with the real one.
    const saved = player.ai;
    player.ai = brain;
    const out = driveAi(player, {
      track: sim.track,
      racers: sim.racers,
      dt: FIXED_STEP,
      raceTime: sim.raceTime,
      rng: sim.rng,
      running: sim.phase === 'running',
    });
    player.ai = saved;
    return out;
  };
}

function referenceBrain(difficultyId: string): NonNullable<RacerState['ai']> {
  const profile = DIFFICULTIES.find((d) => d.id === difficultyId) ?? DIFFICULTIES[1];
  if (!profile) throw new Error('no difficulty profiles are defined');
  return {
    difficultyId: profile.id,
    skill: profile.skill,
    aggression: profile.aggression,
    boldness: profile.boldness,
    mistakeRate: profile.mistakeRate,
    surgeDiscipline: profile.surgeDiscipline,
    pace: profile.pace,
    lineBias: 0,
    reaction: profile.reaction,
    noisePhase: 0,
    targetLateral: 0,
    targetSpeed: 0,
    smoothedTargetLateral: 0,
    overtakeTimer: 0,
    overtakeSide: 0,
    strikeCooldown: 0,
    mistakeTimer: 0,
    driftHold: 0,
    boostHold: 0,
    recovery: 'none',
    recoveryTimer: 0,
    branchChoice: null,
    branchDecidedAt: -1,
    catchUpScale: 1,
    // A neutral crew. The reference brain exists to measure what a *difficulty*
    // does, so it deliberately carries no crew character at all.
    style: { shortcut: 1, towPatience: 1, strike: 1, drift: 1, room: 1 },
    defence: 0,
    defendSide: 0,
    defendTimer: 0,
  };
}
