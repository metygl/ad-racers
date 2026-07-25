import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { clamp01, smoothstep } from '../../core/math';
import type { Track } from '../../game/track/buildTrack';
import { surfaceTexture } from '../textures/procedural';

/**
 * The landscape the course sits in.
 *
 * A single heightfield covering the track's bounding box plus a margin. The
 * only interesting part is the blend: within the corridor the terrain is
 * pinned to the road's own elevation, then it eases out into free noise over a
 * few metres. Without that the road would either float above the ground or be
 * buried in it wherever the course climbs.
 */

/** How far past the corridor the terrain takes to reach its free height. */
const BLEND_DISTANCE = 26;
/** Extra ground drawn beyond the track bounds, so the horizon is never empty. */
const MARGIN = 220;

/** Two octaves of value noise, evaluated per vertex. */
function makeNoise(seed: number): (x: number, z: number) => number {
  const rng = new Rng(seed);
  const size = 64;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

  const at = (x: number, z: number, scale: number): number => {
    const fx = x * scale;
    const fz = z * scale;
    const x0 = ((Math.floor(fx) % size) + size) % size;
    const z0 = ((Math.floor(fz) % size) + size) % size;
    const x1 = (x0 + 1) % size;
    const z1 = (z0 + 1) % size;
    const tx = fx - Math.floor(fx);
    const tz = fz - Math.floor(fz);
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const a = (grid[z0 * size + x0] as number) * (1 - sx) + (grid[z0 * size + x1] as number) * sx;
    const b = (grid[z1 * size + x0] as number) * (1 - sx) + (grid[z1 * size + x1] as number) * sx;
    return a * (1 - sz) + b * sz;
  };

  return (x, z) => at(x, z, 0.006) * 0.68 + at(x + 500, z - 300, 0.021) * 0.32;
}

export interface TerrainResult {
  mesh: THREE.Mesh;
  /** Ground height at a world position, for scattering scenery. */
  heightAt: (x: number, z: number) => number;
}

export function buildTerrain(track: Track, resolution: number): TerrainResult {
  const { bounds, definition } = track;
  const minX = bounds.minX - MARGIN;
  const maxX = bounds.maxX + MARGIN;
  const minZ = bounds.minZ - MARGIN;
  const maxZ = bounds.maxZ + MARGIN;

  const cols = Math.max(2, Math.ceil((maxX - minX) / resolution)) + 1;
  const rows = Math.max(2, Math.ceil((maxZ - minZ) / resolution)) + 1;
  const stepX = (maxX - minX) / (cols - 1);
  const stepZ = (maxZ - minZ) / (rows - 1);

  const noise = makeNoise(definition.seed);
  const relief = definition.terrainRelief;

  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const heights = new Float32Array(cols * rows);

  const base = new THREE.Color(definition.theme.terrainColor);
  const accent = new THREE.Color(definition.theme.terrainAccent);
  const scratch = new THREE.Color();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = minX + c * stepX;
      const z = minZ + r * stepZ;

      const projection = track.project({ x, z });
      const outside = Math.abs(projection.lateral) - projection.halfWidth;
      // 0 right at the road edge, 1 once we are clear of the blend band.
      const freedom = smoothstep(0, BLEND_DISTANCE, outside);

      const free = noise(x, z);
      const wild = projection.y + (free - 0.5) * 2 * relief;
      // Just off the road the ground sits a touch below the tarmac so the
      // shoulder reads as a kerb rather than a seam.
      const height = projection.y - 0.25 + (wild - (projection.y - 0.25)) * freedom;

      positions[i * 3] = x;
      positions[i * 3 + 1] = height;
      positions[i * 3 + 2] = z;
      heights[i] = height;
      uvs[i * 2] = x / 40;
      uvs[i * 2 + 1] = z / 40;

      // Tint by a mix of slope-ish noise and distance from the road, which
      // gives a natural-looking band of worn ground either side of the course.
      const tint = clamp01(free * 0.75 + (1 - freedom) * 0.5);
      scratch.copy(base).lerp(accent, tint);
      colors[i * 3] = scratch.r;
      colors[i * 3 + 1] = scratch.g;
      colors[i * 3 + 2] = scratch.b;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: surfaceTexture(`terrain-${definition.id}`, '#ffffff', {
      seed: definition.seed,
      contrast: 0.22,
      repeat: 1,
      cells: 5,
    }),
    roughness: 1,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;

  const heightAt = (x: number, z: number): number => {
    const c = Math.round((x - minX) / stepX);
    const r = Math.round((z - minZ) / stepZ);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return 0;
    return heights[r * cols + c] as number;
  };

  return { mesh, heightAt };
}
