/**
 * Deterministic pseudo-random number generation.
 *
 * Every random decision inside the simulation (AI mistakes, hazard timing,
 * particle jitter that feeds back into physics) must come from one of these so
 * that a race replays identically from the same seed. `Math.random` is banned
 * in `src/game/sim` and `src/game/ai`; `tests/unit/determinism.test.ts` guards
 * that by running the same race twice and comparing the results.
 */

/** sfc32 — small, fast, passes PractRand, and trivially serialisable. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // Scramble a single 32-bit seed into four words so that adjacent seeds
    // (1, 2, 3 ...) produce well-separated streams.
    let h = seed >>> 0;
    const next = (): number => {
      h = (h + 0x6d2b79f5) >>> 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // Discard the first few outputs so the stream is well mixed.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return (r >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Snapshot of the internal state, for save/restore in tests and replays. */
  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  setState(state: readonly [number, number, number, number]): void {
    [this.a, this.b, this.c, this.d] = state;
  }

  clone(): Rng {
    const copy = new Rng(0);
    copy.setState(this.getState());
    return copy;
  }
}

/**
 * Turns an arbitrary string (track id, racer id, "grid-shuffle") into a 32-bit
 * seed so subsystems can derive independent, reproducible streams from one
 * race seed without stealing draws from each other.
 */
export function hashSeed(text: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
