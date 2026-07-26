import type { Vec2 } from '../../core/math';

/**
 * Surfaces the simulation understands. Every visual surface in every track maps
 * onto one of these so the physics stays predictable and testable.
 */
export type SurfaceId = 'road' | 'dirt' | 'sand' | 'grass' | 'water' | 'ice';

export interface SurfaceProperties {
  /** Lateral grip multiplier. 1 = reference tarmac. */
  grip: number;
  /** Fraction of the vehicle's top speed reachable on this surface. */
  speedCap: number;
  /** Extra rolling drag, in units of the base rolling resistance. */
  drag: number;
  /** Screen-shake / rumble intensity, also drives dust particle rate. */
  roughness: number;
}

export const SURFACES: Record<SurfaceId, SurfaceProperties> = {
  road: { grip: 1.0, speedCap: 1.0, drag: 1.0, roughness: 0.05 },
  dirt: { grip: 0.82, speedCap: 0.94, drag: 1.35, roughness: 0.45 },
  sand: { grip: 0.66, speedCap: 0.7, drag: 2.1, roughness: 0.7 },
  grass: { grip: 0.58, speedCap: 0.52, drag: 2.8, roughness: 0.85 },
  water: { grip: 0.55, speedCap: 0.62, drag: 3.2, roughness: 0.55 },
  ice: { grip: 0.3, speedCap: 1.0, drag: 0.85, roughness: 0.02 },
};

/** How the world reacts at the edge of the drivable corridor. */
export type EdgeKind =
  /** No barrier: you can drive off, it is just slow. */
  | 'open'
  /** Solid barrier that pushes you back with an impact. */
  | 'wall';

export interface ControlPoint {
  x: number;
  z: number;
  /** Centreline elevation. */
  y?: number;
  /** Half-width of the drivable corridor at this point. */
  halfWidth: number;
  /** Banking in radians; positive banks the right edge up. */
  bank?: number;
  surface?: SurfaceId;
  edge?: EdgeKind;
}

export interface BranchDefinition {
  id: string;
  name: string;
  /** Human-facing hint shown on the track select card. */
  risk: string;
  /**
   * Control points for the branch. The first and last are projected onto the
   * main centreline at build time to derive the span of main-line distance the
   * branch covers, and branch progress maps linearly into that span. That is
   * what makes a shortcut legal by construction: riding it still sweeps
   * continuously through every checkpoint in between, and no shortcut can skip
   * one. See `docs/ARCHITECTURE.md`.
   */
  points: ControlPoint[];
}

export type ObstacleKind = 'rock' | 'pillar' | 'crate' | 'stump' | 'barrier' | 'monolith';

export interface ObstacleDefinition {
  x: number;
  z: number;
  radius: number;
  kind: ObstacleKind;
  /** Height, for the renderer. */
  height: number;
  /** How much of the racer's speed survives a hit. */
  restitution?: number;
}

export type HazardKind = 'boostPad' | 'mud' | 'gust';

export interface HazardDefinition {
  x: number;
  z: number;
  radius: number;
  kind: HazardKind;
  /** Direction for `gust` hazards, radians. */
  direction?: number;
  strength?: number;
}

export type SceneryKind =
  | 'pine'
  | 'broadleaf'
  | 'palm'
  | 'boulder'
  | 'monolith'
  | 'pylon'
  | 'reed'
  | 'crystal'
  | 'chimney';

export interface ScenerySpec {
  kind: SceneryKind;
  /** Instances per 100 m² inside the band. */
  density: number;
  /** Lateral band, in multiples of the local half-width, measured from centre. */
  bandInner: number;
  bandOuter: number;
  scaleMin: number;
  scaleMax: number;
}

export interface TrackTheme {
  /** Zenith / horizon / ground colours for the sky dome, as hex numbers. */
  skyTop: number;
  skyHorizon: number;
  fogColor: number;
  fogDensity: number;
  sunColor: number;
  sunIntensity: number;
  /** Sun direction in spherical terms; elevation in radians above horizon. */
  sunElevation: number;
  sunAzimuth: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  roadColor: number;
  shoulderColor: number;
  terrainColor: number;
  terrainAccent: number;
  /** Tint applied to dust and drift particles. */
  dustColor: number;
  /** Additive haze colour used for the speed streaks. */
  speedLineColor: number;
}

export interface TrackDefinition {
  id: string;
  name: string;
  /** One-line flavour shown on the select screen. */
  tagline: string;
  description: string;
  laps: number;
  /** Difficulty hint 1-3 shown as pips on the select card. */
  technicality: number;
  points: ControlPoint[];
  branches: BranchDefinition[];
  obstacles: ObstacleDefinition[];
  hazards: HazardDefinition[];
  scenery: ScenerySpec[];
  theme: TrackTheme;
  /** Surface outside the corridor. */
  offTrackSurface: SurfaceId;
  /** Number of ordered checkpoints, distributed evenly by arc length. */
  checkpointCount: number;
  /** Terrain noise amplitude for the surrounding landscape. */
  terrainRelief: number;
  /** Deterministic seed for scenery scatter and terrain noise. */
  seed: number;
}

export interface PathSample {
  pos: Vec2;
  y: number;
  /** Unit tangent, pointing forwards along the path. */
  tangent: Vec2;
  /** Unit normal, pointing to the **right** of the tangent (see `core/math.ts`). */
  normal: Vec2;
  halfWidth: number;
  bank: number;
  /** Signed curvature (1/m); positive is a turn to the **right**. */
  curvature: number;
  /** Arc length from the start of this path. */
  distance: number;
  surface: SurfaceId;
  edge: EdgeKind;
  /** Equivalent arc length on the main centreline. */
  mainDistance: number;
}

export interface Path {
  id: string;
  closed: boolean;
  samples: PathSample[];
  length: number;
  /** Main-centreline span this path covers (identical to [0, length] for main). */
  entryMainDistance: number;
  exitMainDistance: number;
}

export interface Checkpoint {
  index: number;
  /** Arc length along the main centreline. */
  mainDistance: number;
  pos: Vec2;
  normal: Vec2;
  halfWidth: number;
}

export interface Projection {
  path: Path;
  /** Index of the nearest sample. */
  sampleIndex: number;
  /** Arc length along that path. */
  distance: number;
  /** Equivalent arc length along the main centreline. */
  mainDistance: number;
  /** Signed lateral offset from the centreline; positive is to the **right**. */
  lateral: number;
  halfWidth: number;
  /** Interpolated centre position at `distance`. */
  center: Vec2;
  tangent: Vec2;
  normal: Vec2;
  y: number;
  bank: number;
  curvature: number;
  surface: SurfaceId;
  edge: EdgeKind;
  /** True when the racer is within the drivable corridor. */
  onTrack: boolean;
}
