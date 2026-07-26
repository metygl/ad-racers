import { clamp } from '../../core/math';
import { RACE } from '../config';
import type { Track } from '../track/buildTrack';
import type { RacerState, SimEvent } from './state';

/**
 * Lap, checkpoint and position rules.
 *
 * The whole scheme rests on one idea: every racer's progress is expressed as a
 * distance along the *main* centreline, even when they are physically on a
 * shortcut branch. A branch declares the span of main-line distance it covers
 * and its own arc length maps linearly into that span, so taking a shortcut
 * still sweeps continuously through every checkpoint in between. That makes
 * legal shortcuts free and illegal cuts impossible without extra rules.
 */

/** How far past a checkpoint a racer may still claim it, in metres. */
const CHECKPOINT_GRACE = 70;

export interface RaceRulesContext {
  track: Track;
  raceTime: number;
  events: SimEvent[];
}

/**
 * Registers checkpoints, laps and finishes for a single racer.
 * Must be called exactly once per fixed step, after the physics.
 */
export function updateRaceProgress(racer: RacerState, ctx: RaceRulesContext): void {
  if (racer.finished) return;
  const { track } = ctx;
  const count = track.checkpoints.length;

  // A racer may legitimately clear more than one checkpoint in a step only in
  // pathological cases, but looping keeps the state machine total.
  for (let guard = 0; guard < count; guard++) {
    const cp = track.checkpoints[racer.nextCheckpoint];
    if (!cp) break;
    const gap = track.forwardGap(racer.mainDistance, cp.mainDistance);
    // gap > 0 means the checkpoint is still ahead.
    if (gap > 0 || gap < -CHECKPOINT_GRACE) break;
    // Being wildly off the racing corridor does not count as passing the gate;
    // this is what stops someone driving across the infield for a free lap.
    if (Math.abs(racer.lateral) > racer.currentHalfWidth * RACE.checkpointCorridor) break;

    racer.nextCheckpoint = (racer.nextCheckpoint + 1) % count;
    racer.checkpointsPassed += 1;
    racer.lastCheckpointDistance = cp.mainDistance;
    ctx.events.push({ type: 'checkpoint', racer: racer.index, checkpoint: cp.index });

    if (cp.index === 0) onCrossLine(racer, ctx);
  }

  updateProgressScore(racer, track);
}

function onCrossLine(racer: RacerState, ctx: RaceRulesContext): void {
  const { track, raceTime } = ctx;
  if (racer.lapsCompleted < 0) {
    // First crossing: this is the start of lap 1, not the end of one.
    racer.lapsCompleted = 0;
    racer.currentLapStart = raceTime;
    return;
  }

  const lapTime = raceTime - racer.currentLapStart;
  racer.lapTimes.push(lapTime);
  if (lapTime < racer.bestLap) racer.bestLap = lapTime;
  racer.lapsCompleted += 1;
  racer.currentLapStart = raceTime;
  ctx.events.push({ type: 'lap', racer: racer.index, lap: racer.lapsCompleted, time: lapTime });

  if (racer.lapsCompleted >= track.laps) {
    racer.completed = true;
    racer.finished = true;
    racer.finishTime = raceTime;
  }
}

/**
 * A strictly increasing score used to sort the field. Checkpoints passed give
 * the coarse ordering; distance since the last one breaks ties. Because the
 * coarse term is multiplied by the full track length, a racer can never leap
 * ahead of someone with more checkpoints by driving fast.
 */
function updateProgressScore(racer: RacerState, track: Track): void {
  const since = clamp(track.forwardGap(racer.lastCheckpointDistance, racer.mainDistance), 0, track.length);
  racer.progress = racer.checkpointsPassed * track.length + since;
}

/**
 * Assigns 1-based live positions. Finished racers are ordered by finish time
 * and always sit ahead of anyone still running.
 */
export function updatePositions(racers: RacerState[]): void {
  const order = [...racers].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    return b.progress - a.progress;
  });
  order.forEach((racer, i) => {
    racer.position = i + 1;
  });
}

/** Current lap number for display: 1-based and clamped to the race length. */
export function displayLap(racer: RacerState, track: Track): number {
  return clamp(racer.lapsCompleted + 1, 1, track.laps);
}
