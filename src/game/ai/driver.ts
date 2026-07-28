import type { Rng } from '../../core/rng';
import { angleDelta, clamp, clamp01, distance, dot, fromHeading, heading as headingOf, lerp } from '../../core/math';
import type { Vec2 } from '../../core/math';
import { COMBAT, DRIFT, HOP, PHYSICS, RACE, SURGE, TOW } from '../config';
import type { Track } from '../track/buildTrack';
import { sampleAt } from '../track/buildTrack';
import { SURFACES } from '../track/types';
import type { Path, PathSample } from '../track/types';
import { canStartStrike, isInStrikeEnvelope } from '../sim/combat';
import type { ControlInput, RacerState } from '../sim/state';
import { emptyInput } from '../sim/state';

/**
 * Opponent driver.
 *
 * The AI drives with the same `ControlInput` the player produces and the same
 * physics — there is no separate "AI vehicle model". What difficulty changes
 * is how close to the limit it is willing to drive, how quickly it reacts, how
 * often it makes a mistake, and how readily it uses the companion. It never
 * gets extra grip, extra power, or knowledge of the player's inputs.
 *
 * Catch-up is applied by `simulation.ts`, bounded to ±3% engine scale, and is
 * symmetric across the field. That is small enough to be invisible frame to
 * frame and far too small to reel in a genuine mistake, which is the whole
 * point: the pack stays together without the player ever feeling cheated.
 */

export interface DifficultyProfile {
  id: string;
  label: string;
  description: string;
  /**
   * How much of the theoretical cornering limit the AI targets.
   *
   * Well below 1 even at Ace, and that is not timidity. The corner-speed model
   * reads curvature from the centreline, while the car actually drives an
   * offset line with a control lag, so the true limit for the path it takes is
   * lower than the number the model produces. Measured across all four
   * courses, targeting 0.86 of the limit is both dirtier *and slower* than
   * targeting 0.72 — the extra entry speed is paid back with interest in
   * corner exit. Difficulty separation comes from `pace`, `reaction` and
   * `mistakeRate` instead.
   */
  skill: number;
  /** Chance per second of a small, self-correcting mistake. */
  mistakeRate: number;
  /** Reaction delay applied to steering, seconds. */
  reaction: number;
  /** 0-1 willingness to use the companion strike. */
  aggression: number;
  /** 0-1 willingness to commit to a shortcut. */
  boldness: number;
  /** Fraction of available surge the AI is willing to hold in reserve. */
  surgeDiscipline: number;
  /**
   * Fraction of the skiff's straight-line pace the AI actually asks for.
   *
   * `skill` alone barely separates the levels, because it only scales the
   * cornering limit and corner speed goes as its square root — a 20% skill gap
   * turns into a 3% lap-time gap. This is the term that makes the three levels
   * feel like three different fields to race against. It never touches the
   * physics; it only lowers the AI's own speed target.
   */
  pace: number;
}

export const DIFFICULTIES: readonly DifficultyProfile[] = [
  {
    id: 'rookie',
    label: 'Rookie',
    description: 'Forgiving pace. The pack brakes early and rarely swings at you.',
    skill: 0.56,
    mistakeRate: 0.16,
    reaction: 0.24,
    aggression: 0.16,
    boldness: 0.25,
    surgeDiscipline: 0.45,
    pace: 0.80,
  },
  {
    id: 'pro',
    label: 'Pro',
    description: 'Committed lines, real overtakes, and they will use the pod arm.',
    skill: 0.64,
    mistakeRate: 0.07,
    reaction: 0.14,
    aggression: 0.45,
    boldness: 0.6,
    surgeDiscipline: 0.7,
    pace: 0.92,
  },
  {
    id: 'ace',
    label: 'Ace',
    description: 'Late braking, shortcut runs, and no free room on the inside.',
    skill: 0.72,
    mistakeRate: 0.025,
    reaction: 0.08,
    aggression: 0.72,
    boldness: 0.9,
    surgeDiscipline: 0.92,
    pace: 1.0,
  },
] as const;

export function getDifficulty(id: string): DifficultyProfile {
  return DIFFICULTIES.find((d) => d.id === id) ?? (DIFFICULTIES[1] as DifficultyProfile);
}

/**
 * Peak lateral acceleration a skiff can hold. Deliberately the same expression
 * the physics uses in `vehicle.ts`, so the AI's corner-speed predictions match
 * what the car will actually do rather than being a second, drifting model.
 */
function corneringLimit(racer: RacerState, surfaceGrip: number): number {
  return racer.spec.grip * PHYSICS.gripToLateralAccel * surfaceGrip;
}

/** Fastest speed that can hold a corner of the given curvature. */
function cornerSpeed(curvature: number, limit: number): number {
  const k = Math.abs(curvature);
  if (k < 1e-4) return Infinity;
  return Math.sqrt(limit / k);
}

/**
 * Looks ahead along a path, rolling over onto the main line when a branch runs
 * out.
 *
 * A shortcut is an open path, so `sampleAt` clamps at its end — which means for
 * the last lookahead-length of a branch the AI aims at a fixed point and then
 * sails straight past the exit onto the grass. Continuing onto the main line
 * past `exitMainDistance` is what makes rejoining as smooth as leaving.
 */
function sampleAhead(track: Track, path: Path, distance: number, ahead: number): PathSample {
  const target = distance + ahead;
  if (path.closed || target <= path.length) return sampleAt(path, target);
  return track.sampleMain(path.exitMainDistance + (target - path.length));
}

/**
 * Path-following gains. Exposed as one object because they are coupled: raising
 * the heading gain without lengthening the lookahead makes the controller
 * unstable, which shows up as the AI weaving off an open-edged course.
 */
export const AI_TUNING = {
  lookaheadSeconds: 1.1,
  headingGain: 2.2,
  crossTrackGain: 0.35,
};

export interface AiContext {
  track: Track;
  racers: RacerState[];
  dt: number;
  raceTime: number;
  rng: Rng;
  running: boolean;
}

/**
 * Produces the AI's control input for this step.
 * Pure with respect to the world: it only mutates `racer.ai`.
 */
export function driveAi(racer: RacerState, ctx: AiContext): ControlInput {
  const ai = racer.ai;
  const input = emptyInput();
  if (!ai) return input;

  ai.noisePhase += ctx.dt * 0.37;
  ai.strikeCooldown = Math.max(0, ai.strikeCooldown - ctx.dt);
  ai.mistakeTimer = Math.max(0, ai.mistakeTimer - ctx.dt);
  ai.overtakeTimer = Math.max(0, ai.overtakeTimer - ctx.dt);
  ai.driftHold = Math.max(0, ai.driftHold - ctx.dt);
  ai.boostHold = Math.max(0, ai.boostHold - ctx.dt);
  ai.defendTimer = Math.max(0, ai.defendTimer - ctx.dt);

  if (racer.finished) {
    // Keep rolling gently so finished cars clear the line rather than parking.
    input.throttle = 0.35;
    input.steer = steerTowardsLine(racer, ctx, ai.smoothedTargetLateral, 14);
    return input;
  }

  // --- recovery -----------------------------------------------------------
  if (updateRecovery(racer, ctx, input)) return input;


  const surfaceGrip = SURFACES[racer.surface].grip;
  const limit = corneringLimit(racer, surfaceGrip) * ai.skill;
  const speed = Math.hypot(racer.velocity.x, racer.velocity.z);

  // --- lateral target: racing line + personality + traffic -----------------
  const projection = ctx.track.project(racer.pos, racer.path);
  // Lookahead has to exceed the skiff's own minimum turning radius, or pure
  // pursuit demands a corner the car physically cannot take, saturates the
  // steering and oscillates itself off the road. At 33 m/s the grip-limited
  // radius is about 90 m, so roughly a second of travel is the floor.
  const lookaheadDistance = clamp(speed * AI_TUNING.lookaheadSeconds, 12, 46);
  const apexCurvature = averagedCurvature(ctx.track, racer.path, projection.distance, lookaheadDistance * 1.4);

  // Classic outside-in line: sit wide before a corner, tighten to the apex.
  const apexPull = clamp(-Math.sign(apexCurvature) * Math.min(1, Math.abs(apexCurvature) * 42), -1, 1);
  const wander = Math.sin(ai.noisePhase) * 0.18 + Math.sin(ai.noisePhase * 0.63 + 1.7) * 0.1;
  let targetLateral = (apexPull * 0.3 + ai.lineBias * 0.42 + wander) * projection.halfWidth * 0.7;

  const overtake = planOvertake(racer, ctx, projection.halfWidth);
  if (overtake !== null) targetLateral = overtake;

  /*
   * Cover the line the car behind is coming down.
   *
   * Attacking was already modelled and defending was not, so a rival being
   * caught simply carried on driving its own line and let the pass happen -
   * which is most of why the Ace field read as "the same race, faster". A
   * defence never outranks an overtake of the defender's own: doing both at
   * once puts a car in the middle of the road holding nobody up. See
   * `planDefence` for what keeps it a race move rather than blocking.
   */
  const defend = planDefence(racer, ctx, projection.halfWidth, Math.abs(apexCurvature));
  if (defend !== null && overtake === null) targetLateral = defend;

  // Aiming at a shortcut mouth outranks both the racing line and an overtake:
  // the window to make the split is short, and half-committing to it is the
  // worst of both. This has to be applied *after* the line is computed, or the
  // line logic simply overwrites it and the skiff sails past the entrance.
  const branchAim = chooseBranch(racer, ctx, projection.normal, projection.halfWidth);
  if (branchAim !== null) targetLateral = branchAim;

  // Edge pressure: the closer the skiff already is to an edge, the more the
  // target collapses towards the centre. Without this the AI happily aims at a
  // 0.9-width apex while it is already scraping the barrier, and on a walled
  // course like Emberfall Quarry that turns into a permanent grind.
  const edgePressure = clamp01((Math.abs(racer.lateral) - projection.halfWidth * 0.55) / (projection.halfWidth * 0.45));
  const edgeWeight = projection.edge === 'wall' ? 0.9 : 0.6;
  targetLateral = lerp(targetLateral, 0, edgePressure * edgeWeight);

  // Below about 16 m/s the steering barely bites, so asking for a lane change
  // saturates the controller and the car launches off the grid pointing at the
  // scenery. Ramping the target in from wherever the skiff actually is makes
  // the start clean and costs nothing once it is up to speed.
  const settle = clamp01(speed / 16);
  targetLateral = lerp(racer.lateral, targetLateral, settle);

  const lateralLimit = projection.halfWidth * (projection.edge === 'wall' ? 0.78 : 0.9);
  targetLateral = clamp(targetLateral, -lateralLimit, lateralLimit);
  ai.targetLateral = targetLateral;
  // Reaction delay is modelled as smoothing on the target, not a buffer, so it
  // costs nothing in memory and still makes low difficulties look unhurried.
  const responsiveness = 1 - Math.exp(-(ctx.dt / Math.max(0.02, ai.reaction)));
  ai.smoothedTargetLateral = lerp(ai.smoothedTargetLateral, targetLateral, responsiveness);

  input.steer = steerTowardsLine(racer, ctx, ai.smoothedTargetLateral, lookaheadDistance);

  // --- speed target: look ahead and brake for the tightest thing coming ----
  let targetSpeed = racer.spec.topSpeed * ai.pace;
  const scanSteps = 14;
  const scanRange = clamp(speed * speed * 0.034 + 26, 35, 190);
  for (let i = 1; i <= scanSteps; i++) {
    const ahead = (i / scanSteps) * scanRange;
    const sample = sampleAhead(ctx.track, racer.path, projection.distance, ahead);
    const allowed = cornerSpeed(sample.curvature, limit);
    if (!Number.isFinite(allowed)) continue;
    // How fast we may be *now* to still be at `allowed` in `ahead` metres.
    // Deliberately below the ~46 m/s² the brakes can actually produce. Planning
    // with the true figure means arriving at the limit exactly, with nothing
    // left for the mid-corner correction, which is how an AI ends up on the
    // grass at every tight corner.
    const brakeAccel = 21 * surfaceGrip * ai.skill;
    const permitted = Math.sqrt(Math.max(0, allowed * allowed + 2 * brakeAccel * ahead));
    targetSpeed = Math.min(targetSpeed, permitted);
  }
  const surfaceCap = racer.spec.topSpeed * SURFACES[racer.surface].speedCap * ai.pace;
  targetSpeed = Math.min(targetSpeed, surfaceCap);

  // Occasional honest mistakes: a beat of lifted throttle or a wide entry.
  if (ai.mistakeTimer <= 0 && ctx.running && ctx.rng.chance(ai.mistakeRate * ctx.dt)) {
    ai.mistakeTimer = ctx.rng.range(0.35, 0.9);
  }
  if (ai.mistakeTimer > 0) targetSpeed *= 0.82;

  ai.targetSpeed = targetSpeed;

  if (speed < targetSpeed - 0.5) {
    input.throttle = 1;
  } else if (speed > targetSpeed + 2.5) {
    input.throttle = 0;
    input.brake = true;
  } else {
    input.throttle = clamp01(0.35 + (targetSpeed - speed) * 0.4);
  }

  // Off-track, the binding constraint is the turn radius, not the pace: at the
  // grass speed cap a skiff's grip-limited radius is about the same as the
  // course's, so holding speed leaves it running parallel to the road forever.
  // Slowing down is what actually gets it back on.
  if (!racer.onTrack) {
    const recoverSpeed = Math.sqrt(corneringLimit(racer, surfaceGrip) * Math.max(8, projection.halfWidth * 2));
    if (speed > recoverSpeed) {
      input.throttle = 0;
      input.brake = true;
    } else {
      input.throttle = 0.75;
      input.brake = false;
    }
    input.drift = false;
  }

  // --- drift ---------------------------------------------------------------
  const cornerTightness = Math.abs(apexCurvature);
  // A crew that likes being sideways commits at a lower bar than one that does
  // not; the difficulty still decides whether it can carry the line.
  const canDrift = speed > DRIFT.minSpeed + 6 && racer.onTrack && ai.boldness * ai.style.drift > 0.45;
  if (canDrift && cornerTightness > 0.009 && Math.abs(input.steer) > 0.28) {
    // Commit for long enough to actually bank a charge tier. Reacting frame by
    // frame produces a stutter of half-second drifts that never reward
    // anything, which is why the AI used to bank no surge at all.
    ai.driftHold = Math.max(ai.driftHold, 1.7);
  }
  input.drift = canDrift && ai.driftHold > 0;

  // --- surge ---------------------------------------------------------------
  const straightAhead = Math.abs(averagedCurvature(ctx.track, racer.path, projection.distance, 55)) < 0.009;
  const behindSomeone = racer.position > 1;
  const surgeReady = racer.surge > SURGE.triggerThreshold + (1 - ai.surgeDiscipline) * 0.1;
  if (surgeReady && (straightAhead || (behindSomeone && racer.surge > 0.65)) && !racer.airborne && !input.drift) {
    ai.boostHold = Math.max(ai.boostHold, 1.2);
  }
  // Hysteresis, so the boost is one committed burst rather than a flicker that
  // restarts the audio and the exhaust flare many times a second.
  input.boost = ai.boostHold > 0 && racer.surge > 0.02 && !racer.airborne;

  // --- the tow -------------------------------------------------------------
  /*
   * Sitting in the wake charges a snap; pulling out spends it. A bold driver
   * holds the tow to the end of the straight and goes late, which is exactly
   * the decision the player faces. A timid one breaks early and wastes it.
   *
   * The AI does not get to see the charge value the player cannot: it reads
   * `towCharge` off its own car, which is the same number the player's HUD
   * shows.
   */
  if (racer.slipstreaming && racer.towCharge >= TOW.minCharge && ai.boldness > 0.3) {
    // Committing to the pull-out is the same manoeuvre as an overtake, so it
    // reuses the overtake timer rather than inventing a second lane-change
    // controller that would fight it.
    //
    // How long the crew is prepared to sit there first is the readable part:
    // an impatient one goes on the first usable charge, a patient one waits for
    // the tether to be nearly full. Bounded so nobody waits past what a tow can
    // actually give them.
    const corneringSoon = !straightAhead;
    const patience = clamp(0.72 * ai.style.towPatience, 0.5, 0.97);
    if (corneringSoon || racer.towCharge > patience) ai.overtakeTimer = Math.max(ai.overtakeTimer, 1.4);
  }

  // --- the hop -------------------------------------------------------------
  /*
   * Two uses, both defensive rather than clever: hop the last moment before a
   * crest so the landing is level, and hop out of a patch of spoil. A bolder
   * driver hops earlier and lands better.
   *
   * Deliberately *not* used to shave corners. An AI that hops constantly reads
   * as a bug, and the mechanic's value to the player is the timing, which an
   * opponent spamming it would devalue.
   */
  const crestAhead = surfaceDrop(ctx.track, racer.path, projection.distance, speed);
  input.hop = !racer.airborne && speed > HOP.minSpeed * 3 && crestAhead && ai.boldness > 0.4;

  // --- companion strike ----------------------------------------------------
  input.strike = planStrike(racer, ctx);

  return input;
}

/**
 * Steers towards a point on the current path offset laterally by `lateral`.
 *
 * Pure pursuit on its own leaves a standing lateral offset whenever the car is
 * already displaced — it happily runs parallel to the road, just beside it. The
 * explicit cross-track term is what actually pulls it back on, and the slip
 * term applies opposite lock so a slide is caught rather than amplified.
 */
function steerTowardsLine(racer: RacerState, ctx: AiContext, lateral: number, lookahead: number): number {
  const projection = ctx.track.project(racer.pos, racer.path);
  const target = sampleAhead(ctx.track, racer.path, projection.distance, lookahead);
  const point: Vec2 = {
    x: target.pos.x + target.normal.x * lateral,
    z: target.pos.z + target.normal.z * lateral,
  };
  const toTarget: Vec2 = { x: point.x - racer.pos.x, z: point.z - racer.pos.z };
  const desired = headingOf(toTarget);
  const error = angleDelta(racer.heading, desired);

  // Cross-track error, normalised by the corridor so a wide course tolerates a
  // wider excursion before the correction bites.
  const crossTrack = clamp((lateral - projection.lateral) / Math.max(4, projection.halfWidth), -1.5, 1.5);

  const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
  // Opposite lock. `slip` is positive when the skiff is sliding towards its own
  // right, which is the slide you catch by steering right.
  const damping = racer.slip * clamp01(speed / 30) * 0.55;

  /*
   * Positive steer turns right, and a positive heading error means the target
   * is to the right — so every term carries straight through with no negation.
   *
   * This used to be negated as a whole, which cancelled a matching sign error
   * in `stepVehicle` and left the AI driving correctly while the player steered
   * backwards. Both negations are gone; the AI's behaviour is unchanged.
   */
  return clamp(error * AI_TUNING.headingGain + crossTrack * AI_TUNING.crossTrackGain + damping, -1, 1);
}

/**
 * True when the surface is about to fall away sharply — a crest, in other
 * words, and the one moment a hop is worth spending.
 *
 * Measured over roughly a fifth of a second of travel, which is far enough
 * ahead to act on and near enough that it is still the same crest.
 */
function surfaceDrop(track: Track, path: Path, distance: number, speed: number): boolean {
  const span = Math.max(6, speed * 0.2);
  const here = sampleAhead(track, path, distance, 0).y;
  const soon = sampleAhead(track, path, distance, span).y;
  const later = sampleAhead(track, path, distance, span * 2).y;
  // Rising then falling is a crest; a steady descent is just a hill.
  return soon > here + 0.05 && later < soon - 0.35;
}

/** Mean curvature over a stretch of path, used for line and boost decisions. */
function averagedCurvature(track: Track, path: Path, from: number, span: number): number {
  const steps = 8;
  let sum = 0;
  for (let i = 1; i <= steps; i++) {
    sum += sampleAhead(track, path, from, (i / steps) * span).curvature;
  }
  return sum / steps;
}

/**
 * Picks a lateral offset that gets around the car ahead, or returns null to
 * leave the racing line alone. The AI only commits when there is genuinely
 * room, so it does not shove itself into walls chasing a gap.
 */
function planOvertake(racer: RacerState, ctx: AiContext, halfWidth: number): number | null {
  const ai = racer.ai;
  if (!ai) return null;

  if (ai.overtakeTimer > 0) return clamp(ai.overtakeSide * halfWidth * 0.72, -halfWidth * 0.9, halfWidth * 0.9);

  const forward = fromHeading(racer.heading);
  let closest: RacerState | null = null;
  let closestAhead = Infinity;

  for (const other of ctx.racers) {
    if (other.index === racer.index || other.finished) continue;
    const rel: Vec2 = { x: other.pos.x - racer.pos.x, z: other.pos.z - racer.pos.z };
    const ahead = dot(rel, forward);
    if (ahead < 2 || ahead > 24) continue;
    if (distance(racer.pos, other.pos) > 26) continue;
    if (Math.abs(other.y - racer.y) > 3) continue;
    if (ahead < closestAhead) {
      closestAhead = ahead;
      closest = other;
    }
  }
  if (!closest) return null;

  // Sit in the tow for a moment before pulling out, which reads as intent
  // rather than a lane change out of nowhere.
  if (closestAhead > 12 && racer.slipstreaming) return null;

  // Pick the side with more room between the rival and the edge.
  const leftRoom = halfWidth - closest.lateral;
  const rightRoom = halfWidth + closest.lateral;
  const side = leftRoom > rightRoom ? 1 : -1;
  const room = Math.max(leftRoom, rightRoom);
  // How much room the crew insists on before committing. A crew that will take
  // a gap that is not really there and one that wants the whole lane are the
  // two ends of the same decision, and it is one of the most visible.
  if (room < 3.2 * ai.style.room) return null;

  ai.overtakeSide = side;
  ai.overtakeTimer = ctx.rng.range(1.8, 3.4);
  return clamp(side * halfWidth * 0.72, -halfWidth * 0.9, halfWidth * 0.9);
}

/**
 * Covers the side a challenger is coming down, or returns null to leave the
 * racing line alone.
 *
 * The tactical half of the difficulty ladder. Everything else the AI does
 * treats the cars behind as scenery, which is why an Ace field read as a Pro
 * field with more pace: it never denied anybody anything. A defence here is one
 * committed move to the challenger's side, held for a beat so the player has to
 * do something about it, and abandoned as soon as the challenger is no longer
 * there.
 *
 * Four bounds keep it from becoming blocking, and the first two are what stop
 * it costing races rather than winning them.
 *
 * It only defends on a *straight*. Covering a line into a corner is what a
 * driver does; swinging across the road mid-corner is what a driver who has
 * stopped racing does, and the first version of this did exactly that - it cost
 * a second a lap and produced sustained body angles the F4 bound is there to
 * prevent. It is also a *shift* from wherever the defender already is rather
 * than a jump to a fixed offset, so it is a lane change and not a lunge.
 *
 * Then: it only ever moves towards the side already being attacked, never past
 * two thirds of the corridor, and never while the defender is mid-overtake of
 * its own, because a car doing both at once simply drives into the middle and
 * holds nobody up.
 */
function planDefence(racer: RacerState, ctx: AiContext, halfWidth: number, curvature: number): number | null {
  const ai = racer.ai;
  if (!ai || ai.defence < 0.35) return null;
  // Anything the racing line has an opinion about belongs to the racing line.
  if (curvature > 0.006) {
    ai.defendTimer = 0;
    return null;
  }

  const cover = (side: number): number =>
    clamp(racer.lateral + side * halfWidth * 0.34, -halfWidth * 0.66, halfWidth * 0.66);

  if (ai.defendTimer > 0) return cover(ai.defendSide);

  const forward = fromHeading(racer.heading);
  for (const other of ctx.racers) {
    if (other.index === racer.index || other.finished) continue;
    if (other.path.id !== racer.path.id) continue;
    const rel: Vec2 = { x: other.pos.x - racer.pos.x, z: other.pos.z - racer.pos.z };
    const behind = -dot(rel, forward);
    // Close enough to be a threat, far enough back that this is not contact.
    if (behind < 2.5 || behind > 16) continue;
    if (distance(racer.pos, other.pos) > 20) continue;
    if (Math.abs(other.y - racer.y) > 3) continue;
    // Only a challenger who is actually catching. Someone matched on pace is
    // not attacking, and covering them wastes the whole move.
    const closing = dot({ x: other.velocity.x - racer.velocity.x, z: other.velocity.z - racer.velocity.z }, forward);
    if (closing < 1.5) continue;

    // The side they have committed to, which is where the door has to shut.
    const side = Math.sign(other.lateral - racer.lateral);
    if (side === 0) continue;
    ai.defendSide = side;
    // A Rookie's cover is a token gesture; an Ace holds it. The difficulty term
    // is the whole difference in how long the door stays shut.
    ai.defendTimer = ctx.rng.range(0.5, 0.9) * (0.5 + ai.defence);
    return cover(side);
  }
  return null;
}

/**
 * Decides whether to swing the pod arm. The AI plays by the same rules the
 * player does and adds two courtesies of its own: it will not hit a rival who
 * is already staggered, and it will not gang up during the opening seconds.
 */
function planStrike(racer: RacerState, ctx: AiContext): -1 | 0 | 1 {
  const ai = racer.ai;
  if (!ai || ai.strikeCooldown > 0) return 0;
  if (!canStartStrike(racer, ctx.raceTime)) return 0;

  for (const side of [-1, 1] as const) {
    for (const other of ctx.racers) {
      if (other.index === racer.index || other.finished) continue;
      // Do not kick someone who is already down.
      if (other.stagger > 0) continue;
      if (!isInStrikeEnvelope(racer, other, side)) continue;
      // Aggression is a per-second probability, so it does not depend on the
      // step rate and stays comparable between difficulty levels.
      if (!ctx.rng.chance(ai.aggression * 3.2 * ctx.dt)) continue;
      ai.strikeCooldown = COMBAT.cooldown + ctx.rng.range(0.1, 0.7) * (1 - ai.aggression);
      return side;
    }
  }
  return 0;
}

/**
 * Shortcut selection.
 *
 * The AI evaluates a branch once per lap as it approaches the entry, and
 * commits. Boldness decides how often it takes the risk; skill decides whether
 * it can actually carry the line through. Returns the lateral offset to aim at
 * while lining up the mouth, or null to leave the racing line alone.
 */
function chooseBranch(racer: RacerState, ctx: AiContext, normal: Vec2, halfWidth: number): number | null {
  const ai = racer.ai;
  if (!ai) return null;
  const track = ctx.track;
  if (track.branches.length === 0) return null;

  // Once on a branch, ride it out; `project` keeps the skiff latched to the
  // branch corridor and the ordinary line-following handles the rest.
  if (racer.path.id !== 'main') {
    ai.branchChoice = racer.path.id;
    return null;
  }

  for (const branch of track.branches) {
    const gap = track.forwardGap(racer.mainDistance, branch.entryMainDistance);

    // Clear the "already decided" latch once well clear of the split, so the
    // choice is made afresh on every lap. Without this an opponent decides once
    // on lap one and is committed for the whole race, which makes a bold field
    // and a cautious one take a shortcut exactly as often as each other.
    if (gap > 90 || gap < -60) {
      if (ai.branchDecidedAt === branch.entryMainDistance) ai.branchDecidedAt = -1;
      continue;
    }

    // Decide in the window 55-25 m before the split.
    if (gap <= 55 && gap >= 25 && ai.branchDecidedAt !== branch.entryMainDistance) {
      ai.branchDecidedAt = branch.entryMainDistance;
      /*
       * Choose by predicted route time, then by nerve — in that order.
       *
       * Boldness alone made the decision a dice roll on a *distance* saving,
       * which is not the same thing as a time saving: a shortcut that is 48 m
       * shorter but narrower, walled and on dirt can be slower for a car
       * travelling fast enough. Measured across seeds, the boldest difficulty
       * was finishing the technical course *behind* the middle one for exactly
       * this reason, which inverts the whole ladder.
       *
       * Boldness now decides how thin a predicted margin the driver will accept
       * — an Ace will take a cut that barely pays, a Rookie wants it obvious —
       * and a route that is predicted to be slower is never taken by anyone.
       */
      /*
       * Take it when it is worth taking, and let nerve set how thin a margin
       * counts as worth it.
       *
       * This used to be a bare dice roll against boldness, which the comment
       * above already described as something better than it was. Two
       * consequences, both measured: a branch that was *strictly slower* was
       * still taken by every crew in the field — Glasshouse's Rootway tore
       * whole races apart that way — and the difficulty ordering the suite
       * asserts was not real, a census over eight seeds reading 10 / 13 / 11
       * for Rookie / Pro / Ace.
       *
       * `branch.idealGain` is the seconds the route actually saves, measured at
       * build time with each metre's surface speed cap. A route that loses time
       * is now never chosen by anyone at any difficulty, and a bold driver
       * accepts a thinner margin than a cautious one — which makes the ordering
       * a property of the design rather than of the seed.
       */
      const margin = lerp(RACE.branchMarginCautious, RACE.branchMarginBold, ai.boldness);
      ai.branchChoice = branch.idealGain >= margin ? branch.id : null;
    }
  }

  if (!ai.branchChoice) return null;
  const branch = track.branches.find((b) => b.id === ai.branchChoice);
  if (!branch) return null;

  const gap = track.forwardGap(racer.mainDistance, branch.entryMainDistance);
  if (gap < -25) {
    // Missed it. Give up rather than turning back across the road.
    ai.branchChoice = null;
    return null;
  }
  if (gap > 60) return null;

  /*
   * Aim past the merge, not at the mouth.
   *
   * A branch now eases away from the main line over its first third so it
   * leaves tangentially, which means the first stretch of it *is* the main
   * line. Aiming eighteen metres in therefore aimed at the road the AI was
   * already on, it never steered towards the cut, and it stopped taking
   * shortcuts entirely. The aim point has to be far enough in to be somewhere
   * the main line is not.
   */
  /*
   * And be willing to leave the road to do it.
   *
   * The aim used to be clamped inside the main corridor, which quietly made
   * branch entry impossible: a racer is handed to the corridor that *contains*
   * it, so a driver that never steers past the road edge is never on the
   * branch, and the AI stopped taking shortcuts entirely. Crossing the edge is
   * not a mistake here — it is the manoeuvre.
   *
   * The bound is the run-off rather than the road, so a committed driver can
   * reach a mouth that has already diverged, and still cannot aim at something
   * halfway across the scenery.
   */
  const mouth = sampleAt(branch, branch.length * 0.45);
  const toMouth: Vec2 = { x: mouth.pos.x - racer.pos.x, z: mouth.pos.z - racer.pos.z };
  const reach = halfWidth + PHYSICS.offTrackMargin * 0.6;
  return clamp(dot(toMouth, normal), -reach, reach);
}

/**
 * Unsticks a wedged AI. Reversing away from whatever it is buried in and then
 * realigning with the track is enough for every case the courses can produce,
 * and `tests/unit/ai.test.ts` asserts that no AI ever fails to finish.
 */
function updateRecovery(racer: RacerState, ctx: AiContext, input: ControlInput): boolean {
  const ai = racer.ai;
  if (!ai) return false;
  const speed = Math.hypot(racer.velocity.x, racer.velocity.z);

  // The wedge timer is owned by the simulation and is never cleared by these
  // manoeuvres, so a car that cannot free itself still respawns rather than
  // cycling reverse/realign forever.
  if (racer.wedgeTimer > RACE.respawnTime) {
    ai.recovery = 'none';
    ai.recoveryTimer = 0;
    return false;
  }

  if (ai.recovery === 'none') {
    if (ctx.running && speed < RACE.stuckSpeed && !racer.airborne) {
      racer.stuckTimer += ctx.dt;
      if (racer.stuckTimer > RACE.stuckTime) {
        ai.recovery = 'reverse';
        ai.recoveryTimer = 0.9;
        racer.stuckTimer = 0;
      }
    } else {
      racer.stuckTimer = 0;
    }

    // A racer facing backwards is not stuck but is definitely lost; steer it
    // round without the full reverse manoeuvre.
    const projection = ctx.track.project(racer.pos, racer.path);
    const alignment = dot(fromHeading(racer.heading), projection.tangent);
    if (alignment < -0.25) {
      racer.wrongWayTimer += ctx.dt;
      if (racer.wrongWayTimer > RACE.wrongWayTime) {
        ai.recovery = 'realign';
        ai.recoveryTimer = 1.6;
        racer.wrongWayTimer = 0;
      }
    } else {
      racer.wrongWayTimer = 0;
    }
    return false;
  }

  ai.recoveryTimer -= ctx.dt;

  if (ai.recovery === 'reverse') {
    input.brake = true;
    input.throttle = 0;
    // `lateral` is positive to the right of the centreline, and reversing swings
    // the nose the opposite way — so back out towards the middle of the road.
    input.steer = racer.lateral > 0 ? -0.6 : 0.6;
    if (ai.recoveryTimer <= 0) {
      ai.recovery = 'realign';
      ai.recoveryTimer = 1.4;
    }
    return true;
  }

  // realign
  const projection = ctx.track.project(racer.pos, racer.path);
  const desired = headingOf(projection.tangent);
  const error = angleDelta(racer.heading, desired);
  input.steer = clamp(error * 2.2, -1, 1);
  input.throttle = 0.7;
  if (ai.recoveryTimer <= 0 || (Math.abs(error) < 0.35 && speed > RACE.stuckSpeed * 2)) {
    ai.recovery = 'none';
    racer.stuckTimer = 0;
  }
  return true;
}
