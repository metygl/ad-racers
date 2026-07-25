/**
 * Waveform and buffer generation.
 *
 * Every sound in the game is synthesised here. There are no audio files, which
 * means nothing to license, nothing to download and nothing to fail on a slow
 * connection — and it keeps the provenance of the soundtrack as simple as the
 * provenance of the textures. See docs/ASSET-PIPELINE.md.
 *
 * Split out from `AudioEngine` so the maths is testable in Node without a
 * `AudioContext`.
 */

/** Deterministic value noise, used instead of `Math.random` in buffers. */
function noiseAt(seed: number, index: number): number {
  let h = (seed + index * 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface BufferSpec {
  channels: number;
  length: number;
  sampleRate: number;
  /** Fills one channel. */
  fill: (channel: Float32Array, channelIndex: number, sampleRate: number) => void;
}

/**
 * Filtered noise, the basis of every impact and surface sound. `resonance`
 * above zero adds a simple one-pole resonant character without needing a
 * BiquadFilter per voice.
 */
export function noiseBurst(
  length: number,
  sampleRate: number,
  options: { seed: number; decay: number; lowpass: number; resonance?: number },
): (channel: Float32Array) => void {
  return (channel) => {
    let low = 0;
    let band = 0;
    const f = Math.min(0.99, (2 * Math.PI * options.lowpass) / sampleRate);
    const q = options.resonance ?? 0;
    for (let i = 0; i < length; i++) {
      const white = noiseAt(options.seed, i) * 2 - 1;
      // State-variable lowpass; cheap, stable, and the resonance term gives the
      // "thunk" its pitch without a separate oscillator.
      const high = white - low - q * band;
      band += f * high;
      low += f * band;
      const envelope = Math.exp((-i / sampleRate) * options.decay);
      channel[i] = low * envelope;
    }
  };
}

/** A short pitched blip: the countdown lights and the UI clicks. */
export function tone(
  length: number,
  sampleRate: number,
  options: { frequency: number; decay: number; harmonics?: number[]; attack?: number },
): (channel: Float32Array) => void {
  const harmonics = options.harmonics ?? [1, 0.35, 0.12];
  const attack = options.attack ?? 0.004;
  return (channel) => {
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      let sample = 0;
      for (let h = 0; h < harmonics.length; h++) {
        sample += (harmonics[h] as number) * Math.sin(2 * Math.PI * options.frequency * (h + 1) * t);
      }
      const rise = Math.min(1, t / attack);
      channel[i] = sample * rise * Math.exp(-t * options.decay);
    }
  };
}

/**
 * The engine loop.
 *
 * A single cycle of a rich sawtooth-like waveform plus a breath of noise,
 * played back at a rate proportional to RPM. One looping buffer per racer is
 * far cheaper than a bank of oscillators and gives a more convincing engine,
 * because the harmonic content stays constant as the pitch slides.
 */
export function engineCycle(length: number, seed: number): (channel: Float32Array) => void {
  return (channel) => {
    for (let i = 0; i < length; i++) {
      const phase = i / length;
      // Asymmetric saw: a hard edge and a slow return reads as combustion
      // rather than as a synth.
      const saw = phase < 0.18 ? phase / 0.18 : 1 - (phase - 0.18) / 0.82;
      const body = saw * 2 - 1;
      const growl = Math.sin(2 * Math.PI * phase * 3) * 0.22 + Math.sin(2 * Math.PI * phase * 5) * 0.1;
      const grit = (noiseAt(seed, i) * 2 - 1) * 0.12;
      channel[i] = (body * 0.62 + growl + grit) * 0.5;
    }
  };
}

/**
 * The ambience bed: a slow, wide pad built from detuned sines over a fifth.
 * Deliberately unmelodic — it sits under the engine without competing with it,
 * and it loops seamlessly because every partial completes a whole number of
 * cycles across the buffer.
 */
export function ambientPad(
  seconds: number,
  sampleRate: number,
  options: { root: number; seed: number },
): (channel: Float32Array, channelIndex: number) => void {
  const length = Math.floor(seconds * sampleRate);
  // Ratios over the root; whole-cycle counts guarantee a click-free loop.
  const partials = [1, 1.5, 2, 3, 4.5];
  return (channel, channelIndex) => {
    for (let p = 0; p < partials.length; p++) {
      const ratio = partials[p] as number;
      const cycles = Math.round((options.root * ratio * seconds) / 1) || 1;
      const amplitude = 0.34 / (p + 1.4);
      // A small per-channel and per-partial phase offset widens the stereo
      // image without any actual reverb.
      const phase = noiseAt(options.seed, p * 7 + channelIndex) * Math.PI * 2;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Slow amplitude drift so the pad breathes instead of droning.
        const swell = 0.72 + 0.28 * Math.sin(2 * Math.PI * (p + 1) * t + phase);
        channel[i] = (channel[i] as number) + Math.sin(2 * Math.PI * cycles * t + phase) * amplitude * swell;
      }
    }
    // Normalise so the pad never clips regardless of how the partials line up.
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(channel[i] as number));
    if (peak > 0) {
      const gain = 0.55 / peak;
      for (let i = 0; i < length; i++) channel[i] = (channel[i] as number) * gain;
    }
  };
}

/**
 * A rising or falling sweep, used for the Surge burst and the drift release.
 */
export function sweep(
  length: number,
  sampleRate: number,
  options: { from: number; to: number; decay: number; noise?: number; seed?: number },
): (channel: Float32Array) => void {
  return (channel) => {
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const frequency = options.from + (options.to - options.from) * t * t;
      phase += (2 * Math.PI * frequency) / sampleRate;
      const noise = options.noise ? (noiseAt(options.seed ?? 1, i) * 2 - 1) * options.noise : 0;
      channel[i] = (Math.sin(phase) * (1 - (options.noise ?? 0)) + noise) * Math.exp((-i / sampleRate) * options.decay);
    }
  };
}
