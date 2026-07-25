import * as THREE from 'three';
import type { TrackTheme } from '../../game/track/types';

/**
 * Sky and lighting.
 *
 * The dome is a single inverted sphere with a small custom shader: a vertical
 * gradient, a sun disc with a soft bloom around it, and a band of procedural
 * cloud. No texture, no cubemap, no download — and because it is a shader
 * rather than a gradient texture, the horizon stays smooth at any resolution
 * instead of banding.
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
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uCloud;
  uniform float uTime;

  varying vec3 vDirection;

  // Cheap hash-based value noise; two octaves is plenty for a cloud band.
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

  void main() {
    vec3 dir = normalize(vDirection);

    // Bias the gradient towards the horizon so most of the visible sky while
    // racing is the interesting part.
    vec3 sky = mix(uHorizon, uTop, pow(clamp(dir.y, 0.0, 1.0), 0.38));

    float sun = max(dot(dir, normalize(uSunDirection)), 0.0);
    sky += uSunColor * pow(sun, 620.0) * 1.6;
    sky += uSunColor * pow(sun, 8.0) * 0.22;

    // Cloud band, only above the horizon, drifting slowly.
    if (dir.y > 0.02) {
      vec2 uv = dir.xz / max(dir.y, 0.08) * 0.35 + vec2(uTime * 0.004, uTime * 0.002);
      float n = noise(uv) * 0.6 + noise(uv * 2.7) * 0.3 + noise(uv * 6.1) * 0.1;
      float cloud = smoothstep(0.52, 0.78, n) * uCloud * smoothstep(0.02, 0.28, dir.y);
      sky = mix(sky, mix(vec3(1.0), uSunColor, 0.35), cloud * 0.55);
    }

    gl_FragColor = vec4(sky, 1.0);
    #include <colorspace_fragment>
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
    uSunColor: { value: new THREE.Color(theme.sunColor) },
    uSunDirection: { value: sunDirection },
    uCloud: { value: cloudiness },
    uTime: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
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
