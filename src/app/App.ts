import { AudioEngine } from '../audio/AudioEngine';
import { clamp01, formatLapTime, ordinal } from '../core/math';
import { PerformanceMonitor } from '../core/perf';
import {
  clearSave,
  defaultSave,
  loadSave,
  recordCircuit,
  recordResult,
  saveSave,
  unlockedSpeedClasses,
} from '../core/storage';
import type { GameSettings, SaveData } from '../core/storage';
import { FIXED_STEP, MAX_STEPS_PER_FRAME, SPEED_CLASSES, getSpeedClass } from '../game/config';
import type { SpeedClass } from '../game/config';
import { applyRoundResult, createCircuit, isComplete, playerPlace, playerStanding } from '../game/circuit';
import type { CircuitState } from '../game/circuit';
import { getDifficulty } from '../game/ai/driver';
import { InputManager } from '../game/input/InputManager';
import { bindingLabel } from '../game/input/bindings';
import type { ActionId } from '../game/input/bindings';
import { getRacer, normalizeRacerId, RACERS } from '../game/racers';
import { Simulation } from '../game/sim/simulation';
import { emptyInput } from '../game/sim/state';
import type { ControlInput, SimEvent } from '../game/sim/state';
import { getTrack, TRACK_DEFINITIONS } from '../game/track/tracks';
import { GameRenderer } from '../render/Renderer';
import { CAMERA_MODES } from '../render/camera/ChaseCamera';
import { AdaptiveQuality, detectInitialQuality } from '../render/quality';
import type { QualityId } from '../render/quality';
import { buildSettingsScreen } from './screens/SettingsScreen';
import { buildSetupScreen } from './screens/SetupScreen';
import { buildTitleScreen } from './screens/TitleScreen';
import { buildControlsCard, buildMessagePanel, buildPauseOverlay, buildResultsScreen } from './screens/panels';
import { Hud } from './ui/Hud';
import { TouchControls, shouldUseTouch } from './ui/TouchControls';
import { GamepadNavigator } from './ui/gamepadNav';
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

type ScreenName =
  | 'loading'
  | 'title'
  | 'setup'
  | 'settings'
  | 'controls'
  | 'race'
  | 'results'
  | 'error'
  | 'unsupported';

/**
 * How the current race came to exist.
 *
 * A championship round and a one-off race are the same `Simulation` with the
 * same rules; the only difference is what happens at the results screen. Making
 * that an explicit mode rather than a nullable circuit field is what keeps
 * "restart" honest: restarting a championship round has to replay *that round's*
 * seed, not roll a new race.
 */
type RaceMode = 'single' | 'circuit';

/**
 * Steps per frame allowed while the field finishes behind the player.
 *
 * Twenty seconds of race time resolves in about a second of wall clock, which
 * is exactly as long as a finish camera should linger anyway.
 */
const RESOLVE_STEPS_PER_FRAME = 160;

/**
 * How long the finish camera runs before the results screen.
 *
 * Measured against the resolve, which takes about a second of real time to
 * finish the field behind the player — so the beat costs the player almost
 * nothing they were not already waiting for, and buys the one shot in the game
 * that shows the machine they have been driving from outside.
 */
const FINISH_HOLD = 2.1;
/** The same beat without the orbit, for reduced motion. */
const FINISH_HOLD_REDUCED = 0.9;

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
  /** Seconds of finish camera left before the results screen. */
  private finishHold = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private frameHandle = 0;
  private releaseTrap: (() => void) | null = null;
  private systemReducedMotion = false;
  private contextLost = false;
  private raceSeed = 1;
  private raceMode: RaceMode = 'single';
  private circuit: CircuitState | null = null;
  private lastResultRecords = { race: false, lap: false };
  private lastUnlock: string | null = null;
  private detachInput: (() => void) | null = null;
  private readonly gamepadNav: GamepadNavigator;
  private lastPlayerInput: ControlInput = emptyInput();
  /** Names whatever is standing on the garage stage. See `buildStageCaption`. */
  private stageCaption: HTMLElement | null = null;

  constructor(options: AppOptions) {
    this.root = options.root;
    this.canvas = options.canvas;
    this.save = loadSave();
    this.save.settings.lastRacer = normalizeRacerId(this.save.settings.lastRacer);

    this.ui = el('div', { class: 'ui', 'data-testid': 'ui' });
    this.hud = new Hud();
    this.hud.root.hidden = true;
    this.perfOverlay = el('div', { class: 'perf', hidden: true, 'aria-hidden': 'true' });
    this.touch = new TouchControls({
      input: this.input,
      onPause: () => this.togglePause(true),
      onCamera: () => this.cycleCamera(),
    });

    this.root.append(this.hud.root, this.ui, this.touch.root, this.perfOverlay);

    this.gamepadNav = new GamepadNavigator({
      root: this.ui,
      onBack: () => this.handleMenuBack(),
    });

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
    window.addEventListener('popstate', this.handleBack);
    document.addEventListener('visibilitychange', this.handleVisibility);
    // A race must not keep running behind a notification, another window, or a
    // focused address bar. `visibilitychange` alone misses every case where the
    // tab stays visible but stops being the thing the player is looking at.
    window.addEventListener('blur', this.handleVisibility);

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

    // The renderer detects near misses because it is what holds the field and
    // the camera; it has no business making a sound, so it calls back here.
    this.renderer.onNearMiss = (intensity) => {
      this.audio.play('nearMiss', { volume: 0.3 + intensity * 0.45 });
    };

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
    window.removeEventListener('popstate', this.handleBack);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('blur', this.handleVisibility);
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
        this.renderSettings();
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

  /**
   * The single place race visibility is decided.
   *
   * Every route that reaches or leaves a race goes through here, and it is
   * idempotent: calling it twice is calling it once. That is not tidiness, it
   * is the fix for a critical defect. `showPause` used to set `screen = 'race'`
   * directly without touching HUD or touch visibility, so Pause → Settings →
   * Back → Resume returned to a *running* race with the HUD hidden and every
   * touch control gone — a total loss of control on a phone, and a total loss
   * of information everywhere else. WebGL context restoration took the same
   * route and produced the same result.
   */
  private applyRaceSurface(): void {
    const inRace = this.screen === 'race' && this.simulation !== null;
    const driving = inRace && !this.paused && !this.contextLost;
    // Entering driving is also where the Back guard is armed, so every route
    // into a running race - a fresh start, a resume, a restored context - is
    // protected by exactly one history entry. See `handleBack`.
    if (driving) this.armBackGuard();
    this.hud.root.hidden = !inRace;
    this.ui.hidden = driving;
    this.input.setEnabled(driving);
    const touchDriving = driving && shouldUseTouch();
    if (touchDriving) this.touch.show();
    else this.touch.hide();
    // The HUD gives ground to the thumbs only while they are actually there.
    document.documentElement.classList.toggle('touch-active', touchDriving);
    this.hud.setTouch(shouldUseTouch());
    /*
     * Tell the camera how much of the frame the thumbs are standing in.
     *
     * Read after the class toggle, on the next frame, because the controls'
     * layout depends on it — measuring first would report the previous
     * viewport's band. Desktop passes 0 and nothing changes.
     */
    requestAnimationFrame(() => {
      this.renderer?.chase.setOccludedBand(touchDriving ? this.touch.occludedFraction() : 0);
    });
  }

  /**
   * The caption that names what is standing on the stage.
   *
   * A lit machine with no name is a screensaver. This lives outside the menu
   * panel, in the space the panel has been moved aside to leave, so it belongs
   * to the machine rather than to the form - and it is `aria-hidden` because
   * every word of it is already in the selected crew's card and in the results
   * table, where a screen reader will meet it in a useful order.
   */
  private buildStageCaption(profileId: string, mood: 'garage' | 'result'): HTMLElement {
    const profile = getRacer(profileId);
    const caption = el(
      'div',
      { class: 'stage-caption', 'aria-hidden': 'true' },
      el('p', { class: 'stage-caption__kicker', text: mood === 'result' ? 'Crew' : 'In the bay' }),
      el('p', { class: 'stage-caption__crew', text: profile.crew }),
      el('p', { class: 'stage-caption__skiff', text: profile.skiff }),
      el('p', { class: 'stage-caption__pilots', text: `${profile.pilot} & ${profile.wrench}` }),
    );
    caption.style.setProperty('--crew-trim', `#${profile.colors.trim.toString(16).padStart(6, '0')}`);
    return caption;
  }

  /**
   * Where the garage stage is framed, given the layout the viewport has.
   *
   * Two cases rather than a measurement, because the two cases are what the
   * stylesheet actually has: wide enough and the panel moves to the left, so
   * the machine goes in the space it left; narrow and the panel is anchored to
   * the bottom, so the machine goes in the band above it. Measuring an element
   * would be more general, and would also mean measuring during layout on every
   * screen change to learn something the media query already knows.
   */
  private updateHeroAnchor(): void {
    const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 68rem)').matches;
    // Wide: the gap the panel leaves on the right. Narrow: the band above it.
    // The fill is smaller on a phone because the band is a third of a short
    // viewport, and a machine framed to the full height would run under the
    // panel rather than stand above it.
    if (wide) this.renderer?.setHeroAnchor(0.78, 0.52, 0.42);
    else this.renderer?.setHeroAnchor(0.5, 0.2, 0.26);
  }

  private showScreen(name: ScreenName, content?: HTMLElement): void {
    this.input.cancelCapture();
    this.releaseTrap?.();
    this.releaseTrap = null;
    this.screen = name;
    clear(this.ui);
    this.ui.dataset.screen = name;
    this.applyRaceSurface();

    // The stage caption is a sibling of the panel, not part of it: it belongs
    // to the machine on the canvas, which is in the space the panel vacated.
    if (this.stageCaption && (name === 'setup' || name === 'results')) this.ui.append(this.stageCaption);
    else this.stageCaption = null;

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
    this.raceMode = 'single';
    this.circuit = null;
    // The title screen's background is the demonstration race, not the garage.
    this.renderer?.setHero(null);
    this.stopRace();
    this.showScreen(
      'title',
      buildTitleScreen({
        onRace: () => {
          void this.audio.start();
          this.pendingMode = 'single';
          if (!this.save.settings.seenControls) this.showControls(true);
          else this.showSetup();
        },
        onCircuit: () => {
          void this.audio.start();
          this.pendingMode = 'circuit';
          if (!this.save.settings.seenControls) this.showControls(true);
          else this.showSetup();
        },
        onSettings: () => this.showSettings(),
        onControls: () => this.showControls(false),
        bestSummary: this.bestSummary(),
        circuitSummary: this.circuitSummary(),
      }),
    );
  }

  /** Which mode the setup screen will launch into. */
  private pendingMode: RaceMode = 'single';

  private circuitSummary(): string | null {
    const entries = Object.entries(this.save.circuits);
    if (entries.length === 0) return null;
    const best = entries.reduce((a, b) => (a[1].place <= b[1].place ? a : b));
    const [key, record] = best;
    const [difficultyId, speedClassId] = key.split(':');
    return (
      `Circuit best — ${ordinal(record.place)} on ${getDifficulty(difficultyId ?? 'pro').label} ` +
      `${getSpeedClass(speedClassId ?? 'reclaim').label}`
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
    // The garage: the selected crew's machine on a lit stage behind the panel,
    // in place of the attract race. See `HeroStage`.
    this.renderer?.setHero(getRacer(this.save.settings.lastRacer));
    this.updateHeroAnchor();
    this.stageCaption = this.buildStageCaption(this.save.settings.lastRacer, 'garage');
    this.showScreen(
      'setup',
      buildSetupScreen({
        mode: this.pendingMode,
        selection: {
          trackId: this.save.settings.lastTrack,
          racerId: this.save.settings.lastRacer,
          difficultyId: this.save.settings.lastDifficulty,
          speedClassId: this.save.settings.lastSpeedClass,
        },
        bests: this.save.bests,
        unlockedSpeedClasses: unlockedSpeedClasses(this.save, SPEED_CLASSES.map((c) => c.id)),
        onChange: (selection) => {
          this.save.settings.lastTrack = selection.trackId;
          this.save.settings.lastRacer = selection.racerId;
          this.save.settings.lastDifficulty = selection.difficultyId;
          this.save.settings.lastSpeedClass = selection.speedClassId;
          this.persist();
          // Picking a crew puts that crew on the stage; `setHero` no-ops when
          // the selection has not actually changed.
          this.renderer?.setHero(getRacer(selection.racerId));
          this.stageCaption?.replaceWith((this.stageCaption = this.buildStageCaption(selection.racerId, 'garage')));
        },
        onStart: () => {
          if (this.pendingMode === 'circuit') this.startCircuit();
          else {
            this.raceMode = 'single';
            this.circuit = null;
            this.startRace();
          }
        },
        onBack: () => this.showTitle(),
      }),
    );
  }

  private showSettings(): void {
    const returnTo = this.screen === 'race' ? 'race' : this.screen;
    this.previousScreen = returnTo === 'settings' ? 'title' : returnTo;
    this.renderSettings();
  }

  private renderSettings(): void {
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
          this.renderSettings();
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

  private startRace(seed = Math.floor(performance.now()) >>> 0, trackId = this.save.settings.lastTrack): void {
    if (!this.renderer) return;
    this.stopAttract();
    this.renderer.setHero(null);
    this.raceSeed = seed;

    let track;
    try {
      track = getTrack(trackId);
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
      speedClass: this.activeSpeedClass(),
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

    // `showScreen` reaches `applyRaceSurface`, which arms the Back guard.
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
    // Same seed *and* same course replays exactly the same race, which is what
    // makes "restart" a real retry rather than a reroll — and what stops a
    // restarted championship round quietly becoming a different round.
    this.startRace(this.raceSeed, this.simulation?.track.definition.id);
  }

  /**
   * The speed class the player has actually earned.
   *
   * Read through the unlock check rather than straight off the settings,
   * because a save edited by hand — or one carried over from a session where a
   * class was unlocked and then the data was cleared — must not be able to
   * start a race in a class the player has not opened.
   */
  private activeSpeedClass(): SpeedClass {
    const unlocked = unlockedSpeedClasses(this.save, SPEED_CLASSES.map((c) => c.id));
    const wanted = this.save.settings.lastSpeedClass;
    return getSpeedClass(unlocked.has(wanted) ? wanted : (SPEED_CLASSES[0]?.id ?? 'reclaim'));
  }

  /** Starts a fresh championship over every course. */
  private startCircuit(): void {
    const playerId = this.save.settings.lastRacer;
    this.raceMode = 'circuit';
    this.circuit = createCircuit({
      seed: Math.floor(performance.now()) >>> 0,
      difficultyId: this.save.settings.lastDifficulty,
      speedClassId: this.activeSpeedClass().id,
      playerProfileId: playerId,
      entries: [playerId, ...RACERS.filter((r) => r.id !== playerId).map((r) => r.id)],
    });
    this.startCircuitRound();
  }

  private startCircuitRound(): void {
    const circuit = this.circuit;
    const round = circuit?.rounds[circuit.currentRound];
    if (!circuit || !round) {
      this.showTitle();
      return;
    }
    this.startRace(round.seed, round.trackId);
  }

  private showPause(): void {
    this.input.cancelCapture();
    this.paused = true;
    this.audio.suspend();
    clear(this.ui);
    this.ui.dataset.screen = 'pause';
    this.screen = 'race';
    // Restores the HUD and hides the thumb pads in one call, whichever route
    // arrived here — including Pause → Settings → Back and a restored context.
    this.applyRaceSurface();
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
      this.applyRaceSurface();
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
    const speedClass = this.activeSpeedClass();

    this.lastResultRecords = { race: false, lap: false };
    if (player?.completed) {
      this.lastResultRecords = recordResult(
        this.save,
        simulation.track.definition.id,
        player.finishTime,
        player.bestLap,
        this.save.settings.lastDifficulty,
        speedClass.id,
      );
      this.persist();
    }

    const results = simulation.results();
    let circuitView: Parameters<typeof buildResultsScreen>[0]['circuit'] = null;
    this.lastUnlock = null;

    if (this.raceMode === 'circuit' && this.circuit) {
      const before = new Set(unlockedSpeedClasses(this.save, SPEED_CLASSES.map((c) => c.id)));
      this.circuit = applyRoundResult(
        this.circuit,
        results.map((racer) => ({
          profileId: racer.profileId,
          position: racer.finishPosition,
          time: racer.finishTime,
        })),
      );
      const complete = isComplete(this.circuit);
      if (complete) {
        const standing = playerStanding(this.circuit);
        recordCircuit(this.save, this.circuit.difficultyId, this.circuit.speedClassId, {
          place: playerPlace(this.circuit),
          points: standing?.points ?? 0,
          totalTime: standing?.totalTime ?? Infinity,
        });
        this.persist();
        const after = unlockedSpeedClasses(this.save, SPEED_CLASSES.map((c) => c.id));
        const opened = [...after].find((id) => !before.has(id));
        this.lastUnlock = opened ? getSpeedClass(opened).label : null;
      }
      if (this.lastUnlock) this.hud.announceMoment(`${this.lastUnlock} unlocked`, 'reward');
      circuitView = {
        round: this.circuit.currentRound,
        rounds: this.circuit.rounds.length,
        standings: this.circuit.standings,
        playerProfileId: this.circuit.playerProfileId,
        complete,
        ...(this.lastUnlock ? { unlocked: this.lastUnlock } : {}),
      };
    }

    const inCircuit = this.raceMode === 'circuit' && this.circuit !== null;
    const moreRounds = inCircuit && this.circuit !== null && !isComplete(this.circuit);

    /*
     * The finish payoff: the machine that just raced, staged and lit.
     *
     * The review's verdict on this screen was that it is responsive and clear
     * and still "lacks finish spectacle" - a small flat symbol above a
     * classification table. The classification is worth keeping and is; what it
     * did not have was the crew's own machine at a size that says the race
     * mattered. It is the garage stage under result lighting, so the two
     * screens are one composition seen twice and nothing is built twice.
     */
    if (player) {
      this.renderer?.setHero(getRacer(player.profileId), 'result');
      this.stageCaption = this.buildStageCaption(player.profileId, 'result');
    }
    this.updateHeroAnchor();

    this.showScreen(
      'results',
      buildResultsScreen({
        results,
        playerIndex: player?.index ?? 0,
        track: simulation.track,
        difficultyId: this.save.settings.lastDifficulty,
        speedClassId: speedClass.id,
        records: this.lastResultRecords,
        circuit: circuitView,
        primaryLabel: moreRounds ? 'Next round' : inCircuit ? 'New circuit' : 'Rematch',
        onPrimary: () => {
          if (moreRounds) this.startCircuitRound();
          else if (inCircuit) this.startCircuit();
          else this.startRace();
        },
        onSetup: () => {
          this.raceMode = 'single';
          this.circuit = null;
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
        // Escape means "pause" in a race and "back" everywhere else. Having it
        // do nothing on a menu is the sort of inconsistency that makes a
        // keyboard player stop trusting the whole interface.
        if (this.screen === 'race') this.togglePause();
        else this.handleMenuBack();
        break;
      case 'camera':
        this.cycleCamera();
        break;
      default:
        break;
    }
  };

  /**
   * The back/cancel action, shared by the pad's B button and by Escape outside
   * a race. Always goes somewhere sensible rather than nowhere.
   */
  private handleMenuBack(): void {
    switch (this.screen) {
      case 'race':
        if (this.paused) this.togglePause(false);
        break;
      case 'settings':
        if (this.previousScreen === 'race' && this.simulation) this.showPause();
        else this.showTitle();
        break;
      case 'setup':
      case 'controls':
      case 'results':
        this.showTitle();
        break;
      default:
        break;
    }
  }

  /** Steps through the chase camera modes, from any input device. */
  private cycleCamera(): void {
    if (!this.renderer || this.screen !== 'race' || this.paused) return;
    const ids = CAMERA_MODES.map((mode) => mode.id);
    const index = ids.indexOf(this.renderer.chase.mode);
    const next = ids[(index + 1) % ids.length] ?? 'chase';
    this.renderer.chase.mode = next;
    this.save.settings.cameraMode = next;
    this.persist();
    this.hud.notify(`Camera: ${CAMERA_MODES.find((m) => m.id === next)?.label ?? next}`, 'info');
  }

  private handleResize = (): void => {
    const width = Math.max(1, this.root.clientWidth || window.innerWidth);
    const height = Math.max(1, this.root.clientHeight || window.innerHeight);
    this.renderer?.setSize(width, height);
    // A rotation can move the panel from beside the stage to above it.
    this.updateHeroAnchor();
    // A rotation changes both the viewport and the controls' footprint, so the
    // composition correction has to be re-measured with the new layout.
    this.renderer?.chase.setOccludedBand(this.touch.occludedFraction());
  };

  /**
   * True while a history entry exists purely to absorb one Back gesture.
   *
   * At most one is ever outstanding. Pushing a second is what turned the guard
   * into a trap.
   */
  private backGuardArmed = false;

  private armBackGuard(): void {
    if (this.backGuardArmed) return;
    history.pushState({ race: true }, '');
    this.backGuardArmed = true;
  }

  /*
   * Browser Back must not silently destroy a race - and must not become
   * inescapable either.
   *
   * The app already protects a run from losing focus, from the tab being
   * hidden, and from the graphics context being lost — and then a single Back
   * gesture threw all of it away with no pause, no confirmation and no way
   * back. A review measured the page going straight to `about:blank` mid-race.
   * Back is the most common accidental action on a phone there is.
   *
   * So starting a race pushes one history entry and the first Back lands here
   * instead of leaving: it pauses and re-arms, which makes the gesture mean
   * "stop and let me decide".
   *
   * The re-arm is what has to be conditional. Pushing a replacement entry on
   * *every* popstate - including the ones that arrive while the race is already
   * paused - meant Back could never leave the page at all, and every press grew
   * the history stack by one, so the player could not get out by holding it
   * either. A second, deliberate Back from the pause dialog is now let through
   * as normal, and the guard is not re-armed until the player resumes driving.
   * Menus keep ordinary Back behaviour.
   */
  private handleBack = (): void => {
    // Whatever happens next, the browser has already consumed the entry.
    this.backGuardArmed = false;
    if (this.screen !== 'race' || !this.simulation) return;
    if (this.paused) return;
    this.togglePause(true);
    this.armBackGuard();
  };

  private handleVisibility = (): void => {
    if (document.hidden || !document.hasFocus()) {
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
      this.hud.prepare(this.simulation);
      // Through the same atomic path as any other resume, so a restored context
      // returns a complete race surface rather than a bare world.
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

    // Menus and the pause dialog are navigable with a pad, which is what makes
    // the game operable on a controller-only device from first launch.
    if (this.screen !== 'race' || this.paused) {
      this.gamepadNav.update(this.input.activeGamepad(), elapsed);
    }

    if (!simulation || !renderer || this.screen !== 'race') {
      // The garage stage takes the frame when one is up; it replaces the
      // attract race rather than being drawn on top of it, so a menu never
      // costs more than one scene.
      if (renderer?.hasHero) renderer.renderHero(this.save.settings.reducedMotion ? 0 : elapsed);
      else this.runAttract(renderer, elapsed);
      this.perf.record(elapsed, 0);
      return;
    }

    let steps = 0;
    if (!this.paused) {
      const input: ControlInput = this.input.poll(elapsed);
      this.lastPlayerInput = input;
      const resolving = simulation.resolvingAfterPlayer;
      const maxAccumulated = FIXED_STEP * (resolving ? RESOLVE_STEPS_PER_FRAME : MAX_STEPS_PER_FRAME);
      // Once the player has finished, the field resolves on a deterministic
      // simulated-step budget rather than one paced by wall-clock elapsed
      // time: raising the per-frame step ceiling alone does nothing, because
      // an ordinary frame's real elapsed time is still only enough for a
      // couple of fixed steps. Outside resolve, capping the accumulator to
      // real elapsed time is what stops a long stall from being "paid back"
      // as a burst of simulation the player never sees.
      this.accumulator += resolving ? maxAccumulated : elapsed;
      if (this.accumulator > maxAccumulated) this.accumulator = maxAccumulated;

      /*
       * Once the player has crossed the line the remaining field is resolved at
       * speed rather than in real time.
       *
       * The simulation now waits for rivals to actually finish instead of
       * marking them DNF the moment the player arrives, and a deterministic
       * step costs microseconds — so a few hundred extra steps a frame turns
       * "wait twenty seconds for a real result" into "about a second of finish
       * camera". Nothing about the outcome changes; only how long the player
       * watches it happen.
       */
      const maxSteps = resolving ? RESOLVE_STEPS_PER_FRAME : MAX_STEPS_PER_FRAME;
      const events: SimEvent[] = [];
      while (this.accumulator >= FIXED_STEP && steps < maxSteps) {
        if (simulation.phase === 'finished') break;
        simulation.step(steps === 0 ? input : { ...input, strike: 0, respawn: false });
        this.accumulator -= FIXED_STEP;
        steps += 1;
        const stepEvents = simulation.drainEvents();
        events.push(...stepEvents);
        if (stepEvents.some((event) => event.type === 'raceEnd')) break;
      }

      if (events.length > 0) {
        renderer.consumeEvents(events, simulation);
        this.hud.handleEvents(events, simulation);
        this.audio.handleEvents(events, simulation, renderer.chase.listenerYaw);
        /*
         * The finish moment.
         *
         * Starts the instant the *player* crosses the line, not when the field
         * finishes — the reward belongs to the player's own flag. The camera
         * swings out to a low three-quarter orbit and the rider comes off the
         * bars, scaled by the result: a win gets an arm in the air, a sixth
         * gets a rider slumped over the tank. ART-10's finding was that
         * finishing had no spectacle at all; the race simply stopped and a
         * table appeared.
         */
        for (const event of events) {
          if (event.type !== 'finish') continue;
          const finisher = simulation.racers[event.racer];
          if (!finisher?.isPlayer) continue;
          const field = Math.max(1, simulation.racers.length - 1);
          const celebration = clamp01(1 - (event.position - 1) / field);
          renderer.setCelebration(event.racer, celebration);
          // Reduced motion keeps the beat and drops the orbit: the camera holds
          // a steady three-quarter view rather than travelling around the car.
          if (!this.save.settings.reducedMotion) renderer.chase.startFinish();
          // Reduced motion drops the orbit, not the lighting: the hero still
          // has to be visible, it just does not travel.
          renderer.setHeroLight(true);
        }

        if (events.some((event) => event.type === 'raceEnd')) {
          /*
           * The results screen waits out an authored beat rather than cutting.
           *
           * Long enough for the orbit to read and for the crowd reaction and
           * the rider's pose to land, short enough that a player replaying a
           * course for the tenth time is not held. Reduced motion keeps a
           * shorter beat rather than none, so the transition is still a
           * transition.
           */
          this.finishHold = this.save.settings.reducedMotion ? FINISH_HOLD_REDUCED : FINISH_HOLD;
        }
      }

      this.audio.updateEngines(simulation, renderer.chase.listenerYaw);
      this.hud.update(simulation, elapsed);

      if (this.finishHold > 0) {
        this.finishHold -= elapsed;
        if (this.finishHold <= 0) {
          renderer.chase.endFinish();
          renderer.setHeroLight(false);
          renderer.render(simulation, 0);
          this.finishRace();
          return;
        }
      }
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
        ? `draws ${stats.drawCalls} +${stats.postPasses} post · tris ${(stats.triangles / 1000).toFixed(0)}k · ` +
          `particles ${stats.particles}\n`
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
    advance: (seconds: number) => void;
    skipToFinish: () => void;
  } {
    return {
      startRace: (seed: number) => this.startRace(seed),
      simulation: () => this.simulation,
      settings: () => this.save.settings,
      screen: () => (this.paused ? 'pause' : this.screen),
      input: () => this.lastPlayerInput,
      /*
       * Burns a stretch of race the test is not about, without drawing it.
       *
       * Simulated time can only advance `MAX_STEPS_PER_FRAME` fixed steps per
       * *rendered* frame - deliberately, so a stall is never paid back as a
       * burst - which means the cost of waiting for race time is the cost of
       * rendering, multiplied. Under CI's software WebGL a frame is a fifth of
       * a second, so the loop yields about 67 ms of race per 200 ms of wall
       * clock and a test that wants past the 3 s countdown and the 2 s strike
       * grace pays close to a minute for five and a half seconds nobody
       * asserts anything about. That is what put the gamepad shoulder-button
       * test on the edge of its 60 s wait and got it quarantined.
       *
       * This is the same tool `skipToFinish` already is, scoped to a duration:
       * the same deterministic steps the loop would have taken, with no frames
       * in between. Tests that are *about* the loop's own pacing must keep
       * using `waitForRaceTime` and `waitForSteps`.
       */
      advance: (seconds: number) => {
        const simulation = this.simulation;
        if (!simulation) return;
        const input = emptyInput();
        const steps = Math.max(0, Math.round(seconds / FIXED_STEP));
        for (let i = 0; i < steps && simulation.phase !== 'finished'; i++) {
          simulation.step(input);
          simulation.drainEvents();
        }
      },
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
