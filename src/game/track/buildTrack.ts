import type { Vec2 } from '../../core/math';
import { clamp, closestPointOnSegment, distanceSq, lerp, normalize, rightNormal } from '../../core/math';
import { catmullRom, catmullRomScalar, splineIndex } from './spline';
import type {
  BranchDefinition,
  Checkpoint,
  ControlPoint,
  HazardDefinition,
  ObstacleDefinition,
  Path,
  PathSample,
  Projection,
  SurfaceId,
  TrackDefinition,
} from './types';

/** Arc-length spacing of resampled path points, in metres. */
const SAMPLE_SPACING = 1.5;
/** Sub-samples per control-point segment used to measure arc length. */
const FINE_SUBDIVISIONS = 32;
/** Cell size of the broadphase grid used by `project`. */
const GRID_CELL = 12;

interface FineSample {
  pos: Vec2;
  y: number;
  halfWidth: number;
  bank: number;
  surface: SurfaceId;
  edge: ControlPoint['edge'];
  distance: number;
}

function attr<T>(points: readonly ControlPoint[], i: number, closed: boolean, pick: (p: ControlPoint) => T): T {
  return pick(points[splineIndex(i, points.length, closed)] as ControlPoint);
}

/**
 * Densely samples the spline through the control points and accumulates arc
 * length. Scalars (elevation, width, banking) use uniform Catmull-Rom so they
 * vary smoothly; discrete attributes (surface, edge) snap to the nearest
 * control point so a surface change has a crisp boundary.
 */
function fineSample(points: readonly ControlPoint[], closed: boolean): FineSample[] {
  const n = points.length;
  if (n < 2) throw new Error('A path needs at least two control points');
  const segments = closed ? n : n - 1;
  const out: FineSample[] = [];
  let distance = 0;
  let prev: Vec2 | null = null;

  for (let seg = 0; seg < segments; seg++) {
    const p0 = points[splineIndex(seg - 1, n, closed)] as ControlPoint;
    const p1 = points[splineIndex(seg, n, closed)] as ControlPoint;
    const p2 = points[splineIndex(seg + 1, n, closed)] as ControlPoint;
    const p3 = points[splineIndex(seg + 2, n, closed)] as ControlPoint;

    for (let s = 0; s < FINE_SUBDIVISIONS; s++) {
      const t = s / FINE_SUBDIVISIONS;
      const pos = catmullRom(p0, p1, p2, p3, t);
      if (prev) distance += Math.hypot(pos.x - prev.x, pos.z - prev.z);
      prev = pos;

      out.push({
        pos,
        y: catmullRomScalar(
          attr(points, seg - 1, closed, (p) => p.y ?? 0),
          attr(points, seg, closed, (p) => p.y ?? 0),
          attr(points, seg + 1, closed, (p) => p.y ?? 0),
          attr(points, seg + 2, closed, (p) => p.y ?? 0),
          t,
        ),
        halfWidth: catmullRomScalar(
          attr(points, seg - 1, closed, (p) => p.halfWidth),
          attr(points, seg, closed, (p) => p.halfWidth),
          attr(points, seg + 1, closed, (p) => p.halfWidth),
          attr(points, seg + 2, closed, (p) => p.halfWidth),
          t,
        ),
        bank: catmullRomScalar(
          attr(points, seg - 1, closed, (p) => p.bank ?? 0),
          attr(points, seg, closed, (p) => p.bank ?? 0),
          attr(points, seg + 1, closed, (p) => p.bank ?? 0),
          attr(points, seg + 2, closed, (p) => p.bank ?? 0),
          t,
        ),
        surface: (t < 0.5 ? p1.surface : p2.surface) ?? p1.surface ?? 'road',
        edge: (t < 0.5 ? p1.edge : p2.edge) ?? p1.edge ?? 'open',
        distance,
      });
    }
  }

  if (closed) {
    const first = out[0] as FineSample;
    const last = out[out.length - 1] as FineSample;
    distance += Math.hypot(first.pos.x - last.pos.x, first.pos.z - last.pos.z);
    out.push({ ...first, distance });
  } else {
    const lastPoint = points[n - 1] as ControlPoint;
    const last = out[out.length - 1] as FineSample;
    distance += Math.hypot(lastPoint.x - last.pos.x, lastPoint.z - last.pos.z);
    out.push({
      pos: { x: lastPoint.x, z: lastPoint.z },
      y: lastPoint.y ?? 0,
      halfWidth: lastPoint.halfWidth,
      bank: lastPoint.bank ?? 0,
      surface: lastPoint.surface ?? 'road',
      edge: lastPoint.edge ?? 'open',
      distance,
    });
  }

  return out;
}

/** Resamples the fine polyline at a uniform arc-length spacing. */
function resample(fine: FineSample[], closed: boolean): Omit<PathSample, 'tangent' | 'normal' | 'curvature' | 'mainDistance'>[] {
  const total = (fine[fine.length - 1] as FineSample).distance;
  const count = Math.max(8, Math.round(total / SAMPLE_SPACING));
  const step = total / count;
  // A closed path must not duplicate the seam sample, or the tangent at the
  // start/finish line degenerates to a zero-length segment.
  const emit = closed ? count : count + 1;
  const out: Omit<PathSample, 'tangent' | 'normal' | 'curvature' | 'mainDistance'>[] = [];

  let cursor = 0;
  for (let i = 0; i < emit; i++) {
    const target = Math.min(i * step, total);
    while (cursor < fine.length - 2 && (fine[cursor + 1] as FineSample).distance < target) cursor++;
    const a = fine[cursor] as FineSample;
    const b = fine[Math.min(cursor + 1, fine.length - 1)] as FineSample;
    const span = b.distance - a.distance;
    const t = span > 1e-9 ? clamp((target - a.distance) / span, 0, 1) : 0;
    out.push({
      pos: { x: lerp(a.pos.x, b.pos.x, t), z: lerp(a.pos.z, b.pos.z, t) },
      y: lerp(a.y, b.y, t),
      halfWidth: lerp(a.halfWidth, b.halfWidth, t),
      bank: lerp(a.bank, b.bank, t),
      surface: t < 0.5 ? a.surface : b.surface,
      edge: (t < 0.5 ? a.edge : b.edge) ?? 'open',
      distance: target,
    });
  }
  return out;
}

/**
 * Builds a path. When `mainSpan` is omitted the path *is* the main centreline,
 * so its main-line distance is simply its own arc length.
 */
function buildPath(
  id: string,
  points: readonly ControlPoint[],
  closed: boolean,
  mainSpan?: { entry: number; exit: number },
): Path {
  const fine = fineSample(points, closed);
  const base = resample(fine, closed);
  const n = base.length;
  const length = (fine[fine.length - 1] as FineSample).distance;
  const entryMainDistance = mainSpan ? mainSpan.entry : 0;
  const exitMainDistance = mainSpan ? mainSpan.exit : length;
  const span = exitMainDistance - entryMainDistance;

  const samples: PathSample[] = base.map((s, i) => {
    const prev = base[splineIndex(i - 1, n, closed)] as (typeof base)[number];
    const next = base[splineIndex(i + 1, n, closed)] as (typeof base)[number];
    const tangent = normalize({ x: next.pos.x - prev.pos.x, z: next.pos.z - prev.pos.z });
    return {
      ...s,
      tangent,
      // Right-hand normal: +90° on the XZ plane is the vehicle's right. See the
      // handedness rule in `core/math.ts`.
      normal: rightNormal(tangent),
      curvature: 0,
      mainDistance: entryMainDistance + (length > 1e-6 ? (s.distance / length) * span : 0),
    };
  });

  // Signed curvature from the turn angle between consecutive tangents divided
  // by the arc length between them; positive is a right-hand corner. Used for
  // AI corner-speed prediction and for banking the camera, so it needs to be
  // smooth, not just correct.
  for (let i = 0; i < n; i++) {
    const prev = samples[splineIndex(i - 1, n, closed)] as PathSample;
    const next = samples[splineIndex(i + 1, n, closed)] as PathSample;
    const crossProduct = prev.tangent.x * next.tangent.z - prev.tangent.z * next.tangent.x;
    const dotProduct = prev.tangent.x * next.tangent.x + prev.tangent.z * next.tangent.z;
    const turn = Math.atan2(crossProduct, dotProduct);
    const arc = Math.hypot(next.pos.x - prev.pos.x, next.pos.z - prev.pos.z);
    (samples[i] as PathSample).curvature = arc > 1e-6 ? turn / arc : 0;
  }

  // One smoothing pass: raw per-sample curvature is noisy enough that AI
  // braking would stutter on straights.
  const smoothed = samples.map((s, i) => {
    const a = (samples[splineIndex(i - 1, n, closed)] as PathSample).curvature;
    const c = (samples[splineIndex(i + 1, n, closed)] as PathSample).curvature;
    return a * 0.25 + s.curvature * 0.5 + c * 0.25;
  });
  smoothed.forEach((c, i) => {
    (samples[i] as PathSample).curvature = c;
  });

  return { id, closed, samples, length, entryMainDistance, exitMainDistance };
}

/**
 * Builds just the main centreline for a set of control points, without the
 * rest of a `Track`. Course files use it to lay out shortcuts in terms of
 * distance along the road rather than raw coordinates.
 */
export function previewMainPath(points: readonly ControlPoint[]): Path {
  return buildPath('main', points, true);
}

/**
 * Arc-length position of the point on `path` nearest to `point`. Only used at
 * build time, so a linear scan is fine and keeps the code obvious.
 */
function nearestDistanceOnPath(path: Path, point: Vec2): number {
  let best = 0;
  let bestDist = Infinity;
  const n = path.samples.length;
  for (let i = 0; i < n; i++) {
    const a = path.samples[i] as PathSample;
    const b = path.samples[path.closed ? (i + 1) % n : Math.min(i + 1, n - 1)] as PathSample;
    const t = closestPointOnSegment(point, a.pos, b.pos);
    const px = lerp(a.pos.x, b.pos.x, t);
    const pz = lerp(a.pos.z, b.pos.z, t);
    const d = (px - point.x) ** 2 + (pz - point.z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      let segment = b.distance - a.distance;
      if (segment < 0) segment += path.length;
      best = (a.distance + segment * t) % path.length;
    }
  }
  return best;
}

/** Uniform grid over path samples, so `project` never scans the whole track. */
class SampleGrid {
  private readonly cells = new Map<number, { path: Path; index: number }[]>();

  constructor(paths: readonly Path[]) {
    for (const path of paths) {
      path.samples.forEach((sample, index) => {
        const key = this.key(sample.pos.x, sample.pos.z);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push({ path, index });
      });
    }
  }

  private key(x: number, z: number): number {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    // Cantor-style pairing kept in 32 bits; tracks stay well inside ±32 km.
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  query(x: number, z: number, radiusCells: number): { path: Path; index: number }[] {
    const out: { path: Path; index: number }[] = [];
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        const bucket = this.cells.get(this.key((cx + dx) * GRID_CELL, (cz + dz) * GRID_CELL));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

/**
 * A fully derived track: geometry, collision corridor, checkpoints, AI
 * reference line and minimap all come from this one object. Nothing else in
 * the game is allowed to define track shape, which is what guarantees the AI
 * can drive every course the renderer can draw.
 */
export class Track {
  readonly definition: TrackDefinition;
  readonly main: Path;
  readonly branches: Path[];
  readonly allPaths: Path[];
  readonly checkpoints: Checkpoint[];
  readonly obstacles: readonly ObstacleDefinition[];
  readonly hazards: readonly HazardDefinition[];
  readonly length: number;
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private readonly grid: SampleGrid;

  constructor(definition: TrackDefinition) {
    this.definition = definition;
    this.main = buildPath('main', definition.points, true);
    this.length = this.main.length;

    // A branch's span on the main line is derived, not authored: project its
    // first and last control point onto the centreline. A designer only has to
    // draw a road that leaves and rejoins, and the checkpoint mapping follows.
    this.branches = definition.branches.map((branch: BranchDefinition) => {
      const first = branch.points[0];
      const last = branch.points[branch.points.length - 1];
      if (!first || !last) throw new Error(`Branch ${branch.id} on ${definition.id} has no control points`);
      const entry = nearestDistanceOnPath(this.main, first);
      let exit = nearestDistanceOnPath(this.main, last);
      if (exit <= entry) exit += this.length;
      if (exit - entry < 20) {
        throw new Error(`Branch ${branch.id} on ${definition.id} rejoins too soon to be a shortcut`);
      }
      if (exit - entry > this.length * 0.6) {
        throw new Error(`Branch ${branch.id} on ${definition.id} spans too much of the lap`);
      }
      return buildPath(branch.id, branch.points, false, { entry, exit });
    });
    this.allPaths = [this.main, ...this.branches];
    this.grid = new SampleGrid(this.allPaths);

    this.checkpoints = [];
    for (let i = 0; i < definition.checkpointCount; i++) {
      const mainDistance = (i / definition.checkpointCount) * this.length;
      const sample = this.sampleMain(mainDistance);
      this.checkpoints.push({
        index: i,
        mainDistance,
        pos: sample.pos,
        normal: sample.normal,
        halfWidth: sample.halfWidth,
      });
    }

    this.obstacles = definition.obstacles;
    this.hazards = definition.hazards;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const path of this.allPaths) {
      for (const s of path.samples) {
        const reach = s.halfWidth + 6;
        minX = Math.min(minX, s.pos.x - reach);
        maxX = Math.max(maxX, s.pos.x + reach);
        minZ = Math.min(minZ, s.pos.z - reach);
        maxZ = Math.max(maxZ, s.pos.z + reach);
      }
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  get laps(): number {
    return this.definition.laps;
  }

  /** Interpolated sample on the main centreline at an arc-length position. */
  sampleMain(distance: number): PathSample {
    return sampleAt(this.main, distance);
  }

  sampleOn(path: Path, distance: number): PathSample {
    return sampleAt(path, distance);
  }

  /** World position offset laterally from the main centreline. */
  pointAt(distance: number, lateral: number): Vec2 {
    const s = this.sampleMain(distance);
    return { x: s.pos.x + s.normal.x * lateral, z: s.pos.z + s.normal.z * lateral };
  }

  /**
   * Finds where a world position sits on the track network. Branches win over
   * the main line only when the racer is genuinely inside the branch corridor,
   * so brushing past a shortcut entrance does not silently reroute progress.
   */
  project(point: Vec2, preferredPath?: Path): Projection {
    const candidates = this.grid.query(point.x, point.z, 2);
    let best: Projection | null = null;
    let bestScore = Infinity;

    const consider = (path: Path, index: number): void => {
      const n = path.samples.length;
      const a = path.samples[index] as PathSample;
      const nextIndex = path.closed ? (index + 1) % n : Math.min(index + 1, n - 1);
      const b = path.samples[nextIndex] as PathSample;
      const t = closestPointOnSegment(point, a.pos, b.pos);
      const center: Vec2 = { x: lerp(a.pos.x, b.pos.x, t), z: lerp(a.pos.z, b.pos.z, t) };
      const tangent = normalize({ x: lerp(a.tangent.x, b.tangent.x, t), z: lerp(a.tangent.z, b.tangent.z, t) });
      const normal = rightNormal(tangent);
      const lateral = (point.x - center.x) * normal.x + (point.z - center.z) * normal.z;
      const halfWidth = lerp(a.halfWidth, b.halfWidth, t);

      // Score by the true distance to the clamped closest point, never by the
      // lateral component alone. When `t` clamps to a segment end the lateral
      // component stops meaning "how far away this is" — a segment 60 m further
      // round the lap can sit almost exactly on this point's normal and score
      // as if it were underneath the car. That made progress jump backwards and
      // forwards by tens of metres every frame and was the root cause of the AI
      // sawing at the wheel.
      const score =
        Math.hypot(point.x - center.x, point.z - center.z) -
        (preferredPath && path === preferredPath ? halfWidth * 0.25 : 0);
      if (score >= bestScore) return;

      let segmentLength = b.distance - a.distance;
      if (segmentLength < 0) segmentLength += path.length;
      const distance = (a.distance + segmentLength * t) % (path.closed ? path.length : Infinity);
      const mainDistance = lerp(a.mainDistance, b.mainDistance + (b.mainDistance < a.mainDistance ? this.length : 0), t);

      const bank = lerp(a.bank, b.bank, t);

      bestScore = score;
      best = {
        path,
        sampleIndex: index,
        distance,
        mainDistance: mainDistance % this.length,
        lateral,
        halfWidth,
        center,
        tangent,
        normal,
        /*
         * Elevation of the road *at this lateral offset*, not of the
         * centreline.
         *
         * Banking rotates the ribbon about its centreline, so on a 16 m
         * half-width at 9 degrees the low edge sits 2.5 m below the centre and
         * the high edge 2.5 m above it. Reporting the centreline height put a
         * car two metres in the air on the low side and buried in the mesh on
         * the high side, and — because the terrain was pinned to the centreline
         * too — the low half of every banked road was hidden *underground*.
         * That is what made a skiff on the inside of Saltflat's long bend look
         * like it was on sand while the physics correctly reported road.
         *
         * There is one road surface. This is its height.
         */
        y: lerp(a.y, b.y, t) + Math.sin(bank) * lateral,
        bank,
        curvature: lerp(a.curvature, b.curvature, t),
        surface: t < 0.5 ? a.surface : b.surface,
        edge: t < 0.5 ? a.edge : b.edge,
        onTrack: Math.abs(lateral) <= halfWidth,
      };
    };

    for (const c of candidates) consider(c.path, c.index);

    if (best === null) {
      // Far outside every grid cell (a racer flung well off the map). Fall back
      // to a linear scan of the main line so the sim never returns nonsense.
      let nearest = 0;
      let nearestDist = Infinity;
      this.main.samples.forEach((s, i) => {
        const d = distanceSq(s.pos, point);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = i;
        }
      });
      consider(this.main, nearest);
    }

    return best as unknown as Projection;
  }

  /** Signed forward gap from `a` to `b` in main-line arc length. */
  forwardGap(a: number, b: number): number {
    let gap = b - a;
    while (gap > this.length / 2) gap -= this.length;
    while (gap < -this.length / 2) gap += this.length;
    return gap;
  }
}

/** Interpolated sample lookup by arc length; wraps on closed paths. */
export function sampleAt(path: Path, distance: number): PathSample {
  const n = path.samples.length;
  let d = distance;
  if (path.closed) {
    d = ((d % path.length) + path.length) % path.length;
  } else {
    d = clamp(d, 0, path.length);
  }
  const spacing = path.length / (path.closed ? n : n - 1);
  const raw = d / spacing;
  const i = Math.floor(raw);
  const t = raw - i;
  const a = path.samples[splineIndex(i, n, path.closed)] as PathSample;
  const b = path.samples[splineIndex(i + 1, n, path.closed)] as PathSample;
  const tangent = normalize({ x: lerp(a.tangent.x, b.tangent.x, t), z: lerp(a.tangent.z, b.tangent.z, t) });
  return {
    pos: { x: lerp(a.pos.x, b.pos.x, t), z: lerp(a.pos.z, b.pos.z, t) },
    y: lerp(a.y, b.y, t),
    tangent,
    normal: rightNormal(tangent),
    halfWidth: lerp(a.halfWidth, b.halfWidth, t),
    bank: lerp(a.bank, b.bank, t),
    curvature: lerp(a.curvature, b.curvature, t),
    distance: d,
    surface: t < 0.5 ? a.surface : b.surface,
    edge: t < 0.5 ? a.edge : b.edge,
    mainDistance: lerp(a.mainDistance, b.mainDistance, t),
  };
}
