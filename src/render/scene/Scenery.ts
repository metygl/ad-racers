import * as THREE from 'three';
import { Rng, hashSeed } from '../../core/rng';
import { mergeGeometries } from './mergeGeometry';
import type { Track } from '../../game/track/buildTrack';
import type { ObstacleDefinition, PathSample, SceneryKind, TrackTheme } from '../../game/track/types';

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

/** Prototype geometry for one scenery kind, in local space, y-up from 0. */
function prototype(kind: SceneryKind, theme: TrackTheme): { geometry: THREE.BufferGeometry; material: THREE.Material } {
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
        material: new THREE.MeshStandardMaterial({ color: 0x2f5c3a, roughness: 0.9, flatShading: true }),
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
        material: new THREE.MeshStandardMaterial({ color: 0x4a7c3f, roughness: 0.88, flatShading: true }),
      };
    }
    case 'palm': {
      const geometry = mergeGeometries([
        { geometry: new THREE.CylinderGeometry(0.2, 0.34, 6, 5), position: [0, 3, 0] },
        { geometry: new THREE.ConeGeometry(2.4, 0.8, 5), position: [0, 6.2, 0] },
      ]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({ color: 0x6d8a4a, roughness: 0.9, flatShading: true }),
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
        material: new THREE.MeshStandardMaterial({ color: 0xb8ac7e, roughness: 1, flatShading: true }),
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
  }
}

export interface SceneryOptions {
  densityScale: number;
  visibilityDistance: number;
  heightAt: (x: number, z: number) => number;
  castShadows: boolean;
}

/**
 * Scatters every scenery spec the course declares. Placement is seeded from the
 * track, so the world is identical on every load and every machine — which
 * matters because the screenshots in the docs and the visual regression checks
 * would otherwise drift.
 */
export function buildScenery(track: Track, options: SceneryOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'scenery';
  const samples = track.main.samples;
  const theme = track.definition.theme;

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

        // Never place anything on a drivable surface, including shortcuts.
        const projection = track.project({ x, z });
        if (Math.abs(projection.lateral) < projection.halfWidth + 2.5) continue;

        placements.push({ x, z, scale: rng.range(spec.scaleMin, spec.scaleMax), rotation: rng.range(0, Math.PI * 2) });
      }
    }

    if (placements.length === 0) continue;

    const chunkSize = Math.max(40, options.visibilityDistance / 3);
    const chunks = new Map<string, typeof placements>();
    for (const placement of placements) {
      const key = `${Math.floor(placement.x / chunkSize)},${Math.floor(placement.z / chunkSize)}`;
      const chunk = chunks.get(key) ?? [];
      chunk.push(placement);
      chunks.set(key, chunk);
    }

    const { geometry, material } = prototype(spec.kind, theme);
    for (const [key, chunk] of chunks) {
      const [cellX, cellZ] = key.split(',').map(Number) as [number, number];
      const originX = (cellX + 0.5) * chunkSize;
      const originZ = (cellZ + 0.5) * chunkSize;
      const mesh = new THREE.InstancedMesh(geometry, material, chunk.length);
      mesh.name = `scenery-${spec.kind}`;
      mesh.position.set(originX, 0, originZ);
      mesh.castShadow = options.castShadows;
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      chunk.forEach((p, index) => {
        position.set(p.x - originX, options.heightAt(p.x, p.z) - 0.2, p.z - originZ);
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
