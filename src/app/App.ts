import { AudioEngine } from '../audio/AudioEngine';
import { clamp01, formatLapTime } from '../core/math';
import { PerformanceMonitor } from '../core/perf';
import { clearSave, defaultSave, loadSave, recordResult, saveSave } from '../core/storage';
import type { GameSettings, SaveData } from '../core/storage';
import { FIXED_STEP, MAX_STEPS_PER_FRAME } from '../game/config';
import { getDifficulty } from '../game/ai/driver';
import { InputManager } from '../game/input/InputManager';
import { bindingLabel } from '../game/input/bindings';
import type { ActionId } from '../game/input/bindings';
import { normalizeRacerId, RACERS } from '../game/racers';
import { Simulation } from '../game/sim/simulation';
import { emptyInput } from '../game/sim/state';
import type { ControlInput, SimEvent } from '../game/sim/state';
import { getTrack, TRACK_DEFINITIONS } from '../game/track/tracks';
import { GameRenderer } from '../render/Renderer';
import { AdaptiveQuality, detectInitialQuality } from '../render/quality';
import type { QualityId } from '../render/quality';
import { buildSettingsScreen } from './screens/SettingsScreen';
import { buildSetupScreen } from './screens/SetupScreen';
import { buildTitleScreen } from './screens/TitleScreen';
import { buildControlsCard, buildMessagePanel, buildPauseOverlay, buildResultsScreen } from './screens/panels';
import { Hud } from './ui/Hud';
import { TouchControls, shouldUseTouch } from './ui/TouchControls';
import { clear, el, trapFocus } from './ui/dom';

/**
 * The application shell: screen flow, the game loop, and the wiring between
 * the simulation, the renderer, the audio engine and the DOM.
 *
 * The loop is the important part. The simulation only ever advances in whole
 * fixed steps, the renderer is handed wall-clock time for its own smoothing,
 * and the accumulator is capped — so a slow frame, a background tab or a
 * breakpoint can never make the race play out differently.
 */

type ScreenName = 'loading' | 'title' | 'setup' | 'settings' | 'controls' | 'race' | 'results' | 'error' | 'unsupported';

export interface AppOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
}

export class App {
  private readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private readonly ui: HTMLElement;
  private readonly hud: Hud;
  private readonly input = new InputManager();
  private readonly audio = new AudioEngine();
  private readonly perf = new PerformanceMonitor();
  private readonly touch: TouchControls;
  private readonly perfOverlay: HTMLElement;

  private renderer: GameRenderer | null = null;
  private adaptive: AdaptiveQuality;
  private save: SaveData;
  private simulation: Simulation | null = null;
  /**
   * A full AI-only race that runs behind the menus.
   *
   * It costs one extra simulation and one extra draw while the player is in a
   * menu, and it buys a title screen that is demonstrably the real game rather
   * than a still image. It is torn down the moment a real race starts, and it
   * stops entirely with the frame loop when the tab is hidden.
   */
  private attract: Simulation | null = null;
  private attractIndex = 0;
  private screen: ScreenName = 'loading';
  private previousScreen: ScreenName = 'title';
  private paused = false;
  private accumulator = 0;
  private lastFrame = 0;
  private frameHandle = 0;
  private releaseTrap: (() => void) | null = null;
  private systemReducedMotion = false;
  private contextLost = false;
  private raceSeed = 1;
  private lastResultRecords = { race: false, lap: false };
  private detachInput: (() => void) | null = null;
  private lastPlayerInput: ControlInput = emptyInput();

  constructor(options: AppOptions) {
    this.root = options.root;
    this.canvas = options.canvas;
    this.save = loadSave();
    this.save.settings.lastRacer = normalizeRacerId(this.save.settings.lastRacer);

    this.ui = el('div', { class: 'ui', 'data-testid': 'ui' });
    this.hud = new Hud();
    this.hud.root.hidden = true;
    this.perfOverlay = el('div', { class: 'perf', hidden: true, 'aria-hidden': 'true' });
    this.touch = new TouchControls({ input: this.input, onPause: () => this.togglePause(true) });

    this.root.append(this.hud.root, this.ui, this.touch.root, this.perfOverlay);

    this.adaptive = new AdaptiveQuality(this.save.settings.autoQuality ? detectInitialQuality() : this.save.settings.quality);
  }

  /**
   * Boots the game. Resolves once the first screen is on the page.
   *
   * Async only so callers can await a failure; nothing here needs to wait on
   * anything, which is deliberate — the first frame should not be gated on a
   * promise.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.showScreen('loading');

    this.systemReducedMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.systemReducedMotion && !this.save.settings.reducedMotion) {
      this.save.settings.reducedMotion = true;
    }
    if (typeof matchMedia === 'function' && matchMedia('(prefers-contrast: more)').matches) {
      this.save.settings.highContrast = true;
    }
    this.applyDocumentSettings();

    this.detachInput = this.input.attach();
    this.input.setBindings(this.save.settings.bindings);
    this.input.onAction = this.handleAction;
    this.input.setEnabled(false);

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);

    try {
      this.renderer = new GameRenderer({
        canvas: this.canvas,
        quality: this.adaptive.tier,
        reducedMotion: this.save.settings.reducedMotion,
        onContextLost: this.handleContextLost,
        onContextRestored: this.handleContextRestored,
        onCanvasReplaced: (canvas) => {
          this.canvas = canvas;
        },
      });
    } catch (error) {
      this.showUnsupported(error);
      return;
    }

    this.handleResize();
    // Warm the first track so the first race does not stall on spline building.
    try {
      getTrack(this.save.settings.lastTrack);
    } catch {
      this.save.settings.lastTrack = TRACK_DEFINITIONS[0]?.id ?? 'overgrown-interchange';
    }

    this.startAttract();

    this.lastFrame = performance.now();
    this.frameHandle = requestAnimationFrame(this.frame);
    this.showTitle();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.detachInput?.();
    this.audio.dispose();
    this.renderer?.dispose();
  }

  // --- settings -----------------------------------------------------------

  private applyDocumentSettings(): void {
    const settings = this.save.settings;
    document.documentElement.classList.toggle('reduced-motion', settings.reducedMotion);
    document.documentElement.classList.toggle('high-contrast', settings.highContrast);
    this.hud.setReducedMotion(settings.reducedMotion);
    this.hud.setRecoverKey(bindingLabel(settings.bindings, 'respawn'));
    this.perfOverlay.hidden = !settings.showPerformance;
    this.audio.setSettings(settings.audio);
  }

  private persist(): void {
    saveSave(this.save);
  }

  private updateSettings(next: GameSettings): void {
    const previousQuality = this.save.settings.autoQuality ? 'auto' : this.save.settings.quality;
    const nextQuality = next.autoQuality ? 'auto' : next.quality;
    if (nextQuality !== previousQuality && this.renderer) {
      const tier: QualityId = next.autoQuality ? detectInitialQuality() : next.quality;
      const active = this.simulation ?? this.attract;
      try {
        this.renderer.setQuality(tier, active);
      } catch {
        this.showSettings();
        return;
      }
      this.adaptive.reset(tier);
      if (!this.simulation) {
        if (tier === 'low') this.stopAttract();
        else if (!this.attract) this.startAttract();
      }
    }

    this.save.settings = next;
    this.input.setBindings(next.bindings);
    this.applyDocumentSettings();
    this.persist();
    this.renderer?.setReducedMotion(next.reducedMotion);
    if (this.renderer) this.renderer.chase.mode = next.cameraMode;
  }

  // --- screens ------------------------------------------------------------

  /** True until the player has interacted; suppresses the initial auto-focus. */
  private firstPaint = true;

  private showScreen(name: ScreenName, content?: HTMLElement): void {
    this.input.cancelCapture();
    this.releaseTrap?.();
    this.releaseTrap = null;
    this.screen = name;
    clear(this.ui);
    this.ui.dataset.screen = name;

    const inRace = name === 'race';
    this.hud.root.hidden = !inRace;
    this.ui.hidden = inRace && !this.paused;
    this.input.setEnabled(inRace && !this.paused);
    if (inRace && shouldUseTouch()) this.touch.show();
    else this.touch.hide();

    if (content) {
      this.ui.append(content);
      // Menus are modal over the canvas, so focus has to be contained.
      if (name !== 'race') this.releaseTrap = trapFocus(this.ui, !this.firstPaint);
      this.firstPaint = false;
    } else if (name === 'loading') {
      this.ui.append(
        buildMessagePanel({
          kind: 'loading',
          heading: 'Warming the skiffs',
          body: 'Building the course. This happens once and takes a moment.',
        }),
      );
    }
  }

  private bestSummary(): string | null {
    const entries = Object.entries(this.save.bests).filter(([, best]) => Number.isFinite(best.race));
    if (entries.length === 0) return null;
    const [trackId, best] = entries[0] as [string, { race: number; lap: number }];
    const track = TRACK_DEFINITIONS.find((t) => t.id === trackId);
    return `Best so far — ${track?.name ?? trackId}: ${formatLapTime(best.race)}`;
  }

  private showTitle(): void {
    this.stopRace();
    this.showScreen(
      'title',
      buildTitleScreen({
        onRace: () => {
          void this.audio.start();
          if (!this.save.settings.seenControls) this.showControls(true);
          else this.showSetup();
        },
        onSettings: () => this.showSettings(),
        onControls: () => this.showControls(false),
        bestSummary: this.bestSummary(),
      }),
    );
  }

  private showControls(firstRun: boolean): void {
    this.showScreen(
      'controls',
      buildControlsCard(
        this.save.settings,
        () => {
          if (firstRun) {
            this.save.settings.seenControls = true;
            this.persist();
            this.showSetup();
          } else {
            this.showTitle();
          }
        },
        firstRun ? 'Continue' : 'Back',
      ),
    );
  }

  private showSetup(): void {
    this.showScreen(
      'setup',
      buildSetupScreen({
        selection: {
          trackId: this.save.settings.lastTrack,
          racerId: this.save.settings.lastRacer,
          difficultyId: this.save.settings.lastDifficulty,
        },
        bests: this.save.bests,
        onChange: (selection) => {
          this.save.settings.lastTrack = selection.trackId;
          this.save.settings.lastRacer = selection.racerId;
          this.save.settings.lastDifficulty = selection.difficultyId;
          this.persist();
        },
        onStart: () => this.startRace(),
        onBack: () => this.showTitle(),
      }),
    );
  }

  private showSettings(): void {
    const returnTo = this.screen === 'race' ? 'race' : this.screen;
    this.previousScreen = returnTo === 'settings' ? 'title' : returnTo;
    this.showScreen(
      'settings',
      buildSettingsScreen({
        settings: this.save.settings,
        gamepadConnected: this.input.hasGamepad(),
        onChange: (next) => this.updateSettings(next),
        onBack: () => {
          if (this.previousScreen === 'race' && this.simulation) this.showPause();
          else this.showTitle();
        },
        onClearData: () => {
          clearSave();
          this.save = defaultSave();
          this.applyDocumentSettings();
          this.input.setBindings(this.save.settings.bindings);
          this.showSettings();
        },
        onRebind: (action, done) => this.beginRebind(action, done),
      }),
    );
  }

  private beginRebind(_action: ActionId, done: (code: string | null) => void): void {
    this.input.captureNextKey((code) => {
      // Escape cancels rather than binding itself; Escape must always pause.
      done(code === 'Escape' ? null : code);
    });
  }

  private showUnsupported(error: unknown): void {
    this.showScreen(
      'unsupported',
      buildMessagePanel({
        kind: 'unsupported',
        heading: 'This browser cannot run AD Racers',
        body:
          'The game needs WebGL, which this browser or device did not provide. ' +
          'A recent version of Chrome, Edge, Firefox or Safari on a machine with hardware acceleration enabled will work.',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // --- race lifecycle -----------------------------------------------------

  private startRace(seed = Math.floor(performance.now()) >>> 0): void {
    if (!this.renderer) return;
    this.stopAttract();
    this.raceSeed = seed;

    let track;
    try {
      track = getTrack(this.save.settings.lastTrack);
    } catch (error) {
      this.showScreen(
        'error',
        buildMessagePanel({
          kind: 'error',
          heading: 'That course could not be built',
          body: 'Pick another course and try again.',
          detail: error instanceof Error ? error.message : String(error),
          action: { label: 'Back to setup', onClick: () => this.showSetup() },
        }),
      );
      return;
    }

    const playerId = this.save.settings.lastRacer;
    const others = RACERS.filter((r) => r.id !== playerId);
    const entries = [
      { profileId: playerId, isPlayer: true },
      ...others.map((r) => ({ profileId: r.id, isPlayer: false })),
    ];

    this.simulation = new Simulation({
      track,
      entries,
      difficulty: getDifficulty(this.save.settings.lastDifficulty),
      seed,
      catchUp: this.save.settings.catchUp,
    });

    this.renderer.buildWorld(this.simulation);
    this.renderer.chase.mode = this.save.settings.cameraMode;
    this.hud.prepare(this.simulation);
    this.hud.reset();

    this.accumulator = 0;
    this.paused = false;
    this.perf.reset();

    void this.audio.start().then(() => {
      this.audio.setSettings(this.save.settings.audio);
      this.audio.startAmbience(track.definition.id === 'emberfall-quarry' ? 55 : 62);
    });

    this.showScreen('race');
  }

  /**
   * Builds the AI-only demonstration race shown behind the menus.
   *
   * Skipped entirely on the low quality tier. A phone or an older laptop should
   * not be simulating and rendering a six-car race just to put something behind
   * a menu — that is battery and heat spent on decoration, and it is exactly
   * the device that can least afford it.
   */
  private startAttract(): void {
    if (!this.renderer) return;
    if (this.renderer.qualityId === 'low') {
      this.attract = null;
      return;
    }
    try {
      const definition = TRACK_DEFINITIONS[this.attractIndex % TRACK_DEFINITIONS.length];
      if (!definition) return;
      this.attractIndex += 1;
      this.attract = new Simulation({
        track: getTrack(definition.id),
        entries: RACERS.map((r) => ({ profileId: r.id, isPlayer: false })),
        difficulty: getDifficulty('pro'),
        seed: 0x5eed + this.attractIndex,
        catchUp: true,
      });
      this.renderer.buildWorld(this.attract);
      this.renderer.chase.mode = 'chase';
    } catch {
      // An attract race is a nicety. If a course fails to build here the title
      // screen simply has a dark background, which is not worth an error state.
      this.attract = null;
    }
  }

  private stopAttract(): void {
    this.attract = null;
  }

  private stopRace(): void {
    this.simulation = null;
    this.paused = false;
    this.audio.stopEngines();
    this.audio.stopAmbience();
    this.touch.hide();
    // Back to the demonstration race, on the next course in rotation.
    if (!this.attract) this.startAttract();
  }

  private restartRace(): void {
    // Same seed replays exactly the same race, which is what makes "restart"
    // a real retry rather than a reroll.
    this.startRace(this.raceSeed);
  }

  private showPause(): void {
    this.input.cancelCapture();
    this.paused = true;
    this.input.setEnabled(false);
    this.audio.suspend();
    this.ui.hidden = false;
    clear(this.ui);
    this.ui.dataset.screen = 'pause';
    this.screen = 'race';
    this.ui.append(
      buildPauseOverlay({
        onResume: () => this.togglePause(false),
        onRestart: () => {
          this.restartRace();
        },
        onSettings: () => this.showSettings(),
        onQuit: () => this.showTitle(),
      }),
    );
    this.releaseTrap = trapFocus(this.ui);
  }

  private togglePause(value?: boolean): void {
    if (!this.simulation || this.screen !== 'race') return;
    const next = value ?? !this.paused;
    if (next === this.paused) return;
    if (next) {
      this.showPause();
    } else {
      this.releaseTrap?.();
      this.releaseTrap = null;
      this.paused = false;
      clear(this.ui);
      this.ui.hidden = true;
      this.input.setEnabled(true);
      void this.audio.resume();
      // Drop any accumulated time so the race does not lurch on resume.
      this.accumulator = 0;
      this.lastFrame = performance.now();
    }
  }

  private finishRace(): void {
    const simulation = this.simulation;
    if (!simulation) return;
    const player = simulation.player;
    this.audio.stopEngines();

    this.lastResultRecords = { race: false, lap: false };
    if (player?.completed) {
      this.lastResultRecords = recordResult(
        this.save,
        simulation.track.definition.id,
        player.finishTime,
        player.bestLap,
        this.save.settings.lastDifficulty,
      );
      this.persist();
    }

    this.showScreen(
      'results',
      buildResultsScreen({
        results: simulation.results(),
        playerIndex: player?.index ?? 0,
        track: simulation.track,
        difficultyId: this.save.settings.lastDifficulty,
        records: this.lastResultRecords,
        onRematch: () => this.startRace(),
        onSetup: () => {
          this.stopRace();
          this.showSetup();
        },
        onTitle: () => this.showTitle(),
      }),
    );
  }

  // --- events -------------------------------------------------------------

  private handleAction = (action: ActionId): void => {
    if (this.input.isCapturing) return;
    switch (action) {
      case 'pause':
        if (this.screen === 'race') this.togglePause();
        break;
      case 'camera':
        if (this.renderer && this.screen === 'race' && !this.paused) {
          const next = this.renderer.chase.mode === 'chase' ? 'close' : 'chase';
          this.renderer.chase.mode = next;
          this.save.settings.cameraMode = next;
          this.persist();
        }
        break;
      default:
        break;
    }
  };

  private handleResize = (): void => {
    const width = Math.max(1, this.root.clientWidth || window.innerWidth);
    const height = Math.max(1, this.root.clientHeight || window.innerHeight);
    this.renderer?.setSize(width, height);
  };

  private handleVisibility = (): void => {
    if (document.hidden) {
      // Pausing a race when the tab is hidden is both correct and the cheapest
      // possible power saving: nothing simulates, nothing renders.
      if (this.screen === 'race' && !this.paused && this.simulation) this.togglePause(true);
      this.audio.suspend();
    } else {
      this.lastFrame = performance.now();
      this.accumulator = 0;
      if (!this.paused) void this.audio.resume();
    }
  };

  private handleContextLost = (): void => {
    this.contextLost = true;
    if (this.screen === 'race' && this.simulation && !this.paused) this.togglePause(true);
    this.showScreen(
      'error',
      buildMessagePanel({
        kind: 'error',
        heading: 'Graphics interrupted',
        body:
          'The browser reset the graphics context, usually after the machine woke from sleep or another program took the GPU. ' +
          'The race is paused and nothing is lost.',
        action: { label: 'Reload the game', onClick: () => window.location.reload() },
      }),
    );
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    // Rebuilding is safer than trusting every GPU resource survived, and this
    // path is rare enough that the extra second does not matter.
    if (this.simulation && this.renderer) {
      this.renderer.buildWorld(this.simulation);
      this.showPause();
    } else {
      this.showTitle();
    }
  };

  // --- loop ---------------------------------------------------------------

  private frame = (now: number): void => {
    this.frameHandle = requestAnimationFrame(this.frame);
    const elapsed = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.contextLost) return;

    const simulation = this.simulation;
    const renderer = this.renderer;

    if (!simulation || !renderer || this.screen !== 'race') {
      this.runAttract(renderer, elapsed);
      this.perf.record(elapsed, 0);
      return;
    }

    let steps = 0;
    if (!this.paused) {
      const input: ControlInput = this.input.poll(elapsed);
      this.lastPlayerInput = input;
      this.accumulator += elapsed;
      // Capping the accumulator is what stops a long stall from being "paid
      // back" as a burst of simulation the player never sees.
      const maxAccumulated = FIXED_STEP * MAX_STEPS_PER_FRAME;
      if (this.accumulator > maxAccumulated) this.accumulator = maxAccumulated;

      const events: SimEvent[] = [];
      while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
        simulation.step(steps === 0 ? input : { ...input, strike: 0, respawn: false });
        this.accumulator -= FIXED_STEP;
        steps += 1;
        events.push(...simulation.drainEvents());
      }

      if (events.length > 0) {
        renderer.consumeEvents(events, simulation);
        this.hud.handleEvents(events, simulation);
        const heading = renderer.chase.camera.rotation.y;
        this.audio.handleEvents(events, simulation, heading);
        if (events.some((event) => event.type === 'raceEnd')) {
          this.finishRace();
          return;
        }
      }

      this.audio.updateEngines(simulation, renderer.chase.camera.rotation.y);
      this.hud.update(simulation, elapsed);
    } else {
      this.input.poll(elapsed);
    }

    renderer.render(simulation, this.paused ? 0 : elapsed);
    this.perf.record(elapsed, steps);
    this.updatePerformance(elapsed);
  };

  /**
   * Advances and draws the demonstration race. It is fed a fixed number of
   * steps per frame rather than a wall-clock accumulator: the exact pace does
   * not matter, and a fixed count keeps a slow menu frame from spiking.
   */
  private runAttract(renderer: GameRenderer | null, elapsed: number): void {
    const attract = this.attract;
    if (!attract || !renderer) return;

    if (attract.phase === 'finished') {
      this.startAttract();
      return;
    }

    const steps = Math.min(MAX_STEPS_PER_FRAME, Math.max(1, Math.round(elapsed / FIXED_STEP)));
    for (let i = 0; i < steps; i++) attract.step(emptyInput());
    const events = attract.drainEvents();
    if (events.length > 0) renderer.consumeEvents(events, attract);

    // Follow the *back* of the field, not the leader. A chase camera on the
    // leader has the entire pack behind it, which means skiffs passing through
    // the lens; from the back marker the whole race is laid out ahead.
    const tail = attract.racers.reduce(
      (worst, racer) => (racer.position > worst.position ? racer : worst),
      attract.racers[0] as (typeof attract.racers)[number],
    );
    renderer.render(attract, elapsed, tail?.index);
  }

  private updatePerformance(elapsed: number): void {
    if (this.save.settings.autoQuality && this.renderer && !this.paused) {
      const changed = this.adaptive.sample(elapsed, elapsed);
      if (changed) {
        const active = this.simulation ?? this.attract;
        this.renderer.setQuality(changed, active);
        if (!this.simulation) {
          if (changed === 'low') this.stopAttract();
          else if (!this.attract) this.startAttract();
        }
        this.hud.notify(`Graphics set to ${changed}`, 'info');
      }
    }

    if (!this.save.settings.showPerformance) return;
    const snapshot = this.perf.snapshot();
    const stats = this.renderer?.stats();
    this.perfOverlay.textContent =
      `${snapshot.fps.toFixed(0)} fps · median ${snapshot.medianMs.toFixed(1)} ms · p95 ${snapshot.p95Ms.toFixed(1)} ms\n` +
      `steps/s ${snapshot.stepsPerSecond.toFixed(0)} · quality ${this.renderer?.qualityId ?? '-'}\n` +
      (stats
        ? `draws ${stats.drawCalls} · tris ${(stats.triangles / 1000).toFixed(0)}k · particles ${stats.particles}\n`
        : '') +
      (snapshot.heapMb !== null ? `heap ${snapshot.heapMb.toFixed(0)} MB` : '');
  }

  /** Exposed for the end-to-end tests, which need deterministic race setup. */
  get testHooks(): {
    startRace: (seed: number) => void;
    simulation: () => Simulation | null;
    settings: () => GameSettings;
    screen: () => string;
    input: () => ControlInput;
    skipToFinish: () => void;
  } {
    return {
      startRace: (seed: number) => this.startRace(seed),
      simulation: () => this.simulation,
      settings: () => this.save.settings,
      screen: () => (this.paused ? 'pause' : this.screen),
      input: () => this.lastPlayerInput,
      skipToFinish: () => {
        // Fast-forwards the simulation without rendering. Used only by the
        // browser tests so a full menu-to-results run does not take minutes.
        const simulation = this.simulation;
        if (!simulation) return;
        const input = emptyInput();
        let guard = 0;
        while (simulation.phase !== 'finished' && guard < 120 * 60 * 8) {
          simulation.step(input);
          simulation.drainEvents();
          guard += 1;
        }
        this.finishRace();
      },
    };
  }
}

/** Convenience for the tiny bit of UI that wants a 0-1 progress value. */
export const progress = clamp01;
