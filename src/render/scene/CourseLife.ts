import * as THREE from 'three';
import { Rng, hashSeed } from '../../core/rng';
import type { Track } from '../../game/track/buildTrack';
import type { PathSample } from '../../game/track/types';
import { familyMaterial } from '../materials/families';
import { mergeGeometries } from './mergeGeometry';
import type { MergePart } from './mergeGeometry';

/**
 * Ambient life.
 *
 * ART-03's finding was that the world is "empty, repetitive and inert" — and
 * inert was the sharper half. A course can be dense with structure and still
 * feel like a diorama, because nothing in it has any reason to be there and
 * nothing in it reacts to a race going past. What fixes that is not more
 * geometry; it is a small number of things that *move for their own reasons*.
 *
 * Three systems, and each one answers a different question the frame asks:
 *
 * - **Marshals** — someone is watching. They stand back from the barrier, and
 *   they turn and wave as the field comes past. This is the one that carries
 *   the fiction: a race nobody attends is not a race, it is a time trial in an
 *   abandoned building.
 * - **Motes** — the air is not a vacuum. Spores and dust drifting in the lamp
 *   light, which on a night course is also what makes the light *volumetric*
 *   without a volumetric pass.
 * - **Flock** — the world continues past the edge of the course. Something
 *   crosses the skyline on its own errand and leaves.
 *
 * ## Cost
 *
 * Three draw calls for the whole system, and no per-frame CPU work beyond
 * advancing three uniforms. Everything animates in the vertex shader from a
 * clock and the instance's own position, which is the only way a couple of
 * hundred moving things is affordable next to a six-car field.
 *
 * ## Why the marshals do not use `applyWind`
 *
 * They are not foliage. A marshal's wave has to be legible as an arm, which
 * means a large rotation of one part around a shoulder rather than a small
 * bend of the whole body — and it has to be gated on the field being nearby,
 * which a pure function of position and time cannot know. The proximity gate
 * is one uniform, updated from the leader's position each frame.
 */

export interface CourseLifeOptions {
  /** Scales every population. 0 disables the system entirely. */
  density: number;
  heightAt: (x: number, z: number) => number;
  /** Course accent, used for the marshals' lamps and the motes. */
  accent: number;
  /** True on night courses: motes are lit, and the marshals carry lamps. */
  night: boolean;
  /** The scene's fog, which the motes have to match by hand. */
  fogColor: number;
  fogDensity: number;
}

export interface CourseLifeResult {
  group: THREE.Group;
  /**
   * `focus` is the position the crowd reacts to — the race leader, not the
   * player, because a marshal watching the back of the field while the leader
   * goes past is worse than a marshal who does not move.
   */
  update: (elapsed: number, focus: { x: number; z: number }) => void;
  dispose: () => void;
}

/** Shader chunk shared by the two instanced systems. */
const COMMON_UNIFORMS = `
  uniform float uLifeTime;
  uniform vec3 uFocus;
`;

/**
 * A marshal: a figure with a raised arm, at trackside.
 *
 * The arm is a separate part of the same merged geometry, tagged by having its
 * vertices above `WAVE_PIVOT`. The vertex shader rotates everything above that
 * height around the shoulder — cheap, and at fifty metres indistinguishable
 * from a rigged arm.
 */
const WAVE_PIVOT = 1.35;

function marshalGeometry(): THREE.BufferGeometry {
  const parts: MergePart[] = [
    // Legs and body, one solid mass: at distance a human silhouette is a
    // vertical block with a head, and splitting the legs costs triangles that
    // buy nothing.
    { geometry: new THREE.CylinderGeometry(0.17, 0.22, 0.9, 5), position: [0, 0.45, 0] },
    { geometry: new THREE.BoxGeometry(0.42, 0.62, 0.26), position: [0, 1.2, 0] },
    { geometry: new THREE.SphereGeometry(0.15, 6, 5), position: [0, 1.64, 0] },
    // The raised arm. Everything above the pivot waves, so the arm has to
    // start above it and the head has to sit low enough to only nod.
    { geometry: new THREE.BoxGeometry(0.12, 0.62, 0.12), position: [0.02, 1.78, 0.26], rotation: [0, 0, -0.3] },
  ];
  return mergeGeometries(parts);
}

/**
 * Flying things, as a single merged flock.
 *
 * One mesh containing every bird, each at its own offset, animated in the
 * shader along a shared circuit. Moving the whole mesh and letting the shader
 * spread the flock inside it is what keeps this to one draw call and zero
 * per-frame CPU.
 */
function flockGeometry(count: number, rng: Rng): THREE.BufferGeometry {
  const parts: MergePart[] = [];
  for (let i = 0; i < count; i++) {
    // A shallow V. Two triangles is enough — a bird at two hundred metres is a
    // flicker of a shape, and any more detail is spent below a pixel.
    const spread = 8;
    parts.push({
      geometry: new THREE.ConeGeometry(0.5, 2.2, 3),
      position: [rng.range(-spread, spread), rng.range(-spread * 0.4, spread * 0.4), rng.range(-spread, spread)],
      rotation: [Math.PI / 2, 0, rng.range(-0.4, 0.4)],
    });
  }
  return mergeGeometries(parts);
}

export function buildCourseLife(track: Track, options: CourseLifeOptions): CourseLifeResult {
  const group = new THREE.Group();
  group.name = 'life';
  const disposables: { dispose: () => void }[] = [];
  const time = { value: 0 };
  const focus = { value: new THREE.Vector3() };
  const samples = track.main.samples;
  const rng = new Rng(hashSeed('life', track.definition.seed));

  if (options.density <= 0) {
    return { group, update: () => {}, dispose: () => {} };
  }

  // --- marshals ------------------------------------------------------------

  const marshalCount = Math.max(8, Math.round(46 * options.density));
  const marshals = marshalGeometry();
  disposables.push(marshals);
  const marshalMaterial = familyMaterial('structure', { color: 0x6a7480, repeat: 1 });
  // Trackside figures at night need to be visible as *people*, not as posts,
  // and the only light on this course is what things carry.
  if (options.night) {
    marshalMaterial.emissive = new THREE.Color(options.accent);
    marshalMaterial.emissiveIntensity = 0.22;
  }
  marshalMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uLifeTime = time;
    shader.uniforms.uFocus = focus;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COMMON_UNIFORMS}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec3 origin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           /* Waves only while the field is inside 70 m, and hardest at 25 m.
              A crowd that waves permanently is wallpaper. */
           float range = distance(origin.xz, uFocus.xz);
           float excite = smoothstep(70.0, 25.0, range);
           float phase = origin.x * 0.7 + origin.z * 0.5;
           float wave = sin(uLifeTime * 7.0 + phase) * excite;
           float above = max(transformed.y - ${WAVE_PIVOT.toFixed(2)}, 0.0);
           if (above > 0.0) {
             float a = wave * 0.9;
             float c = cos(a); float s = sin(a);
             vec2 arm = vec2(transformed.x, above);
             transformed.x = arm.x * c - arm.y * s;
             transformed.y = ${WAVE_PIVOT.toFixed(2)} + arm.x * s + arm.y * c;
           }
           /* A small lean into the track as they pass, so the whole figure
              reacts and not just the arm. */
           transformed.z += excite * sin(uLifeTime * 2.0 + phase) * 0.06 * transformed.y;
         }`,
      );
  };
  marshalMaterial.customProgramCacheKey = () => 'marshal';
  disposables.push(marshalMaterial);

  const marshalMesh = new THREE.InstancedMesh(marshals, marshalMaterial, marshalCount);
  marshalMesh.name = 'life-marshals';
  marshalMesh.castShadow = false;
  marshalMesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < marshalCount; i++) {
    // Clustered rather than evenly spread: people gather where they can see
    // something happen, which is corner entries and the start line.
    const cluster = Math.floor((i / marshalCount) * 9) / 9;
    const index = Math.floor((cluster + rng.range(-0.012, 0.012)) * samples.length);
    const sample = samples[Math.max(0, Math.min(samples.length - 1, index))] as PathSample;
    const side = rng.chance(0.5) ? 1 : -1;
    // Well outside the run-off. A spectator standing where a car can be flung
    // is a spectator the player will eventually drive through.
    const lateral = side * (sample.halfWidth + rng.range(6, 16));
    const x = sample.pos.x + sample.normal.x * lateral;
    const z = sample.pos.z + sample.normal.z * lateral;
    position.set(x, options.heightAt(x, z), z);
    // Facing the road, so a wave reads as directed at the race.
    quaternion.setFromAxisAngle(up, Math.atan2(-sample.normal.x * side, -sample.normal.z * side));
    scale.setScalar(rng.range(0.92, 1.12));
    matrix.compose(position, quaternion, scale);
    marshalMesh.setMatrixAt(i, matrix);
  }
  marshalMesh.instanceMatrix.needsUpdate = true;
  group.add(marshalMesh);

  // --- motes ---------------------------------------------------------------

  /*
   * Written as a `ShaderMaterial` rather than by patching a standard one.
   *
   * A camera-facing quad has to be built in view space, which means writing
   * `gl_Position` directly — and three's `project_vertex` chunk both writes it
   * and declares the `mvPosition` that the fog chunk then reads. Patching the
   * one without breaking the other is not possible, so the whole (very small)
   * program is written out here, fog included.
   */
  const moteCount = Math.max(40, Math.round(280 * options.density));
  const moteGeometry = new THREE.InstancedBufferGeometry();
  moteGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  moteGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  const moteOffsets = new Float32Array(moteCount * 4);
  for (let i = 0; i < moteCount; i++) {
    // The offset inside the box that follows the player. Wider than it is
    // tall, because that is the shape of the space in front of a chase camera.
    moteOffsets[i * 4] = rng.range(-38, 38);
    moteOffsets[i * 4 + 1] = rng.range(0.4, 14);
    moteOffsets[i * 4 + 2] = rng.range(-38, 38);
    moteOffsets[i * 4 + 3] = rng.range(0.05, 0.14);
  }
  moteGeometry.setAttribute('aMote', new THREE.InstancedBufferAttribute(moteOffsets, 4));
  moteGeometry.instanceCount = moteCount;
  disposables.push(moteGeometry);

  const moteMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uLifeTime: time,
      uFocus: focus,
      uColor: { value: new THREE.Color(options.night ? options.accent : 0xf0e8d0) },
      uOpacity: { value: options.night ? 0.34 : 0.22 },
      uFogColor: { value: new THREE.Color(options.fogColor) },
      uFogDensity: { value: options.fogDensity },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec4 aMote;
      uniform float uLifeTime;
      uniform vec3 uFocus;
      varying float vFogDepth;
      varying vec2 vQuad;
      void main() {
        vQuad = position.xy;
        /* Motes live in a box carried with the player, so a fixed population
           always surrounds them instead of being scattered over a kilometre of
           course where almost none of it is ever in frame. */
        float phase = aMote.x * 13.0 + aMote.z * 7.0;
        vec3 drift = vec3(
          sin(uLifeTime * 0.4 + phase) * 6.0,
          sin(uLifeTime * 0.27 + phase * 1.7) * 2.2,
          cos(uLifeTime * 0.33 + phase * 1.3) * 6.0
        );
        vec4 viewCentre = modelViewMatrix * vec4(uFocus + aMote.xyz + drift, 1.0);
        vFogDepth = -viewCentre.z;
        gl_Position = projectionMatrix * (viewCentre + vec4(position.xy * aMote.w, 0.0, 0.0));
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying float vFogDepth;
      varying vec2 vQuad;
      void main() {
        /* A soft radial falloff, not a flat quad.
           A hard-edged square is unmistakably a *polygon* the moment it is more
           than a couple of pixels across, and a hundred of them against a night
           sky read as blocky confetti rather than as drifting spores. */
        float falloff = 1.0 - smoothstep(0.1, 0.5, length(vQuad));
        if (falloff <= 0.002) discard;
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        /* Fading towards the fog colour rather than out is what keeps motes
           from reading as a swarm of fireflies at 300 m on a foggy course. */
        gl_FragColor = vec4(mix(uColor, uFogColor, fog), uOpacity * falloff * (1.0 - fog));
      }`,
  });
  disposables.push(moteMaterial);

  const moteMesh = new THREE.Mesh(moteGeometry, moteMaterial);
  moteMesh.name = 'life-motes';
  moteMesh.frustumCulled = false;
  moteMesh.renderOrder = 2;
  group.add(moteMesh);

  // --- flock ---------------------------------------------------------------

  const flock = flockGeometry(Math.max(5, Math.round(11 * options.density)), rng);
  disposables.push(flock);
  const flockMaterial = new THREE.MeshBasicMaterial({
    color: options.night ? 0x0d1522 : 0x2c3340,
    fog: true,
  });
  disposables.push(flockMaterial);
  const flockMesh = new THREE.Mesh(flock, flockMaterial);
  flockMesh.name = 'life-flock';
  flockMesh.frustumCulled = false;
  group.add(flockMesh);

  const centre = new THREE.Vector3(
    (track.bounds.minX + track.bounds.maxX) / 2,
    0,
    (track.bounds.minZ + track.bounds.maxZ) / 2,
  );
  const radius = Math.max(track.bounds.maxX - track.bounds.minX, track.bounds.maxZ - track.bounds.minZ) * 0.42;
  const flockHeight = 58;
  const flockSpeed = 0.035;

  return {
    group,
    update: (elapsed, focusPoint) => {
      time.value += elapsed;
      focus.value.set(focusPoint.x, 0, focusPoint.z);

      // The flock crosses the sky on a slow circuit of its own, banking into
      // the turn. It is never near the course and never interacts with it —
      // that is the point, it has somewhere else to be.
      const angle = time.value * flockSpeed;
      flockMesh.position.set(
        centre.x + Math.cos(angle) * radius,
        flockHeight + Math.sin(angle * 2.3) * 7,
        centre.z + Math.sin(angle) * radius,
      );
      flockMesh.rotation.set(0, -angle, Math.sin(angle * 2.3) * 0.25);
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
