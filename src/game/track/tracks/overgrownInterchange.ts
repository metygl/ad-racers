import { chordAlong, makeRing, scatterAlong } from '../authoring';
import { previewMainPath } from '../buildTrack';
import type { RingNode } from '../authoring';
import type { ObstacleDefinition, TrackDefinition } from '../types';

/**
 * Course 1 — Overgrown Interchange.
 *
 * A motorway junction the forest took back. Wide, fast, forgiving: the course
 * that teaches drifting and the slipstream. One long sweeper, a crested
 * flyover that launches you, and a collapsed slip road that cuts the second
 * complex for anyone willing to run on broken dirt.
 */

const NODES: RingNode[] = [
  { a: 0, r: 246, halfWidth: 12.5, y: 0 },
  { a: 15, r: 251, halfWidth: 12.5, y: 0.5 },
  { a: 30, r: 249, halfWidth: 12, y: 1.8 },
  { a: 45, r: 233, halfWidth: 11, y: 3.6, bankDeg: 4 },
  { a: 60, r: 206, halfWidth: 10, y: 5.4, bankDeg: 7 },
  { a: 75, r: 179, halfWidth: 9, y: 6.2, bankDeg: 8 },
  { a: 90, r: 159, halfWidth: 8.6, y: 5.6, bankDeg: 6 },
  { a: 105, r: 151, halfWidth: 9, y: 4.0 },
  { a: 120, r: 159, halfWidth: 10, y: 2.2 },
  { a: 135, r: 181, halfWidth: 11.5, y: 1.0 },
  { a: 150, r: 213, halfWidth: 12.5, y: 0.4 },
  { a: 165, r: 239, halfWidth: 13, y: 0 },
  // The flyover: a fast climb to a crest that unweights the skiff.
  { a: 180, r: 253, halfWidth: 13, y: 2.5 },
  { a: 195, r: 251, halfWidth: 12.5, y: 8.5 },
  { a: 210, r: 237, halfWidth: 11.5, y: 9.0 },
  { a: 225, r: 206, halfWidth: 10, y: 4.5, bankDeg: 6 },
  { a: 240, r: 165, halfWidth: 9.2, y: 1.4, bankDeg: 9, surface: 'dirt' },
  { a: 255, r: 130, halfWidth: 8.6, y: 0.4, bankDeg: 10, surface: 'dirt' },
  // The old roundabout stub: the one place on this course you genuinely have
  // to brake, and the reason the slip road is worth thinking about.
  { a: 270, r: 116, halfWidth: 8.4, y: 0, surface: 'dirt' },
  { a: 285, r: 122, halfWidth: 9, y: 0, surface: 'dirt' },
  { a: 300, r: 152, halfWidth: 10, y: 0 },
  { a: 315, r: 193, halfWidth: 11, y: 0 },
  { a: 330, r: 223, halfWidth: 12, y: 0 },
  { a: 345, r: 239, halfWidth: 12.5, y: 0 },
];

const ring = makeRing(NODES, { scale: 1.16, aspectX: 1.12, aspectZ: 0.9 });
const mainLine = previewMainPath(ring.points);

/**
 * The collapsed slip road. It leaves the main line before the roundabout stub
 * and rejoins after it, cutting roughly 40 m of lap at the cost of a narrow,
 * low-grip surface with rubble in it. Its span on the main line is derived
 * from where the first and last points project, so it stays legal by
 * construction.
 */
const slipRoad = chordAlong(mainLine, 755, 1125, 7, 30, (t) => {
  const mouth = t < 0.12 || t > 0.88;
  return {
    halfWidth: mouth ? 8 : 5.8,
    ...(mouth ? {} : { surface: 'dirt' as const }),
  };
});

const rubble: ObstacleDefinition[] = slipRoad.slice(2, 5).map((p, i) => ({
  x: p.x + Math.cos(i * 2.1) * 2.2,
  z: p.z + Math.sin(i * 2.1) * 2.2,
  radius: 1.3 + (i % 2) * 0.4,
  kind: 'rock' as const,
  height: 1.8 + (i % 3) * 0.4,
}));

/** Fallen bridge pillars standing in the infield of the long sweeper. */
const pillars: ObstacleDefinition[] = scatterAlong(
  ring,
  60,
  110,
  3,
  () => 1.0,
  () => -14.5,
).map((p) => ({ ...p, radius: 2.2, kind: 'pillar' as const, height: 9 }));

export const OVERGROWN_INTERCHANGE: TrackDefinition = {
  id: 'overgrown-interchange',
  name: 'Overgrown Interchange',
  tagline: 'Four lanes of motorway, three hundred years of ivy.',
  description:
    'The first junction the Reclaim swallowed. Wide, quick and generous, with a flyover crest that ' +
    'throws you into the second half and a collapsed slip road for anyone who trusts their dirt lines.',
  laps: 3,
  technicality: 1,
  points: ring.points,
  branches: [
    {
      id: 'slip-road',
      name: 'Collapsed Slip Road',
      risk: 'Shorter, but narrow dirt with rubble in it.',
      points: slipRoad,
    },
  ],
  obstacles: [...rubble, ...pillars],
  hazards: [
    ...scatterAlong(ring, 170, 176, 1, () => 1.0, () => 0).map((p) => ({
      ...p,
      radius: 5,
      kind: 'boostPad' as const,
    })),
  ],
  scenery: [
    { kind: 'broadleaf', density: 0.9, bandInner: 1.25, bandOuter: 4.5, scaleMin: 0.8, scaleMax: 1.6 },
    { kind: 'pine', density: 0.55, bandInner: 2.2, bandOuter: 7, scaleMin: 0.9, scaleMax: 1.8 },
    { kind: 'pylon', density: 0.045, bandInner: 1.6, bandOuter: 3.2, scaleMin: 1, scaleMax: 1.2 },
    { kind: 'boulder', density: 0.3, bandInner: 1.1, bandOuter: 2.4, scaleMin: 0.5, scaleMax: 1.1 },
  ],
  theme: {
    skyTop: 0x2f5f93,
    skyHorizon: 0xcfe0d8,
    fogColor: 0xbcd2c6,
    fogDensity: 0.0022,
    sunColor: 0xfff2d0,
    sunIntensity: 2.1,
    sunElevation: 0.55,
    sunAzimuth: 2.1,
    ambientSky: 0x9dc2e8,
    ambientGround: 0x4a5c3a,
    ambientIntensity: 1.0,
    roadColor: 0x59605c,
    shoulderColor: 0x6e6a52,
    terrainColor: 0x40632f,
    terrainAccent: 0x6d8a3c,
    dustColor: 0xbfc5a8,
    speedLineColor: 0xdff0ff,
  },
  offTrackSurface: 'grass',
  checkpointCount: 12,
  terrainRelief: 9,
  seed: 0x0a17,
};
