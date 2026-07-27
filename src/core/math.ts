/**
 * Small maths helpers shared by the simulation and the renderer.
 *
 * The simulation deliberately does not import from `three`: it must run in a
 * plain Node process for the headless race tests. Anything the sim needs lives
 * here as flat numbers or `Vec2`.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `rate` is the fraction of the
 * remaining distance covered per second, so the result is identical whether
 * the caller steps at 60 Hz or 120 Hz.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = (angle + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Moves `current` towards `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

export function vec2(x = 0, z = 0): Vec2 {
  return { x, z };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, z: a.z * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

/** 2D cross product (the y component of the 3D cross); sign gives handedness. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.z - a.z * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.z);
}

export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.z * a.z;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len > 1e-9 ? { x: a.x / len, z: a.z / len } : { x: 0, z: 0 };
}

/**
 * Rotates a vector on the XZ plane. Positive angles turn +X towards +Z.
 *
 * ## The handedness rule, stated once
 *
 * The simulation's `(x, z)` plane *is* three.js's `(x, z)` plane: the renderer
 * maps them straight across. three.js is right-handed with +Y up, so +Z points
 * **towards the viewer**, and that single fact decides every left/right
 * question in this codebase:
 *
 * > Rotating a heading by **+90°** (the `+X → +Z` direction above) yields the
 * > vehicle's **right**, not its left.
 *
 * Check it: at heading 0 the nose is +X and up is +Y, so the vehicle's right is
 * `forward × up = X̂ × Ŷ = Ẑ` — and `rotate((1, 0), +90°) = (0, 1) = +Z`. The
 * same holds for a camera: three.js's `lookAt` builds its screen-right axis as
 * `up × (eye − target)`, which for a chase camera behind the car is exactly
 * this vector. Screen right and vehicle right agree.
 *
 * **Therefore an increasing heading is a turn to the right.** This is the
 * opposite of the intuition you get from sketching `(x, z)` on paper with z
 * pointing up the page, and getting it backwards is not a cosmetic mistake: it
 * inverts the steering. An earlier version of this file named the +90° vector
 * `leftOf`, and every consumer inherited the error — `stepVehicle` negated the
 * yaw to compensate, the AI negated its own steering output to compensate for
 * *that*, and the net result was that the AI drove correctly while the player's
 * "steer right" turned the skiff left. `tests/unit/handedness.test.ts` pins the
 * rule down in screen space so it cannot drift again.
 */
export function rotate(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.z * s, z: a.x * s + a.z * c };
}

/** Heading (radians) of a direction vector, matching `rotate`'s convention. */
export function heading(a: Vec2): number {
  return Math.atan2(a.z, a.x);
}

/** Unit vector for a heading. */
export function fromHeading(angle: number): Vec2 {
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

/**
 * Unit vector pointing to the **right** of a heading — the +90° rotation. See
 * the handedness rule on `rotate`.
 */
export function rightOf(angle: number): Vec2 {
  return { x: -Math.sin(angle), z: Math.cos(angle) };
}

/** Unit vector pointing to the **left** of a heading. */
export function leftOf(angle: number): Vec2 {
  return { x: Math.sin(angle), z: -Math.cos(angle) };
}

/** Right-hand normal of a unit tangent, without going via an angle. */
export function rightNormal(tangent: Vec2): Vec2 {
  return { x: -tangent.z, z: tangent.x };
}

/**
 * Closest point to `p` on the segment `a`→`b`, returned as the parametric
 * position along the segment in [0, 1].
 */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) return 0;
  return clamp01(((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq);
}

/** Formats seconds as `m:ss.mmm`, the format used by the HUD and results. */
export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  // Round to whole milliseconds *first*. Taking `seconds % 1` and flooring
  // loses a millisecond whenever the binary representation lands just under the
  // decimal value — 3599.999 formats as 59:59.998, which is the sort of thing
  // that turns a personal best into a mystery.
  const totalMillis = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMillis / 60000);
  const secs = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${minutes}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

/** `1st`, `2nd`, `3rd`, `4th` ... for the position readouts. */
export function ordinal(position: number): string {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}
