import * as THREE from 'three';
import { Rng, hashSeed } from '../../core/rng';
import { PHYSICS } from '../../game/config';
import { mergeGeometries } from './mergeGeometry';
import type { MergePart } from './mergeGeometry';
import type { Track } from '../../game/track/buildTrack';
import type { ObstacleDefinition, PathSample, SceneryKind, TrackTheme } from '../../game/track/types';
import { familyMaterial } from '../materials/families';

/** Multiplies a colour's lightness, keeping its hue and saturation. */
function shade(color: number, factor: number): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
  return c.setHSL(hsl.h, hsl.s, Math.min(1, hsl.l * factor));
}

/**
 * Set dressing and static obstacles.
 *
 * Everything here is instanced: one draw call per scenery kind, however many
 * instances. That is what lets a course carry a couple of thousand trees and
 * still leave the draw-call budget almost untouched.
 *
 * The shapes are deliberately simple and silhouette-led. At racing speed the
 * eye reads outline and colour, not detail, so the geometry budget goes into
 * having *enough* things rather than detailed ones.
 */

/**
 * Distance from the camera at which a scenery instance has dissolved away, and
 * the distance by which it is solid again.
 *
 * The boom raycast can only find something *between* the camera and the car; it
 * cannot do anything about the canopy the camera is already inside. The round-3
 * live review caught exactly that on Overgrown: an off-road excursion into the
 * broadleaf band left the road "reduced to a narrow strip at the far right
 * while dark foliage occupies the centre and left", precisely when the player
 * needed to see a way back. Anything this close to the lens is not scenery any
 * more, it is an obstruction.
 *
 * `NearFade` already does this for gantries and landmarks, but it works on
 * whole objects and every tree of a species is one instanced draw. Per-instance
 * is the only useful granularity here, which is why this is a shader dissolve
 * rather than a material opacity.
 */
const DISSOLVE_GONE = 5.5;
const DISSOLVE_SOLID = 13;

/**
 * Patches a scenery material with the per-instance camera dissolve, and
 * optionally with wind sway.
 *
 * The sway is a function of world position and time in the vertex shader, so
 * every instance gets its own phase for free and the whole species still costs
 * one draw call - animating two thousand trees on the CPU would mean rewriting
 * an instance matrix buffer every frame. The displacement scales with height
 * above the instance origin, so trunks stay planted and only the canopy moves;
 * anything else looks like the tree is sliding around on the ground.
 *
 * One patch, because `onBeforeCompile` is a single slot: a second assignment
 * silently replaces the first, so wind and dissolve have to be installed
 * together or one of them quietly does nothing.
 *
 * The dissolve is an ordered dither rather than alpha, so it needs no
 * transparency, no depth sorting and no second draw - an instance thins out and
 * is gone, and the road behind it is simply there.
 */
function patchScenery(
  material: THREE.Material,
  camera: { value: THREE.Vector3 },
  wind?: { strength: number; speed: number },
): { time: { value: number } } {
  const time = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCameraAt = camera;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uCameraAt;
         varying float vDissolve;
         ${wind ? 'uniform float uWindTime;\nuniform float uWindStrength;\nuniform float uWindSpeed;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec3 instanceOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           vDissolve = smoothstep(${DISSOLVE_GONE.toFixed(1)}, ${DISSOLVE_SOLID.toFixed(1)},
             distance(instanceOrigin.xz, uCameraAt.xz));
           ${
             wind
               ? `float phase = instanceOrigin.x * 0.13 + instanceOrigin.z * 0.11;
           float height = max(transformed.y, 0.0);
           float sway = sin(uWindTime * uWindSpeed + phase) * 0.7
                      + sin(uWindTime * uWindSpeed * 1.7 + phase * 2.3) * 0.3;
           transformed.x += sway * uWindStrength * height * height * 0.02;
           transformed.z += sway * uWindStrength * height * height * 0.012;`
               : ''
           }
         }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vDissolve;
         // A 4x4 ordered dither. Screen-space and stable, so a dissolving
         // canopy stipples out instead of flickering as the camera moves.
         float sceneryDither(vec2 fragment) {
           int x = int(mod(fragment.x, 4.0));
           int y = int(mod(fragment.y, 4.0));
           int index = x + y * 4;
           float table[16];
           table[0]=0.0;   table[1]=8.0;  table[2]=2.0;  table[3]=10.0;
           table[4]=12.0;  table[5]=4.0;  table[6]=14.0; table[7]=6.0;
           table[8]=3.0;   table[9]=11.0; table[10]=1.0; table[11]=9.0;
           table[12]=15.0; table[13]=7.0; table[14]=13.0;table[15]=5.0;
           for (int i = 0; i < 16; i++) if (i == index) return (table[i] + 0.5) / 16.0;
           return 0.5;
         }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if (vDissolve < sceneryDither(gl_FragCoord.xy)) discard;`,
      );
    if (wind) {
      shader.uniforms.uWindTime = time;
      shader.uniforms.uWindStrength = { value: wind.strength };
      shader.uniforms.uWindSpeed = { value: wind.speed };
    }
  };
  // Changing `onBeforeCompile` after a material has been used needs a new
  // program; setting the key up front keeps three from caching the unmodified
  // shader against this material.
  material.customProgramCacheKey = () => `scenery-${wind ? `${wind.strength}-${wind.speed}` : 'still'}`;
  return { time };
}

/** Prototype geometry for one scenery kind, in local space, y-up from 0. */
interface Prototype {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  wind?: number;
  /**
   * A second instanced mesh at the same transforms, in a different material
   * family. One extra draw call for the whole species, and the only way a
   * single silhouette can be made of two materials.
   */
  extra?: { geometry: THREE.BufferGeometry; material: THREE.Material };
  /** Emissive modulation, for anything that is a working light. */
  flicker?: { amplitude: number; speed: number };
}

function prototype(kind: SceneryKind, theme: TrackTheme): Prototype {
  const stone = new THREE.MeshStandardMaterial({ color: theme.shoulderColor, roughness: 0.95, flatShading: true });

  switch (kind) {
    case 'pine': {
      // Trunk plus two stacked cones, merged into one geometry so the whole
      // species is a single instanced draw.
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.22, 0.34, 2.4, 5), position: [0, 1.2, 0] },
        { geometry: new THREE.ConeGeometry(1.9, 4.2, 6), position: [0, 4.1, 0] },
        { geometry: new THREE.ConeGeometry(1.35, 3.2, 6), position: [0, 6.4, 0] },
      ]);
      return {
        geometry,
        // Foliage takes its colour from the course's terrain accent rather than
        // a fixed green. The art bible puts every plant a full value band below
        // the road, and a hard-coded green cannot honour that on a salt flat or
        // in a quarry at last light.
        material: new THREE.MeshStandardMaterial({
          color: shade(theme.terrainAccent, 0.72),
          roughness: 0.92,
          flatShading: true,
        }),
        wind: 0.5,
      };
    }
    case 'broadleaf': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.28, 0.42, 3.2, 5), position: [0, 1.6, 0] },
        { geometry: new THREE.IcosahedronGeometry(2.6, 0), position: [0, 4.9, 0] },
        { geometry: new THREE.IcosahedronGeometry(1.7, 0), position: [1.5, 4.1, 0.6] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          color: shade(theme.terrainAccent, 1.05),
          roughness: 0.9,
          flatShading: true,
        }),
        wind: 0.9,
      };
    }
    case 'palm': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.2, 0.34, 6, 5), position: [0, 3, 0] },
        { geometry: new THREE.ConeGeometry(2.4, 0.8, 5), position: [0, 6.2, 0] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          color: shade(theme.terrainAccent, 1.2),
          roughness: 0.9,
          flatShading: true,
        }),
        wind: 1.4,
      };
    }
    case 'boulder':
      return { geometry: new THREE.DodecahedronGeometry(1.5, 0), material: stone };
    case 'monolith': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.75, 1.35, 11, 6), position: [0, 5.5, 0] },
        { geometry: new THREE.ConeGeometry(0.9, 2.4, 6), position: [0, 12, 0] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.75, metalness: 0.35, flatShading: true }),
      };
    }
    case 'pylon': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.28, 0.6, 16, 5), position: [0, 8, 0] },
        { geometry: new THREE.BoxGeometry(6.5, 0.4, 0.4), position: [0, 14.5, 0] },
        { geometry: new THREE.BoxGeometry(4.8, 0.4, 0.4), position: [0, 12.2, 0] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.6, metalness: 0.5, flatShading: true }),
      };
    }
    case 'reed': {
      const geometry = mergeGeometries([
        { geometry: new THREE.ConeGeometry(0.5, 2.2, 4), position: [0, 1.1, 0] },
        { geometry: new THREE.ConeGeometry(0.36, 1.6, 4), position: [0.5, 0.8, 0.3] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          color: shade(theme.terrainAccent, 1.35),
          roughness: 1,
          flatShading: true,
        }),
        wind: 2.2,
      };
    }
    case 'crystal': {
      const geometry = mergeGeometries([
        { geometry: new THREE.OctahedronGeometry(1.1, 0), position: [0, 1.1, 0] },
        { geometry: new THREE.OctahedronGeometry(0.7, 0), position: [0.8, 0.7, 0.4] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          color: 0xff8a4a,
          emissive: 0x8a2a10,
          emissiveIntensity: 0.75,
          roughness: 0.35,
          flatShading: true,
        }),
      };
    }
    case 'chimney': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(1.5, 2.6, 20, 8), position: [0, 10, 0] },
        { geometry: new THREE.CylinderGeometry(2.1, 1.7, 1.6, 8), position: [0, 20.5, 0] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({ color: 0x6b4231, roughness: 0.95, flatShading: true }),
      };
    }

    /*
     * ------------------------------------------------------------------
     * Glasshouse Vigil's own vocabulary.
     *
     * The art review's judgement on this course was "no readable glasshouse":
     * a good sky over a generic road. A place has to be built out of the
     * things it *was* — glazing bars, growth racks, lamp masts, the roof on
     * the floor — not out of the same trees as everywhere else with a
     * different tint. Every one of these is authored to read as a specific
     * piece of ruined horticulture at race distance.
     * ------------------------------------------------------------------
     */
    case 'glassFrame': {
      /*
       * A standing glazing frame, most of its panes gone.
       *
       * The surviving glass is the point. Two translucent panes in a mostly
       * empty grid say "this was a roof" far more clearly than a full one
       * would, and the gaps let the sky through — which is where this course's
       * only real light comes from.
       */
      const bar = 0.16;
      const geometry = mergeGeometries([
        ...[-1, 1].map((side): MergePart => ({
          geometry: new THREE.BoxGeometry(bar, 9, bar),
          position: [0, 4.5, side * 2.6],
        })),
        { geometry: new THREE.BoxGeometry(bar, bar, 5.4), position: [0, 9, 0] },
        { geometry: new THREE.BoxGeometry(bar, bar, 5.4), position: [0, 5.6, 0] },
        { geometry: new THREE.BoxGeometry(bar, bar, 5.4), position: [0, 2.4, 0] },
      ]);
      return {
        geometry,
        // Two families in one silhouette, which is what a glazing frame *is*:
        // the bars are painted structure, the surviving pane is glass. Merged
        // into one mesh, one of the two has to win — and a pane that reflects
        // like a girder is the exact failure ART-08 named.
        material: familyMaterial('structure', { color: shade(theme.shoulderColor, 0.9), repeat: 3 }),
        extra: {
          geometry: new THREE.BoxGeometry(0.04, 3.1, 2.5).translate(0, 7.4, -1.2),
          material: familyMaterial('glazing', { color: 0xcfe6f2, repeat: 2 }),
        },
      };
    }
    case 'growthRack': {
      // Three tiers of planting trays, with three centuries of growth spilling
      // over the edges.
      const geometry = mergeGeometries([
        ...[0, 1, 2].map((tier): MergePart => ({
          geometry: new THREE.BoxGeometry(2.4, 0.14, 1.1),
          position: [0, 0.9 + tier * 1.1, 0],
        })),
        ...[-1, 1].flatMap((side) =>
          [-1, 1].map((end): MergePart => ({
            geometry: new THREE.BoxGeometry(0.1, 3.3, 0.1),
            position: [end * 1.1, 1.65, side * 0.5],
          })),
        ),
        ...[0, 1, 2].map((tier): MergePart => ({
          geometry: new THREE.IcosahedronGeometry(0.62, 0),
          position: [tier % 2 === 0 ? 0.6 : -0.5, 1.2 + tier * 1.1, 0],
        })),
      ]);
      return {
        geometry,
        material: familyMaterial('growth', { color: shade(theme.terrainAccent, 1.15), repeat: 2 }),
        wind: 0.6,
      };
    }
    case 'lampMast': {
      /*
       * A growth lamp still running on whatever is left in it.
       *
       * Emissive, and on this course that is load bearing rather than
       * decorative: the lamps are most of what tells a driver where the road
       * goes. Fog is disabled on the head so a distant one still reads as a
       * light rather than dissolving into the haze — which is exactly what you
       * navigate by at night.
       */
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.16, 0.26, 11, 6), position: [0, 5.5, 0] },
        { geometry: new THREE.BoxGeometry(1.8, 0.18, 0.5), position: [0.7, 11, 0] },
        { geometry: new THREE.BoxGeometry(1.2, 0.42, 0.44), position: [1.3, 10.7, 0] },
      ]);
      return {
        geometry,
        material: familyMaterial('emitter', {
          color: 0x2b3540,
          emissive: 0xbfe9d0,
          emissiveIntensity: 0.28,
          repeat: 2,
        }),
        // A lamp with three centuries of corrosion in its ballast does not burn
        // steady. The flicker is slow and shallow — enough that the course
        // feels *alive* rather than lit, and not enough to make the thing a
        // driver navigates by unreliable.
        flicker: { amplitude: 0.12, speed: 1.9 },
      };
    }
    case 'fallenTruss': {
      // The roof, on the floor. Low, long, and lying at an angle so it reads as
      // *collapsed* rather than as a wall someone built.
      const geometry = mergeGeometries([
        { geometry: new THREE.BoxGeometry(7, 0.18, 0.18), position: [0, 0.8, -0.7], rotation: [0, 0, 0.12] },
        { geometry: new THREE.BoxGeometry(7, 0.18, 0.18), position: [0, 0.3, 0.7] },
        ...[-2, 0, 2].map((along): MergePart => ({
          geometry: new THREE.BoxGeometry(0.14, 0.14, 1.6),
          position: [along, 0.55, 0],
          rotation: [0.5, 0, 0],
        })),
      ]);
      return {
        geometry,
        material: familyMaterial('corroded', { color: shade(theme.shoulderColor, 0.7), repeat: 3 }),
      };
    }
    case 'volunteer': {
      // Saplings that got in through the broken roof and never left.
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.1, 0.16, 2.6, 5), position: [0, 1.3, 0] },
        { geometry: new THREE.IcosahedronGeometry(1.15, 0), position: [0, 3.1, 0] },
        { geometry: new THREE.IcosahedronGeometry(0.7, 0), position: [0.7, 2.5, 0.3] },
      ]);
      return {
        geometry,
        material: familyMaterial('growth', { color: shade(theme.terrainAccent, 1.3), repeat: 2 }),
        wind: 1.6,
      };
    }
  }
}

export interface SceneryOptions {
  densityScale: number;
  visibilityDistance: number;
  heightAt: (x: number, z: number) => number;
  castShadows: boolean;
}

export interface SceneryResult {
  group: THREE.Group;
  /**
   * Advances every wind-swayed material and tells the dissolve where the
   * camera is.
   */
  update: (elapsed: number, cameraAt: THREE.Vector3) => void;
}

/**
 * Scatters every scenery spec the course declares. Placement is seeded from the
 * track, so the world is identical on every load and every machine — which
 * matters because the screenshots in the docs and the visual regression checks
 * would otherwise drift.
 */
export function buildScenery(track: Track, options: SceneryOptions): SceneryResult {
  const group = new THREE.Group();
  group.name = 'scenery';
  const samples = track.main.samples;
  const theme = track.definition.theme;
  const clocks: { value: number }[] = [];
  const lights: { material: THREE.MeshStandardMaterial; amplitude: number; speed: number; base: number; phase: number }[] = [];
  // One shared uniform for the whole course, written once a frame.
  const cameraAt = { value: new THREE.Vector3() };

  for (const spec of track.definition.scenery) {
    const rng = new Rng(hashSeed(spec.kind, track.definition.seed));
    const placements: { x: number; z: number; scale: number; rotation: number }[] = [];

    // Walk the centreline and scatter into the lateral band on both sides. The
    // density is per 100 m², so the spec reads the same whatever the course is.
    const stride = 4;
    for (let i = 0; i < samples.length; i += stride) {
      const sample = samples[i] as PathSample;
      const inner = sample.halfWidth * spec.bandInner;
      const outer = sample.halfWidth * spec.bandOuter;
      if (outer <= inner) continue;
      const area = ((outer - inner) * 2 * stride * 1.5) / 100;
      let expected = area * spec.density * options.densityScale;

      while (expected > 0) {
        if (expected < 1 && !rng.chance(expected)) break;
        expected -= 1;
        const side = rng.chance(0.5) ? 1 : -1;
        const lateral = side * rng.range(inner, outer);
        const along = rng.range(-stride * 0.75, stride * 0.75);
        const x = sample.pos.x + sample.normal.x * lateral + sample.tangent.x * along;
        const z = sample.pos.z + sample.normal.z * lateral + sample.tangent.z * along;

        /*
         * Never place anything on a drivable surface — nor anywhere inside the
         * run-off.
         *
         * The obvious clearance is "just off the road", and it is wrong. Only
         * the course's declared obstacles are collidable, so a tree standing
         * two metres past the white line is scenery a player drives *through*:
         * the camera ends up inside a canopy with the road nowhere in frame.
         * The run-off margin is how far a car can legitimately be flung, so it
         * is the clearance scenery has to respect.
         */
        const projection = track.project({ x, z });
        if (Math.abs(projection.lateral) < projection.halfWidth + PHYSICS.offTrackMargin * 0.8) continue;

        placements.push({ x, z, scale: rng.range(spec.scaleMin, spec.scaleMax), rotation: rng.range(0, Math.PI * 2) });
      }
    }

    if (placements.length === 0) continue;

    const budget = Math.ceil(placements.length * Math.min(1, options.visibilityDistance / 650));
    const selected = Array.from(
      { length: budget },
      (_, index) => placements[Math.floor((index * placements.length) / budget)] as (typeof placements)[number],
    );
    const { geometry, material, wind, extra, flicker } = prototype(spec.kind, theme);
    // Every scenery material gets the dissolve; only some get wind.
    const patched = patchScenery(material, cameraAt, wind === undefined ? undefined : { strength: wind, speed: 1.1 });
    if (wind) clocks.push(patched.time);
    if (extra) patchScenery(extra.material, cameraAt);
    if (flicker) lights.push({ material: material as THREE.MeshStandardMaterial, ...flicker, base: (material as THREE.MeshStandardMaterial).emissiveIntensity, phase: rng.range(0, 6.28) });

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    // Both parts of a two-family species take the same transforms, so the
    // pane is always in the frame that goes with it.
    for (const [partGeometry, partMaterial, suffix] of [
      [geometry, material, ''],
      ...(extra ? ([[extra.geometry, extra.material, '-glass']] as const) : []),
    ] as const) {
      const mesh = new THREE.InstancedMesh(partGeometry, partMaterial, selected.length);
      mesh.name = `scenery-${spec.kind}${suffix}`;
      mesh.castShadow = options.castShadows && suffix === '';
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      selected.forEach((p, index) => {
        position.set(p.x, options.heightAt(p.x, p.z) - 0.2, p.z);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotation);
        scale.setScalar(p.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }

  let clock = 0;
  return {
    group,
    update: (elapsed: number, camera: THREE.Vector3) => {
      clock += elapsed;
      cameraAt.value.copy(camera);
      for (const c of clocks) c.value += elapsed;
      for (const light of lights) {
        // Two incommensurate sines, so the flicker never settles into a
        // rhythm the eye can predict and start reading as a strobe.
        const wobble =
          Math.sin(clock * light.speed + light.phase) * 0.7 + Math.sin(clock * light.speed * 2.7 + light.phase * 1.9) * 0.3;
        light.material.emissiveIntensity = light.base * (1 + wobble * light.amplitude);
      }
    },
  };
}

/**
 * The far horizon.
 *
 * A ring of large, low, silhouette-only landforms placed well outside the
 * course, at the value band the art bible reserves for vistas. Nothing here is
 * ever reached or collided with; its whole job is that the frame has a
 * background as well as a foreground, which is the difference between a course
 * that sits in a world and a course that sits on a table.
 *
 * One instanced draw for the whole ring, and no shadows — a shadow cast from
 * 900 m away lands nowhere useful and costs a shadow-map slot that the trees
 * beside the road need.
 */
export function buildHorizon(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'horizon';
  const { bounds, definition } = track;
  const theme = definition.theme;

  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreZ = (bounds.minZ + bounds.maxZ) / 2;
  const reach = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;

  const rng = new Rng(hashSeed('horizon', definition.seed));
  const geometry = new THREE.ConeGeometry(1, 1, 5, 1);
  // Vistas sit a band below the near terrain and carry no high-frequency
  // detail, so they read as depth rather than as noise.
  const material = new THREE.MeshStandardMaterial({
    color: shade(theme.fogColor, 0.42),
    roughness: 1,
    flatShading: true,
    fog: true,
  });

  const count = 88;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'horizon-range';
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < count; i++) {
    // Two staggered rings, so the range has depth of its own instead of reading
    // as a single scalloped wall.
    const band = i % 2;
    const angle = (i / count) * Math.PI * 2 + rng.range(-0.05, 0.05);
    const distance = reach + 340 + band * 260 + rng.range(-70, 70);
    const height = rng.range(60, 190) * (1 + band * 0.5);
    const width = rng.range(180, 420);
    position.set(centreX + Math.cos(angle) * distance, -18, centreZ + Math.sin(angle) * distance);
    quaternion.setFromAxisAngle(axis, rng.range(0, Math.PI * 2));
    scale.set(width, height, width * rng.range(0.7, 1.2));
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
  return group;
}

/**
 * Static obstacles. These are simulation objects, not decoration, so they are
 * built from the same definitions the physics collides against and sized to
 * match the collision radius exactly — what you see is what you hit.
 */
export function buildObstacles(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'obstacles';
  const theme = track.definition.theme;

  const byKind = new Map<string, ObstacleDefinition[]>();
  for (const obstacle of track.obstacles) {
    const list = byKind.get(obstacle.kind) ?? [];
    list.push(obstacle);
    byKind.set(obstacle.kind, list);
  }

  for (const [kind, list] of byKind) {
    let geometry: THREE.BufferGeometry;
    let material: THREE.Material;
    switch (kind) {
      case 'rock':
        geometry = new THREE.DodecahedronGeometry(1, 0);
        material = new THREE.MeshStandardMaterial({ color: theme.shoulderColor, roughness: 0.95, flatShading: true });
        break;
      case 'pillar':
        geometry = new THREE.CylinderGeometry(1, 1.1, 1, 8);
        material = new THREE.MeshStandardMaterial({ color: 0x6a6a68, roughness: 0.85, flatShading: true });
        break;
      case 'crate':
        geometry = new THREE.BoxGeometry(1.7, 1, 1.7);
        material = new THREE.MeshStandardMaterial({ color: 0x8a6a3c, roughness: 0.9 });
        break;
      case 'monolith':
        geometry = new THREE.CylinderGeometry(0.55, 1, 1, 6);
        material = new THREE.MeshStandardMaterial({ color: 0x9a5f38, roughness: 0.7, metalness: 0.4, flatShading: true });
        break;
      default:
        geometry = new THREE.BoxGeometry(2, 1, 1);
        material = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 });
        break;
    }

    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `obstacle-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    list.forEach((obstacle, index) => {
      const projection = track.project({ x: obstacle.x, z: obstacle.z });
      matrix.compose(
        new THREE.Vector3(obstacle.x, projection.y + obstacle.height / 2 - 0.2, obstacle.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obstacle.x * 0.37),
        // Horizontal scale matches the collision radius, so nothing is ever hit
        // by something that looks smaller than the impact.
        new THREE.Vector3(obstacle.radius, obstacle.height, obstacle.radius),
      );
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
}

/** Visible markers for the boost pads, so a hazard is never a surprise. */
export function buildHazardMarkers(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hazards';
  for (const hazard of track.hazards) {
    if (hazard.kind !== 'boostPad') continue;
    const projection = track.project({ x: hazard.x, z: hazard.z });
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(hazard.radius, 24),
      new THREE.MeshBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(hazard.x, projection.y + 0.06, hazard.z);
    pad.renderOrder = 2;
    pad.name = 'boost-pad';
    group.add(pad);
  }
  return group;
}
