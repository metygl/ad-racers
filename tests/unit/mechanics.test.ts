import { describe, expect, it } from 'vitest';
import { fromHeading, wrapAngle } from '../../src/core/math';
import {
  COLLISION,
  DRIFT,
  FIXED_STEP,
  HOP,
  LANDING,
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
