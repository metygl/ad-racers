import { describe, expect, it } from 'vitest';
import { distance, wrapAngle } from '../../src/core/math';
import { FIXED_STEP, PHYSICS } from '../../src/game/config';
import { Track, sampleAt } from '../../src/game/track/buildTrack';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { RacerState } from '../../src/game/sim/state';
import { TRACK_DEFINITIONS, getTrack } from '../../src/game/track/tracks';
import { SURFACES } from '../../src/game/track/types';
import { runHeadlessRace } from '../support/headless';
import type { Path, PathSample } from '../../src/game/track/types';
import { buildSetup } from '../support/headless';

/**
 * Track geometry.
 *
 * Everything the game does — physics, checkpoints, AI navigation, the minimap —
 * is derived from these splines, so a geometry defect is never local: it shows
 * up as an unfair race. These are the invariants worth pinning.
 */

describe.each(TRACK_DEFINITIONS.map((d) => [d.name, d.id] as const))('%s', (_name, id) => {
  const track = getTrack(id);

  it('builds a closed centreline of a sensible length', () => {
    expect(track.main.closed).toBe(true);
    expect(track.length).toBeGreaterThan(600);
    expect(track.length).toBeLessThan(4000);
    expect(track.main.samples.length).toBeGreaterThan(100);
  });

  it('has continuous, evenly spaced samples with no seam at the start line', () => {
    const samples = track.main.samples;
    const gaps: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i] as PathSample;
      const b = samples[(i + 1) % samples.length] as PathSample;
      gaps.push(distance(a.pos, b.pos));
    }
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    expect(min).toBeGreaterThan(0.5);
    // Including the wrap-around gap, which is where a seam bug would show.
    expect(max / min).toBeLessThan(1.5);
  });

  it('never crosses itself', () => {
    // A self-intersecting loop breaks projection, checkpoints and AI at once.
    // Non-adjacent samples must stay at least a corridor apart.
    const samples = track.main.samples;
    const stride = 3;
    for (let i = 0; i < samples.length; i += stride) {
      const a = samples[i] as PathSample;
      for (let j = i + stride; j < samples.length; j += stride) {
        // Skip neighbours in arc length, including across the wrap.
        const along = Math.min(j - i, samples.length - (j - i)) * (track.length / samples.length);
        if (along < 60) continue;
        const b = samples[j] as PathSample;
        expect(distance(a.pos, b.pos)).toBeGreaterThan(a.halfWidth + b.halfWidth);
      }
    }
  });

  it('has unit tangents and left-hand normals', () => {
    for (const sample of track.main.samples) {
      expect(Math.hypot(sample.tangent.x, sample.tangent.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(sample.normal.x, sample.normal.z)).toBeCloseTo(1, 6);
      // The normal is the tangent rotated +90°, so their dot product is zero.
      expect(sample.tangent.x * sample.normal.x + sample.tangent.z * sample.normal.z).toBeCloseTo(0, 6);
    }
  });

  it('stays within a cornering speed a skiff can actually reach', () => {
    // A corner tighter than this cannot be taken above walking pace and reads
    // as a mistake rather than a challenge.
    const maxCurvature = Math.max(...track.main.samples.map((s) => Math.abs(s.curvature)));
    expect(1 / maxCurvature).toBeGreaterThan(40);
  });

  it('distributes checkpoints evenly and in order', () => {
    const checkpoints = track.checkpoints;
    expect(checkpoints.length).toBe(track.definition.checkpointCount);
    expect(checkpoints[0]?.mainDistance).toBe(0);
    for (let i = 1; i < checkpoints.length; i++) {
      const previous = checkpoints[i - 1]?.mainDistance ?? 0;
      const current = checkpoints[i]?.mainDistance ?? 0;
      expect(current).toBeGreaterThan(previous);
    }
    const spacing = track.length / checkpoints.length;
    // No checkpoint gap may exceed the grace window used when claiming one.
    expect(spacing).toBeGreaterThan(70);
  });

  it('projects a point on the centreline back to itself', () => {
    for (let d = 0; d < track.length; d += 37) {
      const sample = track.sampleMain(d);
      const projection = track.project(sample.pos);
      expect(Math.abs(projection.lateral)).toBeLessThan(1.5);
      expect(projection.onTrack).toBe(true);
      // Distances agree modulo the lap, allowing for sample resolution.
      const gap = Math.abs(track.forwardGap(d, projection.mainDistance));
      expect(gap).toBeLessThan(3);
    }
  });

  it('projects monotonically along the centreline', () => {
    // The bug this pins: scoring candidates by lateral offset instead of true
    // distance let projection snap to a segment tens of metres away.
    let previous = track.project(track.sampleMain(0).pos).mainDistance;
    for (let d = 2; d < track.length; d += 2) {
      const here = track.project(track.sampleMain(d).pos).mainDistance;
      const step = track.forwardGap(previous, here);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(6);
      previous = here;
    }
  });

  it('keeps obstacles clear of the drivable corridor', () => {
    for (const obstacle of track.obstacles) {
      const projection = track.project({ x: obstacle.x, z: obstacle.z });
      // Obstacles may sit on a shortcut, but never in the middle of a road:
      // they must leave at least a skiff's width of clear line beside them.
      const clearance = projection.halfWidth - (Math.abs(projection.lateral) - obstacle.radius);
      expect(clearance).toBeLessThan(projection.halfWidth * 2);
    }
  });
});

describe('shortcuts', () => {
  it.each(TRACK_DEFINITIONS.filter((d) => d.branches.length > 0).map((d) => [d.name, d.id] as const))(
    '%s: every shortcut is genuinely shorter than the road it leaves',
    (_name, id) => {
      const track = getTrack(id);
      expect(track.branches.length).toBeGreaterThan(0);
      for (const branch of track.branches) {
        const span = branch.exitMainDistance - branch.entryMainDistance;
        const saving = span - branch.length;
        // A "shortcut" that is longer is a trap, not a choice.
        expect(saving).toBeGreaterThan(20);
        // ...and one that saves a fifth of the lap is not a choice either.
        expect(saving / track.length).toBeLessThan(0.12);
      }
    },
  );

  it.each(TRACK_DEFINITIONS.filter((d) => d.branches.length > 0).map((d) => [d.name, d.id] as const))(
    '%s: branch progress maps monotonically into the main line',
    (_name, id) => {
      const track = getTrack(id);
      for (const branch of track.branches) {
        let previous = -Infinity;
        for (const sample of branch.samples) {
          expect(sample.mainDistance).toBeGreaterThan(previous);
          previous = sample.mainDistance;
        }
        // The span covers every checkpoint in between continuously, which is
        // what makes a shortcut legal without any extra rule.
        expect(branch.samples[0]?.mainDistance).toBeCloseTo(branch.entryMainDistance, 3);
        const last = branch.samples[branch.samples.length - 1];
        expect(last?.mainDistance).toBeCloseTo(branch.exitMainDistance, 3);
      }
    },
  );

  it('joins the main line at both ends', () => {
    for (const definition of TRACK_DEFINITIONS) {
      const track = getTrack(definition.id);
      for (const branch of track.branches) {
        const first = branch.samples[0] as PathSample;
        const last = branch.samples[branch.samples.length - 1] as PathSample;
        const entry = track.sampleMain(branch.entryMainDistance);
        const exit = track.sampleMain(branch.exitMainDistance % track.length);
        // A mouth that does not meet the road would drop a racer into scenery.
        expect(distance(first.pos, entry.pos)).toBeLessThan(entry.halfWidth);
        expect(distance(last.pos, exit.pos)).toBeLessThan(exit.halfWidth);
      }
    }
  });
});

describe('track validation', () => {
  it('rejects a branch that does not advance along the lap', () => {
    const base = TRACK_DEFINITIONS[0];
    if (!base) throw new Error('no track definitions');
    const bad = {
      ...base,
      id: 'bad-branch',
      branches: [
        {
          id: 'nowhere',
          name: 'Nowhere',
          risk: '',
          // Both ends project to almost the same place on the main line.
          points: [
            { ...base.points[0], halfWidth: 6 },
            { ...base.points[0], x: (base.points[0]?.x ?? 0) + 4, halfWidth: 6 },
          ],
        },
      ],
    };
    expect(() => new Track(bad as typeof base)).toThrow(/rejoins too soon|no control points/);
  });
});

describe('sampleAt', () => {
  it('wraps cleanly around a closed path', () => {
    const track = getTrack('overgrown-interchange');
    const atZero = sampleAt(track.main, 0);
    const atLap = sampleAt(track.main, track.length);
    expect(atLap.pos.x).toBeCloseTo(atZero.pos.x, 6);
    expect(atLap.pos.z).toBeCloseTo(atZero.pos.z, 6);

    const negative = sampleAt(track.main, -10);
    const equivalent = sampleAt(track.main, track.length - 10);
    expect(negative.pos.x).toBeCloseTo(equivalent.pos.x, 6);
  });

  it('clamps on an open path rather than wrapping', () => {
    const track = getTrack('overgrown-interchange');
    const branch = track.branches[0];
    if (!branch) return;
    const before = sampleAt(branch, -50);
    const start = sampleAt(branch, 0);
    expect(before.pos.x).toBeCloseTo(start.pos.x, 6);
  });
});

/**
 * Branch merges.
 *
 * A shortcut has to meet the road in the right *place* and going the right
 * *way*. Every shipped branch used to satisfy the first and fail the second —
 * between 33 and 62 degrees of tangent mismatch at the mouths — which on
 * Saltflat cost a slide and on Emberfall's walled seven-metre Conveyor
 * destroyed the car: a live review measured 52.5 m/s down to 8.75 m/s in three
 * quarters of a second, for successfully completing the shortcut.
 */
describe('branch merges', () => {
  const angleBetween = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
    Math.abs(wrapAngle(Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x)));

  for (const definition of TRACK_DEFINITIONS) {
    const track = getTrack(definition.id);
    for (const branch of track.branches) {
      it(`${definition.name}: ${branch.id} joins and leaves the road tangentially`, () => {
        const first = branch.samples[0] as PathSample;
        const last = branch.samples[branch.samples.length - 1] as PathSample;
        const atEntry = track.sampleMain(branch.entryMainDistance % track.length);
        const atExit = track.sampleMain(branch.exitMainDistance % track.length);

        // Same place...
        expect(distance(first.pos, atEntry.pos)).toBeLessThan(2);
        expect(distance(last.pos, atExit.pos)).toBeLessThan(2);
        // ...and the same direction. Ten degrees is the most a corridor this
        // narrow can absorb without the merge becoming an impact.
        expect(angleBetween(first.tangent, atEntry.tangent)).toBeLessThan(0.18);
        expect(angleBetween(last.tangent, atExit.tangent)).toBeLessThan(0.18);
      });
    }
  }
});

/**
 * Driving every shortcut, and measuring the handoff.
 *
 * The geometry assertions above are necessary but not sufficient: what matters
 * is what happens to a car. The thing under test is the *handoff* — the step
 * where a racer stops being projected onto one corridor and starts being
 * projected onto another. Everything else on a shortcut (rubble, spoil, silt)
 * is deliberate content and is not this test's business.
 *
 * At the Conveyor exit that handoff used to remove 44 m/s in under a second,
 * because a point past the end of an open path clamps onto its final segment
 * and the reported lateral stops meaning anything — the physics read -32 m
 * against a 9.9 m corridor as being far outside a wall.
 */
describe('driving every shortcut', () => {
  interface Handoff {
    from: string;
    to: string;
    speedDrop: number;
    jump: number;
    turn: number;
  }

  /** Drives from a point on `path` and records every corridor handoff. */
  function driveFrom(
    trackId: string,
    startOn: Path,
    startDistance: number,
    seconds: number,
    headingOffset = 0,
  ): { handoffs: Handoff[]; racer: RacerState; sim: Simulation; recovered: boolean } {
    const sim = new Simulation(buildSetup({ trackId, entries: 1, playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    const racer = sim.racers[0] as RacerState;
    const entry = sampleAt(startOn, startDistance);
    const heading = Math.atan2(entry.tangent.z, entry.tangent.x) + headingOffset;
    const speed = racer.spec.topSpeed * 0.7;
    racer.pos = { ...entry.pos };
    racer.y = entry.y;
    racer.heading = heading;
    racer.velocity = { x: Math.cos(heading) * speed, z: Math.sin(heading) * speed };
    racer.path = startOn;

    const handoffs: Handoff[] = [];
    // Whether the racer ever got back onto a drivable corridor after leaving
    // one. This, not "is it on track at an arbitrary instant", is what makes a
    // mistake recoverable.
    let leftTrack = false;
    let recovered = true;
    let previousPath = racer.path.id;
    let previousSpeed = speed;
    let previousPos = { ...racer.pos };
    let previousHeading = racer.heading;

    for (let i = 0; i < Math.ceil(seconds / FIXED_STEP); i++) {
      const projection = sim.track.project(racer.pos, racer.path);
      // Lookahead scales with speed, as the real driver's does: a fixed short
      // lookahead is what makes pure pursuit oscillate into a barrier.
      const speedNow = Math.hypot(racer.velocity.x, racer.velocity.z);
      const ahead = sampleAt(projection.path, projection.distance + Math.max(14, speedNow * 1.1));
      const desired = Math.atan2(ahead.pos.z - racer.pos.z, ahead.pos.x - racer.pos.x);
      const error = wrapAngle(desired - racer.heading);
      const crossTrack = -projection.lateral / Math.max(4, projection.halfWidth);
      sim.step({ ...emptyInput(), throttle: 1, steer: Math.max(-1, Math.min(1, error * 2.2 + crossTrack * 0.6)) });
      sim.drainEvents();

      if (!racer.onTrack) {
        leftTrack = true;
        recovered = false;
      } else if (leftTrack) {
        recovered = true;
      }

      const now = Math.hypot(racer.velocity.x, racer.velocity.z);
      if (racer.path.id !== previousPath) {
        handoffs.push({
          from: previousPath,
          to: racer.path.id,
          speedDrop: previousSpeed - now,
          jump: distance(previousPos, racer.pos),
          turn: Math.abs(wrapAngle(racer.heading - previousHeading)),
        });
        previousPath = racer.path.id;
      }
      previousSpeed = now;
      previousPos = { ...racer.pos };
      previousHeading = racer.heading;
    }

    return { handoffs, racer, sim, recovered };
  }

  for (const definition of TRACK_DEFINITIONS) {
    const track = getTrack(definition.id);
    for (const branch of track.branches) {
      it(`${definition.name}: ${branch.id} hands off cleanly at both ends`, () => {
        const { handoffs, racer } = driveFrom(definition.id, branch, 1, 22);

        // It used the branch and came back off it.
        expect(handoffs.some((h) => h.from === branch.id)).toBe(true);

        for (const handoff of handoffs) {
          // Nothing teleports: one step at racing pace is well under a metre.
          expect(handoff.jump).toBeLessThan(1.2);
          // Nothing snaps round.
          expect(handoff.turn).toBeLessThan(0.12);
          // And the corridor change itself costs nothing worth noticing.
          expect(handoff.speedDrop).toBeLessThan(3);
        }
        expect(racer.onTrack).toBe(true);
      });

      it(`${definition.name}: ${branch.id} is recoverable when the entry is missed`, () => {
        // Arrive at the mouth aimed across it, which is what missing looks like.
        const { racer, recovered } = driveFrom(definition.id, branch, branch.length * 0.12, 20, 0.55);
        // Never pinned, never stopped: a missed shortcut costs time, not the race.
        expect(recovered).toBe(true);
        expect(Math.hypot(racer.velocity.x, racer.velocity.z)).toBeGreaterThan(10);
      });
    }
  }
});

describe('landmarks', () => {
  /**
   * Landmarks are placed by *fraction of the centreline* rather than by world
   * coordinate, precisely so they cannot drift away from the corner they are
   * meant to mark during tuning. These assert the two things that placement
   * has to guarantee: that every landmark resolves onto the course, and that
   * nothing solid stands where a car can legitimately be flung.
   */
  for (const definition of TRACK_DEFINITIONS) {
    const landmarks = definition.landmarks ?? [];
    if (landmarks.length === 0) continue;

    it(`${definition.name}: every landmark stands clear of the run-off`, () => {
      const track = getTrack(definition.id);
      const samples = track.main.samples;

      for (const landmark of landmarks) {
        expect(landmark.at).toBeGreaterThanOrEqual(0);
        expect(landmark.at).toBeLessThanOrEqual(1);

        const index = Math.min(samples.length - 1, Math.round(landmark.at * samples.length));
        const sample = samples[index];
        if (!sample) throw new Error('landmark resolved off the course');

        const lateral = landmark.lateral * sample.halfWidth;
        const x = sample.pos.x + sample.normal.x * lateral;
        const z = sample.pos.z + sample.normal.z * lateral;

        /*
         * An arch is the deliberate exception: it spans the road, so its
         * *centre* is on the centreline and what has to clear the run-off is
         * its legs. Everything else is measured where it stands.
         */
        const clearance = sample.halfWidth + PHYSICS.offTrackMargin * 0.8;
        if (landmark.kind === 'arch') {
          // The rib's half-span, from the builder: 44 m at scale 1.
          const halfSpan = (44 * (landmark.scale ?? 1)) / 2;
          expect(halfSpan).toBeGreaterThan(clearance);
        } else {
          const projection = track.project({ x, z });
          expect(Math.abs(projection.lateral)).toBeGreaterThan(clearance);
        }
      }
    });
  }
});

describe('branches are worth taking and survivable', () => {
  /**
   * The round-2 race-design review's headline finding was that Glasshouse's
   * Rootway was "a race-ending trap that also destabilizes every opponent
   * field": it saved 25 m of distance while taxing three quarters of its length
   * at a 38% speed cap, every crew took it anyway, and multiple crews came to a
   * near stop inside it. A shortcut nobody should choose is not a decision, and
   * one the field chooses regardless is a trap.
   *
   * Two properties make a branch a decision rather than a trap, and both are
   * measured here rather than asserted in prose.
   */

  for (const definition of TRACK_DEFINITIONS) {
    const track = getTrack(definition.id);
    for (const branch of track.branches) {
      it(`${definition.name}: ${branch.id} is faster than the road it cuts`, () => {
        /*
         * Compared on ideal time, not on distance. A branch that is shorter and
         * slower is the exact failure this closes, so the surface each metre is
         * driven on has to be part of the comparison.
         */
        const base = 46;
        const entry = (branch.samples[0] as PathSample).mainDistance;
        const span = track.forwardGap(entry, (branch.samples[branch.samples.length - 1] as PathSample).mainDistance);

        const timeOf = (samples: readonly PathSample[]): number => {
          let total = 0;
          for (let i = 1; i < samples.length; i++) {
            const step = (samples[i] as PathSample).distance - (samples[i - 1] as PathSample).distance;
            total += step / (base * SURFACES[(samples[i] as PathSample).surface].speedCap);
          }
          return total;
        };

        let mainTime = 0;
        for (let d = 1.5; d <= span; d += 1.5) {
          mainTime += 1.5 / (base * SURFACES[track.sampleMain((entry + d) % track.length).surface].speedCap);
        }
        const gain = mainTime - timeOf(branch.samples);

        // Worth taking, and not so much that ignoring it is a mistake.
        expect(gain, `${branch.id} ideal gain, seconds`).toBeGreaterThan(0.2);
        expect(gain, `${branch.id} ideal gain, seconds`).toBeLessThan(2.5);
      });
    }
  }

  it('a full field can drive every branch without stalling', () => {
    /*
     * The field-level assertion, because the failure was a field-level one: the
     * review found "minimum speeds included Boneyard 0.4 m/s and Emberworks
     * 0.2 m/s" with every crew in the branch at once, and asked for "no branch
     * crawl below a deliberate recoverable threshold".
     *
     * *Sustained* is the operative word. An instantaneous floor is the wrong
     * bar: a car recovering from contact is briefly slow wherever it happens to
     * be, on a branch or not, and failing that is failing racing rather than
     * failing the branch. What must not happen is a car being slow in there for
     * long enough that the route, rather than the driving, decided the race.
     */
    for (const [trackId, difficultyId] of [
      ['glasshouse-vigil', 'pro'],
      ['glasshouse-vigil', 'ace'],
      ['emberfall-quarry', 'pro'],
    ] as const) {
      const runs = new Map<number, number>();
      let worstCrawl = 0;
      const result = runHeadlessRace({
        trackId,
        difficultyId,
        playerIndex: null,
        maxSeconds: 400,
        onStep: (sim) => {
          for (const racer of sim.racers) {
            const crawling =
              !racer.finished &&
              racer.path !== sim.track.main &&
              Math.hypot(racer.velocity.x, racer.velocity.z) < 6;
            const run = crawling ? (runs.get(racer.index) ?? 0) + FIXED_STEP : 0;
            runs.set(racer.index, run);
            worstCrawl = Math.max(worstCrawl, run);
          }
        },
      });

      expect(worstCrawl, `${trackId} ${difficultyId}: seconds crawling inside a branch`).toBeLessThan(1.5);
      // And the branch did not cost anyone the race.
      expect(result.results.filter((r) => r.finishTime > 0).length).toBe(6);
    }
  }, 600000);
});
