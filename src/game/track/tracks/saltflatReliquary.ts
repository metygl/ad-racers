import { chordAlong, makeRing, scatterAlong } from '../authoring';
import { previewMainPath } from '../buildTrack';
import type { RingNode } from '../authoring';
import type { HazardDefinition, ObstacleDefinition, TrackDefinition } from '../types';

/**
 * Course 2 — Saltflat Reliquary.
 *
 * A dry lake under a white noon sky, studded with the rusted spires the old
 * world left standing. The fastest course in the set: enormous width, long
 * committed sweeps, and almost no walls, so mistakes cost speed rather than
 * the race. Its trade is the lagoon — a straight line across standing water
 * that saves real distance at a real cost in grip.
 */

const NODES: RingNode[] = [
  { a: 0, r: 270, halfWidth: 16, y: 0 },
  { a: 15, r: 276, halfWidth: 16, y: 0 },
  { a: 30, r: 272, halfWidth: 15.5, y: 0.4 },
  { a: 45, r: 258, halfWidth: 15, y: 0.9, bankDeg: 5 },
  { a: 60, r: 238, halfWidth: 14.5, y: 1.2, bankDeg: 8 },
  { a: 75, r: 219, halfWidth: 14, y: 1.2, bankDeg: 9 },
  { a: 90, r: 209, halfWidth: 14, y: 0.9, bankDeg: 7 },
  { a: 105, r: 214, halfWidth: 14.5, y: 0.5 },
  { a: 120, r: 232, halfWidth: 15, y: 0.2 },
  { a: 135, r: 256, halfWidth: 15.5, y: 0 },
  { a: 150, r: 275, halfWidth: 16, y: 0 },
  { a: 165, r: 284, halfWidth: 16, y: 0 },
  { a: 180, r: 283, halfWidth: 16, y: 0 },
  { a: 195, r: 271, halfWidth: 15, y: 0 },
  { a: 210, r: 246, halfWidth: 13.5, y: 0 },
  // The one genuinely technical corner: a tightening left around a spire field.
  { a: 225, r: 209, halfWidth: 12, y: 0, bankDeg: 6 },
  { a: 240, r: 172, halfWidth: 10.5, y: 0, bankDeg: 9 },
  { a: 252, r: 152, halfWidth: 10, y: 0, bankDeg: 10 },
  { a: 264, r: 149, halfWidth: 10.5, y: 0, bankDeg: 8 },
  { a: 276, r: 163, halfWidth: 11.5, y: 0 },
  { a: 288, r: 182, halfWidth: 12.5, y: 0 },
  { a: 300, r: 205, halfWidth: 13.5, y: 0 },
  { a: 315, r: 231, halfWidth: 14.5, y: 0 },
  { a: 330, r: 251, halfWidth: 15.5, y: 0 },
  { a: 345, r: 262, halfWidth: 16, y: 0 },
];

const ring = makeRing(NODES, { scale: 1.02, aspectX: 1.2, aspectZ: 0.86 });
const mainLine = previewMainPath(ring.points);

/**
 * The Lagoon Line. A cut across the shallow water in the middle of the long
 * right-hand sweep. It is shorter, but `water` costs 42% top speed and over
 * half the grip, so it only pays if you carry enough entry speed and do not
 * have to steer once you are in it.
 *
 * Authored with `chordAlong` like every other shortcut rather than by hand.
 * The hand-placed version met the road at 33 degrees on entry and 45 on exit —
 * survivable here only because this course is open-edged and thirty metres
 * wide, and the same mistake on Emberfall's walled Conveyor was destroying
 * cars. One authoring path means one merge guarantee.
 */
const lagoon = chordAlong(mainLine, 585, 1040, 9, -44, (t) => {
  const mouth = t < 0.16 || t > 0.84;
  return {
    halfWidth: mouth ? 14 : 11,
    ...(mouth ? {} : { surface: 'water' as const }),
  };
});

/** Rusted spires. Big, obvious, and placed to reward a tidy line, not to trap. */
const spires: ObstacleDefinition[] = [
  ...scatterAlong(ring, 228, 274, 4, () => 0.82, (t) => Math.sin(t * Math.PI) * 5).map((p, i) => ({
    ...p,
    radius: 2.6,
    kind: 'monolith' as const,
    height: 16 + (i % 3) * 5,
  })),
  ...scatterAlong(ring, 40, 60, 2, () => 1.0, () => -22).map((p) => ({
    ...p,
    radius: 3,
    kind: 'monolith' as const,
    height: 22,
  })),
];

/**
 * Crosswind across the open flat.
 *
 * Tuned to be felt, not fought: at this strength it costs a bike-width of line
 * over the length of the straight, which a driver corrects without thinking.
 * Any stronger and it pushes a car that is doing nothing wrong off a 32 m wide
 * course, which reads as the game misbehaving rather than as weather.
 */
const gusts: HazardDefinition[] = scatterAlong(ring, 150, 190, 3, () => 1.0, () => 0).map((p) => ({
  ...p,
  radius: 26,
  kind: 'gust' as const,
  direction: Math.PI * 0.35,
  strength: 0.32,
}));

export const SALTFLAT_RELIQUARY: TrackDefinition = {
  id: 'saltflat-reliquary',
  name: 'Saltflat Reliquary',
  tagline: 'Flat, white, and far too fast for its own good.',
  description:
    'A dry lake with the old world sticking out of it. Enormous width and long committed sweeps ' +
    'make this the top-speed course; the crosswind and the lagoon cut decide it.',
  laps: 3,
  technicality: 2,
  points: ring.points,
  branches: [
    {
      id: 'lagoon-line',
      name: 'The Lagoon Line',
      risk: 'Straighter, but standing water halves your grip.',
      points: lagoon,
    },
  ],
  obstacles: spires,
  hazards: [
    ...gusts,
    ...scatterAlong(ring, 300, 306, 1, () => 1.0, () => 0).map((p) => ({
      ...p,
      radius: 6,
      kind: 'boostPad' as const,
    })),
  ],
  scenery: [
    { kind: 'monolith', density: 0.03, bandInner: 1.4, bandOuter: 6, scaleMin: 0.7, scaleMax: 2.2 },
    { kind: 'boulder', density: 0.35, bandInner: 1.1, bandOuter: 4, scaleMin: 0.3, scaleMax: 0.9 },
    { kind: 'reed', density: 0.7, bandInner: 1.05, bandOuter: 1.9, scaleMin: 0.6, scaleMax: 1.2 },
  ],
  theme: {
    // High, flat, brutal light on white salt. The grade pulls saturation *down*
    // rather than up: the drama here is glare and scale, and a bleached
    // landscape that is also colourful reads as a postcard rather than a place
    // nobody should be racing on.
    skyTop: 0x2a6fae,
    skyHorizon: 0xd6e2e8,
    fogColor: 0xdfe6e4,
    fogDensity: 0.0009,
    sunColor: 0xfffaf0,
    sunIntensity: 2.9,
    sunElevation: 1.05,
    sunAzimuth: 0.7,
    ambientSky: 0xcfe2f2,
    ambientGround: 0x8e8f84,
    ambientIntensity: 1.7,
    roadColor: 0x7d7f78,
    shoulderColor: 0x9a9484,
    kerbColor: 0xf0ede0,
    terrainColor: 0x5e6055,
    terrainAccent: 0x7a7a68,
    dustColor: 0xe8ecec,
    speedLineColor: 0xffffff,
    cloudiness: 0.22,
    grade: {
      lift: [0.02, 0.022, 0.026],
      gain: [1.0, 1.0, 1.02],
      saturation: 0.9,
      contrast: 1.06,
      bloomThreshold: 1.3,
      bloomIntensity: 0.44,
      vignette: 0.2,
    },
  },
  offTrackSurface: 'sand',
  checkpointCount: 12,
  terrainRelief: 3,
  seed: 0x5a17,
};
