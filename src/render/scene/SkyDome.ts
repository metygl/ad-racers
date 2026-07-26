import * as THREE from 'three';
import type { TrackTheme } from '../../game/track/types';

/**
 * Sky, atmosphere and lighting.
 *
 * The dome is a single inverted sphere with a custom shader: a three-stop
 * vertical gradient, a sun with a shaped halo rather than a hard disc, two
 * drifting cloud layers at different scales, and — for a night course — stars
 * that stay put in world space.
 *
 * No texture, no cubemap, no download. And because it is a shader rather than a
 * gradient texture the horizon stays smooth at any resolution instead of
 * banding, which at these low saturations is otherwise the first thing a player
 * notices.
 *
 * The art bible requires the horizon band of the sky to match the fog colour
 * *exactly*. A mismatch there is the most obvious tell of a cheap 3D scene:
 * distant geometry fades into one colour while the sky behind it is another,
 * and the world reads as a painted backdrop with objects in front of it. So the
 * bottom of the gradient is not a hand-picked hex value that has to be kept in
 * agreement with the fog — it *is* the fog colour.
 */

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    // World-space direction from the camera, which is all the fragment shader
    // needs since the dome is always centred on the camera.
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uCloud;
  uniform float uTime;
  uniform float uNight;

  varying vec3 vDirection;

  // Cheap hash-based value noise; four octaves is plenty for a cloud band.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    return noise(p) * 0.55 + noise(p * 2.3) * 0.27 + noise(p * 5.1) * 0.12 + noise(p * 9.7) * 0.06;
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float up = clamp(dir.y, -1.0, 1.0);

    /*
     * Three stops rather than two. A straight horizon-to-zenith lerp puts the
     * brightest part of the gradient right at the horizon, which reads as an
     * overcast dome whatever colours you feed it. Holding a haze band low down
     * and easing into the sky colour above it is what gives a sky depth.
     */
    vec3 sky = mix(uHaze, uHorizon, smoothstep(-0.02, 0.16, up));
    sky = mix(sky, uTop, pow(clamp(up, 0.0, 1.0), 0.55));

    vec3 sunDir = normalize(uSunDirection);
    float sun = max(dot(dir, sunDir), 0.0);

    /*
     * The sun as a halo, not a disc.
     *
     * A single tight high-exponent term is a hard white dot, and once the bloom
     * gets hold of it the result is a featureless ball with a visible edge —
     * which is exactly what it looked like before this was rewritten. Three
     * terms at very different falloffs give a core, an inner glow and a wide
     * atmospheric scatter, which is what reads as light rather than as a sprite.
     */
    sky += uSunColor * pow(sun, 900.0) * 3.0 * (1.0 - uNight);
    sky += uSunColor * pow(sun, 42.0) * 0.34 * (1.0 - uNight);
    sky += uSunColor * pow(sun, 3.5) * 0.12;
    // Scatter along the whole horizon on the sun's side, which is what makes a
    // low sun feel like a low sun instead of a lamp.
    sky += uSunColor * pow(max(sunDir.y * 0.5 + 0.5, 0.0), 2.0) * exp(-abs(up) * 9.0) * 0.1;

    // Two cloud layers at different scales and speeds, so the sky has parallax
    // of its own and never resolves into one repeating pattern.
    if (up > 0.0) {
      float mask = smoothstep(0.0, 0.3, up);
      vec2 base = dir.xz / max(up, 0.06);
      float high = fbm(base * 0.22 + vec2(uTime * 0.0035, uTime * 0.0018));
      float low = fbm(base * 0.55 + vec2(uTime * 0.009, -uTime * 0.004));

      float sheet = smoothstep(0.52, 0.82, high) * uCloud * mask;
      float wisps = smoothstep(0.62, 0.9, low) * uCloud * mask * 0.55;

      // Clouds are lit from the sun's side; the shadowed side stays close to
      // the sky colour so they read as volume rather than as stickers.
      vec3 lit = mix(vec3(0.86), uSunColor, 0.4);
      vec3 shade = mix(sky, uHaze, 0.5);
      sky = mix(sky, mix(shade, lit, clamp(sun * 1.6 + 0.35, 0.0, 1.0)), sheet * 0.6);
      sky = mix(sky, lit, wisps * 0.2);
    }

    /*
     * Stars, on a night course only.
     *
     * Placed by hashing a quantised direction, so they are fixed in world space
     * and sweep past correctly as the camera turns — a star field that rotates
     * with the camera is worse than no star field. Faded out near the horizon,
     * where the haze would swallow them anyway.
     */
    if (uNight > 0.0 && up > 0.02) {
      vec2 cell = floor(dir.xz / max(up, 0.05) * 90.0);
      float star = hash(cell);
      float twinkle = 0.75 + 0.25 * sin(uTime * 2.0 + star * 40.0);
      float brightness = smoothstep(0.9972, 1.0, star) * twinkle * smoothstep(0.02, 0.3, up);
      sky += vec3(brightness) * uNight * 1.3;
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export interface SkyResult {
  mesh: THREE.Mesh;
  /** Advances the cloud drift. */
  update: (elapsed: number) => void;
  sunDirection: THREE.Vector3;
}

export function sunDirectionFor(theme: TrackTheme): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(theme.sunElevation) * Math.cos(theme.sunAzimuth),
    Math.sin(theme.sunElevation),
    Math.cos(theme.sunElevation) * Math.sin(theme.sunAzimuth),
  ).normalize();
}

export function buildSky(theme: TrackTheme, cloudiness: number): SkyResult {
  const sunDirection = sunDirectionFor(theme);
  const uniforms = {
    uTop: { value: new THREE.Color(theme.skyTop) },
    uHorizon: { value: new THREE.Color(theme.skyHorizon) },
    // The bottom of the gradient *is* the fog colour, so distant geometry
    // dissolves into a sky of the same value instead of standing out against it.
    uHaze: { value: new THREE.Color(theme.fogColor) },
    uSunColor: { value: new THREE.Color(theme.sunColor) },
    uSunDirection: { value: sunDirection },
    uCloud: { value: cloudiness },
    uTime: { value: 0 },
    uNight: { value: theme.night ? 1 : 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), material);
  mesh.name = 'sky';
  // Drawn first, never culled, and scaled to sit inside the far plane.
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.scale.setScalar(4000);

  return {
    mesh,
    sunDirection,
    update: (elapsed: number) => {
      uniforms.uTime.value += elapsed;
    },
  };
}

export interface LightingResult {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  /** Keeps the shadow frustum tight around the player. */
  follow: (x: number, y: number, z: number) => void;
}

export function buildLighting(theme: TrackTheme, shadowMapSize: number, shadowRadius: number): LightingResult {
  const group = new THREE.Group();
  group.name = 'lighting';

  /*
   * A hemisphere fill, and it does real work.
   *
   * Everything in this game is flat shaded, which means a face turned away from
   * the key receives exactly nothing and goes to pure black — and a course full
   * of black silhouettes is the difference between "stylised" and "unfinished".
   * The hemisphere gives the shadow side the sky's colour from above and the
   * ground's from below, which is both what actually happens and the cheapest
   * possible way to keep a tree looking like a tree from behind.
   */
  const hemisphere = new THREE.HemisphereLight(theme.ambientSky, theme.ambientGround, theme.ambientIntensity);
  group.add(hemisphere);

  const sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
  const direction = sunDirectionFor(theme);
  sun.position.copy(direction).multiplyScalar(180);
  sun.castShadow = shadowMapSize > 0;
  if (shadowMapSize > 0) {
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const camera = sun.shadow.camera;
    camera.left = -shadowRadius;
    camera.right = shadowRadius;
    camera.top = shadowRadius;
    camera.bottom = -shadowRadius;
    camera.near = 1;
    camera.far = 520;
    // A shadow map this size over this area has texels around 10 cm, so the
    // bias has to be generous enough to avoid acne on the near-flat road
    // without detaching contact shadows under the skiffs.
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.035;
  }
  group.add(sun);
  group.add(sun.target);

  const follow = (x: number, y: number, z: number): void => {
    sun.target.position.set(x, y, z);
    sun.position.set(x + direction.x * 180, y + direction.y * 180, z + direction.z * 180);
    sun.target.updateMatrixWorld();
  };

  return { group, sun, follow };
}
