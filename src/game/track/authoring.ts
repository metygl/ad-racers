import { smoothstep } from '../../core/math';
import { sampleAt } from './buildTrack';
import type { ControlPoint, EdgeKind, Path, SurfaceId } from './types';

/**
 * Track authoring helpers.
 *
 * Courses are authored as a radius profile around a centre rather than as raw
 * XZ points. Two reasons, both practical:
 *
 *  1. A radius profile sampled in angle order is star-shaped, so the resulting
 *     loop cannot self-intersect. Hand-placed points can, and a track that
 *     crosses itself breaks projection, checkpoints and AI navigation at once.
 *     `tests/unit/track.test.ts` still checks for self-intersection, but this
 *     makes the failure mode structurally unlikely rather than merely tested.
 *  2. Shortcuts can be expressed as "the same corner at 70% of the radius",
 *     which is exactly how a real cut-through relates to the road it leaves.
 */

export interface RingNode {
  /** Angle around the centre, degrees. Must increase monotonically. */
  a: number;
  /** Distance from the centre, metres. */
  r: number;
  halfWidth: number;
  /** Centreline elevation, metres. */
  y?: number;
  /** Banking, degrees; positive raises the right edge. */
  bankDeg?: number;
  surface?: SurfaceId;
  edge?: EdgeKind;
}

export interface RingOptions {
  /** Uniform scale applied to every radius. */
  scale?: number;
  /** Horizontal stretch; 1 is circular. */
  aspectX?: number;
  aspectZ?: number;
  centerX?: number;
  centerZ?: number;
}

export interface Ring {
  points: ControlPoint[];
  /** Interpolated radius at any angle, wrapping around 360°. */
  radiusAt(angleDeg: number): number;
  /** Interpolated half-width at any angle. */
  halfWidthAt(angleDeg: number): number;
  /** Interpolated elevation at any angle. */
  elevationAt(angleDeg: number): number;
  /** A control point at an angle, optionally pulled in or pushed out. */
  pointAt(angleDeg: number, radiusScale: number, overrides?: Partial<ControlPoint>): ControlPoint;
}

function toXZ(angleDeg: number, radius: number, opts: Required<RingOptions>): { x: number; z: number } {
  const a = (angleDeg * Math.PI) / 180;
  return {
    x: opts.centerX + Math.cos(a) * radius * opts.scale * opts.aspectX,
    z: opts.centerZ + Math.sin(a) * radius * opts.scale * opts.aspectZ,
  };
}

/** Linear interpolation of a per-node scalar at an arbitrary angle. */
function interpolate(nodes: readonly RingNode[], angleDeg: number, pick: (n: RingNode) => number): number {
  const a = ((angleDeg % 360) + 360) % 360;
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const lo = nodes[i] as RingNode;
    const hi = nodes[(i + 1) % n] as RingNode;
    const loA = lo.a;
    const hiA = hi.a > lo.a ? hi.a : hi.a + 360;
    const target = a >= loA ? a : a + 360;
    if (target >= loA && target <= hiA) {
      const t = hiA === loA ? 0 : (target - loA) / (hiA - loA);
      return pick(lo) + (pick(hi) - pick(lo)) * t;
    }
  }
  return pick(nodes[0] as RingNode);
}

export function makeRing(nodes: readonly RingNode[], options: RingOptions = {}): Ring {
  const opts: Required<RingOptions> = {
    scale: options.scale ?? 1,
    aspectX: options.aspectX ?? 1,
    aspectZ: options.aspectZ ?? 1,
    centerX: options.centerX ?? 0,
    centerZ: options.centerZ ?? 0,
  };

  const points: ControlPoint[] = nodes.map((node) => {
    const { x, z } = toXZ(node.a, node.r, opts);
    const point: ControlPoint = { x, z, halfWidth: node.halfWidth };
    if (node.y !== undefined) point.y = node.y;
    if (node.bankDeg !== undefined) point.bank = (node.bankDeg * Math.PI) / 180;
    if (node.surface !== undefined) point.surface = node.surface;
    if (node.edge !== undefined) point.edge = node.edge;
    return point;
  });

  const radiusAt = (angleDeg: number): number => interpolate(nodes, angleDeg, (n) => n.r);
  const halfWidthAt = (angleDeg: number): number => interpolate(nodes, angleDeg, (n) => n.halfWidth);
  const elevationAt = (angleDeg: number): number => interpolate(nodes, angleDeg, (n) => n.y ?? 0);

  return {
    points,
    radiusAt,
    halfWidthAt,
    elevationAt,
    pointAt(angleDeg, radiusScale, overrides = {}) {
      const { x, z } = toXZ(angleDeg, radiusAt(angleDeg) * radiusScale, opts);
      return {
        x,
        z,
        y: elevationAt(angleDeg),
        halfWidth: halfWidthAt(angleDeg),
        ...overrides,
      };
    },
  };
}

/**
 * Control points for a shortcut that leaves and rejoins the main line.
 *
 * A branch built by scaling the ring's radius is not reliably shorter than the
 * road it leaves — the excursion out and back can cost more than the tighter
 * arc saves. Interpolating between two points *on the main centreline*, chosen
 * by distance along it, makes the shortest possible path the straight case, so
 * the saving is guaranteed by construction and `bulge` is purely a shaping
 * control: it bows the cut so the shortcut reads as a road rather than a ruler
 * line.
 *
 * ## Merging, which is the part that was wrong
 *
 * Meeting the main line at the right *place* is not enough; a branch has to
 * meet it going the right *way*. The first version was a straight chord plus a
 * sine arch, and both of those have their steepest slope exactly at the ends —
 * so every shipped shortcut rejoined the road at between 33 and 62 degrees of
 * tangent mismatch. On Saltflat, which is open-edged and 32 m wide, that cost a
 * slide. On Emberfall's walled seven-metre Conveyor it was a wall: a live
 * review measured 52.5 m/s down to 8.75 m/s in three quarters of a second, with
 * the skiff dumped off-road, for successfully *completing* the shortcut.
 *
 * The branch is therefore a blend. Near each mouth it *is* the main line —
 * same position, same tangent, same curvature — and it eases into the chord
 * across the middle. `smoothstep` has zero derivative at both ends, so the
 * handoff is tangential by construction rather than by tuning, and it stays
 * tangential if someone later changes the bulge.
 *
 * `tests/unit/track.test.ts` asserts every shipped shortcut actually saves
 * distance and merges within a few degrees, so neither half can silently break.
 */
export function chordAlong(
  path: Path,
  fromDistance: number,
  toDistance: number,
  count: number,
  bulge: number,
  attributes: (t: number) => Partial<ControlPoint>,
): ControlPoint[] {
  const a = sampleAt(path, fromDistance);
  const b = sampleAt(path, toDistance);
  const mid = sampleAt(path, (fromDistance + toDistance) / 2);
  const outward = { x: mid.pos.x - (a.pos.x + b.pos.x) / 2, z: mid.pos.z - (a.pos.z + b.pos.z) / 2 };
  const outLen = Math.hypot(outward.x, outward.z) || 1;

  /*
   * Sampled densely regardless of what the caller asked for.
   *
   * A Catmull-Rom's tangent at its first point is set by its first two points,
   * so with seven control points the second one already sits a third of the way
   * into the ease and the spline leaves the mouth at an angle anyway. The
   * caller's `count` is treated as a floor; the ease needs enough points to be
   * expressible.
   */
  const n = Math.max(count, 21);
  const out: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const here = sampleAt(path, fromDistance + (toDistance - fromDistance) * t);

    // The cut: a straight chord bowed out by a sine arch.
    const arch = Math.sin(t * Math.PI) * bulge;
    const chordX = a.pos.x + (b.pos.x - a.pos.x) * t + (outward.x / outLen) * arch;
    const chordZ = a.pos.z + (b.pos.z - a.pos.z) * t + (outward.z / outLen) * arch;

    // How much of the cut is in effect here: nothing at the mouths, all of it
    // through the middle, with a smooth (zero-derivative) ramp between.
    const blend = smoothstep(0, MERGE_FRACTION, t) * smoothstep(0, MERGE_FRACTION, 1 - t);

    const authored = attributes(t);

    /*
     * Through the merge the branch *is* the main road, so it must describe the
     * same corridor.
     *
     * Two overlapping corridors is not a cosmetic problem. Physics projects a
     * racer onto exactly one path and then applies that path's width and edge —
     * so a car in the middle of Emberfall's eight-metre main road, projected
     * onto the Conveyor's five-and-a-half-metre walled corridor lying on top of
     * it, hit a wall that visibly was not there. That is the 44 m/s the review
     * measured at the Conveyor exit.
     *
     * Where the branch has eased back onto the road it therefore inherits the
     * road's half-width and drops its own edge treatment; the branch's real
     * width and walls fade in with the cut itself.
     */
    const point: ControlPoint = {
      x: here.pos.x + (chordX - here.pos.x) * blend,
      z: here.pos.z + (chordZ - here.pos.z) * blend,
      y: here.y,
      halfWidth: here.halfWidth,
      ...authored,
    };
    const authoredWidth = authored.halfWidth ?? here.halfWidth;
    point.halfWidth = here.halfWidth + (authoredWidth - here.halfWidth) * blend;
    if (blend < 0.75) {
      // Still substantially on the road: the road's edge rule governs.
      delete point.edge;
      if (blend < 0.4) delete point.surface;
    }

    out.push(point);
  }
  return out;
}

/**
 * Fraction of a branch's length spent easing away from and back onto the main
 * line.
 *
 * Long enough that the merge is tangential at the resolution the control-point
 * density can express, short enough that the shortcut still spends most of
 * itself being a shortcut. At 0.3 it was neither: 60% of every branch followed
 * the road it was supposed to be cutting, which turned every shortcut on the
 * Circuit from a saving into a loss.
 */
const MERGE_FRACTION = 0.3;

/**
 * Scatters obstacles along a chord of the ring, which is how the courses place
 * rubble on a shortcut without hand-typing coordinates.
 */
export function scatterAlong(
  ring: Ring,
  fromAngle: number,
  toAngle: number,
  count: number,
  radiusScale: (t: number) => number,
  lateral: (t: number) => number,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angle = fromAngle + (toAngle - fromAngle) * t;
    const base = ring.pointAt(angle, radiusScale(t));
    const next = ring.pointAt(angle + 1, radiusScale(t));
    const dx = next.x - base.x;
    const dz = next.z - base.z;
    const len = Math.hypot(dx, dz) || 1;
    // Right-hand normal of the local direction (see `core/math.ts`).
    out.push({ x: base.x + (-dz / len) * lateral(t), z: base.z + (dx / len) * lateral(t) });
  }
  return out;
}

/**
 * Picks points a given fraction along a branch.
 *
 * Course files place rubble by indexing into the control-point array, which is
 * only stable if the array length is. It is not: `chordAlong` samples densely
 * so its merge ease is expressible, and a `slice(2, 5)` that used to mean
 * "the middle of the cut" silently became "just inside the mouth" — which,
 * after the merge rework, is *on the main racing line*. Every shortcut's
 * hazards had quietly moved onto the road.
 *
 * Fractions cannot drift like that.
 */
export function atFractions(points: readonly ControlPoint[], fractions: readonly number[]): ControlPoint[] {
  const last = points.length - 1;
  return fractions.map((t) => points[Math.round(Math.max(0, Math.min(1, t)) * last)] as ControlPoint);
}
