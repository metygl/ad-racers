import * as THREE from 'three';

/**
 * The art bible, as code.
 *
 * `docs/ART-BIBLE.md` states a strict luminance ordering that is what keeps the
 * road readable at 48 m/s: racers brightest, then the road, then its edges,
 * then everything the world is made of, then the sky — bright but flat and
 * desaturated. Written down in prose that rule survives about a week. Written
 * down here, with a test that walks every shipped course and checks it, it
 * survives.
 *
 * `tests/unit/palette.test.ts` asserts the bands hold for every course theme.
 */

export interface ValueBand {
  min: number;
  max: number;
}

/**
 * Relative luminance bands, in linear light. Anything drawn in the world has to
 * land in the band for its layer.
 */
export const VALUE_BANDS = {
  /** Racers, strike flare, boost. Never lost against anything. */
  racer: { min: 0.16, max: 1 },
  /** The road surface. The one place the eye returns to. */
  road: { min: 0.05, max: 0.3 },
  /** Kerbs, shoulders, barriers — read brighter than the road they edge. */
  edge: { min: 0.1, max: 0.42 },
  /** Near terrain and set dressing. Always darker than the road. */
  terrain: { min: 0.012, max: 0.14 },
  /** Distant architecture. Silhouette only. */
  vista: { min: 0.008, max: 0.1 },
  /** Sky. Bright, but desaturated and flat. */
  sky: { min: 0.06, max: 0.95 },
} as const satisfies Record<string, ValueBand>;

/** Relative luminance of a colour, in linear light. */
export function luminance(color: THREE.ColorRepresentation): number {
  const c = new THREE.Color(color);
  // three.js stores colours in linear-sRGB once `Color` has converted them,
  // which is the space the coefficients below are defined in.
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/** HSL saturation of a colour, 0-1. */
export function saturation(color: THREE.ColorRepresentation): number {
  return new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).s;
}

export function inBand(color: THREE.ColorRepresentation, band: ValueBand): boolean {
  const l = luminance(color);
  return l >= band.min && l <= band.max;
}

/**
 * Per-course colour grading, applied in the composite pass.
 *
 * Grading is where a course gets its *feeling* as opposed to its palette. The
 * three-way lift/gamma/gain split is deliberate: lift moves the shadows without
 * touching the highlights, which is how a course reads as hazy or as crisp;
 * gain moves the highlights, which is how it reads as hot or as cold.
 */
export interface GradeSpec {
  exposure: number;
  lift: number[];
  gamma: number[];
  gain: number[];
  saturation: number;
  contrast: number;
  bloomThreshold: number;
  bloomIntensity: number;
  vignette: number;
}

export function toColor(rgb: number[]): THREE.Color {
  return new THREE.Color(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);
}

export const DEFAULT_GRADE: GradeSpec = {
  exposure: 1.05,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  saturation: 1.04,
  contrast: 1.03,
  bloomThreshold: 0.72,
  bloomIntensity: 0.6,
  vignette: 0.18,
};

/**
 * Crew colours, kept here rather than in `racers.ts` so the whole palette is
 * visible in one file and the value-band test has one place to look.
 *
 * The constraint the six of them satisfy together: any two must be separable at
 * 40 m from behind, in fog, and under the common forms of colour blindness. In
 * practice that means no two crews share a hue *family*, and — more importantly
 * — every crew also has a distinct silhouette, so colour is never carrying the
 * identification on its own.
 */
export interface CrewPalette {
  body: number;
  trim: number;
  glow: number;
}
