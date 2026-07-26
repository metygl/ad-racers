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

/**
 * Scales a filled buffer to a target peak.
 *
 * Every generator here sums components — harmonics, a resonant filter, noise —
 * whose worst case is not obvious from the parameters, and Web Audio hard-clips
 * anything outside [-1, 1]. Normalising afterwards makes the peak a property of
 * the API rather than something a tuning change can quietly break.
 * `tests/unit/audio.test.ts` asserts nothing ever clips.
 */
export function normalise(channel: Float32Array, target = 0.9): void {
  let peak = 0;
  for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i] as number));
  if (peak <= 1e-9) return;
  const gain = target / peak;
  for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] as number) * gain;
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
    normalise(channel);
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
    normalise(channel);
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
    normalise(channel, 0.8);
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
    normalise(channel, 0.55);
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
    normalise(channel);
  };
}

/**
 * A seamless loop of filtered noise, used for the wind and for every surface
 * bed.
 *
 * The seam is the whole difficulty. A noise buffer looped naively clicks at the
 * join, and at the volumes these run at a click every four seconds is the most
 * audible thing in the mix. Cross-fading the last `fade` fraction of the buffer
 * with its own beginning makes the loop point mathematically continuous, which
 * `tests/unit/audio.test.ts` asserts by comparing the samples either side of it.
 */
export function noiseLoop(
  length: number,
  sampleRate: number,
  options: { seed: number; lowpass: number; highpass?: number; fade?: number },
): (channel: Float32Array) => void {
  return (channel) => {
    const raw = new Float32Array(length);
    const cutoff = Math.min(0.99, (2 * Math.PI * options.lowpass) / sampleRate);
    const highCutoff = options.highpass ? Math.min(0.99, (2 * Math.PI * options.highpass) / sampleRate) : 0;
    let low = 0;
    let high = 0;
    for (let i = 0; i < length; i++) {
      const white = noiseAt(options.seed, i) * 2 - 1;
      low += cutoff * (white - low);
      if (highCutoff > 0) {
        high += highCutoff * (low - high);
        raw[i] = low - high;
      } else {
        raw[i] = low;
      }
    }

    const fade = Math.max(1, Math.floor(length * (options.fade ?? 0.12)));
    for (let i = 0; i < length; i++) channel[i] = raw[i] as number;
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      const tail = raw[length - fade + i] as number;
      const head = raw[i] as number;
      channel[i] = tail * (1 - t) + head * t;
    }
    normalise(channel, 0.72);
  };
}

/**
 * A rhythmic music layer that sits under the pad and fades in with intensity.
 *
 * Deliberately pitched from the same series as the pad and the interface
 * sounds, so nothing in the mix is ever in a different key from anything else.
 * It carries a pulse rather than a melody: a tune competes with the engine for
 * the player's attention, and the engine has to win.
 */
export function musicPulse(
  seconds: number,
  sampleRate: number,
  options: { root: number; bpm: number; seed: number },
): (channel: Float32Array, index: number) => void {
  const length = Math.floor(seconds * sampleRate);
  const beat = (60 / options.bpm) * sampleRate;
  // Root, fifth, octave, minor third: an open, unresolved shape that can loop
  // for four minutes without demanding somewhere to go.
  const degrees = [1, 1.5, 2, 1.2];

  return (channel, index) => {
    for (let i = 0; i < length; i++) {
      const beatIndex = Math.floor(i / beat);
      const phaseInBeat = (i % beat) / beat;
      const degree = degrees[beatIndex % degrees.length] as number;
      const frequency = options.root * degree * (beatIndex % 8 >= 4 ? 0.75 : 1);
      // A plucked envelope: fast attack, exponential decay, silent by the end
      // of the beat so nothing overlaps into the next.
      const envelope = Math.exp(-phaseInBeat * 6) * (1 - Math.exp(-phaseInBeat * 120));
      const t = i / sampleRate;
      const wobble = noiseAt(options.seed + beatIndex, i >> 8) * 0.02;
      const value =
        Math.sin(2 * Math.PI * frequency * t) * 0.6 +
        Math.sin(4 * Math.PI * frequency * t) * 0.18 +
        Math.sin(Math.PI * frequency * t) * 0.28;
      // A small stereo spread from the channel index, so the pulse has width
      // without needing a second buffer.
      channel[i] = value * envelope * (1 + (index === 0 ? -wobble : wobble));
    }
    normalise(channel, 0.55);
  };
}
