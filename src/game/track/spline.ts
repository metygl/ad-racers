import type { Vec2 } from '../../core/math';
import { clamp } from '../../core/math';

/**
 * Centripetal Catmull-Rom sampling.
 *
 * Centripetal (alpha = 0.5) rather than uniform parameterisation because
 * uniform Catmull-Rom overshoots and self-intersects when control points are
 * unevenly spaced — which is exactly what happens on a hand-authored track
 * where a hairpin has tight points and a straight has sparse ones. An
 * overshooting centreline would put the racing line outside the road.
 */

export interface SplinePoint {
  x: number;
  z: number;
}

function tj(ti: number, a: SplinePoint, b: SplinePoint, alpha: number): number {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  return ti + Math.pow(d, alpha);
}

/**
 * Evaluates the centripetal Catmull-Rom segment p1→p2 at local parameter
 * `t` in [0, 1], using p0 and p3 as tangent context.
 */
export function catmullRom(
  p0: SplinePoint,
  p1: SplinePoint,
  p2: SplinePoint,
  p3: SplinePoint,
  t: number,
  alpha = 0.5,
): Vec2 {
  const t0 = 0;
  const t1 = tj(t0, p0, p1, alpha);
  const t2 = tj(t1, p1, p2, alpha);
  const t3 = tj(t2, p2, p3, alpha);

  // Degenerate control points (duplicates) collapse the knot spacing; fall
  // back to a straight lerp rather than dividing by zero.
  if (t1 - t0 < 1e-9 || t2 - t1 < 1e-9 || t3 - t2 < 1e-9) {
    return { x: p1.x + (p2.x - p1.x) * t, z: p1.z + (p2.z - p1.z) * t };
  }

  const tt = t1 + (t2 - t1) * clamp(t, 0, 1);

  const a1x = ((t1 - tt) / (t1 - t0)) * p0.x + ((tt - t0) / (t1 - t0)) * p1.x;
  const a1z = ((t1 - tt) / (t1 - t0)) * p0.z + ((tt - t0) / (t1 - t0)) * p1.z;
  const a2x = ((t2 - tt) / (t2 - t1)) * p1.x + ((tt - t1) / (t2 - t1)) * p2.x;
  const a2z = ((t2 - tt) / (t2 - t1)) * p1.z + ((tt - t1) / (t2 - t1)) * p2.z;
  const a3x = ((t3 - tt) / (t3 - t2)) * p2.x + ((tt - t2) / (t3 - t2)) * p3.x;
  const a3z = ((t3 - tt) / (t3 - t2)) * p2.z + ((tt - t2) / (t3 - t2)) * p3.z;

  const b1x = ((t2 - tt) / (t2 - t0)) * a1x + ((tt - t0) / (t2 - t0)) * a2x;
  const b1z = ((t2 - tt) / (t2 - t0)) * a1z + ((tt - t0) / (t2 - t0)) * a2z;
  const b2x = ((t3 - tt) / (t3 - t1)) * a2x + ((tt - t1) / (t3 - t1)) * a3x;
  const b2z = ((t3 - tt) / (t3 - t1)) * a2z + ((tt - t1) / (t3 - t1)) * a3z;

  return {
    x: ((t2 - tt) / (t2 - t1)) * b1x + ((tt - t1) / (t2 - t1)) * b2x,
    z: ((t2 - tt) / (t2 - t1)) * b1z + ((tt - t1) / (t2 - t1)) * b2z,
  };
}

/** Scalar Catmull-Rom (uniform) used for width / elevation / banking tracks. */
export function catmullRomScalar(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Index helper shared by every spline walk: clamps for open paths, wraps for
 * closed ones. Keeping it in one place is what stops the classic off-by-one
 * seam where a closed track has a kink at the start/finish line.
 */
export function splineIndex(i: number, count: number, closed: boolean): number {
  if (closed) return ((i % count) + count) % count;
  return clamp(i, 0, count - 1);
}
