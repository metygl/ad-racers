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
import { buildLighting, buildSky } from './scene/SkyDome';
import type { LightingResult, SkyResult } from './scene/SkyDome';
import { buildTerrain } from './scene/Terrain';
import { buildTrackMesh } from './scene/TrackMesh';
import { buildVehicle } from './scene/VehicleModel';
import type { VehicleVisual } from './scene/VehicleModel';
import { QUALITY_TIERS } from './quality';
import type { QualityId } from './quality';
import { DEFAULT_GRADE, toColor } from './palette';
import { PostComposer, defaultPostSettings } from './post/Composer';
import type { PostSettings } from './post/Composer';
import { disposeTextures } from './textures/procedural';

/**
 * Everything that draws.
 *
 * The renderer reads the simulation but never writes to it, and it never
 * advances time on its own — `render` is handed the interpolation state by the
 * game loop. That separation is what makes the race deterministic regardless of
 * frame rate, and it is what lets the whole simulation be tested without a GPU.
 */

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

      const terrain = buildTerrain(track, tier.terrainResolution);
      this.world.add(terrain.mesh);
      this.world.add(buildTrackMesh(track));
      const scenery = buildScenery(track, {
        densityScale: tier.sceneryDensity,
        visibilityDistance: tier.sceneryDistance,
        heightAt: terrain.heightAt,
        castShadows: tier.shadowMapSize > 0,
      });
      this.scenery = scenery;
      this.world.add(scenery.group);
      this.world.add(buildHorizon(track));
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
      const visual = buildVehicle(getRacer(racer.profileId), tier.vehicleShadows);
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
    this.occluders = [];
    if (this.lighting) {
      this.scene.remove(this.lighting.group);
      this.lighting = null;
    }
  }

  /** Turns simulation events into effects. Called once per rendered frame. */
  consumeEvents(events: readonly SimEvent[], simulation: Simulation): void {
    for (const event of events) {
      switch (event.type) {
        case 'collision': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          this.particles.emit('impact', racer.pos.x, racer.y + 0.8, racer.pos.z, 0xffd9a0, 8, clamp01(event.speed / 18));
          this.particles.emit('spark', racer.pos.x, racer.y + 0.7, racer.pos.z, 0xffb95c, 10, clamp01(event.speed / 14));
          if (racer.isPlayer) this.chase.addShake(clamp01(event.speed / 16) * 0.8);
          break;
        }
        case 'wallHit': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          this.particles.emit('spark', event.pos.x, racer.y + 0.6, event.pos.z, 0xffc36b, 7, clamp01(event.speed / 16));
          if (racer.isPlayer) this.chase.addShake(clamp01(event.speed / 20) * 0.7);
          break;
        }
        case 'strikeHit': {
          const target = simulation.racers[event.target];
          const y = target ? target.y + 1.1 : 1.1;
          this.particles.emit('impact', event.pos.x, y, event.pos.z, 0xfff0b8, 12, event.strength);
          this.particles.emit('spark', event.pos.x, y, event.pos.z, 0xffe08a, 14, event.strength);
          if (target?.isPlayer || simulation.racers[event.attacker]?.isPlayer) {
            this.chase.addShake(0.55 * event.strength);
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
          const colors = [0x9fd8ff, 0xffc46b, 0xff7ad9];
          this.particles.emit(
            'boost',
            racer.pos.x, racer.y + 0.5, racer.pos.z,
            colors[Math.min(event.tier, colors.length) - 1] ?? 0xffffff,
            10 + event.tier * 5,
            1,
          );
          // The camera punch scales with the tier, so the third tier is
          // physically bigger news than the first rather than just a different
          // colour of spark.
          if (racer.isPlayer) this.chase.addKick(0.16 + event.tier * 0.14);
          break;
        }
        case 'boostStart': {
          if (simulation.racers[event.racer]?.isPlayer) this.chase.addKick(0.45);
          break;
        }
        case 'towSnap': {
          const racer = simulation.racers[event.racer];
          if (!racer) break;
          this.particles.emit('boost', racer.pos.x, racer.y + 0.6, racer.pos.z, 0xbfe9ff, 16, event.strength * 1.4);
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
          this.particles.emit('dust', racer.pos.x, racer.y + 0.2, racer.pos.z, this.dustColor, event.clean ? 8 : 16, 1.4);
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
   * which is how the attract race can follow the leader instead of a player.
   */
  render(simulation: Simulation, elapsed: number, focusIndex?: number): void {
    if (this.disposed) return;
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
      this.lighting?.follow(focus.pos.x, focus.y, focus.pos.z);
      if (this.sky) {
        this.sky.mesh.position.copy(this.chase.camera.position);
        this.sky.update(elapsed);
      }
    }

    this.scenery?.update(elapsed);
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
    const rate = surface.roughness * 16 * clamp01(speed / 35) + slideFactor * 13;
    const count = Math.floor(rate * elapsed + (this.elapsedTotal * 60 + racer.index) % 1);
    if (count > 0) {
      const color = racer.surface === 'water' ? 0xcfe8ff : this.dustColor;
      const kind = racer.surface === 'water' ? 'splash' : 'dust';
      this.particles.emit(kind, behindX, racer.y + 0.25, behindZ, color, Math.min(count, 2), 1 + slideFactor);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    for (const visual of this.vehicles.values()) visual.dispose();
    this.vehicles.clear();
    this.clearWorld();
    this.particles.dispose();
    this.composer?.dispose();
    disposeTextures();
    this.renderer.dispose();
  }
}

/** Recursively releases GPU resources for a subtree. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else if (material) {
      material.dispose();
    }
  });
}
