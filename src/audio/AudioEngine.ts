import { clamp, clamp01 } from '../core/math';
import type { RacerState, SimEvent } from '../game/sim/state';
import type { Simulation } from '../game/sim/simulation';
import { ambientPad, engineCycle, noiseBurst, sweep, tone } from './synth';

/**
 * The whole soundtrack, synthesised at startup.
 *
 * Two hard rules, both about respecting the player:
 *  - Nothing is created or started until a real user gesture. The context is
 *    built lazily on the first click or key press, so the game never trips a
 *    browser autoplay policy and never makes noise at someone who did not ask.
 *  - Music, effects and master are three independent gains with independent
 *    mutes, because "I want the engine but not the music" is a normal thing to
 *    want and should not require turning everything off.
 */

export interface AudioSettings {
  master: number;
  music: number;
  effects: number;
  muted: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = { master: 0.7, music: 0.5, effects: 0.85, muted: false };

type OneShot = 'countdown' | 'go' | 'impact' | 'scrape' | 'strike' | 'strikeHit' | 'counter' | 'boost' | 'drift' | 'lap' | 'finish' | 'uiMove' | 'uiSelect' | 'uiBack';

interface EngineVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  filter: BiquadFilterNode;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private buffers = new Map<OneShot, AudioBuffer>();
  private engineBuffer: AudioBuffer | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private voices = new Map<number, EngineVoice>();
  private settings: AudioSettings = { ...DEFAULT_AUDIO };
  private started = false;
  private failed = false;

  get isRunning(): boolean {
    return this.started && !this.failed && this.context?.state === 'running';
  }

  get unavailable(): boolean {
    return this.failed;
  }

  /**
   * Creates the context. Must be called from inside a user-gesture handler.
   * Safe to call repeatedly; only the first call does any work.
   */
  async start(): Promise<void> {
    if (this.started || this.failed) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.failed = true;
      return;
    }
    try {
      const context = new Ctor();
      this.context = context;
      this.masterGain = context.createGain();
      this.musicGain = context.createGain();
      this.effectsGain = context.createGain();
      this.musicGain.connect(this.masterGain);
      this.effectsGain.connect(this.masterGain);
      this.masterGain.connect(context.destination);

      this.buildBuffers(context);
      this.applySettings();
      this.started = true;
      if (context.state === 'suspended') await context.resume();
    } catch {
      // A browser that refuses to create a context is a supported situation:
      // the game stays fully playable, just silent.
      this.failed = true;
    }
  }

  /** Resumes after a tab switch or an autoplay suspension. */
  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        /* Nothing to do; the next gesture will try again. */
      }
    }
  }

  suspend(): void {
    void this.context?.suspend();
  }

  setSettings(settings: AudioSettings): void {
    this.settings = { ...settings };
    this.applySettings();
  }

  private applySettings(): void {
    if (!this.context || !this.masterGain || !this.musicGain || !this.effectsGain) return;
    const now = this.context.currentTime;
    const master = this.settings.muted ? 0 : clamp01(this.settings.master);
    // Ramps rather than steps, so a volume slider does not click.
    this.masterGain.gain.setTargetAtTime(master, now, 0.02);
    this.musicGain.gain.setTargetAtTime(clamp01(this.settings.music) * 0.5, now, 0.02);
    this.effectsGain.gain.setTargetAtTime(clamp01(this.settings.effects), now, 0.02);
  }

  private buffer(context: AudioContext, seconds: number, fill: (channel: Float32Array, index: number) => void, channels = 1): AudioBuffer {
    const length = Math.max(1, Math.floor(seconds * context.sampleRate));
    const buffer = context.createBuffer(channels, length, context.sampleRate);
    for (let c = 0; c < channels; c++) fill(buffer.getChannelData(c), c);
    return buffer;
  }

  private buildBuffers(context: AudioContext): void {
    const rate = context.sampleRate;

    this.buffers.set('countdown', this.buffer(context, 0.22, tone(Math.floor(0.22 * rate), rate, { frequency: 440, decay: 12, harmonics: [1, 0.2] })));
    this.buffers.set('go', this.buffer(context, 0.7, tone(Math.floor(0.7 * rate), rate, { frequency: 660, decay: 5, harmonics: [1, 0.45, 0.2, 0.1] })));
    this.buffers.set('impact', this.buffer(context, 0.45, noiseBurst(Math.floor(0.45 * rate), rate, { seed: 11, decay: 13, lowpass: 420, resonance: 0.55 })));
    this.buffers.set('scrape', this.buffer(context, 0.3, noiseBurst(Math.floor(0.3 * rate), rate, { seed: 23, decay: 9, lowpass: 2600, resonance: 0.2 })));
    this.buffers.set('strike', this.buffer(context, 0.3, sweep(Math.floor(0.3 * rate), rate, { from: 900, to: 240, decay: 14, noise: 0.5, seed: 31 })));
    this.buffers.set('strikeHit', this.buffer(context, 0.4, noiseBurst(Math.floor(0.4 * rate), rate, { seed: 41, decay: 16, lowpass: 900, resonance: 0.7 })));
    this.buffers.set('counter', this.buffer(context, 0.35, tone(Math.floor(0.35 * rate), rate, { frequency: 1180, decay: 14, harmonics: [1, 0.6, 0.3] })));
    this.buffers.set('boost', this.buffer(context, 0.85, sweep(Math.floor(0.85 * rate), rate, { from: 180, to: 1200, decay: 3.2, noise: 0.35, seed: 53 })));
    this.buffers.set('drift', this.buffer(context, 0.5, sweep(Math.floor(0.5 * rate), rate, { from: 320, to: 880, decay: 6, noise: 0.2, seed: 61 })));
    this.buffers.set('lap', this.buffer(context, 0.5, tone(Math.floor(0.5 * rate), rate, { frequency: 784, decay: 6, harmonics: [1, 0.3, 0.15] })));
    this.buffers.set('finish', this.buffer(context, 1.4, tone(Math.floor(1.4 * rate), rate, { frequency: 523.25, decay: 2.2, harmonics: [1, 0.5, 0.3, 0.18, 0.1] })));
    this.buffers.set('uiMove', this.buffer(context, 0.08, tone(Math.floor(0.08 * rate), rate, { frequency: 620, decay: 40, harmonics: [1] })));
    this.buffers.set('uiSelect', this.buffer(context, 0.16, tone(Math.floor(0.16 * rate), rate, { frequency: 880, decay: 22, harmonics: [1, 0.3] })));
    this.buffers.set('uiBack', this.buffer(context, 0.16, tone(Math.floor(0.16 * rate), rate, { frequency: 330, decay: 22, harmonics: [1, 0.25] })));

    // One engine cycle at a nominal 110 Hz; playback rate does the rest.
    const cycleLength = Math.floor(rate / 110);
    this.engineBuffer = this.buffer(context, cycleLength / rate, engineCycle(cycleLength, 7));
  }

  /** Starts the ambient bed. Called when a race begins. */
  startAmbience(root: number): void {
    if (!this.context || !this.musicGain) return;
    this.stopAmbience();
    const seconds = 12;
    const buffer = this.buffer(this.context, seconds, ambientPad(seconds, this.context.sampleRate, { root, seed: 5 }), 2);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.musicGain);
    source.start();
    this.ambientSource = source;
  }

  stopAmbience(): void {
    if (!this.ambientSource) return;
    try {
      this.ambientSource.stop();
    } catch {
      /* Already stopped. */
    }
    this.ambientSource.disconnect();
    this.ambientSource = null;
  }

  play(sound: OneShot, options: { volume?: number; rate?: number; pan?: number } = {}): void {
    const context = this.context;
    const buffer = this.buffers.get(sound);
    if (!context || !buffer || !this.effectsGain || context.state !== 'running') return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;

    const gain = context.createGain();
    gain.gain.value = clamp01(options.volume ?? 1);

    if (options.pan !== undefined && context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(options.pan, -1, 1);
      source.connect(gain).connect(panner).connect(this.effectsGain);
    } else {
      source.connect(gain).connect(this.effectsGain);
    }

    source.start();
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }

  /** Creates or updates the looping engine voice for one racer. */
  private voiceFor(index: number): EngineVoice | null {
    const context = this.context;
    if (!context || !this.engineBuffer || !this.effectsGain) return null;
    const existing = this.voices.get(index);
    if (existing) return existing;

    const source = context.createBufferSource();
    source.buffer = this.engineBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const gain = context.createGain();
    gain.gain.value = 0;
    const panner = context.createStereoPanner();
    source.connect(filter).connect(gain).connect(panner).connect(this.effectsGain);
    source.start();

    const voice: EngineVoice = { source, gain, panner, filter };
    this.voices.set(index, voice);
    return voice;
  }

  /**
   * Updates every engine voice from the simulation.
   *
   * The player's skiff is centred and loud; rivals are panned and attenuated by
   * where they are relative to the camera, which is the cue that tells you
   * someone is coming up your inside before you can see them.
   */
  updateEngines(simulation: Simulation, listenerHeading: number): void {
    if (!this.isRunning) return;
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const player = simulation.player ?? simulation.racers[0];
    if (!player) return;

    for (const racer of simulation.racers) {
      const voice = this.voiceFor(racer.index);
      if (!voice) continue;

      const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
      // RPM is speed-derived but never drops to silence, so an idling skiff on
      // the grid still sounds alive.
      const rpm = 0.32 + clamp01(speed / racer.spec.topSpeed) * 0.68 + (racer.boosting ? 0.22 : 0);
      voice.source.playbackRate.setTargetAtTime(rpm * 2.4, now, 0.06);

      let volume: number;
      let pan = 0;
      if (racer.isPlayer) {
        volume = 0.3;
        voice.filter.frequency.setTargetAtTime(racer.boosting ? 4200 : 2400, now, 0.1);
      } else {
        const dx = racer.pos.x - player.pos.x;
        const dz = racer.pos.z - player.pos.z;
        const distance = Math.hypot(dx, dz);
        // Inverse falloff with a floor, so a pack sounds like a pack rather
        // than like one car that keeps teleporting.
        volume = 0.22 / (1 + distance / 14);
        const right = Math.sin(listenerHeading) * dx - Math.cos(listenerHeading) * dz;
        pan = clamp(right / Math.max(6, distance), -1, 1);
        voice.filter.frequency.setTargetAtTime(2400 - clamp01(distance / 80) * 1500, now, 0.15);
      }

      voice.gain.gain.setTargetAtTime(volume, now, 0.08);
      voice.panner.pan.setTargetAtTime(pan, now, 0.08);
    }
  }

  /** Silences and releases every engine voice. */
  stopEngines(): void {
    for (const voice of this.voices.values()) {
      try {
        voice.source.stop();
      } catch {
        /* Already stopped. */
      }
      voice.source.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
      voice.panner.disconnect();
    }
    this.voices.clear();
  }

  /** Maps simulation events to one-shots. */
  handleEvents(events: readonly SimEvent[], simulation: Simulation, listenerHeading: number): void {
    if (!this.isRunning) return;
    const player = simulation.player ?? simulation.racers[0];

    const spatial = (racer: RacerState | undefined): { volume: number; pan: number } => {
      if (!racer || !player) return { volume: 1, pan: 0 };
      if (racer.isPlayer) return { volume: 1, pan: 0 };
      const dx = racer.pos.x - player.pos.x;
      const dz = racer.pos.z - player.pos.z;
      const distance = Math.hypot(dx, dz);
      const right = Math.sin(listenerHeading) * dx - Math.cos(listenerHeading) * dz;
      return { volume: clamp01(1 / (1 + distance / 18)), pan: clamp(right / Math.max(6, distance), -1, 1) };
    };

    for (const event of events) {
      switch (event.type) {
        case 'countdown':
          this.play(event.value > 0 ? 'countdown' : 'go', { volume: 0.8, rate: event.value > 0 ? 1 : 1 });
          break;
        case 'collision': {
          const { volume, pan } = spatial(simulation.racers[event.racer]);
          this.play('impact', { volume: volume * clamp01(event.speed / 16), pan, rate: 0.85 + clamp01(event.speed / 30) * 0.4 });
          break;
        }
        case 'wallHit': {
          const { volume, pan } = spatial(simulation.racers[event.racer]);
          this.play('scrape', { volume: volume * clamp01(event.speed / 22) * 0.7, pan });
          break;
        }
        case 'strikeSwing': {
          const { volume, pan } = spatial(simulation.racers[event.racer]);
          this.play('strike', { volume: volume * 0.6, pan });
          break;
        }
        case 'strikeHit': {
          const { volume, pan } = spatial(simulation.racers[event.target]);
          this.play('strikeHit', { volume: volume * (0.5 + event.strength * 0.5), pan });
          break;
        }
        case 'strikeCounter':
          this.play('counter', { volume: 0.7 });
          break;
        case 'boostStart': {
          const racer = simulation.racers[event.racer];
          const { volume, pan } = spatial(racer);
          this.play('boost', { volume: volume * 0.7, pan });
          break;
        }
        case 'driftRelease': {
          const racer = simulation.racers[event.racer];
          const { volume, pan } = spatial(racer);
          this.play('drift', { volume: volume * 0.55, pan, rate: 0.85 + event.tier * 0.16 });
          break;
        }
        case 'lap':
          if (simulation.racers[event.racer]?.isPlayer) this.play('lap', { volume: 0.6 });
          break;
        case 'finish':
          if (simulation.racers[event.racer]?.isPlayer) this.play('finish', { volume: 0.75 });
          break;
        default:
          break;
      }
    }
  }

  dispose(): void {
    this.stopEngines();
    this.stopAmbience();
    void this.context?.close();
    this.context = null;
    this.started = false;
  }
}
