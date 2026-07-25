import { makeRing, scatterAlong } from '../authoring';
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

/**
 * The Lagoon Line. A straight cut across the shallow water in the middle of
 * the long right-hand sweep. It is shorter, but `water` costs 42% top speed
 * and over half the grip, so it only pays if you carry enough entry speed and
 * do not have to steer once you are in it.
 */
const lagoon = [
  ring.pointAt(112, 1.0, { halfWidth: 11 }),
  ring.pointAt(128, 0.84, { halfWidth: 9, surface: 'water' }),
  ring.pointAt(150, 0.76, { halfWidth: 9, surface: 'water' }),
  ring.pointAt(172, 0.78, { halfWidth: 9, surface: 'water' }),
  ring.pointAt(190, 0.88, { halfWidth: 10, surface: 'water' }),
  ring.pointAt(204, 1.0, { halfWidth: 11 }),
];

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

/** Crosswind across the open flat, strong enough to notice on the long straight. */
const gusts: HazardDefinition[] = scatterAlong(ring, 150, 190, 3, () => 1.0, () => 0).map((p) => ({
  ...p,
  radius: 26,
  kind: 'gust' as const,
  direction: Math.PI * 0.35,
  strength: 0.55,
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
    skyTop: 0x2b6fc4,
    skyHorizon: 0xf2f7ff,
    fogColor: 0xe8f1f7,
    fogDensity: 0.0016,
    sunColor: 0xffffff,
    sunIntensity: 2.6,
    sunElevation: 1.15,
    sunAzimuth: 0.7,
    ambientSky: 0xcfe6ff,
    ambientGround: 0xd8d2c0,
    ambientIntensity: 1.25,
    roadColor: 0xd9d3c2,
    shoulderColor: 0xbfb7a2,
    terrainColor: 0xe6e2d6,
    terrainAccent: 0xc9bfa8,
    dustColor: 0xf2ecdd,
    speedLineColor: 0xffffff,
  },
  offTrackSurface: 'sand',
  checkpointCount: 12,
  terrainRelief: 3,
  seed: 0x5a17,
};
