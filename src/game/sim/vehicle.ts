import type { Rng } from '../../core/rng';
import { clamp, clamp01, damp, dot, fromHeading, moveTowards, wrapAngle } from '../../core/math';
import type { Vec2 } from '../../core/math';
import { COMBAT, DRIFT, PHYSICS, SURGE } from '../config';
import type { Track } from '../track/buildTrack';
import { sampleAt } from '../track/buildTrack';
import { SURFACES } from '../track/types';
import type { SurfaceId } from '../track/types';
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

/** Unit vector pointing left of the given heading. */
function leftOf(headingRad: number): Vec2 {
  return { x: -Math.sin(headingRad), z: Math.cos(headingRad) };
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

/** dy/ds of the track surface at a point, used for the airborne model. */
function slopeAt(track: Track, racer: RacerState, distance: number): number {
  const ahead = sampleAt(racer.path, distance + 2).y;
  const behind = sampleAt(racer.path, distance - 2).y;
  void track;
  return (ahead - behind) / 4;
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
  const left = leftOf(racer.heading);
  let vLong = dot(racer.velocity, forward);
  let vLat = dot(racer.velocity, left);

  // --- drift --------------------------------------------------------------
  const wantsDrift = input.drift && vLong > DRIFT.minSpeed && !racer.airborne;
  if (wantsDrift && !racer.drift.active) {
    racer.drift.active = true;
    racer.drift.direction = Math.abs(input.steer) > 0.15 ? Math.sign(input.steer) : Math.sign(vLat) || 1;
    racer.drift.charge = 0;
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
      accel += spec.enginePower * ctx.engineScale * input.throttle * curve * (racer.boosting ? SURGE.forceMultiplier : 1);
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
    const l = leftOf(racer.heading);
    racer.velocity = { x: f.x * vLong + l.x * vLat, z: f.z * vLong + l.z * vLat };
  }

  // --- steering -----------------------------------------------------------
  const targetSteer = clamp(input.steer, -1, 1);
  racer.steer = damp(racer.steer, targetSteer, PHYSICS.steerResponse, dt);

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
  const latAccelMax = spec.grip * PHYSICS.gripToLateralAccel * surf.grip * (drifting ? PHYSICS.driftYawLimitBonus : 1);
  const gripYawLimit = latAccelMax / Math.max(6, speed);
  const yawRate = Math.min(steerYawRate, gripYawLimit);

  // Positive steer turns right, which is a negative rotation in this basis.
  const yaw = -racer.steer * yawRate * (vLong < 0 ? -1 : 1);
  racer.heading = wrapAngle(racer.heading + yaw * dt);

  // --- lateral grip -------------------------------------------------------
  // Re-project the (unchanged) world velocity onto the new, rotated basis. Any
  // lateral component that appears is the skiff sliding, and grip bleeds it off
  // over time rather than instantly.
  const newForward = fromHeading(racer.heading);
  const newLeft = leftOf(racer.heading);
  vLong = dot(racer.velocity, newForward);
  vLat = dot(racer.velocity, newLeft);

  let grip = spec.grip * surf.grip;
  if (drifting) grip *= DRIFT.gripMultiplier;
  if (staggered) grip *= COMBAT.staggerGrip;
  if (racer.airborne) grip *= 0.15;

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
    const productive = clamp01(Math.abs(racer.slip) / 0.28) * clamp01(vLong / 25);
    // Charge only bleeds away once the slide has genuinely stopped working,
    // otherwise a drift held through a corner exit never banks a tier.
    const decay = productive < 0.3 ? DRIFT.chargeDecay * (0.3 - productive) : 0;
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
    x: newForward.x * vLong + newLeft.x * vLat,
    z: newForward.z * vLong + newLeft.z * vLat,
  };

  // --- vertical -----------------------------------------------------------
  const groundY = projection.y;
  if (racer.airborne) {
    racer.verticalVelocity -= PHYSICS.gravity * dt;
    racer.y += racer.verticalVelocity * dt;
    if (racer.y <= groundY) {
      const impact = -racer.verticalVelocity;
      racer.y = groundY;
      racer.verticalVelocity = 0;
      racer.airborne = false;
      const clean = impact <= PHYSICS.cleanLandingSpeed;
      if (clean) {
        racer.surge = Math.min(SURGE.max, racer.surge + SURGE.cleanLandingGain);
      } else {
        const loss = clamp01((impact - PHYSICS.cleanLandingSpeed) / 18);
        vLong *= 1 - loss * 0.28;
        racer.velocity = {
          x: newForward.x * vLong + newLeft.x * vLat,
          z: newForward.z * vLong + newLeft.z * vLat,
        };
      }
      ctx.events.push({ type: 'jumpLand', racer: racer.index, clean, speed: impact });
    }
  } else {
    const slope = slopeAt(ctx.track, racer, projection.distance);
    const verticalSpeed = slope * vLong;
    const nextGround = sampleAt(racer.path, projection.distance + vLong * dt).y;
    const ballistic = groundY + verticalSpeed * dt - 0.5 * PHYSICS.gravity * dt * dt;
    if (verticalSpeed > 1 && ballistic > nextGround + 0.02) {
      racer.airborne = true;
      racer.verticalVelocity = verticalSpeed;
      racer.y = groundY;
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
  if (over <= 0) return;

  const side = Math.sign(projection.lateral);
  const normal = projection.normal;

  if (!walled) {
    const inwardX = -normal.x * side;
    const inwardZ = -normal.z * side;
    const push =
      PHYSICS.runOffReturn * Math.min(1, over / PHYSICS.runOffFullReturn) +
      Math.max(0, over - PHYSICS.runOffFullReturn) * PHYSICS.runOffHardGain;
    racer.velocity = {
      x: racer.velocity.x + inwardX * push * ctx.dt,
      z: racer.velocity.z + inwardZ * push * ctx.dt,
    };
    // Extra drag out here, so wandering off is always slower than staying on.
    const drag = Math.exp(-PHYSICS.runOffDrag * ctx.dt);
    racer.velocity = { x: racer.velocity.x * drag, z: racer.velocity.z * drag };

    // A far outer clamp still exists so nothing can leave the world entirely,
    // but it sits well beyond where the return force has already taken over.
    const hardLimit = limit + PHYSICS.runOffMaxOvershoot;
    const beyond = Math.abs(projection.lateral) - hardLimit;
    if (beyond > 0) {
      racer.pos = { x: racer.pos.x + inwardX * beyond, z: racer.pos.z + inwardZ * beyond };
    }
    return;
  }

  // Push back to the limit along the track normal.
  racer.pos = {
    x: racer.pos.x - normal.x * side * over,
    z: racer.pos.z - normal.z * side * over,
  };

  const intoWall = dot(racer.velocity, { x: normal.x * side, z: normal.z * side });
  if (intoWall <= 0) return;

  // Remove the component into the wall and scrub speed proportionally to how
  // square-on the impact was; a graze costs almost nothing.
  racer.velocity = {
    x: racer.velocity.x - normal.x * side * intoWall * (1 + PHYSICS.wallRestitution),
    z: racer.velocity.z - normal.z * side * intoWall * (1 + PHYSICS.wallRestitution),
  };
  const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
  const squareness = clamp01(intoWall / Math.max(4, speed));
  const scrub = 1 - squareness * 0.45;
  racer.velocity = { x: racer.velocity.x * scrub, z: racer.velocity.z * scrub };

  if (intoWall > PHYSICS.wallSpinThreshold * 0.25) {
    // Nudge the heading away from the barrier so the recovery is intuitive
    // rather than leaving the nose buried in it.
    const targetHeading = Math.atan2(projection.tangent.z, projection.tangent.x);
    racer.heading = wrapAngle(
      racer.heading + moveTowards(0, wrapAngle(targetHeading - racer.heading), 0.35 * clamp01(intoWall / 20)),
    );
    racer.drift.active = false;
    racer.drift.charge = 0;
  }

  if (racer.contactCooldown <= 0) {
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
