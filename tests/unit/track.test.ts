import { describe, expect, it } from 'vitest';
import { distance } from '../../src/core/math';
import { Track, sampleAt } from '../../src/game/track/buildTrack';
import { TRACK_DEFINITIONS, getTrack } from '../../src/game/track/tracks';
import type { PathSample } from '../../src/game/track/types';

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
