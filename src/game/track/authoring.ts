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
  /** Banking, degrees; positive raises the left edge. */
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
 * Control points for a shortcut that cuts straight across a bend.
 *
 * A branch built by scaling the ring's radius is not reliably shorter than the
 * road it leaves — the excursion out and back can cost more than the tighter
 * arc saves. Interpolating between two points *on the main centreline*, chosen
 * by distance along it, makes the shortest possible path the `bulge = 0` case,
 * so the saving is guaranteed by construction and `bulge` is purely a shaping
 * control: it bows the cut towards the outside of the bend so the shortcut
 * reads as a road rather than a ruler line.
 *
 * `tests/unit/track.test.ts` asserts every shipped shortcut actually saves
 * distance, so a bulge tuned too far cannot silently ship.
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

  const out: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const here = sampleAt(path, fromDistance + (toDistance - fromDistance) * t);
    // A sine arch peaks in the middle and is zero at both ends, so the branch
    // always meets the main line exactly where it is supposed to.
    const arch = Math.sin(t * Math.PI) * bulge;
    out.push({
      x: a.pos.x + (b.pos.x - a.pos.x) * t + (outward.x / outLen) * arch,
      z: a.pos.z + (b.pos.z - a.pos.z) * t + (outward.z / outLen) * arch,
      y: here.y,
      halfWidth: here.halfWidth,
      ...attributes(t),
    });
  }
  return out;
}

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
    // Left normal of the local direction.
    out.push({ x: base.x + (-dz / len) * lateral(t), z: base.z + (dx / len) * lateral(t) });
  }
  return out;
}
