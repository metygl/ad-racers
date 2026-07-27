import * as THREE from 'three';
import type { RacerProfile } from '../../game/racers';
import { disposeMaterial } from '../materials/ownership';
import { buildVehicle } from './VehicleModel';
import type { VehicleVisual } from './VehicleModel';

/**
 * The garage, and the finish shot that reuses it.
 *
 * The round-3 live review's judgement on crew selection was that it is "still a
 * selection form, not the requested premium showcase": a card grid of small
 * flat schematics, 4,503 px of it on a 320 px phone, with no vehicle, no
 * staging, no lighting and nothing that made choosing a machine feel like
 * choosing a machine. The same review found the results screen leading with the
 * same small symbol above a table.
 *
 * Both are the same missing thing - the machine, lit, at a size that means
 * something - so this is one stage used twice. It is built from
 * `buildVehicle`, the *production* race model, which is the point: a garage
 * that draws its own idea of a skiff can disagree with the one the player then
 * drives, and this one cannot.
 *
 * It is a scene of its own rather than a dressed-up race scene. A race scene
 * carries a course's fog, sky, grade and key direction, and a hero shot needs
 * none of those - a night course would hand the garage a black room. Its own
 * scene is about a dozen objects and three lights, which is far cheaper than
 * the attract race it replaces on those screens.
 */

/** How the stage is lit and posed. */
export type HeroMood = 'garage' | 'result';

export interface HeroStageResult {
  scene: THREE.Scene;
  /** Advances the turntable. Reduced motion passes 0 and it holds still. */
  update: (elapsed: number) => void;
  /**
   * Positions and aims the camera for this frame.
   *
   * `fill` is how much of the viewport's *height* the machine should span. The
   * caller owns it because it depends on the room the menu panel has left, and
   * that is a layout question rather than a staging one.
   */
  frame: (camera: THREE.PerspectiveCamera, fill: number) => void;
  dispose: () => void;
}

/** Height the camera looks from, as a multiple of the machine's own height. */
const EYE_HEIGHT = 0.78;
/** Seconds for one full turn of the stage. */
const TURN_SECONDS = 34;
/** Where the camera starts, so a still frame is already a three-quarter view. */
const START_ANGLE = 0.72;

/**
 * Bounds of the parts that are actually drawn.
 *
 * `Box3.setFromObject` ignores `visible` and expands over every geometry in the
 * subtree, so a skiff measures fourteen metres long - the tow tether's cone is
 * twelve of them - and framing to that puts the machine in the middle distance.
 * The shot has to be framed to the machine, so this measures what is on screen.
 */
function visibleBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  root.updateWorldMatrix(false, true);
  const walk = (object: THREE.Object3D): void => {
    if (!object.visible) return;
    const geometry = (object as THREE.Mesh).geometry;
    if (geometry) {
      geometry.computeBoundingBox();
      if (geometry.boundingBox) box.union(part.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld));
    }
    for (const child of object.children) walk(child);
  };
  walk(root);
  return box;
}

function padTexture(color: THREE.Color): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable; cannot build the garage floor');

  // A pool of light under the machine and nothing beyond it, so the floor reads
  // as a lit stage rather than as a disc floating in the dark.
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  const hex = `#${color.getHexString()}`;
  gradient.addColorStop(0, hex);
  gradient.addColorStop(0.55, `${hex}b0`);
  gradient.addColorStop(1, '#00000000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Workshop floor markings: the bay the skiff is standing in.
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, (i / 6) * (size / 2), 0, Math.PI * 2);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'hero-pad';
  return texture;
}

export function buildHeroStage(profile: RacerProfile, mood: HeroMood): HeroStageResult {
  const scene = new THREE.Scene();
  scene.name = `hero-${mood}`;
  /*
   * A room tone, not a void.
   *
   * Without a background the stage is cut out against pure black, and on a
   * phone - where the machine sits in a band above the panel - the seam between
   * the lit floor and nothing is a hard horizontal line across the screen. The
   * backdrop and the floor then have something to sit in front of.
   */
  scene.background = new THREE.Color(mood === 'result' ? 0x0d1520 : 0x0a1018);

  const trim = new THREE.Color(profile.colors.trim);
  const glow = new THREE.Color(profile.colors.glow);

  /*
   * The machine, from the race model.
   *
   * It never casts here: the stage's own key comes from above and in front, and
   * a cast shadow at this distance buys a shadow map for one object. The floor
   * pool does the grounding instead, which is what a photographer would do.
   */
  const visual: VehicleVisual = buildVehicle(profile, false);
  // Nose towards the camera's starting quarter rather than square on, so the
  // silhouette reads as a shape rather than as a front elevation.
  visual.group.rotation.y = -0.42;
  scene.add(visual.group);

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  // --- the floor ------------------------------------------------------------
  // Wider than the backdrop, so the ground always reaches the wall and there is
  // never a band of background between the two.
  const padGeometry = new THREE.CircleGeometry(16, 48);
  const pad = padTexture(new THREE.Color(mood === 'result' ? 0x53687d : 0x44566a));
  const padMaterial = new THREE.MeshBasicMaterial({ map: pad, transparent: true, depthWrite: false });
  const floor = new THREE.Mesh(padGeometry, padMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  scene.add(floor);
  disposables.push(padGeometry, padMaterial, pad);

  /*
   * A backdrop, angled.
   *
   * Without one the skiff is cut out against nothing and every dark part of it
   * disappears - which is precisely the failure the review reported on the
   * night course. Two panels behind and to the sides give the hull something to
   * separate against from every angle the turntable reaches.
   */
  const wallGeometry = new THREE.CylinderGeometry(15, 15, 13, 32, 1, true);
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: mood === 'result' ? 0x33445a : 0x2a3747,
    roughness: 0.95,
    metalness: 0.05,
    side: THREE.BackSide,
  });
  const wall = new THREE.Mesh(wallGeometry, wallMaterial);
  wall.position.y = 6.4;
  scene.add(wall);
  disposables.push(wallGeometry, wallMaterial);

  /*
   * --- the lights ----------------------------------------------------------
   *
   * A studio with no environment map has to earn every bit of its light from
   * lamps. The hull is `metalness: 0.35`, which scales the diffuse response
   * down by that much and puts the rest into a specular term that has nothing
   * to reflect - so the race scene's intensities, which sit under a sun and a
   * whole sky, render a black machine here. These are deliberately much
   * stronger, and there are four of them because a hero shot is lit from four
   * directions or it is a snapshot.
   */
  // Fill first, so nothing on the machine is ever pure black; the art bible
  // puts racers in the top value band and a hero shot cannot be the exception.
  scene.add(new THREE.HemisphereLight(0x8ea8cc, 0x1d232c, mood === 'result' ? 3.4 : 2.9));

  // Key: high, in front, and warm - the one light that models the hull.
  const key = new THREE.DirectionalLight(0xfff2dd, mood === 'result' ? 6.5 : 5.4);
  key.position.set(6.5, 9.5, 5.5);
  scene.add(key);

  // Kicker from the opposite front quarter, so the far side of the hull is
  // modelled rather than merely lit less.
  const kicker = new THREE.DirectionalLight(0xcfe0ff, 2.2);
  kicker.position.set(-7, 5, 6);
  scene.add(kicker);

  // Rim in the crew's own trim colour, from behind: this is what draws the
  // silhouette, and taking it from the crew is what makes six stages six
  // stages rather than one stage with six paint jobs.
  const rim = new THREE.PointLight(trim.getHex(), 90, 22, 1.5);
  rim.position.set(-5.6, 3.4, -4.4);
  scene.add(rim);

  // And a low bounce in the glow colour, so the underside and the skirts are
  // not a void where the machine meets the floor.
  const bounce = new THREE.PointLight(glow.getHex(), mood === 'result' ? 46 : 30, 15, 1.8);
  bounce.position.set(2.2, 0.5, 3.2);
  scene.add(bounce);

  /*
   * The shot is framed from the machine, not from a constant.
   *
   * The six crews differ in nose length, shoulder width and fin height by
   * enough to matter, and a fixed orbit radius that suits one of them crops
   * another. Measuring the built model means the composition holds for every
   * crew and survives anyone changing the geometry later.
   */
  const bounds = visibleBounds(visual.group);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const reach = Math.max(size.x, size.z, size.y * 1.6);

  let angle = START_ANGLE;

  return {
    scene,
    update: (elapsed: number) => {
      angle += (elapsed / TURN_SECONDS) * Math.PI * 2;
    },
    frame: (camera: THREE.PerspectiveCamera, fill: number) => {
      // Distance that puts `reach` across `fill` of the vertical field.
      const radius = reach / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(0.05, fill));
      camera.position.set(
        centre.x + Math.cos(angle) * radius,
        centre.y + size.y * EYE_HEIGHT,
        centre.z + Math.sin(angle) * radius,
      );
      // Aimed a little above the machine's own centre, so it sits in the lower
      // half of its frame the way a product shot does.
      camera.lookAt(centre.x, centre.y + size.y * 0.12, centre.z);
    },
    dispose: () => {
      visual.dispose();
      for (const item of disposables) {
        if (item instanceof THREE.Material) disposeMaterial(item);
        else item.dispose();
      }
      scene.clear();
    },
  };
}
