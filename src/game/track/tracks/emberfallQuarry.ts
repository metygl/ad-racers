import { chordAlong, makeRing, scatterAlong } from '../authoring';
import { previewMainPath } from '../buildTrack';
import type { RingNode } from '../authoring';
import type { ObstacleDefinition, TrackDefinition } from '../types';

/**
 * Course 3 — Emberfall Quarry.
 *
 * A worked-out basalt quarry at last light, still warm underneath. The
 * technical course: narrow, walled ledges, steep elevation, dirt underfoot and
 * two blind crests. Every edge here is a `wall`, so a mistake bounces you
 * rather than dumping you into the scenery — which is what makes a course this
 * tight fair to race on.
 */

const NODES: RingNode[] = [
  { a: 0, r: 196, halfWidth: 10, y: 0, surface: 'dirt', edge: 'wall' },
  { a: 14, r: 200, halfWidth: 10, y: 1.5, surface: 'dirt', edge: 'wall' },
  { a: 28, r: 193, halfWidth: 9, y: 4.5, surface: 'dirt', edge: 'wall' },
  // Climb onto the upper bench.
  { a: 42, r: 175, halfWidth: 8, y: 9.5, surface: 'dirt', edge: 'wall', bankDeg: 6 },
  { a: 56, r: 151, halfWidth: 7.4, y: 14, surface: 'dirt', edge: 'wall', bankDeg: 9 },
  { a: 70, r: 132, halfWidth: 7, y: 16.5, surface: 'dirt', edge: 'wall', bankDeg: 11 },
  { a: 84, r: 126, halfWidth: 7, y: 17, surface: 'dirt', edge: 'wall', bankDeg: 8 },
  { a: 98, r: 134, halfWidth: 7.6, y: 16, surface: 'dirt', edge: 'wall' },
  // Blind crest, then the drop back down the face.
  { a: 112, r: 154, halfWidth: 8.4, y: 17.5, surface: 'dirt', edge: 'wall' },
  { a: 126, r: 180, halfWidth: 9.2, y: 12, surface: 'dirt', edge: 'wall' },
  { a: 140, r: 203, halfWidth: 10, y: 6, surface: 'dirt', edge: 'wall' },
  { a: 154, r: 216, halfWidth: 10.5, y: 2.5, surface: 'road', edge: 'wall' },
  { a: 168, r: 220, halfWidth: 11, y: 0.5, surface: 'road', edge: 'wall' },
  { a: 182, r: 214, halfWidth: 11, y: 0, surface: 'road', edge: 'wall' },
  { a: 196, r: 197, halfWidth: 10, y: 0, surface: 'road', edge: 'wall', bankDeg: 7 },
  { a: 210, r: 172, halfWidth: 9, y: 0, surface: 'road', edge: 'wall', bankDeg: 10 },
  // The Kiln: the tightest corner in the game, taken in second-tier drift.
  { a: 224, r: 145, halfWidth: 8, y: 0.5, surface: 'dirt', edge: 'wall', bankDeg: 12 },
  { a: 236, r: 128, halfWidth: 7.6, y: 1.5, surface: 'dirt', edge: 'wall', bankDeg: 12 },
  { a: 248, r: 126, halfWidth: 7.6, y: 2.5, surface: 'dirt', edge: 'wall', bankDeg: 8 },
  { a: 262, r: 138, halfWidth: 8.2, y: 3, surface: 'dirt', edge: 'wall' },
  { a: 278, r: 160, halfWidth: 9, y: 2.5, surface: 'dirt', edge: 'wall' },
  { a: 296, r: 180, halfWidth: 9.6, y: 1.5, surface: 'dirt', edge: 'wall' },
  { a: 316, r: 191, halfWidth: 10, y: 0.8, surface: 'dirt', edge: 'wall' },
  { a: 340, r: 195, halfWidth: 10, y: 0.2, surface: 'dirt', edge: 'wall' },
];

const ring = makeRing(NODES, { scale: 1.0, aspectX: 1.05, aspectZ: 0.94 });
const mainLine = previewMainPath(ring.points);

/**
 * The Conveyor. A raised maintenance ledge that skips the outside of the upper
 * bench. It is barely wider than two skiffs, walled on both sides, and has
 * spoil heaps on it — but it holds more speed than the proper line if you get
 * it right.
 */
const conveyor = chordAlong(mainLine, 360, 660, 7, 34, (t) => {
  const mouth = t < 0.12 || t > 0.88;
  return { halfWidth: mouth ? 7.5 : 5.4, surface: 'dirt' as const, edge: 'wall' as const };
});

const spoil: ObstacleDefinition[] = conveyor.slice(2, 5).map((p, i) => ({
  x: p.x + Math.cos(i * 2.4) * 1.7,
  z: p.z + Math.sin(i * 2.4) * 1.7,
  radius: 1.1,
  kind: 'crate' as const,
  height: 1.5 + (i % 2) * 0.5,
  restitution: 0.15,
}));

/** Basalt columns standing where the quarry face used to be. */
const columns: ObstacleDefinition[] = scatterAlong(ring, 150, 200, 4, () => 1.0, () => -16).map((p, i) => ({
  ...p,
  radius: 2.4,
  kind: 'pillar' as const,
  height: 12 + (i % 2) * 6,
}));

export const EMBERFALL_QUARRY: TrackDefinition = {
  id: 'emberfall-quarry',
  name: 'Emberfall Quarry',
  tagline: 'Still warm under the gravel, three centuries on.',
  description:
    'Basalt benches, blind crests and walls on both sides. The technical course: brake early, ' +
    'commit to the drift, and think twice before you take the Conveyor.',
  laps: 3,
  technicality: 3,
  points: ring.points,
  branches: [
    {
      id: 'conveyor',
      name: 'The Conveyor',
      risk: 'Two skiffs wide, walled, with spoil on it.',
      points: conveyor,
    },
  ],
  obstacles: [...spoil, ...columns],
  hazards: [
    ...scatterAlong(ring, 176, 182, 1, () => 1.0, () => 0).map((p) => ({
      ...p,
      radius: 5,
      kind: 'boostPad' as const,
    })),
    ...scatterAlong(ring, 288, 296, 2, () => 1.0, (t) => -3 + t * 6).map((p) => ({
      ...p,
      radius: 7,
      kind: 'mud' as const,
    })),
  ],
  scenery: [
    { kind: 'chimney', density: 0.02, bandInner: 1.5, bandOuter: 4, scaleMin: 1, scaleMax: 1.8 },
    { kind: 'boulder', density: 1.1, bandInner: 1.05, bandOuter: 3.2, scaleMin: 0.4, scaleMax: 1.4 },
    { kind: 'crystal', density: 0.28, bandInner: 1.1, bandOuter: 2.6, scaleMin: 0.5, scaleMax: 1.3 },
    { kind: 'pine', density: 0.2, bandInner: 2.6, bandOuter: 6, scaleMin: 0.6, scaleMax: 1.1 },
  ],
  theme: {
    // Last light in a basalt quarry: a low sun raking across black rock, with
    // the only warmth in the sky and in the ember glow. The one course where
    // full-saturation accents are load bearing, because in this light the
    // corridor is otherwise nearly monochrome.
    skyTop: 0x1c2544,
    skyHorizon: 0xb4593a,
    fogColor: 0x60404a,
    fogDensity: 0.0022,
    sunColor: 0xffb066,
    sunIntensity: 2.2,
    sunElevation: 0.16,
    sunAzimuth: 3.5,
    ambientSky: 0x5a6a9a,
    ambientGround: 0x3a2620,
    ambientIntensity: 1.55,
    roadColor: 0x4e4a4e,
    shoulderColor: 0x5c4a44,
    kerbColor: 0xff9b52,
    terrainColor: 0x241d24,
    terrainAccent: 0x3d2c2a,
    dustColor: 0xc2a08c,
    speedLineColor: 0xffd0a0,
    cloudiness: 0.68,
    grade: {
      // Cool shadows against a hot key is what makes a sunset read as a sunset
      // rather than as an orange filter over a daytime scene.
      lift: [0.014, 0.016, 0.03],
      gain: [1.08, 0.99, 0.93],
      saturation: 1.1,
      contrast: 1.05,
      bloomThreshold: 1.0,
      bloomIntensity: 0.62,
      vignette: 0.22,
    },
  },
  offTrackSurface: 'dirt',
  checkpointCount: 12,
  terrainRelief: 16,
  seed: 0xe317,
};
