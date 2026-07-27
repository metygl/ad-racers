import * as THREE from 'three';

/**
 * The post-processing chain.
 *
 * Written by hand rather than assembled from `three/examples/jsm`'s composer,
 * for two reasons that are both about control. The example passes each own a
 * full-resolution render target and a full-screen draw; chaining four of them
 * costs four full-screen reads on a budget that has to hold 60 fps on an
 * integrated GPU. And `UnrealBloomPass` in particular runs five mip levels with
 * two blur passes each, which is a lot of bandwidth for an effect this game
 * wants to keep on a short leash anyway.
 *
 * What this does instead:
 *
 * ```
 *   scene ─► HDR target ─┬─────────────────────────────► composite ─► screen
 *                        └─► bright pass (¼) ─► blur ──┘
 * ```
 *
 * Three reduced-resolution draws and one full-screen composite. The composite
 * does grade, vignette, radial speed warp and chromatic fringe in the same
 * pass, because they are all cheap arithmetic on a colour that has already been
 * fetched — splitting them into separate passes would multiply the expensive
 * part (the texture read) to save nothing.
 *
 * The art bible's rule governs every parameter here: **post supports
 * readability and never conceals weak art.** The bloom threshold sits above the
 * road's value band on purpose, so the road itself can never bloom; the
 * vignette is capped; and everything motion-derived scales to exactly zero
 * under reduced motion.
 */

export interface PostSettings {
  /** Luminance above which a pixel contributes to bloom. */
  bloomThreshold: number;
  bloomIntensity: number;
  /** Per-course colour grade. */
  lift: THREE.Color;
  gamma: THREE.Color;
  gain: THREE.Color;
  saturation: number;
  contrast: number;
  vignette: number;
  /** Linear exposure multiplier applied before the tone map. */
  exposure: number;
  /** 0-1 driving the radial warp and the fringe; scaled by the caller. */
  speed: number;
  /** Master switch for every motion-derived term. */
  motion: number;
}

export function defaultPostSettings(): PostSettings {
  return {
    bloomThreshold: 0.72,
    bloomIntensity: 0.62,
    lift: new THREE.Color(0, 0, 0),
    gamma: new THREE.Color(1, 1, 1),
    gain: new THREE.Color(1, 1, 1),
    saturation: 1.04,
    contrast: 1.03,
    vignette: 0.18,
    exposure: 1.05,
    speed: 0,
    motion: 1,
  };
}

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uScene;
  uniform float uThreshold;
  uniform vec2 uTexel;
  varying vec2 vUv;

  void main() {
    // A 2x2 box while downsampling: sampling one texel of a quarter-size target
    // aliases badly on the thin bright things this game has most of — exhaust
    // discs, kerb markers, tier flares — and the aliasing then blooms.
    vec3 sum = texture2D(uScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
    sum += texture2D(uScene, vUv + uTexel * vec2(0.5, -0.5)).rgb;
    sum += texture2D(uScene, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
    sum += texture2D(uScene, vUv + uTexel * vec2(0.5, 0.5)).rgb;
    vec3 color = sum * 0.25;

    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee, so a surface hovering either side of the threshold does not
    // flicker in and out of the bloom as the light changes across it.
    float contribution = smoothstep(uThreshold, uThreshold + 0.28, luma);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uSource;
  uniform vec2 uDirection;
  varying vec2 vUv;

  void main() {
    // Nine-tap Gaussian folded into five bilinear fetches.
    vec3 color = texture2D(uSource, vUv).rgb * 0.227027;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    color += texture2D(uSource, vUv + o1).rgb * 0.3162162162;
    color += texture2D(uSource, vUv - o1).rgb * 0.3162162162;
    color += texture2D(uSource, vUv + o2).rgb * 0.0702702703;
    color += texture2D(uSource, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uBloomIntensity;
  uniform float uExposure;
  uniform vec3 uLift;
  uniform vec3 uGamma;
  uniform vec3 uGain;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uVignette;
  uniform float uSpeed;
  uniform float uFringe;
  varying vec2 vUv;

  /*
   * ACES filmic, in the same fitted approximation three.js uses, so switching
   * the chain off on the low tier does not change how the game is graded.
   *
   * It runs *here*, after the bloom, rather than in the scene pass. That
   * ordering is the whole reason the scene target is half float: tone mapping
   * first would compress every highlight to near 1 before the bright pass ever
   * saw it, leaving the bloom with no intensity information to work with, and a
   * thruster and the sun would flare identically.
   */
  vec3 acesFilmic(vec3 color) {
    const mat3 inputMatrix = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 outputMatrix = mat3(
      1.60475, -0.10208, -0.00327,
      -0.53108, 1.10813, -0.07276,
      -0.07367, -0.00605, 1.07602
    );
    vec3 v = inputMatrix * color;
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(outputMatrix * (a / b), 0.0, 1.0);
  }

  /*
   * Linear to sRGB, the exact piecewise transfer function rather than a 2.2
   * power.
   *
   * This has to be here and cannot be skipped. Three.js applies the encode
   * itself when a material draws straight to the canvas, but not when it draws
   * into a render target with a linear colour space — which is what the scene
   * pass does. Leaving it out writes linear values into an sRGB framebuffer,
   * and the entire game comes out looking like it is being viewed at dusk
   * through a filter.
   */
  vec3 linearToSRGB(vec3 color) {
    return mix(
      pow(color, vec3(0.41666666)) * 1.055 - 0.055,
      color * 12.92,
      vec3(lessThanEqual(color, vec3(0.0031308)))
    );
  }

  void main() {
    vec2 centred = vUv - 0.5;
    float radius = length(centred);

    /*
     * Radial speed warp. The frame is pinched very slightly towards the centre
     * with distance from it, which reads as the world rushing past the edges of
     * the screen. Deliberately tiny — a warp large enough to notice as a warp
     * is a warp large enough to make people ill — and it goes to exactly zero
     * when the caller scales uSpeed to zero for reduced motion.
     */
    vec2 warped = vUv - centred * radius * radius * uSpeed;

    /*
     * Chromatic fringe, split along the same radial axis. Under a pixel and a
     * half at full boost. Its whole job is to punctuate the moment Surge is
     * spent; it is never on during ordinary driving.
     */
    vec2 offset = centred * radius * uFringe;
    vec3 color;
    color.r = texture2D(uScene, warped + offset).r;
    color.g = texture2D(uScene, warped).g;
    color.b = texture2D(uScene, warped - offset).b;

    color += texture2D(uBloom, warped).rgb * uBloomIntensity;

    // Everything above this line is in linear HDR; everything below is display
    // referred. Grading after the tone map is what makes the numbers in a
    // course theme mean something a person can predict.
    color = acesFilmic(color * uExposure);

    // Lift / gamma / gain: the standard three-way grade. No LUT, because a LUT
    // is a binary asset and this repository does not ship any.
    color = uLift + color * (uGain - uLift);
    color = pow(max(color, vec3(0.0)), 1.0 / max(uGamma, vec3(0.05)));

    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);
    color = (color - 0.5) * uContrast + 0.5;

    // Vignette, capped by the caller well below anything that would hide a
    // rival arriving from the edge of the frame.
    float falloff = smoothstep(0.34, 0.86, radius);
    color *= 1.0 - falloff * uVignette;

    gl_FragColor = vec4(linearToSRGB(clamp(color, 0.0, 1.0)), 1.0);
  }
`;

/** Ratio of the bloom targets to the main one. */
const BLOOM_SCALE = 0.25;
/** Bloom intensity retained under reduced motion. */
const REDUCED_MOTION_BLOOM = 0.35;
/** Extra threshold under reduced motion, so only true emitters bloom. */
const REDUCED_MOTION_THRESHOLD_LIFT = 0.45;

function fullscreenGeometry(): THREE.BufferGeometry {
  // A single oversized triangle rather than a quad: no diagonal seam, one fewer
  // vertex, and no chance of the two triangles being rasterised inconsistently
  // along the shared edge.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return geometry;
}

export class PostComposer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly geometry = fullscreenGeometry();

  private readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly bloomA: THREE.WebGLRenderTarget;
  private readonly bloomB: THREE.WebGLRenderTarget;

  private readonly bright: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;

  /*
   * Uniform objects are held by reference rather than looked up by name each
   * frame. `ShaderMaterial.uniforms` is an index signature, so every access
   * would otherwise need a non-null assertion, and a typo in a uniform name
   * would silently do nothing at 60 Hz instead of failing loudly.
   */
  private readonly u: {
    threshold: { value: number };
    texel: { value: THREE.Vector2 };
    blurSource: { value: THREE.Texture | null };
    blurDirection: { value: THREE.Vector2 };
    bloom: { value: THREE.Texture };
    bloomIntensity: { value: number };
    exposure: { value: number };
    lift: { value: THREE.Color };
    gamma: { value: THREE.Color };
    gain: { value: THREE.Color };
    saturation: { value: number };
    contrast: { value: number };
    vignette: { value: number };
    speed: { value: number };
    fringe: { value: number };
  };

  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    /*
     * Half float, not byte.
     *
     * Tone mapping runs in the composite pass's input, which means the scene
     * target holds values well above 1 wherever an emissive surface is. Storing
     * that in 8 bits clips every thruster and every tier flare to flat white
     * *before* the bright pass ever sees it, and the bloom then has no
     * intensity information left to work with.
     */
    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const options = { type, depthBuffer: true, stencilBuffer: false };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, options);
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false, stencilBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false, stencilBuffer: false });
    for (const target of [this.sceneTarget, this.bloomA, this.bloomB]) {
      target.texture.minFilter = THREE.LinearFilter;
      target.texture.magFilter = THREE.LinearFilter;
      target.texture.generateMipmaps = false;
      target.texture.wrapS = THREE.ClampToEdgeWrapping;
      target.texture.wrapT = THREE.ClampToEdgeWrapping;
    }

    this.u = {
      threshold: { value: 0.72 },
      texel: { value: new THREE.Vector2() },
      blurSource: { value: null },
      blurDirection: { value: new THREE.Vector2() },
      bloom: { value: this.bloomA.texture },
      bloomIntensity: { value: 0.62 },
      exposure: { value: 1.05 },
      lift: { value: new THREE.Color(0, 0, 0) },
      gamma: { value: new THREE.Color(1, 1, 1) },
      gain: { value: new THREE.Color(1, 1, 1) },
      saturation: { value: 1 },
      contrast: { value: 1 },
      vignette: { value: 0.18 },
      speed: { value: 0 },
      fringe: { value: 0 },
    };

    this.bright = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: {
        uScene: { value: this.sceneTarget.texture },
        uThreshold: this.u.threshold,
        uTexel: this.u.texel,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: {
        uSource: this.u.blurSource,
        uDirection: this.u.blurDirection,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        uScene: { value: this.sceneTarget.texture },
        uBloom: this.u.bloom,
        uBloomIntensity: this.u.bloomIntensity,
        uExposure: this.u.exposure,
        uLift: this.u.lift,
        uGamma: this.u.gamma,
        uGain: this.u.gain,
        uSaturation: this.u.saturation,
        uContrast: this.u.contrast,
        uVignette: this.u.vignette,
        uSpeed: this.u.speed,
        uFringe: this.u.fringe,
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(this.geometry, this.composite);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    const pixelRatio = this.renderer.getPixelRatio();
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneTarget.setSize(this.width, this.height);
    const bw = Math.max(1, Math.floor(this.width * BLOOM_SCALE));
    const bh = Math.max(1, Math.floor(this.height * BLOOM_SCALE));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this.u.texel.value.set(1 / this.width, 1 / this.height);
  }

  /** The target the world should be rendered into. */
  get target(): THREE.WebGLRenderTarget {
    return this.sceneTarget;
  }

  /** Runs bright pass, blur and composite. Assumes the scene is already drawn. */
  render(settings: PostSettings): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    const u = this.u;

    if (settings.bloomIntensity > 0.001) {
      u.threshold.value = settings.bloomThreshold;
      this.quad.material = this.bright;
      renderer.setRenderTarget(this.bloomA);
      renderer.render(this.scene, this.camera);

      const bw = this.bloomA.width;
      const bh = this.bloomA.height;
      this.quad.material = this.blur;

      u.blurSource.value = this.bloomA.texture;
      u.blurDirection.value.set(1 / bw, 0);
      renderer.setRenderTarget(this.bloomB);
      renderer.render(this.scene, this.camera);

      u.blurSource.value = this.bloomB.texture;
      u.blurDirection.value.set(0, 1 / bh);
      renderer.setRenderTarget(this.bloomA);
      renderer.render(this.scene, this.camera);

      u.bloom.value = this.bloomA.texture;
    }

    u.bloomIntensity.value = settings.bloomIntensity;
    u.exposure.value = settings.exposure;
    u.lift.value.copy(settings.lift);
    u.gamma.value.copy(settings.gamma);
    u.gain.value.copy(settings.gain);
    u.saturation.value = settings.saturation;
    u.contrast.value = settings.contrast;
    u.vignette.value = settings.vignette;
    u.speed.value = settings.speed * 0.11 * settings.motion;
    u.fringe.value = settings.speed * 0.0035 * settings.motion;
    /*
     * Reduced motion is a designed mode, not a switch that removes one effect.
     *
     * The warp and the fringe going to zero left the large bloom pulses fully
     * intact, which are the highest-risk thing in the frame for sensory
     * overload and photosensitivity. Bloom is therefore budgeted independently:
     * it stays — an unlit night course needs it to be readable at all — but at
     * a fraction of the intensity and with a higher threshold, so it marks
     * emissive surfaces instead of flooding the frame.
     */
    if (settings.motion < 1) {
      u.bloomIntensity.value = settings.bloomIntensity * REDUCED_MOTION_BLOOM;
      u.threshold.value = settings.bloomThreshold + REDUCED_MOTION_THRESHOLD_LIFT;
      u.vignette.value = settings.vignette * 0.6;
    }

    this.quad.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sceneTarget.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.geometry.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.composite.dispose();
  }
}
