import { chordAlong, makeRing, scatterAlong } from '../authoring';
import { previewMainPath } from '../buildTrack';
import type { RingNode } from '../authoring';
import type { ObstacleDefinition, TrackDefinition } from '../types';

/**
 * Course 4 — Glasshouse Vigil.
 *
 * A collapsed agricultural arcology, raced at night. The crews run it once a
 * year, by the light of whatever the old growth lamps still have in them.
 *
 * ## Why a night course exists
 *
 * The other three are a hazy afternoon, a bleached noon and a low sunset. All
 * three get their drama from a *sun*, which means all three solve the same
 * lighting problem three ways. A night course is the one direction the set does
 * not cover, and it changes what the game is made of rather than what colour it
 * is: the key light is nearly gone, the fill is a cold sky, and every readable
 * thing on the course has to earn its own light. That is a different art
 * problem, and it is the reason this is worth adding rather than padding.
 *
 * ## What it is for as a race
 *
 * Medium-fast and rhythmic, sitting between the salt flat and the quarry. Long
 * radius corners a player can commit to, a mid-lap chicane through the fallen
 * roof frames that punishes a lazy line, and one genuinely long straight where
 * the tow is the whole story: sit in a rival's wake down the Nave, bank the
 * snap, and choose your moment. It is the course the tow mechanic was tuned on.
 *
 * The corridor is open-edged for most of the lap and walled only through the
 * frames, so a mistake is usually survivable — this is a *night* course, and
 * one that also punished every error would be miserable rather than tense.
 */

const NODES: RingNode[] = [
  // --- start / finish, on the old loading apron -----------------------------
  { a: 0, r: 232, halfWidth: 11.5, y: 0 },
  { a: 12, r: 238, halfWidth: 11.5, y: 0 },
  { a: 24, r: 240, halfWidth: 11, y: 0.6 },

  // --- Turn 1: a long, slightly banked right that opens onto the Nave -------
  { a: 38, r: 228, halfWidth: 10.5, y: 1.8, bankDeg: 5 },
  { a: 52, r: 205, halfWidth: 10, y: 3.2, bankDeg: 8 },
  { a: 66, r: 181, halfWidth: 10, y: 3.8, bankDeg: 8 },
  { a: 80, r: 168, halfWidth: 10.5, y: 3.4, bankDeg: 4 },

  // --- The Nave: the long straight, and the tow's home ----------------------
  // Deliberately the widest part of the course. The tow snap is a decision
  // about *when*, and a decision needs room to act on.
  { a: 96, r: 176, halfWidth: 13, y: 2.2 },
  { a: 112, r: 199, halfWidth: 13.5, y: 1.0 },
  { a: 128, r: 224, halfWidth: 13.5, y: 0.4 },
  { a: 144, r: 242, halfWidth: 13, y: 0 },

  // --- The Frames: a walled chicane through the fallen roof -----------------
  // The one place on the course with barriers. Narrow, kinked, and the only
  // section where a bad line costs a bounce rather than a slide.
  { a: 158, r: 246, halfWidth: 8.4, y: 0, edge: 'wall' },
  { a: 168, r: 240, halfWidth: 7.6, y: 0.4, edge: 'wall', bankDeg: -4 },
  { a: 178, r: 244, halfWidth: 7.6, y: 1.0, edge: 'wall', bankDeg: 5 },
  { a: 188, r: 238, halfWidth: 8, y: 1.4, edge: 'wall', bankDeg: -3 },
  { a: 198, r: 226, halfWidth: 9.5, y: 1.2, edge: 'wall' },

  // --- The Terraces: a climb over two crests, the second one blind ----------
  { a: 212, r: 205, halfWidth: 10, y: 4.5 },
  { a: 222, r: 189, halfWidth: 10, y: 8.5 },
  { a: 229, r: 180, halfWidth: 9.6, y: 10.4 },
  { a: 235, r: 174, halfWidth: 9.4, y: 8.2 },
  { a: 244, r: 165, halfWidth: 9.2, y: 5.4 },

  // --- The Cistern: the tight left, taken on the brakes ---------------------
  { a: 258, r: 143, halfWidth: 8.6, y: 3.0, surface: 'dirt', bankDeg: 10 },
  { a: 270, r: 130, halfWidth: 8.2, y: 1.8, surface: 'dirt', bankDeg: 12 },
  { a: 282, r: 132, halfWidth: 8.4, y: 1.0, surface: 'dirt', bankDeg: 9 },
  { a: 296, r: 152, halfWidth: 9.2, y: 0.4, surface: 'dirt' },

  // --- Back onto the apron --------------------------------------------------
  { a: 312, r: 182, halfWidth: 10, y: 0 },
  { a: 328, r: 208, halfWidth: 10.8, y: 0 },
  { a: 344, r: 224, halfWidth: 11.2, y: 0 },
];

const ring = makeRing(NODES, { scale: 1.1, aspectX: 1.08, aspectZ: 0.95 });
const mainLine = previewMainPath(ring.points);

/**
 * The Rootway. A service tunnel under the terraces, cutting the second crest
 * and the top of the Cistern.
 *
 * The trade is the point: it is shorter and it is *flat*, so it gives up the
 * crest — and with it the clean-landing Surge the main line pays. Standing
 * water on the floor costs grip too. A driver who lands the crest well is
 * genuinely better off taking the long way, which is the shape every shortcut
 * in this game is meant to have.
 */
const rootway = chordAlong(mainLine, 1180, 1500, 8, 26, (t) => {
  const mouth = t < 0.14 || t > 0.86;
  return {
    halfWidth: mouth ? 8.6 : 6.6,
    ...(mouth ? {} : { surface: 'water' as const }),
  };
});

/** Fallen glazing bars, standing where the roof came down. */
const glazing: ObstacleDefinition[] = scatterAlong(ring, 160, 196, 5, () => 1.0, (t) => (t < 0.5 ? -13 : 13)).map(
  (p, i) => ({
    ...p,
    radius: 1.4,
    kind: 'barrier' as const,
    height: 2.2 + (i % 3) * 0.8,
    restitution: 0.2,
  }),
);

/** Silt heaps in the Rootway, offset so a clean line through it exists. */
const silt: ObstacleDefinition[] = rootway.slice(3, 5).map((p, i) => ({
  x: p.x + Math.cos(i * 1.9 + 0.6) * 2.8,
  z: p.z + Math.sin(i * 1.9 + 0.6) * 2.8,
  radius: 1.1,
  kind: 'crate' as const,
  height: 1.4,
  restitution: 0.18,
}));

/** The old growth-lamp masts, standing in the infield of the Nave. */
const masts: ObstacleDefinition[] = scatterAlong(ring, 100, 140, 3, () => 1.0, () => -18).map((p) => ({
  ...p,
  radius: 1.9,
  kind: 'pillar' as const,
  height: 16,
}));

export const GLASSHOUSE_VIGIL: TrackDefinition = {
  id: 'glasshouse-vigil',
  name: 'Glasshouse Vigil',
  tagline: 'They run it once a year, by whatever light the old lamps have left.',
  description:
    'A collapsed arcology raced after dark. Long committed corners, a walled chicane through the fallen ' +
    'roof frames, and the Nave — the longest straight on the Circuit, and the one place the tow decides a race.',
  laps: 3,
  technicality: 2,
  points: ring.points,
  branches: [
    {
      id: 'rootway',
      name: 'The Rootway',
      risk: 'Shorter and flat — but it gives up the crest, and there is water on the floor.',
      points: rootway,
    },
  ],
  obstacles: [...glazing, ...silt, ...masts],
  hazards: [
    // A pad at the mouth of the Nave, so the straight starts with a decision
    // already made rather than a long wait.
    ...scatterAlong(ring, 92, 98, 1, () => 1.0, () => 0).map((p) => ({
      ...p,
      radius: 5.5,
      kind: 'boostPad' as const,
    })),
    // A draught through the open end of the Nave, pushing across the racing
    // line. Small, constant, and always in the same direction — a hazard the
    // player learns rather than one that surprises them.
    ...scatterAlong(ring, 116, 136, 3, () => 1.0, () => 0).map((p) => ({
      ...p,
      radius: 13,
      kind: 'gust' as const,
      direction: 1.1,
      strength: 0.55,
    })),
    // Standing water pooled at the bottom of the Cistern.
    ...scatterAlong(ring, 272, 288, 2, () => 1.0, (t) => -4 + t * 8).map((p) => ({
      ...p,
      radius: 7,
      kind: 'mud' as const,
    })),
  ],
  scenery: [
    // Reeds and volunteer growth close in, then the skeleton of the arcology
    // behind it, then the masts. Three depths, so the frame is never flat.
    { kind: 'reed', density: 1.6, bandInner: 1.05, bandOuter: 2.6, scaleMin: 0.7, scaleMax: 1.7 },
    { kind: 'broadleaf', density: 0.5, bandInner: 1.6, bandOuter: 4, scaleMin: 0.9, scaleMax: 1.9 },
    { kind: 'pylon', density: 0.05, bandInner: 1.4, bandOuter: 3, scaleMin: 1.1, scaleMax: 1.5 },
    { kind: 'crystal', density: 0.22, bandInner: 1.1, bandOuter: 2.8, scaleMin: 0.5, scaleMax: 1.2 },
    { kind: 'monolith', density: 0.05, bandInner: 2.2, bandOuter: 5, scaleMin: 0.9, scaleMax: 1.6 },
  ],
  theme: {
    /*
     * Night, and the whole lighting problem inverted.
     *
     * The key is a moon: cold, weak, and high enough to model the road rather
     * than rake across it. The fill does most of the work — at this key
     * strength a flat-shaded world would otherwise be a field of silhouettes —
     * and it is deliberately blue from above and near-black from below, which
     * is what stops a night scene reading as a daytime scene turned down.
     *
     * The emissive accents are load bearing here in a way they are nowhere
     * else: the kerb, the growth lamps and the crystal understorey are most of
     * what tells a driver where the road is.
     */
    skyTop: 0x070c1c,
    skyHorizon: 0x152238,
    fogColor: 0x1b2740,
    fogDensity: 0.0026,
    sunColor: 0xbccbe8,
    sunIntensity: 1.25,
    sunElevation: 0.72,
    sunAzimuth: 4.2,
    ambientSky: 0x35507e,
    ambientGround: 0x0e1418,
    ambientIntensity: 2.6,
    roadColor: 0x525a64,
    shoulderColor: 0x4e5a58,
    kerbColor: 0x7fe8ff,
    terrainColor: 0x161f26,
    terrainAccent: 0x1d3028,
    dustColor: 0x8fa8c0,
    speedLineColor: 0xbfe9ff,
    cloudiness: 0.35,
    night: true,
    grade: {
      // Exposure carries the night rather than a brighter key: the art bible
      // puts racers in the top value band on *every* course, and a night scene
      // where the skiffs are silhouettes has failed the rule however good the
      // screenshot looks.
      exposure: 1.5,
      // Lifted, cool shadows and highlights pulled towards the lamp colour: the
      // look of a place lit by something that is nearly out.
      lift: [0.016, 0.024, 0.042],
      gamma: [1.0, 1.0, 0.97],
      gain: [0.94, 0.99, 1.08],
      saturation: 1.02,
      contrast: 1.08,
      // A low threshold, because at night the emissive accents *are* the
      // composition and they need to carry.
      bloomThreshold: 0.55,
      bloomIntensity: 0.8,
      vignette: 0.26,
    },
  },
  offTrackSurface: 'grass',
  checkpointCount: 12,
  terrainRelief: 7,
  seed: 0x91a7,
};
