import { describe, expect, it } from 'vitest';
import { PHYSICS } from '../../src/game/config';
import { TRACK_DEFINITIONS, getTrack } from '../../src/game/track/tracks';
import type { Track } from '../../src/game/track/buildTrack';
import type { Path, PathSample } from '../../src/game/track/types';

/**
 * Route truth: the road you can see is the road you can drive on.
 *
 * The round-2 gameplay review's sharpest finding was a frame in which the skiff
 * sits visibly on tarmac, between painted kerbs, while the simulation reports
 * `onTrack=false`, surface `sand`, and a lateral offset nine metres outside the
 * corridor. No amount of learned line discipline can solve a surface boundary
 * that contradicts the picture, and no other defect is worth fixing until this
 * one is: every grip, collision, recovery and AI decision is downstream of it.
 *
 * The renderer draws one ribbon per path from `sample.halfWidth`, so the
 * *drawn* drivable surface is the union of every path's corridor. The physics
 * projects a point onto exactly one path. Those two definitions have to agree,
 * and this file is the audit that says so.
 *
 * It is deliberately a property test over the whole geometry rather than a spot
 * check. A boundary bug lives at a specific overlap of a specific branch and is
 * invisible to any fixture that did not happen to pick that metre.
 */

/** Every path the renderer draws a road ribbon for. */
function drawnPaths(track: Track): Path[] {
  return [track.main, ...track.branches];
}

/** A world point at `lateral` metres from a sample's centre. */
function pointAt(sample: PathSample, lateral: number): { x: number; z: number } {
  return {
    x: sample.pos.x + sample.normal.x * lateral,
    z: sample.pos.z + sample.normal.z * lateral,
  };
}

describe('route truth', () => {
  for (const definition of TRACK_DEFINITIONS) {
    /**
     * Anywhere the renderer draws road, the simulation must agree it is road.
     *
     * Sampled across the full width of every corridor rather than down the
     * centreline: the failures are at the edges and in the overlaps, because
     * that is where two paths compete for the same point and the projection has
     * to choose.
     */
    it(`${definition.name}: every drawn corridor point is on track`, () => {
      const track = getTrack(definition.id);
      const failures: string[] = [];

      for (const path of drawnPaths(track)) {
        for (let i = 0; i < path.samples.length; i += 2) {
          const sample = path.samples[i] as PathSample;
          // Just inside the painted edge, the middle, and the centreline. The
          // edge samples are pulled in by a hand's width so this tests the
          // corridor rather than the boundary condition exactly on it.
          for (const fraction of [-0.94, -0.5, 0, 0.5, 0.94]) {
            const point = pointAt(sample, sample.halfWidth * fraction);
            const projection = track.project(point);
            if (!projection.onTrack) {
              failures.push(
                `${path.id} sample ${i} at ${(fraction * 100).toFixed(0)}% width: ` +
                  `projected onto ${projection.path.id} at lateral ${projection.lateral.toFixed(2)} ` +
                  `against half-width ${projection.halfWidth.toFixed(2)}`,
              );
            }
          }
        }
      }

      expect(failures.slice(0, 8)).toEqual([]);
    });

    /**
     * And the converse, which is the half that actually bites: a point the
     * renderer draws as *scenery* must not be reported as road. Without this
     * the first assertion could be satisfied by making every projection claim
     * to be on track everywhere.
     */
    it(`${definition.name}: nothing well outside every corridor reads as on track`, () => {
      const track = getTrack(definition.id);
      const paths = drawnPaths(track);
      const failures: string[] = [];

      for (let i = 0; i < track.main.samples.length; i += 4) {
        const sample = track.main.samples[i] as PathSample;
        for (const side of [-1, 1]) {
          // Well outside the run-off, so a legitimate branch running alongside
          // cannot be the explanation.
          const lateral = side * (sample.halfWidth + PHYSICS.offTrackMargin + 26);
          const point = pointAt(sample, lateral);

          /*
           * Skip anywhere any drawn corridor could legitimately reach.
           *
           * Measured against each path's *widest* half-width with a generous
           * margin, because a branch that swings 50 m off the main line is
           * doing exactly what a branch is for. Being conservative here is the
           * right trade: this assertion exists to stop the containment rule
           * degenerating into "everything is on track", and a probe that skips
           * a few legitimate metres still catches that.
           */
          const covered = paths.some((path) => {
            const reach = Math.max(...path.samples.map((s) => s.halfWidth)) + 12;
            return path.samples.some((s) => Math.hypot(s.pos.x - point.x, s.pos.z - point.z) <= reach);
          });
          if (covered) continue;

          const projection = track.project(point);
          if (projection.onTrack) {
            failures.push(
              `main sample ${i} at ${lateral.toFixed(1)} m: reported on ${projection.path.id} ` +
                `at lateral ${projection.lateral.toFixed(2)} of ${projection.halfWidth.toFixed(2)}`,
            );
          }
        }
      }

      expect(failures.slice(0, 8)).toEqual([]);
    });
  }
});
