import * as THREE from 'three';
import { Rng } from '../../core/rng';

/**
 * Procedural textures.
 *
 * Every texture in the game is drawn here, at load time, into a canvas. There
 * are no image files in the repository and nothing is fetched at runtime, which
 * means the download is a few kilobytes of code rather than megabytes of PNGs,
 * the provenance of every pixel is this file, and a race can start with the
 * network unplugged. See docs/ASSET-PIPELINE.md.
 *
 * All generation is seeded, so the same texture comes out byte-identical on
 * every machine and every run.
 */

const cache = new Map<string, THREE.Texture>();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable; cannot generate textures');
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, repeat: number, key: string): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = key;
  cache.set(key, texture);
  return texture;
}

/** Value noise, sampled on a torus so the result tiles seamlessly. */
function tileableNoise(rng: Rng, size: number, cells: number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

  const out = new Float32Array(size * size);
  const scale = cells / size;
  const smooth = (t: number): number => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const fy = y * scale;
      const x0 = Math.floor(fx) % cells;
      const y0 = Math.floor(fy) % cells;
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const tx = smooth(fx - Math.floor(fx));
      const ty = smooth(fy - Math.floor(fy));
      const a = (grid[y0 * cells + x0] as number) * (1 - tx) + (grid[y0 * cells + x1] as number) * tx;
      const b = (grid[y1 * cells + x0] as number) * (1 - tx) + (grid[y1 * cells + x1] as number) * tx;
      out[y * size + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Sums several octaves of tileable noise into a single 0-1 field. */
function fbm(seed: number, size: number, octaves: number, baseCells: number): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableNoise(new Rng(seed + o * 7919), size, baseCells * Math.pow(2, o));
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (layer[i] as number) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / total;
  return out;
}

/**
 * A mottled surface texture: noise-driven brightness variation over a base
 * colour, with optional flecks. Used for the road, terrain and rock.
 */
export function surfaceTexture(
  key: string,
  baseColor: string,
  options: {
    seed: number;
    size?: number;
    repeat?: number;
    /** Peak lightness swing, 0-1. */
    contrast?: number;
    /** Fleck colour and count. */
    fleckColor?: string;
    fleckCount?: number;
    fleckSize?: number;
    octaves?: number;
    cells?: number;
  },
): THREE.Texture {
  const cached = cache.get(key);
  if (cached) return cached;

  const size = options.size ?? 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, size, size);

  const noise = fbm(options.seed, size, options.octaves ?? 4, options.cells ?? 4);
  const image = ctx.getImageData(0, 0, size, size);
  const contrast = options.contrast ?? 0.16;
  for (let i = 0; i < noise.length; i++) {
    const shade = 1 + ((noise[i] as number) - 0.5) * 2 * contrast;
    image.data[i * 4] = Math.min(255, (image.data[i * 4] as number) * shade);
    image.data[i * 4 + 1] = Math.min(255, (image.data[i * 4 + 1] as number) * shade);
    image.data[i * 4 + 2] = Math.min(255, (image.data[i * 4 + 2] as number) * shade);
  }
  ctx.putImageData(image, 0, 0);

  if (options.fleckColor && options.fleckCount) {
    const rng = new Rng(options.seed + 4211);
    ctx.fillStyle = options.fleckColor;
    for (let i = 0; i < options.fleckCount; i++) {
      const r = options.fleckSize ?? 1.4;
      ctx.globalAlpha = rng.range(0.15, 0.5);
      ctx.beginPath();
      ctx.arc(rng.range(0, size), rng.range(0, size), rng.range(r * 0.4, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return finish(canvas, options.repeat ?? 1, key);
}

/**
 * The road surface: mottled tarmac with a worn centre and a dashed centre line.
 * The line is baked in rather than drawn as separate geometry, which keeps the
 * whole road to a single draw call.
 */
export function roadTexture(key: string, base: string, line: string, seed: number): THREE.Texture {
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const noise = fbm(seed, size, 4, 6);
  const image = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // U runs across the road, so darken the wheel tracks at roughly a
      // third and two thirds of the width.
      const u = x / size;
      const wear = Math.exp(-Math.pow((u - 0.32) / 0.09, 2)) + Math.exp(-Math.pow((u - 0.68) / 0.09, 2));
      const shade = (1 + ((noise[i] as number) - 0.5) * 0.34) * (1 - wear * 0.12);
      image.data[i * 4] = Math.min(255, (image.data[i * 4] as number) * shade);
      image.data[i * 4 + 1] = Math.min(255, (image.data[i * 4 + 1] as number) * shade);
      image.data[i * 4 + 2] = Math.min(255, (image.data[i * 4 + 2] as number) * shade);
    }
  }
  ctx.putImageData(image, 0, 0);

  // Dashed centre line, faded and broken up so it reads as three hundred years
  // old rather than freshly painted.
  const rng = new Rng(seed + 99);
  ctx.fillStyle = line;
  for (let y = 0; y < size; y += 64) {
    ctx.globalAlpha = rng.range(0.25, 0.6);
    ctx.fillRect(size / 2 - 3, y + 8, 6, 34);
  }
  ctx.globalAlpha = 1;

  return finish(canvas, 1, key);
}

/**
 * A soft radial falloff used for every additive particle. One texture serves
 * dust, sparks, embers and the impact flash; the colour comes from the
 * instance, not the texture.
 */
export function particleTexture(): THREE.Texture {
  const key = 'particle';
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.62)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = key;
  cache.set(key, texture);
  return texture;
}

/** Releases every generated texture. Called on teardown and context loss. */
export function disposeTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
