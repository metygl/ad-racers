import { TRACK_DEFINITIONS } from './track/tracks';

/**
 * The Reclaim Circuit: a championship across every course.
 *
 * Why this exists. A single race is a thing you do; a championship is a thing
 * you are *in the middle of*, and that is the difference between a game with a
 * loop and a game with a menu. It is also the cheapest possible way to give a
 * bad round consequences without making it fatal — a spun corner on round one
 * costs points, not the evening.
 *
 * Three rules shape the scoring:
 *
 * 1. **A win is worth a win, not a lockout.** The gap between first and second
 *    is 3 points on a 15-point scale, so one strong round never decides a
 *    championship and one bad round never ends it. Aggregated across three
 *    rounds, consistency beats a single heroic drive — which is the correct
 *    incentive for a game whose driving model rewards a clean line.
 * 2. **Everyone scores.** Finishing last still pays. A player who is out of
 *    contention still has something to race for in the final round, and an
 *    opponent having a bad championship does not become irrelevant to watch.
 * 3. **Ties break on the road.** Equal points are separated by best finish and
 *    then by total time, never by an arbitrary ordering — so a tie is settled
 *    by something the player did rather than by something the code decided.
 *
 * Entirely local. No accounts, no servers, no leaderboards beyond this machine.
 */

/** Points for finishing 1st, 2nd, 3rd … in a round. */
export const CIRCUIT_POINTS: readonly number[] = [15, 12, 10, 8, 6, 4, 3, 2, 1];

export function pointsFor(position: number): number {
  return CIRCUIT_POINTS[position - 1] ?? 1;
}

export interface CircuitRound {
  trackId: string;
  /** Deterministic per-round seed, derived from the championship seed. */
  seed: number;
}

export interface CircuitStanding {
  profileId: string;
  points: number;
  /** Best (numerically lowest) finishing position so far. */
  bestFinish: number;
  /** Sum of finishing times across completed rounds. */
  totalTime: number;
  /** Finishing position in each completed round, in order. */
  finishes: number[];
}

export interface CircuitState {
  /** Championship seed; every round's seed derives from it. */
  seed: number;
  difficultyId: string;
  speedClassId: string;
  playerProfileId: string;
  rounds: CircuitRound[];
  /** Index of the round about to be raced. */
  currentRound: number;
  standings: CircuitStanding[];
}

/**
 * Builds a championship over every shipped course, in the order they are
 * defined — which is deliberately easiest first, so the championship teaches
 * the game in the same order a new player would meet it.
 */
export function createCircuit(options: {
  seed: number;
  difficultyId: string;
  speedClassId: string;
  playerProfileId: string;
  entries: readonly string[];
}): CircuitState {
  return {
    seed: options.seed,
    difficultyId: options.difficultyId,
    speedClassId: options.speedClassId,
    playerProfileId: options.playerProfileId,
    rounds: TRACK_DEFINITIONS.map((track, index) => ({
      trackId: track.id,
      // Rounds must differ from each other but stay reproducible from the
      // championship seed, so "restart round" is a genuine retry.
      seed: (options.seed + index * 0x9e37) >>> 0,
    })),
    currentRound: 0,
    standings: options.entries.map((profileId) => ({
      profileId,
      points: 0,
      bestFinish: Number.POSITIVE_INFINITY,
      totalTime: 0,
      finishes: [],
    })),
  };
}

/**
 * Folds one round's results into the standings and advances the round counter.
 * `results` is the classification, in finishing order.
 */
export function applyRoundResult(
  circuit: CircuitState,
  results: readonly { profileId: string; position: number; time: number }[],
): CircuitState {
  const standings = circuit.standings.map((standing) => {
    const result = results.find((r) => r.profileId === standing.profileId);
    if (!result) return standing;
    return {
      ...standing,
      points: standing.points + pointsFor(result.position),
      bestFinish: Math.min(standing.bestFinish, result.position),
      // A racer classified by the post-race timeout has an infinite time. Using
      // it directly would poison the tiebreak for the whole championship, so it
      // is charged a generous but finite penalty instead.
      totalTime: standing.totalTime + (Number.isFinite(result.time) ? result.time : 600),
      finishes: [...standing.finishes, result.position],
    };
  });

  return { ...circuit, standings: sortStandings(standings), currentRound: circuit.currentRound + 1 };
}

/** Championship order: points, then best finish, then total time. */
export function sortStandings(standings: readonly CircuitStanding[]): CircuitStanding[] {
  return [...standings].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.bestFinish !== b.bestFinish) return a.bestFinish - b.bestFinish;
    return a.totalTime - b.totalTime;
  });
}

export function isComplete(circuit: CircuitState): boolean {
  return circuit.currentRound >= circuit.rounds.length;
}

/** The player's 1-based place in the current standings. */
export function playerPlace(circuit: CircuitState): number {
  const index = circuit.standings.findIndex((s) => s.profileId === circuit.playerProfileId);
  return index < 0 ? circuit.standings.length : index + 1;
}

export function playerStanding(circuit: CircuitState): CircuitStanding | null {
  return circuit.standings.find((s) => s.profileId === circuit.playerProfileId) ?? null;
}
