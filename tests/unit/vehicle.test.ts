import { describe, expect, it } from 'vitest';
import { fromHeading } from '../../src/core/math';
import { COLLISION, DRIFT, FIXED_STEP, PHYSICS, SURGE } from '../../src/game/config';
import { RACERS, toVehicleSpec } from '../../src/game/racers';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { ControlInput, RacerState } from '../../src/game/sim/state';
import { SURFACES } from '../../src/game/track/types';
import { buildSetup } from '../support/headless';

/**
 * Vehicle physics.
 *
 * These pin the properties a driver can feel: a skiff reaches the speed the
 * card says it does, braking is worth doing, a drift is a slide you hold rather
 * than a spin, going off is slow, and two cars that touch separate instead of
 * merging.
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
 * Courses curve, so a test that holds the throttle with the wheel straight
 * drives off the road within a couple of seconds and measures the run-off
 * instead of the thing it meant to measure. This is the smallest controller
 * that keeps a car on the road while the longitudinal behaviour is observed.
 */
function laneKeep(sim: Simulation, racer: RacerState): number {
  const projection = sim.track.project(racer.pos, racer.path);
  const ahead = sim.track.sampleMain(projection.mainDistance + 26);
  const desired = Math.atan2(ahead.pos.z - racer.pos.z, ahead.pos.x - racer.pos.x);
  let error = desired - racer.heading;
  while (error > Math.PI) error -= Math.PI * 2;
  while (error < -Math.PI) error += Math.PI * 2;
  return Math.max(-1, Math.min(1, -error * 2.2));
}

/** Runs with lane-keeping applied on top of the supplied input. */
function drive(sim: Simulation, racer: RacerState, seconds: number, input: ControlInput): void {
  for (let i = 0; i < Math.ceil(seconds / FIXED_STEP); i++) {
    sim.step({ ...input, steer: laneKeep(sim, racer) });
    sim.drainEvents();
  }
}

const speedOf = (racer: RacerState): number => Math.hypot(racer.velocity.x, racer.velocity.z);

describe('top speed', () => {
  it('reaches, and does not exceed, the advertised figure', () => {
    const { sim, racer } = solo();
    drive(sim, racer, 30, { ...emptyInput(), throttle: 1 });
    const speed = speedOf(racer);
    // The engine curve has headroom above the cap so the cap is reachable; the
    // clamp is what makes the advertised number honest.
    expect(speed).toBeGreaterThan(racer.spec.topSpeed * 0.94);
    expect(speed).toBeLessThanOrEqual(racer.spec.topSpeed + 0.5);
  });

  it('is higher for a crew with a higher speed stat', () => {
    const fastest = RACERS.reduce((a, b) => (a.stats.topSpeed > b.stats.topSpeed ? a : b));
    const slowest = RACERS.reduce((a, b) => (a.stats.topSpeed < b.stats.topSpeed ? a : b));
    expect(toVehicleSpec(fastest.stats).topSpeed).toBeGreaterThan(toVehicleSpec(slowest.stats).topSpeed);
  });

  it('rises while boosting and falls back afterwards', () => {
    const { sim, racer } = solo();
    drive(sim, racer, 25, { ...emptyInput(), throttle: 1 });
    const cruise = speedOf(racer);
    racer.surge = 1;
    drive(sim, racer, 1.2, { ...emptyInput(), throttle: 1, boost: true });
    expect(speedOf(racer)).toBeGreaterThan(cruise);
    expect(speedOf(racer)).toBeLessThan(racer.spec.topSpeed * SURGE.speedMultiplier + 1);
  });
});

describe('braking', () => {
  it('sheds speed far faster than lifting off', () => {
    const coast = solo();
    drive(coast.sim, coast.racer, 25, { ...emptyInput(), throttle: 1 });
    const from = speedOf(coast.racer);
    drive(coast.sim, coast.racer, 2, emptyInput());
    const coasted = from - speedOf(coast.racer);

    const brake = solo();
    drive(brake.sim, brake.racer, 25, { ...emptyInput(), throttle: 1 });
    drive(brake.sim, brake.racer, 2, { ...emptyInput(), brake: true });
    const braked = from - speedOf(brake.racer);

    expect(braked).toBeGreaterThan(coasted * 2.5);
  });

  it('reverses from a standstill rather than braking into the scenery', () => {
    const { sim, racer } = solo();
    run(sim, 3, { ...emptyInput(), brake: true });
    const forward = fromHeading(racer.heading);
    const along = racer.velocity.x * forward.x + racer.velocity.z * forward.z;
    expect(along).toBeLessThan(0);
    expect(along).toBeGreaterThanOrEqual(-PHYSICS.reverseMaxSpeed - 0.5);
  });
});

describe('cornering', () => {
  it('is grip limited, so a slower entry turns tighter', () => {
    const radiusAt = (targetSpeed: number): number => {
      const { sim, racer } = solo();
      drive(sim, racer, 30, { ...emptyInput(), throttle: 1 });
      // Trim to the target speed, then hold full lock.
      while (speedOf(racer) > targetSpeed) drive(sim, racer, 0.1, { ...emptyInput(), brake: true });
      const start = { ...racer.pos };
      const startHeading = racer.heading;
      run(sim, 1.2, { ...emptyInput(), throttle: 0.2, steer: 1 });
      const turned = Math.abs(racer.heading - startHeading);
      const travelled = Math.hypot(racer.pos.x - start.x, racer.pos.z - start.z);
      return turned > 1e-4 ? travelled / turned : Infinity;
    };

    const fast = radiusAt(44);
    const slow = radiusAt(22);
    expect(slow).toBeLessThan(fast);
  });

  it('cannot pivot on the spot', () => {
    const { sim, racer } = solo();
    const heading = racer.heading;
    run(sim, 2, { ...emptyInput(), steer: 1 });
    expect(Math.abs(racer.heading - heading)).toBeLessThan(0.05);
  });
});

describe('drifting', () => {
  it('builds a slide and banks charge, and does not spin', () => {
    const { sim, racer } = solo();
    drive(sim, racer, 20, { ...emptyInput(), throttle: 1 });
    let peakSlip = 0;
    for (let i = 0; i < Math.ceil(3 / FIXED_STEP); i++) {
      sim.step({ ...emptyInput(), throttle: 1, steer: -0.8, drift: true });
      sim.drainEvents();
      peakSlip = Math.max(peakSlip, Math.abs(racer.slip));
    }
    // A visible slide...
    expect(peakSlip).toBeGreaterThan(0.2);
    // ...that never becomes a spin.
    expect(peakSlip).toBeLessThan(1.1);
    expect(racer.drift.charge).toBeGreaterThan(0.1);
    expect(speedOf(racer)).toBeGreaterThan(10);
  });

  it('pays out Surge on release, more for a longer slide', () => {
    const chargeToSurge = (seconds: number): number => {
      const { sim, racer } = solo();
      drive(sim, racer, 20, { ...emptyInput(), throttle: 1 });
      run(sim, seconds, { ...emptyInput(), throttle: 1, steer: -0.8, drift: true });
      const before = racer.surge;
      run(sim, 0.1, { ...emptyInput(), throttle: 1 });
      return racer.surge - before;
    };
    const short = chargeToSurge(0.8);
    const long = chargeToSurge(2.6);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeGreaterThanOrEqual(DRIFT.tierSurge[0]);
  });

  it('costs speed, so it is a choice rather than free', () => {
    const straight = solo();
    drive(straight.sim, straight.racer, 20, { ...emptyInput(), throttle: 1 });
    run(straight.sim, 3, { ...emptyInput(), throttle: 1, steer: -0.8 });

    const drifted = solo();
    drive(drifted.sim, drifted.racer, 20, { ...emptyInput(), throttle: 1 });
    run(drifted.sim, 3, { ...emptyInput(), throttle: 1, steer: -0.8, drift: true });

    expect(speedOf(drifted.racer)).toBeLessThan(speedOf(straight.racer));
  });
});

describe('surfaces', () => {
  it('caps speed lower off the road', () => {
    expect(SURFACES.grass.speedCap).toBeLessThan(SURFACES.road.speedCap);
    expect(SURFACES.sand.speedCap).toBeLessThan(SURFACES.road.speedCap);
    expect(SURFACES.water.grip).toBeLessThan(SURFACES.road.grip);
    for (const surface of Object.values(SURFACES)) {
      expect(surface.grip).toBeGreaterThan(0);
      expect(surface.speedCap).toBeGreaterThan(0.3);
      expect(surface.drag).toBeGreaterThan(0);
    }
  });

  it('actually slows a car that leaves the road', () => {
    const { sim, racer } = solo('overgrown-interchange');
    drive(sim, racer, 25, { ...emptyInput(), throttle: 1 });
    const onRoad = speedOf(racer);
    // Steer off, then straighten and hold the throttle out on the grass.
    run(sim, 1.6, { ...emptyInput(), throttle: 1, steer: 1 });
    run(sim, 4, { ...emptyInput(), throttle: 1 });
    expect(racer.onTrack).toBe(false);
    expect(speedOf(racer)).toBeLessThan(onRoad * 0.85);
  });
});

describe('run-off', () => {
  it('always brings a car back rather than pinning it', () => {
    const { sim, racer } = solo('overgrown-interchange');
    drive(sim, racer, 20, { ...emptyInput(), throttle: 1 });
    // Drive hard off the side, then steer back.
    run(sim, 3, { ...emptyInput(), throttle: 1, steer: 1 });
    const worst = Math.abs(racer.lateral);
    expect(worst).toBeGreaterThan(racer.currentHalfWidth);

    for (let i = 0; i < Math.ceil(30 / FIXED_STEP); i++) {
      // Steer back towards the centreline. Part throttle, because the turn
      // radius is grip limited: charging back at full speed turns wider.
      sim.step({ ...emptyInput(), throttle: 0.5, steer: racer.lateral < 0 ? -1 : 1 });
      sim.drainEvents();
      if (racer.onTrack) break;
    }
    expect(racer.onTrack).toBe(true);
  });

  it('never lets a racer leave the world', () => {
    const { sim, racer } = solo('overgrown-interchange');
    run(sim, 40, { ...emptyInput(), throttle: 1, steer: 0.35 });
    // The inward slide grows with distance, so a car driving flat out directly
    // away from the course reaches an equilibrium rather than the horizon.
    const bound = racer.currentHalfWidth + PHYSICS.offTrackMargin + racer.spec.topSpeed / PHYSICS.runOffReturn;
    expect(Math.abs(racer.lateral)).toBeLessThan(bound);
  });
});

describe('collisions', () => {
  it('separates two overlapping racers instead of merging them', () => {
    const sim = new Simulation(buildSetup({ trackId: 'saltflat-reliquary', entries: 2 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const [a, b] = sim.racers;
    if (!a || !b) throw new Error('need two racers');
    b.pos = { ...a.pos };
    for (let i = 0; i < 60; i++) {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThan(COLLISION.radius);
  });

  it('never tunnels a racer through an obstacle', () => {
    const sim = new Simulation(buildSetup({ trackId: 'emberfall-quarry', playerIndex: null }));
    for (let i = 0; i < Math.ceil(120 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
      sim.step(emptyInput());
      sim.drainEvents();
      for (const racer of sim.racers) {
        for (const obstacle of sim.track.obstacles) {
          const overlap = obstacle.radius + COLLISION.radius - Math.hypot(racer.pos.x - obstacle.x, racer.pos.z - obstacle.z);
          // A small overlap within one step's travel is the resolver doing its
          // job; a deep one means something passed straight through.
          expect(overlap).toBeLessThan(0.6);
        }
      }
    }
  });
});

describe('jumps', () => {
  it('leaves the ground over a crest and lands again', () => {
    // Overgrown Interchange has a deliberate flyover crest.
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', playerIndex: null }));
    let airborneSeen = false;
    let landings = 0;
    for (let i = 0; i < Math.ceil(200 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
      sim.step(emptyInput());
      for (const event of sim.drainEvents()) {
        if (event.type === 'jumpLand') landings += 1;
      }
      if (sim.racers.some((r) => r.airborne)) airborneSeen = true;
    }
    expect(airborneSeen).toBe(true);
    expect(landings).toBeGreaterThan(0);
  });

  it('never leaves a racer stuck in the air', () => {
    const sim = new Simulation(buildSetup({ trackId: 'overgrown-interchange', playerIndex: null }));
    const airborneFor = new Map<number, number>();
    for (let i = 0; i < Math.ceil(200 / FIXED_STEP) && sim.phase !== 'finished'; i++) {
      sim.step(emptyInput());
      sim.drainEvents();
      for (const racer of sim.racers) {
        const current = racer.airborne ? (airborneFor.get(racer.index) ?? 0) + FIXED_STEP : 0;
        airborneFor.set(racer.index, current);
        expect(current).toBeLessThan(4);
      }
    }
  });
});
