import * as THREE from 'three';
import { Rng } from '../../core/rng';

/**
 * Material families.
 *
 * The art review's ART-08 finding was that the world's materials "do not
 * support the fiction": every structure in the game was the same flat-shaded
 * standard material with a different colour, so a pane of glass, a rusted
 * girder and a leaf all reflected light identically. Colour alone cannot say
 * what a thing is *made of*, and a world where nothing has a material is a
 * world made of one substance painted six ways.
 *
 * A family here is a small, named, deliberately opinionated bundle: a roughness
 * and metalness that mean something physically, a breakup map so the surface is
 * not uniform, and a rule about flat shading. Everything in a course picks a
 * family rather than inventing its own numbers, which is what makes a course
 * read as a place built out of a limited set of real materials — the same
 * discipline as a physical set dresser working from a materials board.
 *
 * ## Why the breakup maps are greyscale multipliers
 *
 * Each family gets one tileable greyscale map used as `map` over a coloured
 * material. That gives every surface variation without a per-object texture,
 * and it costs one shared texture per family for the whole game rather than one
 * per species. The maps stay low contrast on purpose: at racing speed a busy
 * texture reads as noise, and noise competes with the things a driver actually
 * has to find.
 */

export type MaterialFamily =
  /** Old structural glass: smooth, quite reflective, and the only translucent family. */
  | 'glazing'
  /** Painted structural steel, chalked and streaked but intact. */
  | 'structure'
  /** Steel that lost its paint: rough, pitted, still metal. */
  | 'corroded'
  /** Leaves, stems, moss. Matte, never metallic, and always wind-swayed. */
  | 'growth'
  /** Poured concrete and cast stone: matte, dusty, faintly mottled. */
  | 'masonry'
  /** A working emitter — a lamp, a sign, a live conduit. */
  | 'emitter';

interface FamilyRecipe {
  roughness: number;
  metalness: number;
  flatShading: boolean;
  /** Breakup map contrast, 0 disables the map entirely. */
  breakup: number;
  /** How the breakup map is drawn. */
  pattern: 'mottle' | 'streak' | 'pit' | 'leaf' | 'grain';
  transparent?: boolean;
  opacity?: number;
}

const RECIPES: Record<MaterialFamily, FamilyRecipe> = {
  // High metalness with low roughness is what makes old glass catch the sky at
  // a grazing angle, which on a night course is most of what makes it visible.
  glazing: { roughness: 0.14, metalness: 0.86, flatShading: false, breakup: 0.1, pattern: 'grain', transparent: true, opacity: 0.42 },
  structure: { roughness: 0.62, metalness: 0.35, flatShading: true, breakup: 0.26, pattern: 'streak' },
  corroded: { roughness: 0.94, metalness: 0.22, flatShading: true, breakup: 0.4, pattern: 'pit' },
  growth: { roughness: 0.88, metalness: 0.0, flatShading: true, breakup: 0.3, pattern: 'leaf' },
  masonry: { roughness: 0.97, metalness: 0.0, flatShading: true, breakup: 0.22, pattern: 'mottle' },
  // An emitter's albedo barely matters; the emissive does the work. Kept
  // slightly rough so the housing around the light still catches the key.
  emitter: { roughness: 0.42, metalness: 0.4, flatShading: true, breakup: 0.14, pattern: 'grain' },
};

const maps = new Map<MaterialFamily, THREE.Texture>();

/** Tileable greyscale breakup, drawn once per family and shared everywhere. */
function breakupMap(family: MaterialFamily): THREE.Texture {
  const existing = maps.get(family);
  if (existing) return existing;

  const recipe = RECIPES[family];
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable; cannot generate material maps');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const rng = new Rng(0x9e37 ^ family.length ^ (family.charCodeAt(0) << 8));
  const dark = (a: number): string => `rgba(0,0,0,${a.toFixed(3)})`;
  const light = (a: number): string => `rgba(255,255,255,${a.toFixed(3)})`;
  const c = recipe.breakup;

  switch (recipe.pattern) {
    case 'mottle':
      for (let i = 0; i < 420; i++) {
        ctx.fillStyle = rng.chance(0.5) ? dark(rng.range(0.02, c * 0.5)) : light(rng.range(0.02, c * 0.35));
        ctx.beginPath();
        ctx.arc(rng.range(0, size), rng.range(0, size), rng.range(2, 13), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'streak':
      // Vertical runs: paint chalks and rain carries it downwards, so the
      // direction is not arbitrary.
      for (let i = 0; i < 120; i++) {
        const x = rng.range(0, size);
        const y = rng.range(0, size);
        const length = rng.range(10, 62);
        const gradient = ctx.createLinearGradient(x, y, x, y + length);
        gradient.addColorStop(0, dark(rng.range(0.05, c)));
        gradient.addColorStop(1, dark(0));
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, rng.range(1, 5), length);
      }
      break;
    case 'pit':
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = rng.chance(0.68) ? dark(rng.range(0.05, c)) : light(rng.range(0.03, c * 0.6));
        const r = rng.range(0.6, 3.2);
        ctx.beginPath();
        ctx.arc(rng.range(0, size), rng.range(0, size), r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'leaf':
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = rng.chance(0.5) ? dark(rng.range(0.04, c * 0.8)) : light(rng.range(0.04, c * 0.5));
        ctx.save();
        ctx.translate(rng.range(0, size), rng.range(0, size));
        ctx.rotate(rng.range(0, Math.PI));
        ctx.beginPath();
        ctx.ellipse(0, 0, rng.range(3, 9), rng.range(1, 3), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      break;
    case 'grain':
      for (let i = 0; i < 1600; i++) {
        ctx.fillStyle = rng.chance(0.5) ? dark(rng.range(0.01, c * 0.7)) : light(rng.range(0.01, c * 0.7));
        ctx.fillRect(rng.range(0, size), rng.range(0, size), 1, rng.range(1, 3));
      }
      break;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = `family-${family}`;
  maps.set(family, texture);
  return texture;
}

export interface FamilyOptions {
  color: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  /** Texture repeat, in tiles across the prototype. Bigger objects want more. */
  repeat?: number;
}

/**
 * Builds a material in the given family.
 *
 * Every caller supplies a colour and nothing else about how light behaves —
 * that is the whole point. A species that wants to be shinier picks a different
 * family rather than nudging a roughness, which is what stops the set drifting
 * back into six hundred unrelated numbers.
 */
export function familyMaterial(family: MaterialFamily, options: FamilyOptions): THREE.MeshStandardMaterial {
  const recipe = RECIPES[family];
  const map = breakupMap(family).clone();
  map.needsUpdate = true;
  const repeat = options.repeat ?? 1;
  map.repeat.set(repeat, repeat);

  const material = new THREE.MeshStandardMaterial({
    color: options.color,
    map,
    roughness: recipe.roughness,
    metalness: recipe.metalness,
    flatShading: recipe.flatShading,
  });
  if (recipe.transparent) {
    material.transparent = true;
    material.opacity = recipe.opacity ?? 1;
    // Transparent surfaces that write depth sort against themselves and punch
    // holes in whatever is behind them; on a glazing wall that is every pane.
    material.depthWrite = false;
  }
  if (options.emissive !== undefined) {
    material.emissive = new THREE.Color(options.emissive);
    material.emissiveIntensity = options.emissiveIntensity ?? 1;
  }
  return material;
}

/** Releases the shared family maps. Called from the renderer's teardown. */
export function disposeFamilyMaps(): void {
  for (const map of maps.values()) map.dispose();
  maps.clear();
}
