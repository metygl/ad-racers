import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { particleTexture } from '../textures/procedural';

/**
 * Particles.
 *
 * A single pre-allocated pool rendered as one instanced, additively blended
 * quad mesh. Nothing is allocated after startup and there is exactly one draw
 * call however busy the race gets, so the particle budget is a hard number
 * rather than a hope — which is what makes the low quality tier a real
 * guarantee rather than a suggestion.
 */

interface Particle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  growth: number;
  drag: number;
  gravity: number;
  r: number;
  g: number;
  b: number;
  fade: number;
}

export type ParticleKind = 'dust' | 'spark' | 'impact' | 'ember' | 'splash' | 'boost';

/**
 * Which blend layer a kind belongs to.
 *
 * Dust and spray are *not* luminous. Rendering them additively is what turns a
 * pack of six skiffs kicking up grass into a white sheet across the screen, so
 * they get normal alpha blending and only genuinely glowing effects — sparks,
 * impacts, embers, boost flare — go on the additive layer.
 */
const ADDITIVE_KINDS: ReadonlySet<ParticleKind> = new Set<ParticleKind>(['spark', 'impact', 'ember', 'boost']);

export class ParticleSystem {
  readonly meshes: THREE.InstancedMesh[];
  private readonly additive: THREE.InstancedMesh;
  private readonly smoke: THREE.InstancedMesh;
  private readonly layer: Uint8Array;
  private readonly pool: Particle[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly color = new THREE.Color();
  private readonly rng: Rng;
  private cursor = 0;
  /** Live particle count, exposed to the performance overlay. */
  live = 0;

  constructor(budget: number, seed = 1337) {
    this.rng = new Rng(seed);
    const texture = particleTexture();

    const makeMesh = (name: string, blending: THREE.Blending, opacity: number): THREE.InstancedMesh => {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        blending,
        opacity,
        depthWrite: false,
        // Particles carry their own colour, so scene fog would only wash them
        // out at exactly the moment they matter.
        fog: false,
      });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, budget);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(budget * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = budget;
      return mesh;
    };

    // Both layers are allocated at full budget and share one slot index, so a
    // particle can live on either without any bookkeeping beyond `layer`.
    this.additive = makeMesh('particles-glow', THREE.AdditiveBlending, 1);
    this.smoke = makeMesh('particles-smoke', THREE.NormalBlending, 0.28);
    this.meshes = [this.smoke, this.additive];
    this.layer = new Uint8Array(budget);

    for (let i = 0; i < budget; i++) {
      this.pool.push({
        active: false,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 1, growth: 0, drag: 1, gravity: 0,
        r: 1, g: 1, b: 1, fade: 1,
      });
    }
    // Everything starts collapsed to zero scale, which is how an unused slot is
    // hidden without a per-frame visibility branch.
    this.reset();
  }

  get budget(): number {
    return this.pool.length;
  }

  /**
   * Claims the next slot. When the pool is exhausted the oldest slot is reused
   * rather than dropping the effect — a burst that matters (an impact) should
   * never be silently swallowed because a wheel was kicking up dust.
   */
  private claim(): Particle {
    const particle = this.pool[this.cursor] as Particle;
    this.cursor = (this.cursor + 1) % this.pool.length;
    if (!particle.active) this.live += 1;
    particle.active = true;
    return particle;
  }

  /**
   * Multiplier on every emitted particle's size and count.
   *
   * Reduced motion previously scaled bloom and removed the speed fringe, and
   * left the emitters untouched — so a review found the normal and reduced
   * boost captures "broadly washed out" in both, and the primary readability
   * failure effectively unchanged. Motion sensitivity and luminance
   * sensitivity are not the same axis, but a peak effect that covers the road
   * is a problem on both.
   */
  intensityScale = 1;

  emit(
    kind: ParticleKind,
    x: number,
    y: number,
    z: number,
    color: THREE.ColorRepresentation,
    count: number,
    intensity = 1,
  ): void {
    this.color.set(color);
    const additive = ADDITIVE_KINDS.has(kind);
    if (additive && this.intensityScale < 1) {
      intensity *= this.intensityScale;
      count = Math.max(1, Math.round(count * this.intensityScale));
    }
    for (let i = 0; i < count; i++) {
      const index = this.cursor;
      const p = this.claim();
      this.layer[index] = additive ? 1 : 0;
      // Hide the slot on the layer it is *not* using, so a slot that has just
      // switched layers does not leave a stale quad behind.
      this.matrix.makeScale(0, 0, 0);
      (additive ? this.smoke : this.additive).setMatrixAt(index, this.matrix);
      p.x = x;
      p.y = y;
      p.z = z;
      p.r = this.color.r;
      p.g = this.color.g;
      p.b = this.color.b;
      p.life = 0;
      p.fade = 1;

      switch (kind) {
        case 'dust':
          p.vx = this.rng.range(-1.6, 1.6);
          p.vy = this.rng.range(0.5, 1.9) * intensity;
          p.vz = this.rng.range(-1.6, 1.6);
          p.maxLife = this.rng.range(0.35, 0.7);
          p.size = this.rng.range(0.35, 0.7);
          p.growth = 1.2;
          p.drag = 2.6;
          p.gravity = -0.6;
          p.fade = 0.75;
          break;
        case 'spark':
          p.vx = this.rng.range(-9, 9) * intensity;
          p.vy = this.rng.range(1, 7) * intensity;
          p.vz = this.rng.range(-9, 9) * intensity;
          p.maxLife = this.rng.range(0.22, 0.55);
          p.size = this.rng.range(0.2, 0.42);
          p.growth = -0.3;
          p.drag = 1.2;
          p.gravity = -14;
          break;
        case 'impact':
          /*
           * A contact flash, not a dome.
           *
           * At 1.2-2.6 m growing at 5.5 m/s this reached five or six metres
           * across and lived for half a second, which on a six-car grid is a
           * white wash over the road and every nearby skiff. Two reviews
           * measured it independently: one `strikeHit` hid both vehicles and
           * most of the local road, and the natural opening pack produced "a
           * white bloom mass across the lower-left road and ghost-like rivals".
           * An effect that hides the event it is reporting has failed at the
           * only job it has.
           *
           * Smaller, shorter and with the growth pulled right back, so it
           * punctuates the contact point instead of covering it. The direction
           * of a hit is carried by the debris cone, which survives being small.
           */
          p.vx = this.rng.range(-4, 4) * intensity;
          p.vy = this.rng.range(1.2, 4) * intensity;
          p.vz = this.rng.range(-4, 4) * intensity;
          p.maxLife = this.rng.range(0.16, 0.3);
          p.size = this.rng.range(0.5, 1.1);
          p.growth = 1.6;
          p.drag = 4.5;
          p.gravity = -2;
          break;
        case 'ember':
          p.vx = this.rng.range(-1.2, 1.2);
          p.vy = this.rng.range(1.2, 3.4);
          p.vz = this.rng.range(-1.2, 1.2);
          p.maxLife = this.rng.range(1.4, 2.8);
          p.size = this.rng.range(0.16, 0.34);
          p.growth = -0.05;
          p.drag = 0.5;
          p.gravity = 0.7;
          break;
        case 'splash':
          p.vx = this.rng.range(-3.5, 3.5);
          p.vy = this.rng.range(2.5, 6) * intensity;
          p.vz = this.rng.range(-3.5, 3.5);
          p.maxLife = this.rng.range(0.35, 0.7);
          p.size = this.rng.range(0.35, 0.75);
          p.growth = 1.2;
          p.drag = 1.8;
          p.gravity = -11;
          p.fade = 0.85;
          break;
        case 'boost':
          /*
           * Boost wrapped the skiff in a soft glowing ball: at 1.3 m growing at
           * 3.2 m/s it reached two metres of additive light around a two-metre
           * car. It should read as thrust leaving an emitter, so it is smaller,
           * shorter-lived, and grows far less.
           */
          p.vx = this.rng.range(-1.1, 1.1);
          p.vy = this.rng.range(-0.3, 0.9);
          p.vz = this.rng.range(-1.1, 1.1);
          p.maxLife = this.rng.range(0.16, 0.32);
          p.size = this.rng.range(0.35, 0.8);
          p.growth = 1.4;
          p.drag = 5.5;
          p.gravity = 0.4;
          break;
      }
    }
  }

  /**
   * A burst thrown along a contact normal.
   *
   * Motion finding F6's third part: an impact that sprays debris uniformly in
   * every direction tells the player *that* something happened. Debris thrown
   * back along the normal of the contact tells them *where they were hit*,
   * which is the difference between a hit that is confusing and a hit that is
   * information — and on a six-car grid it is often the only cue that says
   * which side the rival came from.
   *
   * The normal is supplied by the caller, which computes it from the two
   * positions the simulation reported. Nothing about this feeds back.
   */
  emitDirected(
    kind: ParticleKind,
    x: number,
    y: number,
    z: number,
    normal: { x: number; z: number },
    color: THREE.ColorRepresentation,
    count: number,
    intensity = 1,
  ): void {
    const length = Math.hypot(normal.x, normal.z) || 1;
    const nx = normal.x / length;
    const nz = normal.z / length;
    const before = this.cursor;
    this.emit(kind, x, y, z, color, count, intensity);
    // Rewrite the velocities the base emitter randomised: keep its spread, but
    // bias it hard along the normal so the cone points away from the contact.
    for (let i = 0; i < count; i++) {
      const p = this.pool[(before + i) % this.pool.length] as Particle;
      const speed = Math.hypot(p.vx, p.vz);
      p.vx = nx * speed * 1.5 + p.vx * 0.35;
      p.vz = nz * speed * 1.5 + p.vz * 0.35;
      p.vy = Math.abs(p.vy) * 0.7 + 1.2 * intensity;
    }
  }

  /**
   * Advances every live particle and rewrites the instance buffers.
   * `cameraQuaternion` billboards the quads.
   */
  update(elapsed: number, cameraQuaternion: THREE.Quaternion): void {
    const dt = Math.min(elapsed, 0.05);
    this.quaternion.copy(cameraQuaternion);
    let live = 0;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i] as Particle;
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        this.matrix.makeScale(0, 0, 0);
        this.smoke.setMatrixAt(i, this.matrix);
        this.additive.setMatrixAt(i, this.matrix);
        continue;
      }
      live += 1;

      const decay = Math.exp(-p.drag * dt);
      p.vx *= decay;
      p.vz *= decay;
      p.vy = p.vy * decay + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const t = p.life / p.maxLife;
      const size = Math.max(0.02, p.size * (1 + p.growth * t));
      // Fade out on a curve rather than linearly, so particles disappear
      // without a visible pop at the end of their life.
      const alpha = (1 - t) * (1 - t) * p.fade;

      this.position.set(p.x, p.y, p.z);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.quaternion, this.scale);

      const target = this.layer[i] === 1 ? this.additive : this.smoke;
      target.setMatrixAt(i, this.matrix);
      // Additive quads fade by darkening towards black; alpha-blended ones keep
      // their colour and fade by shrinking, since their opacity is fixed on the
      // material. Scaling colour by alpha works acceptably for both and keeps
      // this to a single code path.
      target.instanceColor?.setXYZ(i, p.r * alpha, p.g * alpha, p.b * alpha);
    }

    this.live = live;
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Clears every particle, used when restarting a race. */
  reset(): void {
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < this.pool.length; i++) {
      (this.pool[i] as Particle).active = false;
      this.smoke.setMatrixAt(i, this.matrix);
      this.additive.setMatrixAt(i, this.matrix);
    }
    this.live = 0;
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
