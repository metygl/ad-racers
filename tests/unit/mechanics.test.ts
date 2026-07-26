import { describe, expect, it } from 'vitest';
import { fromHeading, wrapAngle } from '../../src/core/math';
import {
  COLLISION,
  DRIFT,
  FIXED_STEP,
  HOP,
  LANDING,
  PHYSICS,
  RACE,
  RECOVERY,
  SPEED_CLASSES,
  TOW,
  getSpeedClass,
} from '../../src/game/config';
import { RACERS, toVehicleSpec } from '../../src/game/racers';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { ControlInput, RacerState } from '../../src/game/sim/state';
import { getDifficulty } from '../../src/game/ai/driver';
import { getTrack } from '../../src/game/track/tracks';
import { buildSetup, runHeadlessRace } from '../support/headless';

/**
 * The second-generation handling layer.
 *
 * Each mechanic in `docs/DESIGN-DIRECTION.md` promises four beats —
 * anticipation, execution, payoff, recovery — and every one of those is a
 * boundary a test can stand on. These are the boundaries.
 */

function solo(trackId = 'saltflat-reliquary'): { sim: Simulation; racer: RacerState } {
  const sim = new Simulation(buildSetup({ trackId, entries: 1, playerIndex: 0 }));
  while (sim.phase === 'countdown') {
    sim.step(emptyInput());
    sim.drainEvents();
  }
  const racer = sim.racers[0];
  if (!racer) throw new Error('no racer');
  return { sim, racer };
}

function run(sim: Simulation, seconds: number, input: ControlInput): void {
  for (let i = 0; i < Math.ceil(seconds / FIXED_STEP); i++) {
    sim.step(input);
    sim.drainEvents();
  }
}

/**
 * Steer needed to hold the centreline.
 *
 * Every course curves, so holding the throttle with the wheel straight puts the
 * skiff in the run-off within a few seconds and measures the grass instead of
 * the mechanic under test.
 */
function laneKeep(sim: Simulation, racer: RacerState): number {
  const projection = sim.track.project(racer.pos, racer.path);
  const ahead = sim.track.sampleMain(projection.mainDistance + 26);
  const desired = Math.atan2(ahead.pos.z - racer.pos.z, ahead.pos.x - racer.pos.x);
  let error = desired - racer.heading;
  while (error > Math.PI) error -= Math.PI * 2;
  while (error < -Math.PI) error += Math.PI * 2;
  // Pure pursuit alone leaves a standing lateral offset and parks the car on
  // the edge of a wide course, which is no use as a baseline.
  const crossTrack = -projection.lateral / Math.max(4, projection.halfWidth);
  return Math.max(-1, Math.min(1, error * 2.2 + crossTrack * 0.5));
}

/** Runs up to racing speed on the centreline. */
function upToSpeed(sim: Simulation, racer: RacerState, seconds = 14): void {
  for (let i = 0; i < Math.ceil(seconds / FIXED_STEP); i++) {
    sim.step({ ...emptyInput(), throttle: 1, steer: laneKeep(sim, racer) });
    sim.drainEvents();
  }
}

const speedOf = (r: RacerState): number => Math.hypot(r.velocity.x, r.velocity.z);

describe('the hop', () => {
  it('leaves the ground and comes back', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    expect(racer.airborne).toBe(false);

    sim.step({ ...emptyInput(), throttle: 1, hop: true });
    expect(racer.airborne).toBe(true);
    expect(racer.verticalVelocity).toBeGreaterThan(0);

    run(sim, 3, { ...emptyInput(), throttle: 1 });
    expect(racer.airborne).toBe(false);
  });

  it('cannot be repeated faster than its cooldown', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    let hops = 0;
    for (let i = 0; i < Math.ceil(HOP.cooldown / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, hop: true });
      hops += sim.drainEvents().filter((e) => e.type === 'hop').length;
    }
    expect(hops).toBe(1);
  });

  it('cannot be used to pogo a parked skiff', () => {
    const { sim, racer } = solo();
    run(sim, 1, { ...emptyInput(), hop: true });
    expect(racer.airborne).toBe(false);
  });

  it('costs a little speed, so hopping down a straight is never free', () => {
    const measure = (hop: boolean): number => {
      const { sim, racer } = solo();
      upToSpeed(sim, racer);
      run(sim, 2, { ...emptyInput(), throttle: 1, hop });
      return speedOf(racer);
    };
    expect(measure(true)).toBeLessThan(measure(false));
  });

  it('gives a drift begun on landing a charge head start', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    sim.step({ ...emptyInput(), throttle: 1, hop: true });
    // Fly until just after touchdown.
    while (racer.airborne) {
      sim.step({ ...emptyInput(), throttle: 1 });
      sim.drainEvents();
    }
    expect(racer.sinceLanding).toBeLessThanOrEqual(HOP.landingWindow);

    sim.step({ ...emptyInput(), throttle: 1, steer: 0.6, drift: true });
    expect(racer.drift.active).toBe(true);
    // The head start, less the sliver of decay one step of a not-yet-sliding
    // drift costs.
    expect(racer.drift.charge).toBeGreaterThan(HOP.landingDriftCharge * 0.9);
    // ...but nowhere near a payout on its own.
    expect(racer.drift.charge).toBeLessThan(0.34);
  });
});

describe('air control and landing quality', () => {
  it('lets the skiff be steered while airborne', () => {
    const turn = (steer: number): number => {
      const { sim, racer } = solo();
      upToSpeed(sim, racer);
      sim.step({ ...emptyInput(), throttle: 1, hop: true });
      const before = racer.heading;
      let steps = 0;
      while (racer.airborne && steps < 400) {
        sim.step({ ...emptyInput(), throttle: 1, steer });
        sim.drainEvents();
        steps += 1;
      }
      // Wrapped, because a hop taken near ±π would otherwise report a turn of
      // nearly 2π in the wrong direction.
      return wrapAngle(racer.heading - before);
    };
    expect(turn(1)).toBeGreaterThan(0.05);
    expect(turn(-1)).toBeLessThan(-0.05);
  });

  it('pays a real crest landing and refuses an off-road or crooked one', () => {
    /*
     * Measured across a full Ace field over the flyover. Every landing that
     * scored was on the road, level and close to straight; every one that was
     * off the road or more than about fifteen degrees out of line scored zero.
     */
    const scored: { quality: number; onTrack: boolean; slip: number }[] = [];
    runHeadlessRace({
      trackId: 'overgrown-interchange',
      playerIndex: null,
      difficultyId: 'ace',
      maxSeconds: 150,
      onStep: (sim, events) => {
        for (const event of events) {
          if (event.type !== 'jumpLand' || event.clearance < LANDING.minClearance) continue;
          const racer = sim.racers[event.racer];
          if (!racer) continue;
          scored.push({ quality: event.quality, onTrack: racer.onTrack, slip: Math.abs(racer.slip) });
        }
      },
    });

    expect(scored.length).toBeGreaterThan(4);
    expect(scored.some((s) => s.quality > 0.6)).toBe(true);
    for (const landing of scored) {
      if (landing.quality > 0) {
        expect(landing.onTrack).toBe(true);
        expect(landing.slip).toBeLessThan(LANDING.sloppySlip);
      }
    }
  }, 90_000);

  it('pays nothing for a flat hop on a straight, however many times it is tapped', () => {
    /*
     * The exploit this closes: five ordinary flat hops raised Surge from 0.25 to
     * 0.81 in under four seconds. A landing reward exists to pay for taking a
     * *crest* well, so it now requires having actually risen — an air-time floor
     * alone never gated this, because an ordinary hop clears half a second.
     */
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    racer.surge = 0;
    let paid = 0;
    for (let i = 0; i < Math.ceil(6 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, hop: true, steer: laneKeep(sim, racer) });
      for (const event of sim.drainEvents()) {
        if (event.type === 'jumpLand') paid += event.quality;
      }
    }
    expect(paid).toBe(0);
    expect(racer.surge).toBeLessThan(0.05);
  });

  it('pays nothing for a landing that arrives crooked', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    sim.step({ ...emptyInput(), throttle: 1, hop: true });
    racer.surge = 0;
    let quality = -1;
    while (racer.airborne) {
      // Full lock in the air: this lands visibly yawed, and used to still pay.
      sim.step({ ...emptyInput(), throttle: 1, steer: 1 });
      for (const event of sim.drainEvents()) {
        if (event.type === 'jumpLand') quality = event.quality;
      }
    }
    expect(quality).toBe(0);
  });

  it('never leaves a racer airborne indefinitely', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    sim.step({ ...emptyInput(), throttle: 1, hop: true });
    let air = 0;
    while (racer.airborne && air < 6) {
      sim.step({ ...emptyInput(), throttle: 1, steer: 1 });
      sim.drainEvents();
      air += FIXED_STEP;
    }
    expect(racer.airborne).toBe(false);
    expect(air).toBeLessThan(LANDING.minAirTime + 4);
  });
});

describe('reward gating', () => {
  /*
   * Every one of these was a live exploit found in production play. Each is a
   * way of filling the primary speed resource without solving a corner, and
   * every one of them out-earned actually racing.
   */

  it('refuses drift charge off the road', () => {
    const { sim, racer } = solo('overgrown-interchange');
    upToSpeed(sim, racer);
    // Drive off and keep holding the drift, which used to fill the tier ladder
    // to maximum at 9 m/s and pay 0.57 Surge.
    const away = racer.lateral >= 0 ? 1 : -1;
    for (let i = 0; i < Math.ceil(6 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: away, drift: true });
      sim.drainEvents();
    }
    expect(racer.onTrack).toBe(false);
    expect(racer.drift.charge).toBe(0);
  });

  it('bleeds banked drift charge away once the skiff leaves the road', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer);
    const inward = racer.lateral >= 0 ? -0.85 : 0.85;
    for (let i = 0; i < Math.ceil(1.6 / FIXED_STEP) && racer.onTrack; i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: inward, drift: true });
      sim.drainEvents();
    }
    const banked = racer.drift.charge;
    expect(banked).toBeGreaterThan(0.3);

    const away = racer.lateral >= 0 ? 1 : -1;
    for (let i = 0; i < Math.ceil(4 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: away, drift: true });
      sim.drainEvents();
    }
    expect(racer.onTrack).toBe(false);
    expect(racer.drift.charge).toBeLessThan(banked * 0.5);
  });

  it('refuses drift charge below racing speed', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer, 3);
    // Brake down to a crawl on the road, then hold a drift.
    for (let i = 0; i < Math.ceil(3 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), brake: true, steer: laneKeep(sim, racer) });
      sim.drainEvents();
    }
    for (let i = 0; i < Math.ceil(2 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 0.2, steer: 1, drift: true });
      sim.drainEvents();
    }
    expect(Math.hypot(racer.velocity.x, racer.velocity.z)).toBeLessThan(DRIFT.minChargeSpeed);
    expect(racer.drift.charge).toBe(0);
  });
});

describe('wall contact', () => {
  it('bills one impact per contact rather than every frame of a grind', () => {
    /*
     * A neutral-steer graze used to renew the impact every frame and bleed
     * 41 m/s down to about 5 m/s over a couple of seconds of rail grinding,
     * with `onTrack` flickering and no recovery ever starting.
     */
    const sim = new Simulation(buildSetup({ trackId: 'emberfall-quarry', entries: 1, playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const racer = sim.racers[0] as RacerState;
    for (let i = 0; i < Math.ceil(6 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: laneKeep(sim, racer) });
      sim.drainEvents();
    }

    /*
     * Placed hard against the barrier with speed into it, because steering into
     * a wall on a curving course is unreliable as a fixture — and the case the
     * review found unrecoverable was specifically "already touching the wall,
     * wheel released, throttle held".
     */
    const projection = sim.track.project(racer.pos, racer.path);
    const outward = Math.sign(racer.lateral) || 1;
    racer.pos = {
      x: projection.center.x + projection.normal.x * outward * (projection.halfWidth - 0.2),
      z: projection.center.z + projection.normal.z * outward * (projection.halfWidth - 0.2),
    };
    const heading = Math.atan2(projection.tangent.z, projection.tangent.x) + outward * 0.25;
    racer.heading = heading;
    racer.velocity = { x: Math.cos(heading) * 40, z: Math.sin(heading) * 40 };

    let hits = 0;
    const speedAtContact = speedOf(racer);
    for (let i = 0; i < Math.ceil(3 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1 });
      hits += sim.drainEvents().filter((e) => e.type === 'wallHit').length;
    }

    // A three-second neutral run along a barrier is a handful of contacts, not
    // three hundred.
    expect(hits).toBeLessThanOrEqual(Math.ceil(3 / COLLISION.wallImpactLockout) + 2);
    // And holding the throttle must leave the car going, not bled to a crawl.
    expect(speedOf(racer)).toBeGreaterThan(Math.max(8, speedAtContact * 0.6));
  }, 60_000);
});

describe('the tow snap', () => {
  /** Two racers nose to tail, the second directly in the first's wake. */
  function convoy(): { sim: Simulation; lead: RacerState; chase: RacerState } {
    const sim = new Simulation({
      track: getTrack('saltflat-reliquary'),
      entries: [
        { profileId: 'thornline', isPlayer: true },
        { profileId: 'greenline', isPlayer: false },
      ],
      difficulty: getDifficulty('pro'),
      seed: 99,
      catchUp: false,
    });
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const [chase, lead] = sim.racers as [RacerState, RacerState];
    return { sim, lead, chase };
  }

  /** Pins the lead car a fixed distance ahead of the chaser, in its wake. */
  function tow(sim: Simulation, lead: RacerState, chase: RacerState, seconds: number): void {
    for (let i = 0; i < Math.ceil(seconds / FIXED_STEP); i++) {
      const forward = fromHeading(chase.heading);
      lead.pos = { x: chase.pos.x + forward.x * 8, z: chase.pos.z + forward.z * 8 };
      lead.y = chase.y;
      lead.heading = chase.heading;
      lead.velocity = { ...chase.velocity };
      sim.step({ ...emptyInput(), throttle: 1 });
      sim.drainEvents();
    }
  }

  it('charges while in the wake and fires on pulling out', () => {
    const { sim, lead, chase } = convoy();
    tow(sim, lead, chase, TOW.chargeTime + 0.6);
    expect(chase.slipstreaming).toBe(true);
    expect(chase.towCharge).toBeGreaterThan(TOW.minCharge);

    const before = speedOf(chase);
    // Move the lead car away, which is what leaving the wake looks like.
    lead.pos = { x: chase.pos.x + 400, z: chase.pos.z + 400 };
    let snapped = 0;
    for (let i = 0; i < 4; i++) {
      sim.step({ ...emptyInput(), throttle: 1 });
      snapped += sim.drainEvents().filter((e) => e.type === 'towSnap').length;
    }
    expect(snapped).toBe(1);
    expect(speedOf(chase)).toBeGreaterThan(before);
  });

  it('pays nothing for a brush past a rival', () => {
    const { sim, lead, chase } = convoy();
    tow(sim, lead, chase, 0.25);
    lead.pos = { x: chase.pos.x + 400, z: chase.pos.z + 400 };
    let snapped = 0;
    for (let i = 0; i < 4; i++) {
      sim.step({ ...emptyInput(), throttle: 1 });
      snapped += sim.drainEvents().filter((e) => e.type === 'towSnap').length;
    }
    expect(snapped).toBe(0);
  });

  it('is worth about a car length, not a race', () => {
    // The snap must decide who reaches the corner first and nothing larger.
    const gain = TOW.impulse;
    expect(gain).toBeLessThan(8);
    expect(TOW.surge).toBeLessThan(0.25);
  });
});

describe('impact recovery', () => {
  it('helps a struck racer back up to speed, but cannot be farmed', () => {
    const { sim, racer } = solo();
    upToSpeed(sim, racer, 4);
    expect(racer.recoveryBoost).toBe(0);

    // A heavy hit is the trigger; anything gentler is not.
    sim['grantRecovery'](racer, RECOVERY.impactThreshold - 1);
    expect(racer.recoveryBoost).toBe(0);
    sim['grantRecovery'](racer, RECOVERY.impactThreshold + 5);
    expect(racer.recoveryBoost).toBeGreaterThan(0);

    // A second hit inside the cooldown grants nothing, so driving into walls
    // is never a strategy.
    racer.recoveryBoost = 0;
    sim['grantRecovery'](racer, RECOVERY.impactThreshold + 20);
    expect(racer.recoveryBoost).toBe(0);
  });

  it('is smaller than the impact it follows, so a crash is still a loss', () => {
    // Assist duration times the extra force must not exceed the speed a hit of
    // the triggering magnitude removes.
    const extraForce = (RECOVERY.forceMultiplier - 1) * 29;
    expect(extraForce * RECOVERY.duration).toBeLessThan(RECOVERY.impactThreshold);
  });
});

describe('speed classes', () => {
  it('scale the whole field, player included', () => {
    const base = toVehicleSpec(RACERS[0]!.stats, getSpeedClass('reclaim'));
    const top = toVehicleSpec(RACERS[0]!.stats, getSpeedClass('longquiet'));
    expect(top.topSpeed).toBeGreaterThan(base.topSpeed * 1.25);
    expect(top.enginePower).toBeGreaterThan(base.enginePower * 1.25);
    // Grip rises, but by less than the pace, so the fast class corners harder.
    expect(top.grip / base.grip).toBeLessThan(top.topSpeed / base.topSpeed);
  });

  it('are separated far enough to feel like different games', () => {
    for (let i = 1; i < SPEED_CLASSES.length; i++) {
      const step = (SPEED_CLASSES[i] as { scale: number }).scale / (SPEED_CLASSES[i - 1] as { scale: number }).scale;
      expect(step).toBeGreaterThan(1.1);
    }
  });

  it('are all finishable by every opponent on every course', () => {
    for (const speedClassId of SPEED_CLASSES.map((c) => c.id)) {
      for (const trackId of ['overgrown-interchange', 'saltflat-reliquary', 'emberfall-quarry']) {
        const result = runHeadlessRace({
          trackId,
          playerIndex: null,
          difficultyId: 'ace',
          speedClassId,
          maxSeconds: 400,
        });
        expect(result.finished, `${trackId} @ ${speedClassId}`).toBe(true);
        for (const racer of result.results) {
          expect(racer.completed, `${racer.profileId} on ${trackId} @ ${speedClassId}`).toBe(true);
        }
      }
    }
  }, 240_000);
});

describe('the mastery gradient', () => {
  /*
   * Pillar 1 of `docs/DESIGN-DIRECTION.md`: the first corner has to be takeable
   * with throttle and steering alone, and the full mechanic set has to be worth
   * real time. Both halves are asserted, because a game that fails the first is
   * hostile and a game that fails the second is shallow.
   */
  it('lets a player who only steers and accelerates finish', () => {
    const result = runHeadlessRace({
      trackId: 'overgrown-interchange',
      playerIndex: 0,
      difficultyId: 'rookie',
      maxSeconds: 400,
      playerInput: (sim) => {
        const player = sim.player;
        if (!player) return emptyInput();
        // Throttle and a crude lane-keeper. No brake, no drift, no hop, no
        // Surge, no strike.
        const projection = sim.track.project(player.pos, player.path);
        const ahead = sim.track.sampleMain(projection.mainDistance + 30);
        const desired = Math.atan2(ahead.pos.z - player.pos.z, ahead.pos.x - player.pos.x);
        let error = desired - player.heading;
        while (error > Math.PI) error -= Math.PI * 2;
        while (error < -Math.PI) error += Math.PI * 2;
        return { ...emptyInput(), throttle: 1, steer: Math.max(-1, Math.min(1, error * 2.4)) };
      },
    });
    expect(result.sim.player?.completed).toBe(true);
  }, 120_000);
});

describe('the body-angle bound', () => {
  /**
   * Motion finding F4 asked for an explicit limit on how far the body may be
   * *held* crossed up. Grip alone gives a slide an equilibrium but not a bound,
   * so a hit or a bad landing on a low-grip surface can leave the machine
   * sustaining an angle no driver would hold, with the nose pointing somewhere
   * the skiff is never going to go.
   */
  it('turns the nose back towards the direction of travel past the bound', () => {
    const { sim, racer } = solo('saltflat-reliquary');
    upToSpeed(sim, racer);

    /*
     * Put the skiff in the state the finding describes, directly.
     *
     * No sequence of inputs reaches it — the tyre model is strong enough that
     * even full lock with drift held settles around 0.5 rad — which is exactly
     * why the bound exists for the cases inputs do *not* produce: a heavy
     * strike, a landing gone wrong, a wall. Writing the velocity is the only
     * way to test the mechanism rather than the tyre curve in front of it.
     */
    const forward = fromHeading(racer.heading);
    const right = { x: -Math.sin(racer.heading), z: Math.cos(racer.heading) };
    const speed = speedOf(racer);
    // Almost pure lateral. The longitudinal component has to stay small,
    // because the tyre curve multiplies grip by more than ten past the peak
    // slip angle and bleeds an ordinary slide back under the bound inside a
    // single step — which is the whole reason inputs cannot reach this state.
    racer.velocity.x = forward.x * speed * 0.02 + right.x * speed;
    racer.velocity.z = forward.z * speed * 0.02 + right.z * speed;

    // One step to let the simulation measure the attitude it has been handed.
    run(sim, FIXED_STEP, emptyInput());
    expect(Math.abs(racer.slip)).toBeGreaterThan(PHYSICS.bodyAngleMax);

    // With no steering input there is no other source of yaw, so any change in
    // heading over the next step is the bound and nothing else.
    const before = racer.heading;
    const slipSign = Math.sign(racer.slip);
    run(sim, FIXED_STEP, emptyInput());
    const turned = wrapAngle(racer.heading - before);

    expect(turned).not.toBe(0);
    // Towards the direction of travel: opposite in sign to the slip.
    expect(Math.sign(turned)).toBe(-slipSign);
  });

  it('leaves ordinary drifting completely alone', () => {
    /*
     * The bound has to be invisible in normal driving or it is a handling
     * change wearing a readability argument — and it twice was not. An earlier
     * version measured the *pre-grip* angle, which is much larger than the
     * settled one because within a step the body rotates before the tyres pull
     * the velocity round with it. A later one measured the right angle at too
     * tight a threshold. Both cost the Ace field about a second a lap on the
     * salt and inverted the difficulty ladder, which the AI suite caught and
     * this test exists to catch sooner and more cheaply.
     */
    const { sim, racer } = solo('saltflat-reliquary');
    upToSpeed(sim, racer);

    let clamped = 0;
    for (let i = 0; i < Math.ceil(6 / FIXED_STEP); i++) {
      // A committed but ordinary drift: three quarters of lock, held.
      sim.step({ ...emptyInput(), throttle: 1, steer: 0.75, drift: true });
      sim.drainEvents();
      if (Math.abs(racer.slip) > PHYSICS.bodyAngleMax) clamped += 1;
    }
    expect(clamped).toBe(0);
  });

  it('never lets the body sit far from the road, on any course', () => {
    /*
     * The invariant F4 is actually about, asserted on the quantity it names:
     * the body's angle against the *track tangent*, not against its own
     * velocity. A skiff can be at a modest slip angle and still be pointing a
     * long way off the road through a corner, and the second is what a player
     * reads as coherent or broken.
     *
     * *Sustained* is the operative word, and it is measured rather than
     * assumed. A car crossing the road to reach a shortcut mouth legitimately
     * points a long way off the line for a moment, and so does one gathering up
     * a slide; neither is the failure. What the finding describes is a machine
     * that stays there. So this measures the longest unbroken run past the
     * bound, which is the thing that is either readable or not.
     */
    for (const trackId of ['saltflat-reliquary', 'overgrown-interchange', 'emberfall-quarry', 'glasshouse-vigil']) {
      let worstRun = 0;
      const runs = new Map<number, number>();
      runHeadlessRace({
        trackId,
        difficultyId: 'ace',
        playerIndex: null,
        maxSeconds: 400,
        onStep: (sim) => {
          for (const racer of sim.racers) {
            const projection = sim.track.project(racer.pos, racer.path);
            const tangent = Math.atan2(projection.tangent.z, projection.tangent.x);
            const angle = Math.abs(wrapAngle(racer.heading - tangent));
            const run = angle > PHYSICS.bodyAngleMax ? (runs.get(racer.index) ?? 0) + FIXED_STEP : 0;
            runs.set(racer.index, run);
            worstRun = Math.max(worstRun, run);
          }
        },
      });
      expect(worstRun, `${trackId}: seconds held past the body-angle bound`).toBeLessThan(0.75);
    }
  }, 600000);
});

describe('being trapped is always survivable', () => {
  /**
   * The round-2 gameplay review measured a single understandable mistake
   * removing control for tens of seconds: a wall contact that neutral release
   * would not break, that full opposite lock would not break, and that never
   * offered Recover because the skiff kept creeping at three to six metres a
   * second — above the speed the stuck affordance was gated on.
   *
   * The pinned state is written directly rather than driven into. Driving at a
   * barrier produces a glance, not a pin; the pin needs the car already deep in
   * the wall, slow, and pointing into it, which is where a bad landing or a
   * shove from a rival leaves it and which no sequence of inputs reproduces
   * reliably. Testing the escape means starting from the state that failed.
   */

  /** Buries the racer in the outer barrier of a walled section, nose first. */
  function buryInWall(): { sim: Simulation; racer: RacerState; limit: number } {
    const { sim, racer } = solo('glasshouse-vigil');
    upToSpeed(sim, racer);

    for (let i = 0; i < Math.ceil(40 / FIXED_STEP); i++) {
      if (sim.track.project(racer.pos, racer.path).edge === 'wall') break;
      sim.step({ ...emptyInput(), throttle: 1, steer: laneKeep(sim, racer) });
      sim.drainEvents();
    }

    const projection = sim.track.project(racer.pos, racer.path);
    expect(projection.edge, 'never reached a walled section').toBe('wall');

    // Half a metre *past* the barrier, crawling, with the nose buried in it.
    const side = projection.lateral >= 0 ? 1 : -1;
    const outside = projection.halfWidth + 0.5;
    racer.pos = {
      x: projection.center.x + projection.normal.x * side * outside,
      z: projection.center.z + projection.normal.z * side * outside,
    };
    racer.heading = Math.atan2(projection.normal.z * side, projection.normal.x * side);
    racer.velocity = { x: Math.cos(racer.heading) * 3.5, z: Math.sin(racer.heading) * 3.5 };
    racer.wedgeTimer = 0;

    return { sim, racer, limit: projection.halfWidth };
  }

  it('walks a buried skiff back off the barrier under neutral input', () => {
    const { sim, racer } = buryInWall();

    // Neutral: the player has released everything and is waiting to be free.
    let escaped = false;
    for (let i = 0; i < Math.ceil(3 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1 });
      sim.drainEvents();
      const projection = sim.track.project(racer.pos, racer.path);
      if (Math.abs(projection.lateral) <= projection.halfWidth) {
        escaped = true;
        break;
      }
    }

    expect(escaped, 'still pinned against the wall after three seconds').toBe(true);
    expect(racer.wallContactTime).toBeLessThan(1.5);
  });

  it('counts a wall grind as stuck even while the skiff is still moving', () => {
    /*
     * The affordance was gated on speed, and the failure state *has* speed —
     * three to six metres a second of going nowhere. It is progress that has
     * stopped, so progress is what the timer now measures. This asserts the
     * distinction directly: the timer must be running while the car is still
     * travelling well above the old stopped-car threshold.
     */
    const { sim, racer } = buryInWall();
    const side = Math.sign(sim.track.project(racer.pos, racer.path).lateral) || 1;

    let countedWhileMoving = false;
    for (let i = 0; i < Math.ceil(1.5 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: side });
      sim.drainEvents();
      if (racer.wedgeTimer > 0.25 && speedOf(racer) > RACE.stuckSpeed) countedWhileMoving = true;
    }

    expect(countedWhileMoving, 'a moving skiff going nowhere never registered as stuck').toBe(true);
  });

  it('rescues a player who never touches the controls', () => {
    /*
     * Reproduces the race-design review's start-grid ejection: an untouched
     * player was still stranded eighty seconds later, because automatic
     * recovery lived inside the AI branch and a human never reached it.
     */
    const sim = new Simulation(buildSetup({ trackId: 'glasshouse-vigil', playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const player = sim.player;
    if (!player) throw new Error('no player');

    let respawns = 0;
    for (let i = 0; i < Math.ceil(30 / FIXED_STEP); i++) {
      sim.step(emptyInput());
      for (const event of sim.drainEvents()) {
        if (event.type === 'respawn' && event.racer === player.index) respawns += 1;
      }
    }

    // The race put them back on the road rather than leaving them in a hedge.
    expect(respawns).toBeGreaterThan(0);
    const projection = sim.track.project(player.pos, player.path);
    expect(Math.abs(projection.lateral)).toBeLessThan(projection.halfWidth + PHYSICS.offTrackMargin);
  });
});

describe('the start grid', () => {
  it('does not eject a player who never launches', () => {
    /*
     * The race-design review's second blocker: five skiffs leaving the line at
     * full throttle shoved a stationary sixth twenty-four metres off an eleven
     * metre corridor before the first corner. The player had not pressed a key,
     * so no line, reaction or skill could have avoided it.
     */
    const sim = new Simulation(buildSetup({ trackId: 'glasshouse-vigil', playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const player = sim.player;
    if (!player) throw new Error('no player');

    let worst = 0;
    for (let i = 0; i < Math.ceil(RACE.gridGrace / FIXED_STEP); i++) {
      sim.step(emptyInput());
      sim.drainEvents();
      const projection = sim.track.project(player.pos, player.path);
      worst = Math.max(worst, Math.abs(projection.lateral) - projection.halfWidth);
    }

    // Still inside the run-off at worst — nudged, never ejected.
    expect(worst).toBeLessThan(PHYSICS.offTrackMargin * 0.5);
  });
});

describe('flat hopping pays nothing', () => {
  /**
   * The round-1 exploit had two halves. Off-road drift farming was closed; the
   * flat-road half was not, and the round-2 review banked 0.118 Surge — nearly
   * half an activation — from three taps on a straight, with no crest, no
   * obstacle and nothing to read. The optimal resource loop should not be
   * mashing a button in a straight line.
   */
  it('taps on flat road never bank Surge, at any point in a chain', () => {
    const { sim, racer } = solo('saltflat-reliquary');
    upToSpeed(sim, racer);

    // Somewhere genuinely flat: the salt flat's long opening sweep.
    const surgeBefore = racer.surge;
    let landings = 0;
    for (let tap = 0; tap < 6; tap++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: laneKeep(sim, racer), hop: true });
      sim.drainEvents();
      for (let i = 0; i < Math.ceil(0.75 / FIXED_STEP); i++) {
        sim.step({ ...emptyInput(), throttle: 1, steer: laneKeep(sim, racer) });
        for (const event of sim.drainEvents()) if (event.type === 'jumpLand') landings += 1;
      }
    }

    expect(landings, 'the hops never happened, so the test proves nothing').toBeGreaterThan(2);
    expect(racer.surge).toBeLessThanOrEqual(surgeBefore);
  });

  it('still pays for taking a real crest, and only where there is one', () => {
    /*
     * The other half of the gate, and the reason it measures the *road's* drop
     * rather than banning self-generated air: hopping to extend a crest is the
     * skill the mechanic exists for and has to keep paying.
     *
     * Measured across a full field rather than one lap of one car, because
     * whether any single controller happens to take a crest well is noise. The
     * salt flat is the control: it is flat, so nothing there may pay, and if it
     * ever does the gate has stopped meaning anything.
     */
    const paidOn = (trackId: string): number => {
      let paid = 0;
      runHeadlessRace({
        trackId,
        difficultyId: 'pro',
        playerIndex: null,
        maxSeconds: 200,
        onStep: (_sim, events) => {
          for (const event of events) if (event.type === 'jumpLand' && event.quality > 0) paid += 1;
        },
      });
      return paid;
    };

    expect(paidOn('glasshouse-vigil'), 'the hero course pays nothing for its crests').toBeGreaterThan(0);
    expect(paidOn('emberfall-quarry'), 'the quarry pays nothing for its crests').toBeGreaterThan(0);
    expect(paidOn('saltflat-reliquary'), 'the flat course paid for a landing').toBe(0);
  }, 600000);
});

describe('the gust has a lee', () => {
  /**
   * The race-design review's finding on Glasshouse's signature hazard: the
   * catastrophic slowdown is closed, but "I still could not read wind
   * direction, a safe lane, a drafting shelter, or a timing response". A hazard
   * with no counterplay is a toll, not a decision.
   *
   * Measured on the thing the wind actually does — sideways velocity imparted
   * per second — at both edges of the corridor, because a driving proxy over
   * the whole sequence measures the corners as much as the wind.
   */
  it('pushes far less on the sheltered side', () => {
    const track = getTrack('glasshouse-vigil');
    const gust = track.hazards.find((hazard) => hazard.kind === 'gust');
    if (!gust) throw new Error('the hero course has no gust to test');

    /*
     * How far the wind carries an uncorrected car, in metres.
     *
     * Displacement rather than sideways velocity: grip bleeds the lateral
     * component off every step, so a gust does not slide a skiff — it makes the
     * driver hold a correction, and the drift they get for not holding it is
     * what they actually feel.
     */
    const driftAt = (bias: number): number => {
      const sim = new Simulation(buildSetup({ trackId: 'glasshouse-vigil', entries: 1, playerIndex: 0 }));
      while (sim.phase === 'countdown') {
        sim.step(emptyInput());
        sim.drainEvents();
      }
      const racer = sim.racers[0] as RacerState;
      const at = track.project({ x: gust.x, z: gust.z });

      // Standing in the gust, at `bias` across the corridor, pointing down it.
      const offset = bias * at.halfWidth * 0.8;
      racer.pos = { x: at.center.x + at.normal.x * offset, z: at.center.z + at.normal.z * offset };
      racer.heading = Math.atan2(at.tangent.z, at.tangent.x);
      racer.velocity = { x: Math.cos(racer.heading) * 40, z: Math.sin(racer.heading) * 40 };

      const before = track.project(racer.pos, racer.path).lateral;
      run(sim, 1.2, { ...emptyInput(), throttle: 1 });
      return Math.abs(track.project(racer.pos, racer.path).lateral - before);
    };

    const oneEdge = driftAt(-1);
    const otherEdge = driftAt(1);
    const sheltered = Math.min(oneEdge, otherEdge);
    const exposed = Math.max(oneEdge, otherEdge);

    // The wind has to be doing something at all, and one side has to be
    // materially calmer than the other for there to be a lane to find.
    expect(exposed, 'the gust carries an uncorrected car nowhere').toBeGreaterThan(0.4);
    expect(sheltered).toBeLessThan(exposed * 0.7);
  });
});

describe('the first corner is survivable', () => {
  /**
   * The gameplay review's first-run finding: a fresh profile, no post-countdown
   * input, and by race time 21.9 the player was sixth, stationary, on grass,
   * with `STUCK - PRESS R TO RECOVER`. On touch the throttle is open by design,
   * so it happens sooner and through no decision at all. Whatever else the
   * opening is, it should not be able to end a three-lap race before the player
   * has worked out that they are driving.
   */
  it('does not roll an idle player into the scenery', () => {
    const sim = new Simulation(buildSetup({ trackId: 'glasshouse-vigil', playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const player = sim.player;
    if (!player) throw new Error('no player');

    // The touch case exactly: the platform supplies the throttle, the player
    // has not touched anything.
    let worst = -Infinity;
    for (let i = 0; i < Math.ceil(6 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, automaticThrottle: true });
      sim.drainEvents();
      const projection = sim.track.project(player.pos, player.path);
      worst = Math.max(worst, Math.abs(projection.lateral) - projection.halfWidth);
    }

    /*
     * The promise is not that an idle player drives a perfect line — it is that
     * the opening cannot end their race. Wide into the run-off and back is
     * racing; deposited in the vegetation, stopped, with `STUCK` on screen, is
     * the defect. So the bar is the run-off, and that they are still moving.
     */
    expect(worst, 'an untouched player left the run-off').toBeLessThan(PHYSICS.offTrackMargin * 0.6);
    expect(speedOf(player), 'an untouched player was left stranded').toBeGreaterThan(8);
  });

  it('hands the wheel over the instant the player steers', () => {
    /*
     * The other half, and the one that keeps the assist honest: it must be
     * invisible to anyone actually playing, and it must never come back.
     */
    const sim = new Simulation(buildSetup({ trackId: 'glasshouse-vigil', playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const player = sim.player;
    if (!player) throw new Error('no player');

    // One deliberate steering input ends it for the rest of the race.
    run(sim, 0.2, { ...emptyInput(), throttle: 1, steer: 0.6 });
    expect(player.hasSteered).toBe(true);

    // And from here the player's own steering is what reaches the car: hold
    // full lock and the skiff must actually leave the racing line.
    const before = sim.track.project(player.pos, player.path).lateral;
    run(sim, 1.5, { ...emptyInput(), throttle: 1, steer: 1 });
    const after = sim.track.project(player.pos, player.path).lateral;
    expect(Math.abs(after - before), 'the assist was still steering').toBeGreaterThan(1.5);
  });
});
