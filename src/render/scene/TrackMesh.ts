import * as THREE from 'three';
import type { Track } from '../../game/track/buildTrack';
import type { Path, PathSample, TrackTheme } from '../../game/track/types';
import { kerbTexture, roadTexture, surfaceTexture } from '../textures/procedural';

/**
 * The drivable surface.
 *
 * Built directly from the same `PathSample` array the physics projects
 * against, so the road you can see and the road you can drive on cannot
 * disagree. The ribbon carries the shoulder and, where the course declares a
 * walled edge, a barrier — all in one buffer geometry per path so a whole
 * course is two or three draw calls.
 */

const SHOULDER_WIDTH = 1.6;
const BARRIER_HEIGHT = 1.35;
const BARRIER_WIDTH = 0.55;
/** Width of the striped kerb that edges the road, in metres. */
const KERB_WIDTH = 0.9;

interface RibbonBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/**
 * Emits a quad as two triangles.
 *
 * The winding is reversed relative to the obvious order because of how the
 * ribbon is laid out: samples are pushed right-edge-then-left-edge, and the
 * right normal is +Z for a path running along +X, which makes the naive order
 * produce downward-facing triangles. Those get back-face culled and the road
 * simply is not there.
 */
function pushQuad(buffers: RibbonBuffers, a: number, b: number, c: number, d: number): void {
  buffers.indices.push(a, d, c, a, c, b);
}

/**
 * The two edge points of a sample, including banking.
 *
 * `sample.normal` is the *right*-hand normal (see the handedness rule in
 * `src/core/math.ts`), so `outer` is the right edge and `inner` the left. They
 * are named for their winding role rather than for a side, because the ribbon
 * code only cares that they are consistent.
 */
function edges(sample: PathSample, halfWidth: number): { outer: THREE.Vector3; inner: THREE.Vector3 } {
  const bank = sample.bank;
  const lift = Math.sin(bank) * halfWidth;
  return {
    outer: new THREE.Vector3(
      sample.pos.x + sample.normal.x * halfWidth,
      sample.y + lift,
      sample.pos.z + sample.normal.z * halfWidth,
    ),
    inner: new THREE.Vector3(
      sample.pos.x - sample.normal.x * halfWidth,
      sample.y - lift,
      sample.pos.z - sample.normal.z * halfWidth,
    ),
  };
}

function buildRibbon(path: Path, theme: TrackTheme): THREE.Group {
  const group = new THREE.Group();
  group.name = `track-${path.id}`;

  const road: RibbonBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const shoulder: RibbonBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const barrier: RibbonBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const kerb: RibbonBuffers = { positions: [], normals: [], uvs: [], indices: [] };

  const count = path.samples.length;
  const steps = path.closed ? count : count - 1;
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= steps; i++) {
    const index = path.closed ? i % count : Math.min(i, count - 1);
    const sample = path.samples[index] as PathSample;
    const hw = sample.halfWidth;
    const { outer: rightEdge, inner: leftEdge } = edges(sample, hw);
    const outer = edges(sample, hw + SHOULDER_WIDTH);
    const kerbEdge = edges(sample, hw + KERB_WIDTH);
    // V repeats every 9 m so the tarmac grain has a believable scale at speed.
    const v = sample.distance / 9;

    road.positions.push(rightEdge.x, rightEdge.y, rightEdge.z, leftEdge.x, leftEdge.y, leftEdge.z);
    road.normals.push(up.x, up.y, up.z, up.x, up.y, up.z);
    road.uvs.push(0, v, 1, v);

    /*
     * The kerb: a narrow striped strip either side of the road, raised a
     * centimetre above it.
     *
     * This is the highest-value piece of geometry on the whole course for a
     * driver. The art bible puts edges in a brighter value band than the road
     * for exactly this reason — the stripes give the eye an unambiguous read on
     * where the corridor ends, at any speed and in any light, and the rhythm of
     * them passing is itself a speed cue. Its U runs along the track so the
     * stripe repeat is set by distance, not by the road's width.
     */
    const kerbV = sample.distance / 2.4;
    kerb.positions.push(
      kerbEdge.outer.x, kerbEdge.outer.y + 0.02, kerbEdge.outer.z,
      rightEdge.x, rightEdge.y + 0.02, rightEdge.z,
      leftEdge.x, leftEdge.y + 0.02, leftEdge.z,
      kerbEdge.inner.x, kerbEdge.inner.y + 0.02, kerbEdge.inner.z,
    );
    for (let k = 0; k < 4; k++) kerb.normals.push(up.x, up.y, up.z);
    kerb.uvs.push(0, kerbV, 1, kerbV, 0, kerbV, 1, kerbV);

    shoulder.positions.push(
      outer.outer.x, outer.outer.y - 0.06, outer.outer.z,
      rightEdge.x, rightEdge.y, rightEdge.z,
      leftEdge.x, leftEdge.y, leftEdge.z,
      outer.inner.x, outer.inner.y - 0.06, outer.inner.z,
    );
    for (let k = 0; k < 4; k++) shoulder.normals.push(up.x, up.y, up.z);
    shoulder.uvs.push(0, v, 1, v, 0, v, 1, v);

    if (sample.edge === 'wall') {
      for (const [edge, dir] of [
        [outer.outer, 1],
        [outer.inner, -1],
      ] as const) {
        const nx = sample.normal.x * dir;
        const nz = sample.normal.z * dir;
        barrier.positions.push(
          edge.x, edge.y, edge.z,
          edge.x, edge.y + BARRIER_HEIGHT, edge.z,
          edge.x + nx * BARRIER_WIDTH, edge.y + BARRIER_HEIGHT, edge.z + nz * BARRIER_WIDTH,
          edge.x + nx * BARRIER_WIDTH, edge.y, edge.z + nz * BARRIER_WIDTH,
        );
        for (let k = 0; k < 4; k++) barrier.normals.push(-nx, 0, -nz);
        barrier.uvs.push(0, v, 0.25, v, 0.5, v, 0.75, v);
      }
    }
  }

  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    pushQuad(road, a, a + 1, a + 3, a + 2);

    const s = i * 4;
    pushQuad(shoulder, s, s + 1, s + 5, s + 4);
    pushQuad(shoulder, s + 2, s + 3, s + 7, s + 6);
    pushQuad(kerb, s, s + 1, s + 5, s + 4);
    pushQuad(kerb, s + 2, s + 3, s + 7, s + 6);
  }

  // The barrier strip only has vertices where the edge is walled, so it is
  // indexed separately by walking the same samples again.
  {
    let vertex = 0;
    const walled: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const index = path.closed ? i % count : Math.min(i, count - 1);
      const sample = path.samples[index] as PathSample;
      if (sample.edge === 'wall') {
        walled.push(vertex);
        vertex += 8;
      } else {
        walled.push(-1);
      }
    }
    for (let i = 0; i < steps; i++) {
      const here = walled[i] as number;
      const next = walled[i + 1] as number;
      if (here < 0 || next < 0) continue;
      for (const side of [0, 4]) {
        const a = here + side;
        const b = next + side;
        // Inner face and top cap; the outer face is never visible.
        pushQuad(barrier, a, a + 1, b + 1, b);
        pushQuad(barrier, a + 1, a + 2, b + 2, b + 1);
      }
    }
  }

  const roadMaterial = new THREE.MeshStandardMaterial({
    map: roadTexture(`road-${theme.roadColor}`, `#${theme.roadColor.toString(16).padStart(6, '0')}`, '#e8e2c8', theme.roadColor),
    roughness: 0.92,
    metalness: 0.02,
  });
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    map: surfaceTexture(`shoulder-${theme.shoulderColor}`, `#${theme.shoulderColor.toString(16).padStart(6, '0')}`, {
      seed: theme.shoulderColor,
      contrast: 0.28,
      repeat: 6,
    }),
    roughness: 1,
  });
  const barrierMaterial = new THREE.MeshStandardMaterial({
    color: theme.shoulderColor,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const kerbMaterial = new THREE.MeshStandardMaterial({
    map: kerbTexture(theme.kerbColor ?? 0xd8dee2),
    roughness: 0.72,
    metalness: 0.05,
  });

  for (const [buffers, material, name] of [
    [shoulder, shoulderMaterial, 'shoulder'],
    [road, roadMaterial, 'road'],
    [kerb, kerbMaterial, 'kerb'],
    [barrier, barrierMaterial, 'barrier'],
  ] as const) {
    if (buffers.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
    geometry.setIndex(buffers.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${path.id}-${name}`;
    mesh.receiveShadow = true;
    // The road is drawn slightly after the terrain to avoid z-fighting where
    // the terrain blends up to meet it.
    mesh.renderOrder = name === 'road' ? 1 : name === 'kerb' ? 2 : 0;
    group.add(mesh);
  }

  return group;
}

/** The start/finish gantry, so the line is unmistakable at speed. */
function buildStartLine(track: Track, theme: TrackTheme): THREE.Group {
  const group = new THREE.Group();
  const sample = track.sampleMain(0);
  const hw = sample.halfWidth;

  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(hw * 2, 3),
    new THREE.MeshStandardMaterial({ color: 0xf2efe4, roughness: 0.8 }),
  );
  stripe.rotation.x = -Math.PI / 2;
  stripe.rotation.z = -Math.atan2(sample.tangent.z, sample.tangent.x);
  stripe.position.set(sample.pos.x, sample.y + 0.04, sample.pos.z);
  stripe.receiveShadow = true;
  group.add(stripe);

  const postGeometry = new THREE.CylinderGeometry(0.35, 0.45, 7.5, 8);
  const postMaterial = new THREE.MeshStandardMaterial({ color: theme.shoulderColor, roughness: 0.7, metalness: 0.25 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.position.set(
      sample.pos.x + sample.normal.x * (hw + 1.2) * side,
      sample.y + 3.75,
      sample.pos.z + sample.normal.z * (hw + 1.2) * side,
    );
    post.castShadow = true;
    group.add(post);
  }

  const beam = new THREE.Mesh(
    new THREE.BoxGeometry((hw + 1.6) * 2, 1.5, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.6, metalness: 0.3 }),
  );
  beam.position.set(sample.pos.x, sample.y + 7.2, sample.pos.z);
  beam.rotation.y = -Math.atan2(sample.tangent.z, sample.tangent.x);
  beam.castShadow = true;
  group.add(beam);

  // A glowing strip on the underside of the gantry, so the line is readable
  // even on the dusk course.
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry((hw + 1.5) * 2, 0.18, 0.5),
    new THREE.MeshBasicMaterial({ color: 0x8dffc4 }),
  );
  glow.position.set(sample.pos.x, sample.y + 6.4, sample.pos.z);
  glow.rotation.y = beam.rotation.y;
  group.add(glow);

  return group;
}

export function buildTrackMesh(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  const theme = track.definition.theme;

  group.add(buildRibbon(track.main, theme));
  for (const branch of track.branches) group.add(buildRibbon(branch, theme));
  group.add(buildStartLine(track, theme));

  return group;
}
