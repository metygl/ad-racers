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
 * The kerb stripe.
 *
 * Two bands of colour running across the strip, softened at the seams and
 * scuffed towards the road edge where three hundred years of traffic would have
 * worn them. The V axis runs along the track, so the repeat is set by distance
 * and the stripes stay the same length whatever the road is doing.
 *
 * The accent colour is the course's, and it is one of only three places a
 * course is allowed to use full saturation — the art bible reserves that for
 * things a driver has to find.
 */
export function kerbTexture(accent: number): THREE.Texture {
  const key = `kerb-${accent.toString(16)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const hex = `#${accent.toString(16).padStart(6, '0')}`;

  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size / 2);

  // Scuff both bands unevenly, so the kerb reads as worn concrete rather than
  // as a flat two-tone decal.
  const rng = new Rng(accent ^ 0x51ed);
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#000000';
  for (let i = 0; i < 90; i++) {
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(1, 5), rng.range(1, 3));
  }
  ctx.globalAlpha = 1;

  const texture = finish(canvas, 1, key);
  // The U axis crosses the strip and must not tile; the V axis runs along the
  // track and must.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, 1);
  return texture;
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

/**
 * Hull plating: panel seams, rivet lines and streaked wear.
 *
 * The art review's word for the skiffs was "placeholder", and the largest part
 * of that is that a flat-shaded box in a crew colour has no *surface*. These
 * machines are three-hundred-year-old salvage rebuilt in a shed; the plating
 * should read as separate panels that were cut, bolted and then weathered at
 * different rates.
 *
 * The map is deliberately low contrast. A hull is the thing a player has to
 * identify at forty metres in fog, so the texture's job is to stop the panel
 * reading as plastic, not to compete with the crew colour for attention.
 */
export function plateTexture(): THREE.Texture {
  const key = 'skiff-plate';
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Mottling first, so seams and streaks sit on top of it.
  const noise = fbm(0x4d21, size, 4, 5);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < noise.length; i++) {
    const shade = 1 - (1 - (noise[i] as number)) * 0.17;
    image.data[i * 4] = (image.data[i * 4] as number) * shade;
    image.data[i * 4 + 1] = (image.data[i * 4 + 1] as number) * shade;
    image.data[i * 4 + 2] = (image.data[i * 4 + 2] as number) * shade;
  }
  ctx.putImageData(image, 0, 0);

  const rng = new Rng(0x4d21);

  // Panel seams. Uneven spacing, because a panel line every 32 px reads as a
  // grid rather than as plating cut to fit.
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 1.5;
  for (const axis of [0, 1]) {
    let at = rng.range(28, 60);
    while (at < size) {
      ctx.beginPath();
      if (axis === 0) {
        ctx.moveTo(at, 0);
        ctx.lineTo(at, size);
      } else {
        ctx.moveTo(0, at);
        ctx.lineTo(size, at);
      }
      ctx.stroke();
      // A highlight on the far side of the seam: the lip of the next panel.
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      if (axis === 0) {
        ctx.moveTo(at + 1.5, 0);
        ctx.lineTo(at + 1.5, size);
      } else {
        ctx.moveTo(0, at + 1.5);
        ctx.lineTo(size, at + 1.5);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.32)';
      at += rng.range(38, 82);
    }
  }

  // Rivets along a couple of the seams.
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  for (let i = 0; i < 120; i++) {
    ctx.beginPath();
    ctx.arc(rng.range(0, size), rng.range(0, size), 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Streaks running down from the seams, where three centuries of weather has
  // pulled the dirt out of the joints.
  for (let i = 0; i < 46; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const length = rng.range(12, 58);
    const gradient = ctx.createLinearGradient(x, y, x, y + length);
    gradient.addColorStop(0, 'rgba(0,0,0,0.20)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, rng.range(1.5, 4.5), length);
  }

  // Scrapes: bright, short, and only near the edges of the tile, so they read
  // as contact damage rather than as a pattern.
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 30; i++) {
    const x = rng.range(0, size);
    const y = rng.chance(0.5) ? rng.range(0, 26) : rng.range(size - 26, size);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + rng.range(-14, 14), y + rng.range(-3, 3));
    ctx.stroke();
  }

  return finish(canvas, 2, key);
}

/**
 * A crew's flank decal: race number, crew mark and hand-painted name.
 *
 * This is the "team graphics" the art review asked for, and it is drawn rather
 * than modelled for a reason — the alternative is geometry for a number, which
 * costs draw calls on the one part of the skiff a player only ever sees from
 * the side. The mark is built from the crew's own glyph seed, so two crews
 * never share one, and everything is painted in the crew's trim colour over a
 * scuffed patch of primer: these are not sponsored teams, they are people who
 * painted their own number on.
 */
export function liveryTexture(crewId: string, trimColor: number, glyph: number): THREE.Texture {
  const key = `livery-${crewId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const width = 256;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable; cannot generate textures');

  const trim = `#${trimColor.toString(16).padStart(6, '0')}`;
  const rng = new Rng(hashGlyph(crewId));

  ctx.clearRect(0, 0, width, height);

  // The primer patch the number is painted on. Irregular, because it was
  // brushed on by hand over whatever the panel used to be.
  ctx.fillStyle = 'rgba(18,20,24,0.62)';
  ctx.beginPath();
  ctx.moveTo(rng.range(4, 14), rng.range(6, 18));
  ctx.lineTo(width - rng.range(4, 16), rng.range(4, 16));
  ctx.lineTo(width - rng.range(6, 18), height - rng.range(6, 16));
  ctx.lineTo(rng.range(6, 16), height - rng.range(4, 14));
  ctx.closePath();
  ctx.fill();

  /*
   * The crew mark: a small original glyph built from the crew's seed as a
   * ring of struck bars. Deliberately abstract — a mark a crew could cut from
   * a stencil, not a logo — and never a recognisable emblem from anywhere.
   */
  ctx.save();
  ctx.translate(52, height / 2);
  ctx.strokeStyle = trim;
  ctx.lineWidth = 5;
  ctx.lineCap = 'square';
  const bars = 5 + (glyph % 3);
  for (let i = 0; i < bars; i++) {
    const angle = (i / bars) * Math.PI * 2 + (glyph % 7) * 0.21;
    const inner = 9 + ((glyph >> i) & 1) * 7;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * 27, Math.sin(angle) * 27);
    ctx.stroke();
  }
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // The crew's name, stencilled. Condensed and upper case so it survives being
  // 12 px tall on screen.
  ctx.fillStyle = trim;
  ctx.font = 'bold 34px "Arial Narrow", "Helvetica Neue", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(crewId.slice(0, 9).toUpperCase(), 96, height / 2 - 12);

  // A hand-lettered strip under it, in the same colour at low alpha: the sort
  // of thing painted on afterwards and never redone.
  ctx.globalAlpha = 0.5;
  ctx.font = '15px "Arial Narrow", "Helvetica Neue", sans-serif';
  ctx.fillText('RUN WHAT YOU BROUGHT', 97, height / 2 + 18);
  ctx.globalAlpha = 1;

  // Wear over the top of the paint, so the graphics look older than the panel.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = rng.range(0.1, 0.5);
    ctx.beginPath();
    ctx.ellipse(rng.range(0, width), rng.range(0, height), rng.range(1, 7), rng.range(1, 3), rng.range(0, 3), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = key;
  texture.anisotropy = 4;
  cache.set(key, texture);
  return texture;
}

/** Stable small integer from a crew id, so a crew's mark never changes. */
function hashGlyph(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A rider's helmet, unwrapped: dark shell, a bright visor band, and the crew's
 * stripe over the crown.
 *
 * The visor is the whole reason this is a texture rather than three meshes. A
 * head is 30 px on screen at race distance, and at 30 px the only thing that
 * distinguishes a *person* from a lump is a horizontal bright band where the
 * eyes are. It goes in the emissive map so it survives a night course, where
 * an unlit visor would disappear exactly when the silhouette matters most.
 */
export function helmetTexture(trimColor: number): { map: THREE.Texture; emissive: THREE.Texture } {
  const key = `helmet-${trimColor.toString(16)}`;
  const cachedMap = cache.get(key);
  const cachedEmissive = cache.get(`${key}-e`);
  if (cachedMap && cachedEmissive) return { map: cachedMap, emissive: cachedEmissive };

  const size = 64;
  const trim = `#${trimColor.toString(16).padStart(6, '0')}`;

  const shell = makeCanvas(size);
  shell.ctx.fillStyle = '#1a1d23';
  shell.ctx.fillRect(0, 0, size, size);
  // Crown stripe, running front to back.
  shell.ctx.fillStyle = trim;
  shell.ctx.fillRect(size * 0.44, 0, size * 0.12, size);
  // The visor aperture, dark in the albedo so the emissive reads as glass in
  // a recess rather than as paint.
  shell.ctx.fillStyle = '#0a0c10';
  shell.ctx.fillRect(0, size * 0.36, size, size * 0.2);

  const glass = makeCanvas(size);
  glass.ctx.fillStyle = '#000000';
  glass.ctx.fillRect(0, 0, size, size);
  const band = glass.ctx.createLinearGradient(0, size * 0.36, 0, size * 0.56);
  band.addColorStop(0, 'rgba(120,190,220,0.25)');
  band.addColorStop(0.5, 'rgba(190,240,255,1)');
  band.addColorStop(1, 'rgba(90,150,190,0.2)');
  glass.ctx.fillStyle = band;
  glass.ctx.fillRect(0, size * 0.36, size, size * 0.2);

  const map = finish(shell.canvas, 1, key);
  map.wrapS = THREE.RepeatWrapping;
  const emissiveTexture = new THREE.CanvasTexture(glass.canvas);
  emissiveTexture.wrapS = THREE.RepeatWrapping;
  emissiveTexture.wrapT = THREE.ClampToEdgeWrapping;
  emissiveTexture.colorSpace = THREE.SRGBColorSpace;
  emissiveTexture.name = `${key}-e`;
  cache.set(`${key}-e`, emissiveTexture);
  return { map, emissive: emissiveTexture };
}

/** Releases every generated texture. Called on teardown and context loss. */
export function disposeTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
