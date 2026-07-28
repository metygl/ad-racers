import * as THREE from 'three';
import { clamp01 } from '../core/math';
import type { Simulation } from '../game/sim/simulation';
import type { RacerState, SimEvent } from '../game/sim/state';
import { getRacer } from '../game/racers';
import { SURFACES } from '../game/track/types';
import { ChaseCamera } from './camera/ChaseCamera';
import { ParticleSystem } from './scene/Particles';
import { buildHazardMarkers, buildHorizon, buildObstacles, buildScenery } from './scene/Scenery';
import type { SceneryResult } from './scene/Scenery';
import { buildLandmarks } from './scene/Landmarks';
import { NearFade } from './scene/nearFade';
import { buildCourseLife } from './scene/CourseLife';
import type { CourseLifeResult } from './scene/CourseLife';
import { buildLighting, buildSky } from './scene/SkyDome';
import type { LightingResult, SkyResult } from './scene/SkyDome';
import { buildTerrain } from './scene/Terrain';
import { buildTrackMesh } from './scene/TrackMesh';
import { buildVehicle } from './scene/VehicleModel';
import type { VehicleVisual } from './scene/VehicleModel';
import { buildHeroStage } from './scene/HeroStage';
import type { HeroMood, HeroStageResult } from './scene/HeroStage';
import type { RacerProfile } from '../game/racers';
import { QUALITY_TIERS } from './quality';
import type { QualityId } from './quality';
import { DEFAULT_GRADE, toColor } from './palette';
import { PostComposer, defaultPostSettings } from './post/Composer';
import type { PostSettings } from './post/Composer';
import { disposeTextures } from './textures/procedural';
import { disposeFamilyMaps } from './materials/families';
import { disposeMaterialsOf } from './materials/ownership';

/**
 * Everything that draws.
 *
 * The renderer reads the simulation but never writes to it, and it never
 * advances time on its own — `render` is handed the interpolation state by the
 * game loop. That separation is what makes the race deterministic regardless of
 * frame rate, and it is what lets the whole simulation be tested without a GPU.
 */

/**
 * How much of an effect budget a rival gets, against the player's one.
 *
 * The player's own payoff must be the loudest thing on screen. Rivals sharing
 * that budget is what turned a busy grid into a screen of orbs with the road
 * and the player's skiff somewhere behind them.
 */
const RIVAL_EFFECT_SCALE = 0.4;

/**
 * What each surface throws up, and how.
 *
 * Motion finding F7: surface feedback was "incoherent" because every surface
 * emitted the same grey puff at a different rate — so leaving the road was a
 * quantitative change the player had to notice rather than a qualitative one
 * they could not miss. A bed gives each surface its own material: a primary
 * spray, and a second emitter that only fires when the skiff is actually
 * sliding, which is what makes the difference legible in one lap.
 *
 * Colours are per surface where the *material* has a colour of its own, and
 * inherited from the course's dust otherwise — a quarry and an arcology should
 * not kick up the same beige, but wet grass is green in both.
 */
interface SurfaceBed {
  kind: 'dust' | 'splash';
  /** Multiplier on the emission rate. */
  rate: number;
  /** Multiplier on particle intensity. */
  scale: number;
  /** Overrides the course dust colour when the material has its own. */
  color?: number;
  secondary?: { kind: 'spark' | 'ember' | 'splash' | 'dust'; color: number; scale: number };
}

const SURFACE_BEDS: Record<string, SurfaceBed> = {
  // Tarmac is nearly clean until it is not: almost no dust, and grit sparking
  // off the hover skirts the moment the skiff is genuinely sideways.
  road: { kind: 'dust', rate: 0.55, scale: 0.7, secondary: { kind: 'spark', color: 0xffcf8a, scale: 0.55 } },
  // Dirt is the loud one, and it throws stones as well as dust.
  dirt: { kind: 'dust', rate: 1.35, scale: 1.25, secondary: { kind: 'ember', color: 0x8a6a44, scale: 0.8 } },
  // Grass tears rather than billows: less dust, and torn green thrown behind.
  grass: { kind: 'dust', rate: 0.95, scale: 0.9, color: 0x6f8a55, secondary: { kind: 'ember', color: 0x7fa860, scale: 1 } },
  // Standing water: spray in front, a fine mist behind.
  water: { kind: 'splash', rate: 1.5, scale: 1.3, color: 0xcfe8ff, secondary: { kind: 'splash', color: 0xe8f4ff, scale: 1.2 } },
  // Salt is dry, fine and bright — it hangs rather than falls.
  salt: { kind: 'dust', rate: 1.15, scale: 1.4, color: 0xf2efe4, secondary: { kind: 'dust', color: 0xfffaf0, scale: 1.3 } },
  sand: { kind: 'dust', rate: 1.25, scale: 1.3, color: 0xd8bf94 },
};

/** Used by any surface a course adds without declaring a bed for it. */
const DEFAULT_BED: SurfaceBed = { kind: 'dust', rate: 1, scale: 1 };

/**
 * How close a rival has to pass, and how fast, to count as a near miss.
 *
 * Both terms matter. Two skiffs sitting side by side at the same speed for a
 * whole straight is not a near miss and must not fire one; the same gap closed
 * at 12 m/s of relative speed is the single most exciting thing that happens in
 * a race and had no feedback at all.
 */
const NEAR_MISS_DISTANCE = 3.6;
const NEAR_MISS_CLOSING = 7;
/**
 * Inside this the two are touching, not passing, and the collision feedback
 * owns the moment.
 */
const NEAR_MISS_CONTACT = 1.9;
/** Seconds before the same rival can trigger another. */
const NEAR_MISS_COOLDOWN = 1.2;

/**
 * How much of the additive effect budget reduced motion keeps.
 *
 * Reduced motion used to scale bloom and drop the speed fringe while leaving
 * the emitters alone, so a review found the normal and reduced boost frames
 * "broadly washed out" in both and the readability failure unchanged. Calming
 * the movement without calming the energy is half a setting.
 */
const REDUCED_MOTION_EFFECTS = 0.45;

/** How far ahead a tow's tether may be drawn to, in metres. */
const TOW_TETHER_REACH = 26;

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality: QualityId;
  reducedMotion: boolean;
  onContextLost: () => void;
  onContextRestored: () => void;
  onCanvasReplaced?: (canvas: HTMLCanvasElement) => void;
}

export interface RenderStats {
  /** Draw calls issued while drawing the world, excluding post-processing. */
  drawCalls: number;
  triangles: number;
  /** Full-screen post-processing passes, which are cheap but not free. */
  postPasses: number;
  particles: number;
  programs: number;
  geometries: number;
  textures: number;
}

export class GameRenderer {
  readonly chase: ChaseCamera;
  private renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly vehicles = new Map<number, VehicleVisual>();
  private particles: ParticleSystem;
  private sky: SkyResult | null = null;
  private scenery: SceneryResult | null = null;
  private life: CourseLifeResult | null = null;
  private readonly nearFade = new NearFade();
  /**
   * A key light that exists only for the finish shot.
   *
   * On a night course a flat-shaded hull has no *form*: every surface falls to
   * near-black and all the eye is left with is the emissive trim, so the
   * machine reads as a scatter of bright panels on a dark mass — which is what
   * an art review meant by the finish orbit "magnifying the box construction",
   * and adding real hard-surface detail made it worse rather than better,
   * because unlit detail is only more edges.
   *
   * A hero shot is lit. This is the smallest honest version of that: one short-
   * range light carried with the camera, on only while the finish sequence is
   * running, so the skiff, its rider and its companion are modelled by
   * something during the one moment the game asks the player to look at them.
   */
  private heroLight: THREE.PointLight | null = null;
  /**
   * A short-range light carried with the focused racer, on night courses only.
   *
   * The art bible's value hierarchy is enforceable rather than aspirational, and
   * on Glasshouse it was not being met: the round-3 live review found the road
   * legible and everything else - the player's own hull, its orientation, and
   * the ground between it and the road - collapsed into a near-black band. Some
   * of that is grading, but the structural part is that a night course has no
   * key worth the name, so a dark-hulled crew off the illuminated road has
   * nothing lighting it at all.
   *
   * This is deliberately not a headlight and not a spotlight: a small radius
   * around the machine so its own form, its rider and a couple of metres of
   * ground read at any crew colour, and nothing beyond that - the course still
   * belongs to the moon and the lamps.
   */
  private routeLight: THREE.PointLight | null = null;
  /** Meshes the camera ray tests against; scenery and obstacles only. */
  private occluders: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private lighting: LightingResult | null = null;
  private quality: QualityId;
  private reducedMotion: boolean;
  private dustColor = new THREE.Color(0xffffff);
  private trackId: string | null = null;
  private elapsedTotal = 0;
  private disposed = false;
  private canvas: HTMLCanvasElement;
  private composer: PostComposer | null = null;
  private post: PostSettings = defaultPostSettings();
  private size = { width: 1, height: 1 };
  /** Smoothed speed cue, so the warp does not snap on a single fast frame. */
  private speedCue = 0;
  /**
   * Scene draw counts, captured immediately after the world is drawn.
   *
   * `renderer.info.render` is reset at the start of every `render()` call, so
   * once the post chain runs — three reduced-resolution passes and a composite,
   * all of them `renderer.render` calls — the counters describe the last
   * full-screen triangle and nothing else. Reading them at the end of the frame
   * reported "1 draw call, 0 triangles" for the entire game, which is not just
   * a wrong overlay: it silently turned the browser suite's draw-call budget
   * into an assertion that 1 is less than 90.
   */
  private sceneStats = { drawCalls: 0, triangles: 0 };
  /** Seconds of frozen presentation left. See `holdPresentation`. */
  private presentationHold = 0;
  /** The garage / finish stage, when a menu screen has asked for one. */
  private hero: HeroStageResult | null = null;
  private heroProfileId: string | null = null;
  private readonly heroCamera = new THREE.PerspectiveCamera(38, 1, 0.4, 90);
  /**
   * Where in the viewport the hero is framed, 0-1.
   *
   * The stage is drawn full-screen behind the menu panel - there is one canvas
   * and one context, and a second WebGL surface for a still life would be an
   * expensive way to say very little. The panel moves aside instead, exactly as
   * it already does for the attract race on the title screen, and this is how
   * the machine is put in the gap rather than behind the text.
   */
  private heroAnchor = { x: 0.5, y: 0.5, fill: 0.36 };
  /**
   * The stage's own grade.
   *
   * `this.post` carries whatever course was last built, and a garage graded for
   * a night course arrives lifted, cooled and exposed nearly two stops - which
   * is right for that course and wrong for a room. The stage looks the same
   * whatever the player last raced.
   */
  private readonly heroPost: PostSettings = defaultPostSettings();
  private courseExposure = DEFAULT_GRADE.exposure;
  /** Per-rival near-miss cooldowns, so one pass fires exactly one cue. */
  private readonly nearMissCooldowns = new Map<number, number>();
  /** Audio hook for a near miss; the renderer has no business making sound. */
  onNearMiss: ((intensity: number) => void) | null = null;

  constructor(private readonly options: RendererOptions) {
    this.quality = options.quality;
    this.reducedMotion = options.reducedMotion;
    this.canvas = options.canvas;
    const tier = QUALITY_TIERS[this.quality];

    this.renderer = this.createRenderer(tier.antialias);
    this.configureRenderer(this.renderer, tier);

    this.scene.add(this.world);
    this.chase = new ChaseCamera(1);
    this.chase.shakeScale = this.reducedMotion ? 0 : 1;
    this.particles = new ParticleSystem(tier.particleBudget);
    this.particles.intensityScale = this.reducedMotion ? REDUCED_MOTION_EFFECTS : 1;
    for (const mesh of this.particles.meshes) this.scene.add(mesh);
    this.composer = tier.postProcessing ? new PostComposer(this.renderer) : null;

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private createRenderer(antialias: boolean, canvas = this.canvas): THREE.WebGLRenderer {
    return new THREE.WebGLRenderer({
      canvas,
      antialias,
      powerPreference: 'high-performance',
      // The game never reads the canvas back, and keeping the drawing buffer
      // lets the browser skip a clear each frame.
      preserveDrawingBuffer: false,
      alpha: false,
    });
  }

  private configureRenderer(renderer: THREE.WebGLRenderer, tier: (typeof QUALITY_TIERS)[QualityId]): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.maxPixelRatio));
    renderer.shadowMap.enabled = tier.shadowMapSize > 0;
    // PCFSoftShadowMap is deprecated in current three and silently falls back to
    // PCFShadowMap with a console warning, so ask for what we actually get.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    /*
     * Tone mapping belongs to whichever stage writes the final pixel.
     *
     * With the post chain on, the scene is drawn into a half-float target in
     * linear light and the composite does ACES and the sRGB encode after the
     * bloom has had a look at the real highlight values. Letting three tone map
     * the scene pass as well would apply the curve twice and would flatten
     * every highlight before the bright pass could distinguish a thruster from
     * the sun.
     */
    const post = tier.postProcessing;
    renderer.toneMapping = post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  }

  private handleContextLost = (event: Event): void => {
    // Preventing the default is what tells the browser we intend to restore.
    event.preventDefault();
    this.options.onContextLost();
  };

  private handleContextRestored = (): void => {
    this.options.onContextRestored();
  };

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setSize(width: number, height: number): void {
    this.size = { width, height };
    this.renderer.setSize(width, height, false);
    this.chase.setAspect(width / Math.max(1, height));
    this.composer?.setSize(width, height);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.chase.shakeScale = value ? 0 : 1;
    this.particles.intensityScale = value ? REDUCED_MOTION_EFFECTS : 1;
  }

  /**
   * Applies a quality tier. The world is rebuilt because scenery density and
   * terrain resolution are baked into geometry; the caller is expected to do
   * this between races or during a pause, never mid-corner.
   */
  setQuality(quality: QualityId, simulation: Simulation | null): void {
    if (quality === this.quality) return;
    const previousQuality = this.quality;
    const tier = QUALITY_TIERS[quality];
    const previousTier = QUALITY_TIERS[previousQuality];
    if (tier.antialias !== previousTier.antialias) {
      const size = this.renderer.getSize(new THREE.Vector2());
      const replacement = this.canvas.cloneNode(false) as HTMLCanvasElement;
      const nextRenderer = this.createRenderer(tier.antialias, replacement);
      this.configureRenderer(nextRenderer, tier);
      nextRenderer.setSize(size.x, size.y, false);
      const previousRenderer = this.renderer;
      const previousCanvas = this.canvas;
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      this.canvas.replaceWith(replacement);
      this.canvas = replacement;
      this.options.onCanvasReplaced?.(replacement);
      this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
      this.renderer = nextRenderer;
      previousRenderer.forceContextLoss();
      previousRenderer.dispose();
      previousCanvas.width = 1;
      previousCanvas.height = 1;
    } else {
      this.configureRenderer(this.renderer, tier);
    }
    this.quality = quality;

    for (const mesh of this.particles.meshes) this.scene.remove(mesh);
    this.particles.dispose();
    this.particles = new ParticleSystem(tier.particleBudget);
    for (const mesh of this.particles.meshes) this.scene.add(mesh);

    this.composer?.dispose();
    this.composer = tier.postProcessing ? new PostComposer(this.renderer) : null;
    this.composer?.setSize(this.size.width, this.size.height);

    if (simulation) {
      this.trackId = null;
      this.buildWorld(simulation);
    }
  }

  get qualityId(): QualityId {
    return this.quality;
  }

  /** Builds (or rebuilds) the static world and the racer models. */
  buildWorld(simulation: Simulation): void {
    const tier = QUALITY_TIERS[this.quality];
    const track = simulation.track;
    const theme = track.definition.theme;

    if (this.trackId !== track.definition.id) {
      this.clearWorld();
      this.trackId = track.definition.id;

      this.scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
      this.scene.background = null;

      this.sky = buildSky(theme, theme.cloudiness ?? 0.6);
      this.scene.add(this.sky.mesh);

      this.lighting = buildLighting(theme, tier.shadowMapSize, tier.shadowRadius);
      this.scene.add(this.lighting.group);

      if (theme.night ?? false) {
        // Warm against the course's cold key, so the machine separates from the
        // blue it is standing in rather than merging further into it.
        const light = new THREE.PointLight(0xffe6c4, 13, 15, 1.7);
        light.name = 'route-light';
        this.scene.add(light);
        this.routeLight = light;
      }

      const terrain = buildTerrain(track, tier.terrainResolution);
      this.world.add(terrain.mesh);
      const trackMesh = buildTrackMesh(track);
      this.world.add(trackMesh);
      /*
       * The gantry hangs over the grid, which is exactly where the chase
       * camera starts — behind it and below it. Registering it means it is
       * gone before it can cut across the opening frame.
       */
      this.nearFade.clear();
      const gantry = trackMesh.getObjectByName('start-gantry');
      if (gantry) this.nearFade.add(gantry);
      const scenery = buildScenery(track, {
        densityScale: tier.sceneryDensity,
        visibilityDistance: tier.sceneryDistance,
        heightAt: terrain.heightAt,
        castShadows: tier.shadowMapSize > 0,
      });
      this.scenery = scenery;
      this.world.add(scenery.group);
      this.world.add(buildHorizon(track));
      const landmarks = buildLandmarks(track, terrain.heightAt);
      this.world.add(landmarks);
      // Big enough to fill the frame from underneath, so they yield too.
      for (const landmark of landmarks.children) this.nearFade.add(landmark);
      const life = buildCourseLife(track, {
        density: tier.lifeDensity,
        heightAt: terrain.heightAt,
        accent: theme.kerbColor ?? theme.speedLineColor,
        night: theme.night ?? false,
        fogColor: theme.fogColor,
        fogDensity: theme.fogDensity,
      });
      this.life = life;
      this.world.add(life.group);
      const obstacles = buildObstacles(track);
      this.world.add(obstacles);
      /*
       * The camera ray tests a *list*, not a second group.
       *
       * Reparenting these into an `occluders` group would remove them from the
       * world — an Object3D has exactly one parent — and the scenery would stop
       * being drawn. A flat list of the meshes costs nothing and leaves the
       * scene graph alone.
       */
      this.occluders = [...scenery.group.children, ...obstacles.children];
      this.world.add(buildHazardMarkers(track));

      this.dustColor = new THREE.Color(theme.dustColor);

      // Per-course grade, merged over the neutral default so a course only has
      // to state the parts of its look that differ.
      const grade = { ...DEFAULT_GRADE, ...(theme.grade ?? {}) };
      this.post.lift = toColor(grade.lift);
      this.post.gamma = toColor(grade.gamma);
      this.post.gain = toColor(grade.gain);
      this.post.saturation = grade.saturation;
      this.post.contrast = grade.contrast;
      this.post.bloomThreshold = grade.bloomThreshold;
      this.post.bloomIntensity = grade.bloomIntensity;
      this.post.vignette = grade.vignette;
      this.post.exposure = grade.exposure;
      this.courseExposure = grade.exposure;
      /*
       * The low tier has no composite pass, so it cannot have the grade — but
       * it can still have the *exposure*, for free, through three's own tone
       * mapping. Without this a night course on Low is graded as though it were
       * a noon one, which is not "less atmosphere", it is unreadable.
       */
      if (!this.composer) this.renderer.toneMappingExposure = grade.exposure;
    }

    // Racer models are cheap; rebuild them whenever the field changes.
    for (const visual of this.vehicles.values()) {
      this.world.remove(visual.group);
      visual.dispose();
    }
    this.vehicles.clear();
    for (const racer of simulation.racers) {
      /*
       * Only the player's skiff casts into the shadow map.
       *
       * A cast shadow costs a second draw of every casting mesh, so a six-car
       * grid pays for twelve skiffs' worth of geometry to render one — and at
       * racing distance a rival's cast shadow is indistinguishable from the
       * height-aware ground shadow every skiff already carries. The player's
       * own shadow is the one that does real work, because it is the cue they
       * read their altitude off over a crest.
       */
      const visual = buildVehicle(getRacer(racer.profileId), tier.vehicleShadows && racer.isPlayer);
      this.vehicles.set(racer.index, visual);
      this.world.add(visual.group);
    }

    this.particles.reset();
    const player = simulation.player ?? simulation.racers[0];
    if (player) this.chase.reset(player);
  }

  private clearWorld(): void {
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      disposeObject(child);
    }
    if (this.sky) {
      this.scene.remove(this.sky.mesh);
      disposeObject(this.sky.mesh);
      this.sky = null;
    }
    this.scenery = null;
    if (this.heroLight) {
      this.scene.remove(this.heroLight);
      disposeObject(this.heroLight);
      this.heroLight = null;
    }
    if (this.routeLight) {
      this.scene.remove(this.routeLight);
      disposeObject(this.routeLight);
      this.routeLight = null;
    }
    this.life?.dispose();
    this.life = null;
    this.occluders = [];
    if (this.lighting) {
      this.scene.remove(this.lighting.group);
      /*
       * The sun's shadow map is a full render target - 1024² or 2048² of depth
       * - and dropping the reference to the light does not free it. Four
       * courses of a championship therefore retained four of them, which is up
       * to 64 MB of GPU memory nothing could ever reach again. `disposeObject`
       * calls `Light.dispose`, which is what owns the map.
       */
      disposeObject(this.lighting.group);
      this.lighting = null;
    }
  }

  /**
   * Puts one racer's rider into the finish pose.
   *
   * `intensity` is 0 for last and 1 for a win, so the celebration is earned
   * rather than automatic — a rider punching the air after sixth place is worse
   * than no reaction at all.
   */
  setCelebration(index: number, intensity: number): void {
    this.vehicles.get(index)?.setCelebration(intensity);
  }

  /** Turns simulation events into effects. Called once per rendered frame. */
  consumeEvents(events: readonly SimEvent[], simulation: Simulation): void {
    for (const event of events) {
      switch (event.type) {
        case 'collision': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          const force = clamp01(event.speed / 18);
          this.particles.emit('impact', racer.pos.x, racer.y + 0.8, racer.pos.z, 0xffd9a0, 8, force);
          /*
           * Sparks thrown back along the contact normal rather than in every
           * direction. With a rival involved the normal is the line between the
           * two skiffs, which is the one piece of information a uniform burst
           * throws away: *which side* the hit came from.
           */
          const other = event.other === null ? null : simulation.racers[event.other];
          const normal = other
            ? { x: racer.pos.x - other.pos.x, z: racer.pos.z - other.pos.z }
            : { x: racer.pos.x - event.pos.x, z: racer.pos.z - event.pos.z };
          this.particles.emitDirected(
            'spark', event.pos.x, racer.y + 0.7, event.pos.z, normal, 0xffb95c, 10, clamp01(event.speed / 14),
          );
          // The body takes the hit, not just the camera.
          this.vehicles.get(event.racer)?.knock(clamp01(event.speed / 16));
          if (racer.isPlayer) {
            this.chase.addShake(clamp01(event.speed / 16) * 0.8);
            // Only a solid one holds the frame. A brush at 6 m/s that stopped
            // the camera would make ordinary side-by-side racing feel broken.
            if (force > 0.45) this.holdPresentation(0.03 + force * 0.05);
          }
          break;
        }
        case 'wallHit': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          // Off the wall, back towards the road: the normal points from the
          // contact to the racer's own centre.
          this.particles.emitDirected(
            'spark', event.pos.x, racer.y + 0.6, event.pos.z,
            { x: racer.pos.x - event.pos.x, z: racer.pos.z - event.pos.z },
            0xffc36b, 7, clamp01(event.speed / 16),
          );
          this.vehicles.get(event.racer)?.knock(clamp01(event.speed / 20) * 0.8);
          if (racer.isPlayer) this.chase.addShake(clamp01(event.speed / 20) * 0.7);
          break;
        }
        case 'strikeSwing': {
          // Assume a miss until something says otherwise: the recovery pose
          // then differs the moment a hit lands.
          this.vehicles.get(event.racer)?.setSwingLanded(false);
          break;
        }
        case 'strikeHit': {
          this.vehicles.get(event.attacker)?.setSwingLanded(true);
          this.vehicles.get(event.target)?.knock(0.5 + event.strength * 0.5);
          const target = simulation.racers[event.target];
          const y = target ? target.y + 1.1 : 1.1;
          this.particles.emit('impact', event.pos.x, y, event.pos.z, 0xfff0b8, 12, event.strength);
          const attacker = simulation.racers[event.attacker];
          // Debris off the target, away from whoever swung.
          const away = attacker && target
            ? { x: target.pos.x - attacker.pos.x, z: target.pos.z - attacker.pos.z }
            : { x: 0, z: 1 };
          this.particles.emitDirected('spark', event.pos.x, y, event.pos.z, away, 0xffe08a, 14, event.strength);
          if (target?.isPlayer || attacker?.isPlayer) {
            this.chase.addShake(0.55 * event.strength);
            /*
             * The hit-pause. A landed strike is the single most decisive event
             * in the game and it previously read as a shove; holding the frame
             * for a few dozen milliseconds is what gives it weight.
             */
            this.holdPresentation(0.035 + event.strength * 0.05);
          }
          break;
        }
        case 'strikeCounter': {
          const a = simulation.racers[event.a];
          if (a) this.particles.emit('impact', a.pos.x, a.y + 1.2, a.pos.z, 0xbfefff, 14, 1);
          if (a?.isPlayer || simulation.racers[event.b]?.isPlayer) this.chase.addShake(0.4);
          break;
        }
        case 'driftRelease': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          /*
           * A pressure release, not a coloured flare.
           *
           * The payout is grit and vented pressure thrown out along the ground
           * in the crew's own colour — the same salvage language the bands and
           * the debris ring on the skiff use. Tier is carried by how much is
           * thrown, never by hue. See `VehicleModel`.
           */
          const scale = racer.isPlayer ? 1 : RIVAL_EFFECT_SCALE;
          const trim = getRacer(racer.profileId).colors.trim;
          this.particles.emit('dust', racer.pos.x, racer.y + 0.18, racer.pos.z, this.dustColor, Math.round((6 + event.tier * 6) * scale), (0.9 + event.tier * 0.4) * scale);
          this.particles.emit('spark', racer.pos.x, racer.y + 0.55, racer.pos.z, trim, Math.round((4 + event.tier * 3) * scale), (0.7 + event.tier * 0.3) * scale);
          // The camera punch scales with the tier, so the third tier is
          // physically bigger news than the first rather than just a different
          // colour of spark.
          if (racer.isPlayer) this.chase.addKick(0.16 + event.tier * 0.14);
          break;
        }
        case 'boostStart': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          /*
           * A rival's boost gets a fraction of the player's budget.
           *
           * At equal intensity, five rivals boosting on a grid produced white
           * and purple orbs covering a third to a half of the lower frame and
           * concealing the player's own skiff, the road and the braking point.
           * The player's payoff has to be the loudest thing on screen; nobody
           * else's does.
           */
          const scale = racer.isPlayer ? 1 : RIVAL_EFFECT_SCALE;
          this.particles.emit(
            'boost',
            racer.pos.x, racer.y + 0.5, racer.pos.z,
            getRacer(racer.profileId).colors.glow,
            Math.round(10 * scale),
            scale,
          );
          if (racer.isPlayer) this.chase.addKick(0.45);
          break;
        }
        case 'towSnap': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          /*
           * A tether collapsing forward, not a puff of thrust.
           *
           * Sixteen generic boost particles at the car's centre were visually
           * interchangeable with Surge, ambient thrust and a drift release — a
           * review captured the moment unobstructed and could not identify what
           * race interaction had just succeeded. The reward has to be
           * teachable, which means it has to look like the thing it is.
           *
           * The tow is a line between two cars, so the snap is drawn as that
           * line collapsing: a short trail of embers laid along the gap to the
           * car ahead, arriving at the nose. Direction is the whole read, and
           * embers are the one additive kind that keeps a shape instead of
           * blooming into a ball.
           */
          const wake = simulation.racers.find(
            (other) => other.index !== racer.index && !other.finished &&
              Math.hypot(other.pos.x - racer.pos.x, other.pos.z - racer.pos.z) < TOW_TETHER_REACH,
          );
          const forward = { x: Math.cos(racer.heading), z: Math.sin(racer.heading) };
          const toward = wake
            ? { x: wake.pos.x - racer.pos.x, z: wake.pos.z - racer.pos.z }
            : { x: forward.x * 8, z: forward.z * 8 };
          const span = Math.max(1, Math.hypot(toward.x, toward.z));
          for (let step = 0; step < 6; step++) {
            const along = (step + 1) / 6;
            this.particles.emit(
              'ember',
              racer.pos.x + (toward.x / span) * along * span,
              racer.y + 0.75,
              racer.pos.z + (toward.z / span) * along * span,
              0xbfe9ff,
              2,
              event.strength * (1 - along * 0.6),
            );
          }
          // And a compact ring at the nose, where the snap lands.
          this.particles.emit(
            'boost',
            racer.pos.x + forward.x * 2.2,
            racer.y + 0.7,
            racer.pos.z + forward.z * 2.2,
            0xdff4ff,
            5,
            event.strength * 0.7,
          );
          if (racer.isPlayer) this.chase.addKick(0.3 * event.strength);
          break;
        }
        case 'hop': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          this.particles.emit('dust', racer.pos.x, racer.y + 0.1, racer.pos.z, this.dustColor, 5, 0.9);
          break;
        }
        case 'jumpLand': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          /*
           * A landing has to be *coupled to the ground*, not a puff at the car.
           *
           * A review found the rig's compression and rebound working but the
           * landing itself unreadable — "the landing lacks a clear
           * ground-coupled debris or shadow beat" — because the only cue was a
           * cloud emitted at the hull. So the material the skiff arrived on is
           * thrown outward in a ring at ground level, in that surface's own
           * colour, scaled by how hard the arrival was. The ring is what says
           * "this is where you touched down"; the cloud only said "something
           * happened somewhere near this car".
           */
          const bed = SURFACE_BEDS[racer.surface] ?? DEFAULT_BED;
          const force = clamp01(event.speed / 16);
          const ringCount = event.clean ? 6 : 10;
          for (let step = 0; step < ringCount; step++) {
            const angle = (step / ringCount) * Math.PI * 2;
            this.particles.emit(
              bed.kind,
              racer.pos.x + Math.cos(angle) * 1.5,
              racer.y + 0.08,
              racer.pos.z + Math.sin(angle) * 1.5,
              bed.color ?? this.dustColor,
              1,
              (0.5 + force) * bed.scale,
            );
          }
          this.particles.emit('dust', racer.pos.x, racer.y + 0.2, racer.pos.z, this.dustColor, event.clean ? 5 : 9, 1.1);
          if (racer.isPlayer) {
            // The suspension compressing is the read on how well that landing
            // went, so the camera dips with the impact and kicks with a good
            // one. A bad landing gets the shake instead.
            this.chase.addDip(clamp01(event.speed / 14) * 0.7);
            if (event.quality > 0.35) this.chase.addKick(event.quality * 0.35);
            if (!event.clean) this.chase.addShake(clamp01(event.speed / 22) * 0.6);
          }
          if (event.quality > 0.35) {
            this.particles.emit('boost', racer.pos.x, racer.y + 0.4, racer.pos.z, 0xa8f0e0, 12, event.quality * 1.5);
          }
          break;
        }
        case 'hazard': {
          this.particles.emit('boost', event.pos.x, 0.6, event.pos.z, 0x7fe8ff, 16, 1.3);
          break;
        }
        case 'respawn': {
          const racer = simulation.racers[event.racer];
          if (racer) this.particles.emit('boost', racer.pos.x, racer.y + 0.9, racer.pos.z, 0xa8f0e0, 22, 1.2);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Draws one frame. `elapsed` is wall-clock seconds since the last frame.
   * `focusIndex` overrides which racer the camera and audio listener follow,
   * which is how the attract race can follow its back marker instead of a
   * player.
   */
  /**
   * Freezes everything that is *drawn*, without touching simulation timing.
   *
   * Motion finding R2-M4 was that the checkpoint's "presentation-only hit
   * pause" was nothing of the kind: `chase.hold()` returned early from the
   * camera update alone, so the rig, the particles, the HUD and the audio all
   * carried on while only the viewpoint stopped. That is a camera stutter, not
   * a hit stop.
   *
   * A real one cannot slow the clock here — the simulation is deterministic and
   * fixed-step, and a whole race being a unit test depends on that never
   * changing. What it can do is stop advancing the *image*: for a few dozen
   * milliseconds the scene graph is re-presented exactly as it was, then every
   * channel resumes together. The simulation runs on underneath, so the frame
   * after the hold catches up in one step — at 50 m/s and 90 ms that is four
   * and a half metres, inside the follow distance, and it is the same snap a
   * fighting game's recoil resolves into.
   */
  holdPresentation(seconds: number): void {
    if (this.reducedMotion) return;
    this.presentationHold = Math.min(0.09, Math.max(this.presentationHold, seconds));
  }

  /**
   * Puts a crew's machine on the garage stage, or takes it off.
   *
   * Rebuilding is skipped when the same crew is already standing there, because
   * this is called from a radio group's `change` handler and a player arrowing
   * through six crews must not rebuild six skiffs a keystroke.
   */
  setHero(profile: RacerProfile | null, mood: HeroMood = 'garage'): void {
    if (profile && this.heroProfileId === `${profile.id}:${mood}`) return;
    this.hero?.dispose();
    this.hero = null;
    this.heroProfileId = null;
    if (!profile) return;
    this.hero = buildHeroStage(profile, mood);
    this.heroProfileId = `${profile.id}:${mood}`;
  }

  get hasHero(): boolean {
    return this.hero !== null;
  }

  /**
   * Where the stage sits in the viewport and how much of its height the machine
   * spans, all as 0-1 fractions of the viewport.
   */
  setHeroAnchor(x: number, y: number, fill: number): void {
    this.heroAnchor = { x, y, fill };
  }

  /**
   * Draws the garage stage. `elapsed` is 0 under reduced motion, which holds
   * the turntable on its opening three-quarter view rather than removing it.
   */
  renderHero(elapsed: number): void {
    const hero = this.hero;
    if (this.disposed || !hero) return;

    hero.update(elapsed);
    const width = Math.max(1, this.size.width);
    const height = Math.max(1, this.size.height);
    this.heroCamera.aspect = width / height;
    /*
     * The frustum is shifted rather than the model moved.
     *
     * Moving the skiff off-centre in world space would swing it through the
     * turntable's own arc and change how it is lit; offsetting the projection
     * moves the *picture*, so the composition is identical wherever on screen
     * the panel has left room for it.
     */
    this.heroCamera.setViewOffset(
      width,
      height,
      width * (0.5 - this.heroAnchor.x),
      height * (0.5 - this.heroAnchor.y),
      width,
      height,
    );
    this.heroCamera.updateProjectionMatrix();
    hero.frame(this.heroCamera, this.heroAnchor.fill);

    this.heroPost.motion = this.reducedMotion ? 0 : 1;
    if (this.composer) {
      this.renderer.setRenderTarget(this.composer.target);
      this.renderer.render(hero.scene, this.heroCamera);
      this.captureSceneStats();
      this.composer.render(this.heroPost);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.toneMappingExposure = this.heroPost.exposure;
      this.renderer.render(hero.scene, this.heroCamera);
      this.captureSceneStats();
    }
  }

  /** Turns the finish shot's key light on or off. */
  setHeroLight(on: boolean): void {
    if (on && !this.heroLight) {
      // Short range so it models the skiff and leaves the course to the moon.
      const light = new THREE.PointLight(0xfff1dc, 0, 22, 1.6);
      this.scene.add(light);
      this.heroLight = light;
    }
    if (this.heroLight) this.heroLight.userData.wanted = on ? 1 : 0;
  }

  render(simulation: Simulation, elapsed: number, focusIndex?: number): void {
    if (this.disposed) return;
    if (!this.composer) this.renderer.toneMappingExposure = this.courseExposure;

    if (this.presentationHold > 0) {
      this.presentationHold -= elapsed;
      // Draw the scene exactly as it stands. The frame is still presented, so
      // pacing and the draw-call budget are measured on a real frame.
      this.present();
      return;
    }

    this.elapsedTotal += elapsed;
    const tier = QUALITY_TIERS[this.quality];

    const focus =
      (focusIndex === undefined ? undefined : simulation.racers[focusIndex]) ??
      simulation.player ??
      simulation.racers[0];
    for (const racer of simulation.racers) {
      const visual = this.vehicles.get(racer.index);
      if (!visual) continue;
      visual.update(racer, elapsed);
      this.emitTrail(racer, elapsed, tier.particleBudget > 0, focus);
    }

    if (focus) {
      const roughness = focus.onTrack
        ? SURFACES[focus.surface].roughness * clamp01(Math.hypot(focus.velocity.x, focus.velocity.z) / 40)
        : SURFACES[focus.surface].roughness;
      // The road's own direction, so the camera can keep the next apex framed
      // however sideways the skiff is.
      const projection = simulation.track.project(focus.pos, focus.path);
      this.chase.setTrackYaw(Math.atan2(projection.tangent.z, projection.tangent.x));
      this.chase.setClearance(this.measureClearance(focus));
      this.chase.update(focus, elapsed, this.reducedMotion ? 0 : roughness);
      this.nearFade.update(this.chase.camera);

      if (this.heroLight) {
        /*
         * Placed above and to one side of the camera rather than at it, so the
         * machine gets a direction to be lit from instead of a flat frontal
         * wash — and eased rather than switched, so the reveal is part of the
         * moment instead of a light coming on.
         */
        const camera = this.chase.camera;
        this.heroLight.position.set(
          camera.position.x + (focus.pos.x - camera.position.x) * 0.25,
          camera.position.y + 3.4,
          camera.position.z + (focus.pos.z - camera.position.z) * 0.25,
        );
        const wanted = (this.heroLight.userData.wanted as number | undefined) ?? 0;
        this.heroLight.intensity += (wanted * 46 - this.heroLight.intensity) * (1 - Math.exp(-4 * elapsed));
      }
      // Above and slightly behind, so it models the hull and the rider from the
      // side the camera is on rather than flaring the nose flat.
      this.routeLight?.position.set(
        focus.pos.x - Math.cos(focus.heading) * 1.4,
        focus.y + 3.1,
        focus.pos.z - Math.sin(focus.heading) * 1.4,
      );
      this.detectNearMiss(focus, simulation, elapsed);
      this.lighting?.follow(focus.pos.x, focus.y, focus.pos.z);
      if (this.sky) {
        this.sky.mesh.position.copy(this.chase.camera.position);
        this.sky.update(elapsed);
      }
    }

    // The dissolve needs the camera every frame, so this runs after the chase
    // camera has been moved rather than before it.
    this.scenery?.update(elapsed, this.chase.camera.position);
    /*
     * The crowd reacts to the *leader*, not to the player.
     *
     * A marshal who waves at whoever the camera is following is waving at a
     * driver in fifth while the front of the race goes past unnoticed, which
     * reads as a crowd that is watching the wrong thing — worse than one that
     * does not move at all.
     */
    if (this.life) {
      let leader = simulation.racers[0];
      for (const racer of simulation.racers) {
        const ahead = racer.lapsCompleted + racer.progress;
        if (leader && ahead > leader.lapsCompleted + leader.progress) leader = racer;
      }
      if (leader) this.life.update(elapsed, leader.pos);
    }
    this.particles.update(elapsed, this.chase.camera.quaternion);

    /*
     * The speed cue drives the radial warp and the chromatic fringe. It is
     * smoothed rather than read raw: a single fast frame — the instant a boost
     * pad fires, say — would otherwise snap the whole frame's geometry, which
     * reads as a glitch rather than as speed. And it is gated on the *player's*
     * speed, not the camera's, so a fast attract-mode leader does not warp the
     * menu behind the title.
     */
    const focusSpeed = focus ? Math.hypot(focus.velocity.x, focus.velocity.z) : 0;
    const target = clamp01((focusSpeed - 22) / 34) + (focus?.boosting ? 0.35 : 0);
    this.speedCue += (target - this.speedCue) * (1 - Math.exp(-4 * elapsed));
    this.post.speed = this.speedCue;
    this.post.motion = this.reducedMotion ? 0 : 1;

    this.present();
  }

  /**
   * Draws the scene as it currently stands.
   *
   * Split out so a held frame is a *real* frame — presented, measured, and
   * costing what an ordinary one costs — rather than a skipped one. A hit stop
   * that quietly stopped rendering would flatter the frame-pacing numbers and
   * hide its own cost.
   */
  private present(): void {
    if (this.composer) {
      this.renderer.setRenderTarget(this.composer.target);
      this.renderer.render(this.scene, this.chase.camera);
      this.captureSceneStats();
      this.composer.render(this.post);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.chase.camera);
      this.captureSceneStats();
    }
  }

  private captureSceneStats(): void {
    const info = this.renderer.info.render;
    this.sceneStats.drawCalls = info.calls;
    this.sceneStats.triangles = info.triangles;
  }

  /**
   * How much of the camera's ideal boom is unobstructed, 0-1.
   *
   * A ray from the racer back along the boom against the scenery and obstacle
   * meshes. This exists because the review found the chase view repeatedly
   * filled by a tree canopy or a near-plane slab — including a case where the
   * road disappeared entirely on a phone while the player was trying to recover
   * from an excursion. A camera that hides the road at exactly the moment the
   * player has lost the road is worse than no camera at all.
   *
   * Deliberately one ray, on the focused racer only, against a small set of
   * candidate meshes: this runs every frame and must not cost more than the
   * thing it protects.
   */
  private measureClearance(focus: RacerState): number {
    if (this.occluders.length === 0) return 1;
    const origin = this.rayOrigin.set(focus.pos.x, focus.y + 1.6, focus.pos.z);
    const yaw = this.chase.listenerYaw;
    this.rayDirection.set(-Math.cos(yaw), 0.12, -Math.sin(yaw)).normalize();
    this.raycaster.set(origin, this.rayDirection);
    this.raycaster.far = 16;
    const hits = this.raycaster.intersectObjects(this.occluders, false);
    const nearest = hits[0];
    if (!nearest) return 1;
    return clamp01(nearest.distance / 16);
  }

  /**
   * The near miss.
   *
   * A rival closing on the player and passing inside a few metres is the most
   * exciting thing that happens in a race, and F7 found it had *no* feedback at
   * all — the same silent frame as an empty straight. Two terms are both
   * required, and the second is what makes this usable: a rival sitting
   * alongside at matched speed for a whole straight is not a near miss and must
   * not fire one, while the same gap closed at speed is.
   *
   * The cue is deliberately small — a camera kick and a whip of the rival's own
   * dust across the frame, not a slow-motion flourish — because it fires
   * several times a lap and anything larger becomes noise. It also drives the
   * audio hook, which is where most of the read actually lives.
   */
  private detectNearMiss(focus: RacerState, simulation: Simulation, elapsed: number): void {
    for (const key of this.nearMissCooldowns.keys()) {
      const left = (this.nearMissCooldowns.get(key) ?? 0) - elapsed;
      if (left <= 0) this.nearMissCooldowns.delete(key);
      else this.nearMissCooldowns.set(key, left);
    }

    for (const rival of simulation.racers) {
      if (rival.index === focus.index) continue;
      if (this.nearMissCooldowns.has(rival.index)) continue;
      const dx = rival.pos.x - focus.pos.x;
      const dz = rival.pos.z - focus.pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > NEAR_MISS_DISTANCE) continue;
      // Relative speed along the line between them: positive is separating.
      const relative =
        ((rival.velocity.x - focus.velocity.x) * dx + (rival.velocity.z - focus.velocity.z) * dz) / Math.max(0.01, distance);

      /*
       * A near miss is a pass that has *already happened*.
       *
       * The first version accepted any large radial speed, in either sign, so
       * it announced a rival that was closing hard into a collision as a near
       * miss — and then stacked its camera kick on top of the impact feedback a
       * few frames later. A cue that fires before the event it names is worse
       * than no cue: it teaches the player the wrong thing about what just
       * happened.
       *
       * Separating is therefore required, not merely fast, and anything in
       * contact or fresh out of a contact is excluded outright.
       */
      if (relative < NEAR_MISS_CLOSING) continue;
      if (focus.contactCooldown > 0 || rival.contactCooldown > 0) continue;
      if (distance < NEAR_MISS_CONTACT) continue;

      this.nearMissCooldowns.set(rival.index, NEAR_MISS_COOLDOWN);
      const intensity = clamp01((NEAR_MISS_DISTANCE - distance) / NEAR_MISS_DISTANCE);
      this.chase.addKick(intensity * 0.35);
      /*
       * Dust dragged off the *rival*, not off the midpoint between them.
       *
       * The obvious placement is halfway between the two skiffs, and it is
       * wrong: halfway is directly in front of the chase camera, two or three
       * metres out, so a soft particle there is metres across in screen space
       * and smears over the road exactly when the player most needs to see it.
       * Caught on a 320 px viewport, where it covered the racing line. A near
       * miss fires several times a lap, so it has to be the quietest cue in the
       * game rather than the loudest — on the rival's far flank it still reads
       * as coming from the side they passed on and never crosses the line.
       */
      this.particles.emit(
        'dust',
        rival.pos.x + dx * 0.35,
        rival.y + 0.3,
        rival.pos.z + dz * 0.35,
        this.dustColor,
        2,
        0.3 + intensity * 0.25,
      );
      this.onNearMiss?.(intensity);
    }
  }

  /** Continuous per-racer effects: tyre dust, boost flare, drift smoke. */
  private emitTrail(racer: RacerState, elapsed: number, enabled: boolean, focus: RacerState | undefined): void {
    if (!enabled) return;
    const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
    if (speed < 4) return;

    // Trails from racers the player cannot make out are pure cost: they fill
    // the pool, which starves the effects that do matter, and they stack into a
    // haze. Beyond 90 m nothing is emitted at all.
    if (focus) {
      const distance = Math.hypot(racer.pos.x - focus.pos.x, racer.pos.z - focus.pos.z);
      if (distance > 90) return;
    }

    const surface = SURFACES[racer.surface];
    const behindX = racer.pos.x - Math.cos(racer.heading) * 2;
    const behindZ = racer.pos.z - Math.sin(racer.heading) * 2;

    // Rate is per second and scaled by how rough the surface is and how hard
    // the skiff is sliding, so a clean line on tarmac is visually quiet and a
    // drift on dirt throws a proper rooster tail.
    const slideFactor = clamp01(Math.abs(racer.slip) / 0.4);
    const bed = SURFACE_BEDS[racer.surface] ?? DEFAULT_BED;
    const rate = (surface.roughness * 16 * clamp01(speed / 35) + slideFactor * 13) * bed.rate;
    const count = Math.floor(rate * elapsed + (this.elapsedTotal * 60 + racer.index) % 1);
    if (count > 0) {
      // The bed's own colour where it has one — grass throws torn green, water
      // throws white, salt throws something almost luminous — and the course's
      // dust colour otherwise, so a quarry and an arcology do not kick up the
      // same beige.
      const color = bed.color ?? this.dustColor;
      this.particles.emit(bed.kind, behindX, racer.y + 0.25, behindZ, color, Math.min(count, 2), (1 + slideFactor) * bed.scale);
      /*
       * The second layer: what the surface throws *besides* dust.
       *
       * F7's finding was that surface feedback is "incoherent" — every surface
       * emitted the same grey puff at a different rate, so the tell for having
       * left the road was quantitative rather than qualitative. A bed with its
       * own second emitter is qualitative: grit sparks off stone, spray off
       * water, torn growth off grass. A player learns those in one lap.
       */
      if (bed.secondary && slideFactor > 0.25) {
        this.particles.emit(
          bed.secondary.kind,
          behindX,
          racer.y + 0.4,
          behindZ,
          bed.secondary.color,
          1,
          slideFactor * bed.secondary.scale,
        );
      }
    }

    if (racer.boosting) {
      this.particles.emit(
        'boost',
        racer.pos.x - Math.cos(racer.heading) * 2.6,
        racer.y + 0.6,
        racer.pos.z - Math.sin(racer.heading) * 2.6,
        getRacer(racer.profileId).colors.glow,
        2,
        1,
      );
    }
  }

  stats(): RenderStats {
    const info = this.renderer.info;
    return {
      // The world's counts, not the composite's. See `sceneStats`.
      drawCalls: this.sceneStats.drawCalls,
      triangles: this.sceneStats.triangles,
      /** Full-screen passes the post chain adds on top of the scene. */
      postPasses: this.composer ? 4 : 0,
      particles: this.particles.live,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  get exposure(): number {
    return this.renderer.toneMappingExposure;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    for (const visual of this.vehicles.values()) visual.dispose();
    this.vehicles.clear();
    this.hero?.dispose();
    this.hero = null;
    this.clearWorld();
    this.particles.dispose();
    this.composer?.dispose();
    disposeTextures();
    disposeFamilyMaps();
    this.renderer.dispose();
  }
}

/**
 * Recursively releases GPU resources for a subtree.
 *
 * Materials go through `disposeMaterial` rather than `Material.dispose`, so the
 * breakup-map clone `familyMaterial` hands every piece of scenery is released
 * with it. Disposing the material alone left one texture per scenery material
 * behind on every course change.
 */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    disposeMaterialsOf(object);
    // A light's own GPU allocation is its shadow map, and only the light knows
    // about it - nothing above reaches it.
    if (object instanceof THREE.Light) object.dispose();
  });
}
