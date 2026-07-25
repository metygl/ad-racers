import * as THREE from 'three';
import type { Track } from '../../game/track/buildTrack';
import type { Path, PathSample, TrackTheme } from '../../game/track/types';
import { roadTexture, surfaceTexture } from '../textures/procedural';

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
 * ribbon is laid out: samples are pushed left-edge-then-right-edge, and the
 * left normal is +Z for a path running along +X, which makes the naive order
 * produce downward-facing triangles. Those get back-face culled and the road
 * simply is not there.
 */
function pushQuad(buffers: RibbonBuffers, a: number, b: number, c: number, d: number): void {
  buffers.indices.push(a, d, c, a, c, b);
}

/** Left and right edge points of a sample, including banking. */
function edges(sample: PathSample, halfWidth: number): { left: THREE.Vector3; right: THREE.Vector3 } {
  const bank = sample.bank;
  const lift = Math.sin(bank) * halfWidth;
  return {
    left: new THREE.Vector3(
      sample.pos.x + sample.normal.x * halfWidth,
      sample.y + lift,
      sample.pos.z + sample.normal.z * halfWidth,
    ),
    right: new THREE.Vector3(
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

  const count = path.samples.length;
  const steps = path.closed ? count : count - 1;
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i <= steps; i++) {
    const index = path.closed ? i % count : Math.min(i, count - 1);
    const sample = path.samples[index] as PathSample;
    const hw = sample.halfWidth;
    const { left, right } = edges(sample, hw);
    const outer = edges(sample, hw + SHOULDER_WIDTH);
    // V repeats every 9 m so the tarmac grain has a believable scale at speed.
    const v = sample.distance / 9;

    road.positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    road.normals.push(up.x, up.y, up.z, up.x, up.y, up.z);
    road.uvs.push(0, v, 1, v);

    shoulder.positions.push(
      outer.left.x, outer.left.y - 0.06, outer.left.z,
      left.x, left.y, left.z,
      right.x, right.y, right.z,
      outer.right.x, outer.right.y - 0.06, outer.right.z,
    );
    for (let k = 0; k < 4; k++) shoulder.normals.push(up.x, up.y, up.z);
    shoulder.uvs.push(0, v, 1, v, 0, v, 1, v);

    if (sample.edge === 'wall') {
      for (const [edge, dir] of [
        [outer.left, 1],
        [outer.right, -1],
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

  for (const [buffers, material, name] of [
    [shoulder, shoulderMaterial, 'shoulder'],
    [road, roadMaterial, 'road'],
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
    mesh.renderOrder = name === 'road' ? 1 : 0;
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
