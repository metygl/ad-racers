import type { Rng } from '../../core/rng';
import { clamp, clamp01, damp, dot, fromHeading, moveTowards, rightOf, wrapAngle } from '../../core/math';
import { COLLISION, COMBAT, DRIFT, HOP, LANDING, PHYSICS, RECOVERY, SURGE } from '../config';
import type { Track } from '../track/buildTrack';
import { sampleAt } from '../track/buildTrack';
import { SURFACES } from '../track/types';
import type { Path, SurfaceId } from '../track/types';
import type { ControlInput, RacerState, SimEvent } from './state';

export interface VehicleStepContext {
  track: Track;
  dt: number;
  raceTime: number;
  events: SimEvent[];
  rng: Rng;
  offTrackSurface: SurfaceId;
  /**
   * Bounded catch-up multiplier applied to engine force and top speed. The
   * simulation guarantees this stays inside ±`CATCHUP_LIMIT`; see
   * `simulation.ts` and `tests/unit/fairness.test.ts`.
   */
  engineScale: number;
  /** Racing has started; before this the vehicles are held on the grid. */
  running: boolean;
}

/**
 * Steering authority against speed. Zero at a standstill (a parked skiff
 * cannot pivot), peaking at `steeringPeakSpeed`, then tapering so that
 * flat-out sections stay stable instead of twitchy.
 */
function steeringCurve(speed: number, topSpeed: number): number {
  const rise = clamp01(speed / PHYSICS.steeringPeakSpeed);
  const over = clamp01((speed - PHYSICS.steeringPeakSpeed) / Math.max(1, topSpeed - PHYSICS.steeringPeakSpeed));
  return rise * (1 - PHYSICS.steeringHighSpeedFalloff * over);
}

/** Half-width of the stencil used to measure the surface profile, in metres. */
const PROFILE_SPAN = 6;

/**
 * Local vertical profile of the surface: its slope (dy/ds) and how sharply
 * that slope is changing (d²y/ds²). The second term is what decides whether a
 * crest launches the skiff.
 */
function surfaceProfile(path: Path, distance: number, groundY: number): { slope: number; curvature: number } {
  const ahead = sampleAt(path, distance + PROFILE_SPAN).y;
  const behind = sampleAt(path, distance - PROFILE_SPAN).y;
  return {
    slope: (ahead - behind) / (2 * PROFILE_SPAN),
    curvature: (ahead - 2 * groundY + behind) / (PROFILE_SPAN * PROFILE_SPAN),
  };
}

/**
 * Advances one vehicle by a single fixed step.
 *
 * Deliberately free of any renderer or DOM dependency: this runs unchanged
 * inside Node for the headless race tests.
 */
export function stepVehicle(racer: RacerState, input: ControlInput, ctx: VehicleStepContext): void {
  const { dt } = ctx;
  const spec = racer.spec;

  // --- timers -------------------------------------------------------------
  racer.stagger = Math.max(0, racer.stagger - dt);
  racer.contactCooldown = Math.max(0, racer.contactCooldown - dt);
  racer.strike.cooldown = Math.max(0, racer.strike.cooldown - dt);
  racer.hopCooldown = Math.max(0, racer.hopCooldown - dt);
  racer.wallImpactLock = Math.max(0, racer.wallImpactLock - dt);
  racer.recoveryBoost = Math.max(0, racer.recoveryBoost - dt);
  racer.recoveryCooldown = Math.max(0, racer.recoveryCooldown - dt);
  racer.sinceLanding += dt;
  racer.airTime = racer.airborne ? racer.airTime + dt : 0;
  for (const guard of racer.guards) guard.timer -= dt;
  if (racer.guards.some((g) => g.timer <= 0)) {
    racer.guards = racer.guards.filter((g) => g.timer > 0);
  }

  // --- where are we on the track -----------------------------------------
  const projection = ctx.track.project(racer.pos, racer.path);
  racer.path = projection.path;
  racer.lateral = projection.lateral;
  racer.currentHalfWidth = projection.halfWidth;
  racer.previousMainDistance = racer.mainDistance;
  racer.mainDistance = projection.mainDistance;
  const insideCorridor = Math.abs(projection.lateral) <= projection.halfWidth;
  racer.onTrack = insideCorridor;
  const surface: SurfaceId = insideCorridor ? projection.surface : ctx.offTrackSurface;
  if (surface !== racer.surface) {
    racer.surface = surface;
    ctx.events.push({ type: 'surfaceChange', racer: racer.index, surface });
  }
  const surf = SURFACES[surface];

  // --- basis and velocity split -------------------------------------------
  const forward = fromHeading(racer.heading);
  const right = rightOf(racer.heading);
  let vLong = dot(racer.velocity, forward);
  // Positive `vLat` is a slide towards the vehicle's right. See the handedness
  // rule in `core/math.ts`.
  let vLat = dot(racer.velocity, right);

  // --- hop ----------------------------------------------------------------
  // Its own input, never shared with drift. See `HOP` in `config.ts`.
  if (input.hop && !racer.airborne && racer.hopCooldown <= 0 && ctx.running && vLong > HOP.minSpeed) {
    racer.airborne = true;
    racer.verticalVelocity = HOP.impulse;
    racer.hopCooldown = HOP.cooldown;
    racer.airTime = 0;
    racer.airClearance = 0;
    racer.airGroundStart = ctx.track.project(racer.pos, racer.path).y;
    racer.airGroundDrop = 0;
    // Hops in quick succession are a chain, and a chain pays less each time.
    racer.hopChain = racer.sinceLanding <= HOP.chainWindow ? racer.hopChain + 1 : 0;
    vLong = Math.max(0, vLong - HOP.speedCost);
    ctx.events.push({ type: 'hop', racer: racer.index });
  }

  // --- drift --------------------------------------------------------------
  const wantsDrift = input.drift && vLong > DRIFT.minSpeed && !racer.airborne;
  if (wantsDrift && !racer.drift.active) {
    racer.drift.active = true;
    racer.drift.direction = Math.abs(input.steer) > 0.15 ? Math.sign(input.steer) : Math.sign(vLat) || 1;
    // Hop, land, and go straight into a slide: the charge head start is the
    // reward for the timing. Small on purpose — it recognises the gesture, it
    // does not pay for the corner.
    racer.drift.charge = racer.sinceLanding <= HOP.landingWindow ? HOP.landingDriftCharge : 0;
  }
  if (racer.drift.active && (!input.drift || vLong < DRIFT.minSpeed * 0.6)) {
    releaseDrift(racer, ctx);
  }

  const drifting = racer.drift.active;
  const staggered = racer.stagger > 0;

  // --- longitudinal -------------------------------------------------------
  const boostCap = racer.boosting ? SURGE.speedMultiplier : 1;
  const topSpeed = spec.topSpeed * surf.speedCap * boostCap * ctx.engineScale;
  const falloffRef = topSpeed * PHYSICS.powerFalloffHeadroom;

  let accel = 0;
  if (ctx.running && !racer.airborne) {
    if (input.throttle > 0 && vLong < topSpeed) {
      const ratio = clamp01(Math.max(0, vLong) / falloffRef);
      const curve = 1 - Math.pow(ratio, PHYSICS.powerFalloff);
      const assist = racer.recoveryBoost > 0 ? RECOVERY.forceMultiplier : 1;
      accel +=
        spec.enginePower *
        ctx.engineScale *
        input.throttle *
        curve *
        assist *
        (racer.boosting ? SURGE.forceMultiplier : 1);
    }
    if (input.brake) {
      if (vLong > 0.4) {
        accel -= PHYSICS.brakeForce * surf.grip;
      } else if (vLong > -PHYSICS.reverseMaxSpeed) {
        accel -= PHYSICS.reverseForce;
      }
    }
  }

  // Resistances always apply, including in the air (thin as that is).
  const dragRelief = racer.slipstreaming ? 1 - SURGE.slipstreamDragRelief : 1;
  accel -= PHYSICS.dragCoefficient * vLong * Math.abs(vLong) * dragRelief;
  accel -= PHYSICS.rollingResistance * vLong * surf.drag;

  vLong += accel * dt;
  // Hard cap so a skiff's advertised top speed is exactly what it reaches.
  if (vLong > topSpeed) vLong = Math.max(topSpeed, vLong - 40 * dt);
  if (vLong < -PHYSICS.reverseMaxSpeed) vLong = -PHYSICS.reverseMaxSpeed;

  // Rebuild the world-space velocity in the *current* basis before rotating.
  // The heading change below must not drag the velocity vector round with it —
  // the gap between where the skiff points and where it is going is the slip
  // angle, and the slip angle is the drift.
  {
    const f = fromHeading(racer.heading);
    const l = rightOf(racer.heading);
    racer.velocity = { x: f.x * vLong + l.x * vLat, z: f.z * vLong + l.z * vLat };
  }

  // --- steering -----------------------------------------------------------
  /*
   * The physics command is *not* the smoothed thing the chassis leans by.
   *
   * Filtering the command made a 600 ms tap still hold 0.44 of lock a quarter
   * of a second after release, and left rapid countersteer hovering near zero —
   * so catching a slide was impossible and the practical technique became
   * holding full lock. Response is now fast, and faster still when the driver
   * is reversing the wheel or returning to centre, because those are the two
   * moments where lag is a mistake. The renderer smooths the *pose*.
   */
  const targetSteer = clamp(input.steer, -1, 1);
  const opposing = targetSteer * racer.steer < 0;
  const centring = Math.abs(targetSteer) < Math.abs(racer.steer);
  const response =
    PHYSICS.steerResponse *
    (opposing ? PHYSICS.steerReversalGain : centring ? PHYSICS.steerReleaseGain : 1);
  racer.steer = damp(racer.steer, targetSteer, response, dt);

  // Steering and the grip cap both key off the true speed, not the component
  // along the nose. Using `vLong` makes the yaw cap *loosen* as the skiff slides
  // (because `vLong` shrinks), which turns any slide into a spin.
  const speed = Math.hypot(vLong, vLat);

  let authority = steeringCurve(speed, spec.topSpeed);
  if (staggered) authority *= COMBAT.staggerSteering;
  if (racer.airborne) authority *= PHYSICS.airborneSteering;
  const steerYawRate = PHYSICS.maxYawRate * authority * (drifting ? DRIFT.yawMultiplier : 1) * (drifting ? 1 : surf.grip);

  // Grip cap: a corner cannot be taken faster than the tyres can pull the
  // skiff round it. `latAccelMax / v` is the tightest yaw the surface allows,
  // and it is what makes braking for a corner worth doing.
  //
  // Trail braking lifts the cap a little while the brakes are on at speed: load
  // transfers onto the nose and it bites. It is what makes the brake a
  // *steering* input as well as a speed one, so corner entry stays a continuous
  // decision rather than a single yes-or-no.
  const trailBraking = input.brake && vLong > DRIFT.minSpeed ? 1 + PHYSICS.brakeTurnBonus : 1;
  const latAccelMax =
    spec.grip *
    PHYSICS.gripToLateralAccel *
    surf.grip *
    trailBraking *
    (drifting ? PHYSICS.driftYawLimitBonus : 1);
  const gripYawLimit = latAccelMax / Math.max(6, speed);
  let yawRate = Math.min(steerYawRate, gripYawLimit);

  /*
   * In the air there is no grip cap at all — nothing is touching the ground, so
   * nothing limits how fast the skiff can be pointed. Air steering is therefore
   * `steerYawRate` alone, which the airborne authority term has already scaled.
   * Capping it by grip is what made the earlier build's crests feel like a coin
   * flip: the cap tightens with speed, and a crest is taken at speed.
   */
  if (racer.airborne) yawRate = steerYawRate;

  /*
   * Positive steer turns right, and a turn to the right *increases* the heading
   * in this basis — see the handedness rule in `core/math.ts`. There is no
   * negation here and there must never be one: an earlier version had it, which
   * is precisely how the player's steering ended up mirrored.
   *
   * Reversing flips the sign, because the nose swings the other way when the
   * car is travelling backwards, exactly as it does in a real vehicle.
   */
  const yaw = racer.steer * yawRate * (vLong < 0 ? -1 : 1);

  /*
   * A hard bound on how far the body may be crossed up.
   *
   * The lateral-grip model below already gives a slide a stable equilibrium,
   * but "stable" and "bounded" are not the same thing: with enough steering
   * authority and a low-grip surface the equilibrium sits past 50°, and the
   * motion review's F4 finding is what that looks like — a machine sustaining
   * an angle no driver would hold, with the nose pointing somewhere the skiff
   * is never going to go. It reads as broken rather than as spectacular, and it
   * is the one part of a drift a player cannot learn to read.
   *
   * Past the bound, the attitude jets pull the nose back towards the direction
   * of travel, proportionally to the excess. This never fights a *transient* —
   * a flick, a landing, a hit still cross the body up freely — it only stops
   * the angle being *held* there, which is exactly the distinction F4 draws.
   *
   * The angle it reads is `racer.slip` — last step's *settled* value, measured
   * after grip has bled the slide off. The instantaneous pre-grip angle is a
   * different and much larger number, because within a step the body rotates
   * before the tyres get a chance to pull the velocity round with it; bounding
   * that one bounds a transient every corner produces, which is how the first
   * version of this cost the Ace field a second a lap on the salt without ever
   * catching a genuinely unreadable angle.
   */
  const overAngle = Math.abs(racer.slip) - PHYSICS.bodyAngleMax;
  const correction =
    overAngle > 0 && !racer.airborne ? -Math.sign(racer.slip) * overAngle * PHYSICS.bodyAngleRecovery : 0;

  racer.heading = wrapAngle(racer.heading + (yaw + correction) * dt);

  // --- lateral grip -------------------------------------------------------
  // Re-project the (unchanged) world velocity onto the new, rotated basis. Any
  // lateral component that appears is the skiff sliding, and grip bleeds it off
  // over time rather than instantly.
  const newForward = fromHeading(racer.heading);
  const newRight = rightOf(racer.heading);
  vLong = dot(racer.velocity, newForward);
  vLat = dot(racer.velocity, newRight);

  let grip = spec.grip * surf.grip;
  if (drifting) grip *= DRIFT.gripMultiplier;
  if (staggered) grip *= COMBAT.staggerGrip;
  // Airborne there is nothing to grip, so the slide is not bled off — but the
  // skiff's own attitude jets ease the nose back towards the direction of
  // travel, which is what makes a clean landing a skill rather than a lottery.
  if (racer.airborne) grip = PHYSICS.airborneAlign;

  // Tyre curve past the peak: beyond the slip angle the surface is happy to
  // hold, grip climbs steeply. That gives the slide a stable equilibrium
  // instead of letting it run away into a spin, and it is what makes a drift
  // something you hold rather than something that happens to you.
  const slipAngle = Math.atan2(vLat, Math.max(1, Math.abs(vLong)));
  const peak = drifting ? PHYSICS.driftPeakSlipAngle : PHYSICS.peakSlipAngle;
  const excess = Math.max(0, Math.abs(slipAngle) - peak);
  grip *= 1 + excess * PHYSICS.slipRecoveryGain;

  vLat *= Math.exp(-grip * dt);

  // Sliding sideways scrubs speed. Without this a drift is strictly better than
  // a clean line, and the whole risk/reward of the mechanic disappears.
  if (drifting) vLong -= Math.abs(vLat) * PHYSICS.driftScrub * dt;

  racer.slip = Math.atan2(vLat, Math.max(1, Math.abs(vLong)));

  // --- drift charge -------------------------------------------------------
  if (drifting) {
    /*
     * Charge is payment for solving a corner, so it requires all three parts of
     * having solved one: being on the road, carrying pace, and holding a real
     * slide. Off the corridor it does not merely stop accruing — it bleeds.
     *
     * Before this gate, holding drift out on the grass filled the tier ladder
     * to maximum at 9 m/s and paid 0.57 Surge. That is a completely reliable
     * way to fill the primary speed resource without ever taking a corner,
     * which makes the tiers, the racing line and the risk/reward cosmetic.
     */
    const slipping = clamp01((Math.abs(racer.slip) - DRIFT.minChargeSlip) / (0.28 - DRIFT.minChargeSlip));
    const fast = clamp01((vLong - DRIFT.minChargeSpeed) / 12);
    const productive = racer.onTrack ? slipping * fast : 0;
    const decay = racer.onTrack
      ? (productive < 0.3 ? DRIFT.chargeDecay * (0.3 - productive) : 0)
      : DRIFT.offTrackDecay;
    racer.drift.charge = clamp01(racer.drift.charge + DRIFT.chargeRate * productive * dt - decay * dt);
  }

  // --- boost --------------------------------------------------------------
  if (input.boost && !racer.boosting && racer.surge >= SURGE.triggerThreshold && ctx.running) {
    racer.boosting = true;
    ctx.events.push({ type: 'boostStart', racer: racer.index });
  }
  if (racer.boosting) {
    racer.surge = Math.max(0, racer.surge - SURGE.drain * dt);
    if (racer.surge <= 0 || !input.boost) racer.boosting = false;
  }

  // --- reassemble world velocity -----------------------------------------
  racer.velocity = {
    x: newForward.x * vLong + newRight.x * vLat,
    z: newForward.z * vLong + newRight.z * vLat,
  };

  // --- vertical -----------------------------------------------------------
  const groundY = projection.y;
  if (racer.airborne) {
    racer.verticalVelocity -= PHYSICS.gravity * dt;
    racer.y += racer.verticalVelocity * dt;
    /*
     * Peak clearance, not peak height.
     *
     * A crest launches the skiff because the *ground* falls away, so its
     * absolute height usually goes down through the whole flight — measuring a
     * rise above the take-off point scores every crest at zero and every flat
     * hop above it. Clearance is the honest discriminator: a hop reaches about
     * 0.9 m by construction, and a crest reaches several.
     */
    racer.airClearance = Math.max(racer.airClearance, racer.y - projection.y);
    /*
     * How far the *ground* fell away underneath, which is what makes air a
     * crest rather than a pogo.
     */
    racer.airGroundDrop = Math.max(racer.airGroundDrop, racer.airGroundStart - projection.y);
    if (racer.y <= groundY) {
      const impact = -racer.verticalVelocity;
      // Captured before the reset below: both are the flight that just ended.
      const airTime = racer.airTime;
      const peakClearance = racer.airClearance;
      const crestDrop = racer.airGroundDrop;
      racer.y = groundY;
      racer.verticalVelocity = 0;
      racer.airborne = false;
      racer.airTime = 0;
      racer.airClearance = 0;
      racer.sinceLanding = 0;
      const clean = impact <= PHYSICS.cleanLandingSpeed;

      /*
       * Landing quality: how level, and how straight.
       *
       * This is the payoff beat that makes air time a skill rather than
       * something that happens to you. Both halves matter — arriving gently but
       * sideways scores nothing, and so does arriving straight but hard — and a
       * hop off a flat road is excluded by the air-time floor so the mechanic
       * cannot be farmed on a straight.
       */
      /*
       * Levelness is measured from the *clean* landing speed, not from zero. A
       * crest that gives real air necessarily lands at several metres a second,
       * so scoring against zero capped even a perfect flyover landing at about
       * a third and made the whole reward unreachable by driving well.
       */
      const levelness = 1 - clamp01((impact - PHYSICS.cleanLandingSpeed) / 14);
      const alignment = 1 - clamp01((Math.abs(racer.slip) - LANDING.alignedSlip) / (LANDING.sloppySlip - LANDING.alignedSlip));
      /*
       * Landing on the track's line, not merely straight relative to your own
       * velocity — a skiff can be perfectly aligned with where it is going and
       * still be going somewhere the road is not.
       */
      const tangentHeading = Math.atan2(projection.tangent.z, projection.tangent.x);
      const offLine = Math.abs(wrapAngle(racer.heading - tangentHeading));
      const onLine = 1 - clamp01((offLine - LANDING.alignedToTrack) / LANDING.alignedToTrack);
      /*
       * A landing pays for taking a *crest* well. Air time alone never gated
       * the flat-hop farm, because an ordinary hop clears half a second; the
       * rise requirement is what distinguishes a crest from a pogo, and the
       * chain decay is what stops the second, third and fourth hop paying like
       * the first.
       */
      /*
       * And the ground has to have fallen away.
       *
       * Clearance alone does not distinguish a crest from a pogo: the hop
       * impulse on its own reaches the clearance threshold on flat tarmac, so
       * a review banked 0.118 Surge — nearly half an activation — from three
       * taps on a straight, with no crest, no obstacle and nothing to read.
       * The optimal resource loop should not be mashing a button on a straight.
       *
       * Measuring the *road's* drop between take-off and the lowest point
       * underneath the skiff is what separates them, and it does it without
       * caring how the air started: hopping to extend a real crest still pays,
       * because the ground still falls away. Flat hops pay nothing at all, at
       * any point in a chain, so the exploit cannot be slowed down into a farm.
       */
      const eligible =
        airTime >= LANDING.minAirTime &&
        peakClearance >= LANDING.minClearance &&
        crestDrop >= LANDING.minCrestDrop &&
        racer.onTrack &&
        Math.hypot(vLong, vLat) >= LANDING.minSpeed;
      const chainScale = 1 / (1 + racer.hopChain * HOP.chainDecay);
      const quality = eligible ? levelness * alignment * onLine * chainScale : 0;

      /*
       * Landing quality is the *only* landing reward.
       *
       * A separate flat "clean landing" bonus survived every other gate: ten
       * ordinary hops down a straight paid it ten times and banked 0.9 Surge in
       * six seconds. If a landing is not worth scoring it is not worth paying.
       */
      if (quality > 0) {
        racer.surge = Math.min(SURGE.max, racer.surge + LANDING.perfectSurge * quality);
        vLong += LANDING.perfectImpulse * quality;
      }
      if (!clean) {
        const loss = clamp01((impact - PHYSICS.cleanLandingSpeed) / 18);
        vLong *= 1 - loss * 0.28;
      }
      racer.velocity = {
        x: newForward.x * vLong + newRight.x * vLat,
        z: newForward.z * vLong + newRight.z * vLat,
      };
      ctx.events.push({
        type: 'jumpLand',
        racer: racer.index,
        clean,
        speed: impact,
        quality,
        airTime,
        clearance: peakClearance,
      });
    }
  } else {
    /*
     * Following the ground over a crest needs a downward acceleration of
     * `d²y/ds² · v²`. Once that exceeds what gravity and the suspension can
     * supply, the skiff simply carries on in a straight line — which is what
     * being airborne is.
     *
     * Comparing predicted heights one step apart instead, as an earlier version
     * did, cannot work: at 48 m/s a single 8 ms step covers 40 cm, over which
     * even a sharp crest drops well under a millimetre.
     */
    const { slope, curvature } = surfaceProfile(racer.path, projection.distance, groundY);
    const requiredAccel = curvature * vLong * vLong;
    const launchThreshold = -PHYSICS.gravity * PHYSICS.airborneThreshold;
    const launchExcess = (launchThreshold - requiredAccel) / PHYSICS.gravity;
    if (vLong > 12 && launchExcess > PHYSICS.crestMinExcess) {
      racer.airborne = true;
      /*
       * The ground-following rate *plus* an unloading shove.
       *
       * The rate alone leaves the skiff on a path the ground keeps up with, so
       * it lands again on the next step; see `crestUnload`. The shove scales
       * with how far past the threshold the crest is, so a gentle rise gives a
       * skim and the flyover gives real air.
       */
      racer.verticalVelocity =
        slope * vLong + Math.min(PHYSICS.crestUnloadMax, PHYSICS.crestUnload * launchExcess);
      racer.y = groundY;
      racer.airClearance = 0;
      // A crest is not part of a hop chain; it is the thing the reward is for.
      racer.hopChain = 0;
    } else {
      // Glued to the surface, but eased so a kerb does not snap the camera.
      racer.y = damp(racer.y, groundY, 22, dt);
      racer.verticalVelocity = 0;
    }
  }

  // --- integrate ----------------------------------------------------------
  racer.pos = { x: racer.pos.x + racer.velocity.x * dt, z: racer.pos.z + racer.velocity.z * dt };

  resolveTrackEdges(racer, ctx);
}

/**
 * Keeps a racer inside the world.
 *
 * Walled edges bounce immediately — that is what a wall is for, and on the
 * narrow courses bouncing along a barrier is a legitimate (slow) way round.
 *
 * Open edges do *not* get a hard wall. An invisible barrier out in the grass
 * traps a car that arrives pointing at it: every step cancels the velocity
 * component into the barrier, so a player holding the throttle simply sits
 * there at walking pace with no idea why. Instead the ground beyond the limit
 * behaves like a banked run-off — a steady inward acceleration that grows with
 * how far out you are — so a car always finds its own way back to the course.
 */
function resolveTrackEdges(racer: RacerState, ctx: VehicleStepContext): void {
  const projection = ctx.track.project(racer.pos, racer.path);
  const walled = projection.edge === 'wall';
  const limit = walled ? projection.halfWidth : projection.halfWidth + PHYSICS.offTrackMargin;
  const over = Math.abs(projection.lateral) - limit;

  // Clear of the barrier by a comfortable margin: the next contact is a new
  // contact, and may bill again.
  if (over <= -COLLISION.wallClearance) racer.wallImpactLock = 0;
  if (over <= 0) {
    racer.wallContactTime = 0;
    return;
  }
  racer.wallContactTime += ctx.dt;

  const side = Math.sign(projection.lateral);
  const normal = projection.normal;

  if (!walled) {
    const inwardX = -normal.x * side;
    const inwardZ = -normal.z * side;

    /*
     * The return is a *positional* slide, not a force on the velocity.
     *
     * An inward force has to be stronger than the engine to work at all, and
     * once it is, a car pointed outwards at full throttle settles at exactly
     * zero speed — where the steering has no authority either, so it is stuck
     * for good. Sliding the car back instead never fights the throttle and
     * cannot stall: the driver keeps full control the whole way in, and simply
     * finds themselves back on the road.
     */
    const rate = Math.min(over * PHYSICS.runOffReturn, PHYSICS.runOffMaxReturnSpeed);
    racer.pos = { x: racer.pos.x + inwardX * rate * ctx.dt, z: racer.pos.z + inwardZ * rate * ctx.dt };

    // Extra drag out here, so wandering off is always slower than staying on.
    const drag = Math.exp(-PHYSICS.runOffDrag * ctx.dt);
    racer.velocity = { x: racer.velocity.x * drag, z: racer.velocity.z * drag };
    return;
  }

  /*
   * Push clear of the barrier, not merely back to it.
   *
   * Landing exactly on the limit leaves the racer re-colliding on the next
   * step, which is how a graze became a multi-second rail grind that bled
   * 41 m/s down to 5 m/s while `onTrack` flickered and no recovery ever
   * started. A small guaranteed separation ends the contact.
   */
  /*
   * A full clearance, not half of one, plus a widening escape slide.
   *
   * Half a clearance leaves the hull inside the band that still counts as
   * contact, so the lockout can never reset and every subsequent step is
   * another contact. Combined with the fact that yaw authority falls away with
   * speed, that is the twenty-second pin a review measured: at three metres a
   * second neither neutral release nor full opposite lock can point the nose
   * out, and nothing else was moving the car.
   *
   * So separation is guaranteed, and a contact that *persists* is walked off
   * the barrier by an outward slide that grows the longer it lasts. This is the
   * same positional-return trick the run-off uses, and for the same reason: a
   * force strong enough to beat the engine settles the car at zero speed, where
   * steering has no authority at all.
   */
  const escape =
    COLLISION.wallClearance +
    Math.min(COLLISION.wallEscapeMax, racer.wallContactTime * COLLISION.wallEscapeRate) * ctx.dt;
  racer.pos = {
    x: racer.pos.x - normal.x * side * (over + escape),
    z: racer.pos.z - normal.z * side * (over + escape),
  };

  const intoWall = dot(racer.velocity, { x: normal.x * side, z: normal.z * side });
  if (intoWall <= 0) return;

  /*
   * Always remove the component into the wall — a car cannot keep driving into
   * a barrier — but only *bill* an impact once per contact.
   *
   * Restitution is part of the bill. Bouncing every frame is what let a
   * sustained contact compound: two consecutive capped steps still took 42% and
   * then another 27%, so the per-impact ceiling did not actually bound what a
   * contact cost. While locked out the wall simply stops the car going through
   * it, and takes nothing else.
   */
  const billing = racer.wallImpactLock <= 0;
  const speedBefore = Math.hypot(racer.velocity.x, racer.velocity.z);
  const bounce = billing ? 1 + PHYSICS.wallRestitution : 1;
  racer.velocity = {
    x: racer.velocity.x - normal.x * side * intoWall * bounce,
    z: racer.velocity.z - normal.z * side * intoWall * bounce,
  };

  if (billing) {
    const squareness = clamp01(intoWall / Math.max(4, speedBefore));
    const scrub = 1 - squareness * 0.45;
    racer.velocity = { x: racer.velocity.x * scrub, z: racer.velocity.z * scrub };
    racer.wallImpactLock = COLLISION.wallImpactLockout;
  }

  /*
   * A hard ceiling on what one contact may cost.
   *
   * Even a single square-on hit removing most of the speed is unrecoverable
   * rather than punishing, and a sequence of them is what made boundary
   * contact feel arbitrary. Beyond this the wall stops taking speed and simply
   * stops the car going through it.
   */
  const speedAfter = Math.hypot(racer.velocity.x, racer.velocity.z);
  const floor = speedBefore * (1 - COLLISION.maxWallSpeedLoss);
  if (speedAfter < floor && speedAfter > 1e-3) {
    const rescale = floor / speedAfter;
    racer.velocity = { x: racer.velocity.x * rescale, z: racer.velocity.z * rescale };
  }

  if (billing && intoWall > PHYSICS.wallSpinThreshold * 0.25) {
    // Nudge the heading away from the barrier so the recovery is intuitive
    // rather than leaving the nose buried in it.
    const targetHeading = Math.atan2(projection.tangent.z, projection.tangent.x);
    racer.heading = wrapAngle(
      racer.heading + moveTowards(0, wrapAngle(targetHeading - racer.heading), 0.35 * clamp01(intoWall / 20)),
    );
    racer.drift.active = false;
    racer.drift.charge = 0;
  }

  if (billing && racer.contactCooldown <= 0) {
    racer.contactCooldown = 0.12;
    ctx.events.push({ type: 'wallHit', racer: racer.index, speed: intoWall, pos: { ...racer.pos } });
  }
}

/** Ends a drift, granting surge and an impulse according to the charge tier. */
export function releaseDrift(racer: RacerState, ctx: VehicleStepContext): void {
  if (!racer.drift.active) return;
  const charge = racer.drift.charge;
  racer.drift.active = false;
  racer.drift.charge = 0;
  racer.drift.direction = 0;

  let tier = -1;
  for (let i = DRIFT.tiers.length - 1; i >= 0; i--) {
    if (charge >= (DRIFT.tiers[i] as number)) {
      tier = i;
      break;
    }
  }
  if (tier < 0) return;

  racer.surge = Math.min(SURGE.max, racer.surge + (DRIFT.tierSurge[tier] as number));
  const forward = fromHeading(racer.heading);
  const impulse = DRIFT.tierImpulse[tier] as number;
  racer.velocity = { x: racer.velocity.x + forward.x * impulse, z: racer.velocity.z + forward.z * impulse };
  ctx.events.push({ type: 'driftRelease', racer: racer.index, tier: tier + 1 });
}
