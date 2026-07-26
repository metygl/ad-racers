/**
 * Quality tiers.
 *
 * The rule the game follows everywhere: playability is never traded for
 * effects. A tier drops shadow resolution, scenery density, particle budget and
 * draw distance — it never drops frame rate, and it never changes anything the
 * simulation can see, so a race is identical on every tier.
 */

export type QualityId = 'low' | 'medium' | 'high';

export interface QualitySettings {
  id: QualityId;
  label: string;
  description: string;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** 0 disables shadows entirely. */
  shadowMapSize: number;
  /** Half-extent of the shadow camera around the player, metres. */
  shadowRadius: number;
  /** Multiplier on every scenery spec's density. */
  sceneryDensity: number;
  /** Distance beyond which scenery instances are culled, metres. */
  sceneryDistance: number;
  /**
   * Multiplier on the ambient-life populations — marshals, motes, flock.
   *
   * Separate from `sceneryDensity` because life is not set dressing that scales
   * with it. A course with a *thin* crowd still reads as attended; a course
   * with none reads as abandoned, so even the low tier keeps some.
   */
  lifeDensity: number;
  /** Maximum simultaneous particles. */
  particleBudget: number;
  /** Terrain grid spacing, metres. Larger is cheaper. */
  terrainResolution: number;
  /** Whether the screen-space speed effects are drawn. */
  speedEffects: boolean;
  /** Whether vehicles cast shadows (the terrain always receives). */
  vehicleShadows: boolean;
  /** Anti-aliasing on the WebGL context. */
  antialias: boolean;
  /**
   * Whether the post-processing chain runs at all.
   *
   * Off on the low tier, and not as a token gesture: post costs a full-screen
   * read plus three reduced-resolution draws, which on the class of device that
   * lands on the low tier is a meaningful fraction of the frame. The art bible
   * requires the game to be readable without it, so switching it off costs
   * atmosphere and nothing else.
   */
  postProcessing: boolean;
}

export const QUALITY_TIERS: Record<QualityId, QualitySettings> = {
  low: {
    id: 'low',
    label: 'Low',
    description: 'Best for older laptops, tablets and phones.',
    maxPixelRatio: 1,
    shadowMapSize: 0,
    shadowRadius: 60,
    sceneryDensity: 0.35,
    sceneryDistance: 260,
    lifeDensity: 0.4,
    particleBudget: 120,
    terrainResolution: 10,
    speedEffects: false,
    vehicleShadows: false,
    antialias: false,
    postProcessing: false,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced. Shadows on, lighter scenery and particles.',
    maxPixelRatio: 1.5,
    shadowMapSize: 1024,
    shadowRadius: 85,
    sceneryDensity: 0.7,
    sceneryDistance: 420,
    lifeDensity: 0.75,
    particleBudget: 340,
    terrainResolution: 6,
    speedEffects: true,
    vehicleShadows: true,
    antialias: true,
    postProcessing: true,
  },
  high: {
    id: 'high',
    label: 'High',
    description: 'Full scenery, sharp shadows and the complete particle budget.',
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    shadowRadius: 110,
    sceneryDensity: 1,
    sceneryDistance: 650,
    lifeDensity: 1,
    particleBudget: 800,
    terrainResolution: 4,
    speedEffects: true,
    vehicleShadows: true,
    antialias: true,
    postProcessing: true,
  },
};

export const QUALITY_ORDER: readonly QualityId[] = ['low', 'medium', 'high'];

/**
 * First guess at a tier, before any frames have been measured.
 *
 * Deliberately conservative: it is far better to start at Medium and let the
 * adaptive monitor raise the tier than to open at High, stutter through the
 * countdown and drop back.
 */
export function detectInitialQuality(): QualityId {
  if (typeof navigator === 'undefined') return 'medium';

  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

  if (coarse || cores <= 4 || memory <= 3) return 'low';
  if (cores >= 8 && memory >= 8) return 'high';
  return 'medium';
}

/**
 * Watches frame times and moves the tier when the evidence is unambiguous.
 *
 * Two guards keep this from becoming a distraction in itself: it needs a full
 * sampling window of consistent evidence before acting, and once it has dropped
 * a tier it will not raise it again in the same session. Oscillating quality is
 * more annoying than the frame rate it is trying to protect.
 */
export class AdaptiveQuality {
  private samples: number[] = [];
  private hasDropped = false;
  private cooldown = 0;

  /** Frames sampled before a decision is considered. */
  private static readonly WINDOW = 90;
  /** Seconds after a change before another may be considered. */
  private static readonly COOLDOWN = 6;

  constructor(private current: QualityId) {}

  get tier(): QualityId {
    return this.current;
  }

  reset(tier: QualityId): void {
    this.current = tier;
    this.samples.length = 0;
    this.cooldown = AdaptiveQuality.COOLDOWN;
  }

  /**
   * Feeds one frame's duration in seconds. Returns the new tier if it changed.
   */
  sample(frameSeconds: number, elapsed: number): QualityId | null {
    if (this.cooldown > 0) {
      this.cooldown -= elapsed;
      return null;
    }
    this.samples.push(frameSeconds);
    if (this.samples.length < AdaptiveQuality.WINDOW) return null;

    // Use a high percentile rather than the mean: a smooth 60 fps with one
    // 200 ms hitch is a very different experience from a steady 45 fps, and
    // only the second one is worth changing settings over.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    this.samples.length = 0;

    const index = QUALITY_ORDER.indexOf(this.current);

    // Below ~45 fps at the 90th percentile, drop a tier.
    if (p90 > 1 / 45 && index > 0) {
      this.hasDropped = true;
      this.cooldown = AdaptiveQuality.COOLDOWN;
      this.current = QUALITY_ORDER[index - 1] as QualityId;
      return this.current;
    }

    // Comfortably above 60 fps with headroom to spare, and we have never had to
    // drop: it is safe to try the next tier up.
    if (!this.hasDropped && median < 1 / 100 && p90 < 1 / 75 && index < QUALITY_ORDER.length - 1) {
      this.cooldown = AdaptiveQuality.COOLDOWN;
      this.current = QUALITY_ORDER[index + 1] as QualityId;
      return this.current;
    }

    return null;
  }
}
