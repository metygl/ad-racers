import * as THREE from 'three';
import { clamp01, damp, lerp } from '../../core/math';
import { COMBAT } from '../../game/config';
import type { RacerProfile } from '../../game/racers';
import type { RacerState } from '../../game/sim/state';

/**
 * A skiff: pilot on the spine, wrench in the outrigger pod.
 *
 * The silhouette is the point. At 45 m/s with six of these on screen the player
 * has to tell them apart in a glance, so each one is a long low hull, a swept
 * canopy, an offset pod on a visible spar, and a colour. The pod is on the
 * right of the hull, which is also the side the geometry reads from — you can
 * see who is about to swing at you.
 */

const HULL_LENGTH = 4.2;
const HULL_WIDTH = 1.7;
const POD_OFFSET = 1.85;

export interface VehicleVisual {
  group: THREE.Group;
  /** Applies one frame of simulation state. */
  update: (racer: RacerState, elapsed: number) => void;
  dispose: () => void;
}

function panel(color: number, roughness = 0.55, metalness = 0.35): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
}

export function buildVehicle(profile: RacerProfile, castShadow: boolean): VehicleVisual {
  const group = new THREE.Group();
  group.name = `skiff-${profile.id}`;

  const body = panel(profile.colors.body);
  const trim = panel(profile.colors.trim, 0.45, 0.5);
  const dark = panel(0x1b1f26, 0.7, 0.2);
  const glowMaterial = new THREE.MeshBasicMaterial({ color: profile.colors.glow });
  void HULL_WIDTH;

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [body, trim, dark, glowMaterial];
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    disposables.push(geometry);
    group.add(mesh);
    return mesh;
  };

  // --- hull ---------------------------------------------------------------
  // Low chassis plus a narrower raised deck. Two stacked masses read as a
  // designed machine from behind, where a single box reads as a plank.
  // Crew colour goes on the big mass, not the small one: from behind, at speed,
  // the chassis is most of what the player sees, and telling six skiffs apart
  // in a glance is the whole job of the paint.
  const hull = add(new THREE.BoxGeometry(HULL_LENGTH, 0.55, HULL_WIDTH), body, 0, 0.55, 0);
  hull.name = 'hull';
  add(new THREE.BoxGeometry(HULL_LENGTH * 0.8, 0.4, HULL_WIDTH * 0.74), dark, 0.1, 1.0, 0);

  // Swept nose: a four-sided cone reads as a wedge from every angle.
  const nose = add(new THREE.ConeGeometry(0.8, 1.8, 4), body, HULL_LENGTH / 2 + 0.5, 0.85, 0);
  nose.rotation.z = -Math.PI / 2;
  nose.rotation.y = Math.PI / 4;

  // Canopy, windscreen and pilot.
  add(new THREE.BoxGeometry(1.4, 0.36, 1.05), dark, -0.2, 1.34, 0);
  const screen = add(new THREE.BoxGeometry(0.14, 0.5, 0.95), trim, 0.55, 1.5, 0);
  screen.rotation.z = 0.42;
  const pilot = add(new THREE.CapsuleGeometry(0.28, 0.46, 3, 6), trim, -0.3, 1.76, 0);
  pilot.name = 'pilot';

  // Swept tail fin: the strongest silhouette cue from directly behind, which is
  // where the player sees five of these for the whole race.
  const fin = add(new THREE.BoxGeometry(1.1, 1.25, 0.16), body, -HULL_LENGTH / 2 + 0.35, 1.6, 0);
  fin.rotation.z = -0.35;
  fin.name = 'fin';
  const finEdge = add(new THREE.BoxGeometry(0.2, 1.25, 0.2), trim, -HULL_LENGTH / 2 + 0.72, 1.68, 0);
  finEdge.rotation.z = -0.35;

  // Nacelles in body colour with dark end caps, rather than bare black tubes.
  for (const side of [-1, 1]) {
    const nacelle = add(new THREE.CylinderGeometry(0.3, 0.34, 1.4, 8), body, -HULL_LENGTH / 2 + 0.35, 0.6, side * 0.66);
    nacelle.rotation.z = Math.PI / 2;
    const cap = add(new THREE.CylinderGeometry(0.31, 0.31, 0.18, 8), dark, -HULL_LENGTH / 2 - 0.36, 0.6, side * 0.66);
    cap.rotation.z = Math.PI / 2;
  }

  /*
   * Exhaust glow.
   *
   * A camera-facing additive disc, not a cone. A solid cone pointing down the
   * barrel of a chase camera is a bright spike across the middle of the screen
   * — which is exactly where the road is.
   */
  const thrustMaterial = new THREE.MeshBasicMaterial({
    map: null,
    color: profile.colors.glow,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  disposables.push(thrustMaterial);
  const thrust = new THREE.Group();
  thrust.name = 'thrust';
  for (const side of [-1, 1]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.19, 12), thrustMaterial);
    disc.position.set(-HULL_LENGTH / 2 - 0.46, 0.6, side * 0.66);
    disc.rotation.y = -Math.PI / 2;
    thrust.add(disc);
    disposables.push(disc.geometry);
  }
  group.add(thrust);

  // --- outrigger pod ------------------------------------------------------
  const spar = add(new THREE.BoxGeometry(0.28, 0.18, POD_OFFSET), dark, -0.3, 0.72, POD_OFFSET / 2);

  const pod = new THREE.Group();
  pod.position.set(-0.3, 0.62, POD_OFFSET);
  pod.name = 'pod';
  group.add(pod);

  const podShell = new THREE.Mesh(new THREE.CapsuleGeometry(0.46, 0.9, 4, 8), body);
  podShell.rotation.z = Math.PI / 2;
  podShell.castShadow = castShadow;
  pod.add(podShell);
  disposables.push(podShell.geometry);

  const wrench = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.42, 3, 6), trim);
  wrench.position.set(0, 0.62, 0);
  pod.add(wrench);
  disposables.push(wrench.geometry);

  // The grapple arm. Its rest pose is folded; a strike swings it out, and the
  // windup pulls it back first so the attack telegraphs.
  // At rest the grapple arm is folded back along the hull. Only a swing brings
  // it out, which is what makes an incoming strike readable from behind.
  const arm = new THREE.Group();
  arm.position.set(0, 0.5, 0);
  arm.rotation.y = -Math.PI * 0.62;
  pod.add(arm);

  const armGeometry = new THREE.BoxGeometry(0.14, 0.14, 1.5);
  const armMesh = new THREE.Mesh(armGeometry, trim);
  armMesh.position.set(0, 0, 0.85);
  arm.add(armMesh);
  disposables.push(armGeometry);

  const headGeometry = new THREE.IcosahedronGeometry(0.24, 0);
  const head = new THREE.Mesh(headGeometry, glowMaterial);
  head.position.set(0, 0, 1.55);
  arm.add(head);
  disposables.push(headGeometry);

  void spar;

  // --- animation state ----------------------------------------------------
  let lean = 0;
  let pitch = 0;
  let armAngle = 0;

  const update = (racer: RacerState, elapsed: number): void => {
    group.position.set(racer.pos.x, racer.y + 0.15, racer.pos.z);
    // Simulation headings are measured on the XZ plane with +X at zero, while
    // the model faces +X too, so the yaw is a straight negation into three.js's
    // left-handed-about-Y convention.
    group.rotation.y = -racer.heading;

    // Body roll from the slide, plus a little from the raw steering so the
    // skiff visibly commits to a corner before it starts sliding.
    const targetLean = clamp01(Math.abs(racer.slip) / 0.6) * Math.sign(racer.slip) * 0.38 + racer.steer * -0.1;
    lean = damp(lean, targetLean, 9, elapsed);
    group.rotation.z = lean;

    // Nose lift under power, dive under braking, exaggerated while airborne.
    const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
    const targetPitch = racer.airborne ? -0.12 : clamp01(speed / 45) * -0.045;
    pitch = damp(pitch, targetPitch, 6, elapsed);
    group.rotation.x = pitch;

    // Exhaust brightness and size track the throttle and the boost.
    const thrustScale = racer.boosting ? 1.75 : 0.7 + clamp01(speed / 50) * 0.55;
    thrust.scale.set(1, thrustScale, thrustScale);
    thrustMaterial.opacity = racer.boosting ? 0.95 : 0.18 + clamp01(speed / 45) * 0.3;
    thrust.visible = speed > 1.5 || racer.boosting;

    // Grapple arm: back during windup, snapped out during the active frames,
    // easing home through recovery.
    let target = 0;
    switch (racer.strike.phase) {
      case 'windup':
        target = -0.55 * (1 - racer.strike.timer / COMBAT.windup) - 0.15;
        break;
      case 'active':
        target = 1.55;
        break;
      case 'recovery':
        target = lerp(0, 1.2, clamp01(racer.strike.timer / COMBAT.recovery));
        break;
      case 'idle':
        target = 0;
        break;
    }
    // The pod is on the right of the hull; a left-side strike swings the whole
    // pod assembly across instead of reaching through the hull.
    const side = racer.strike.side;
    pod.rotation.y = damp(pod.rotation.y, racer.strike.phase === 'idle' ? 0 : side === -1 ? Math.PI : 0, 14, elapsed);
    armAngle = damp(armAngle, target, 22, elapsed);
    arm.rotation.x = armAngle * 0.35;
    arm.rotation.y = -Math.PI * 0.62 + armAngle;

    // Struck riders slump; it reads instantly even in a pack.
    const stagger = clamp01(racer.stagger / 0.55);
    pilot.rotation.z = stagger * 0.5;
    wrench.rotation.z = -stagger * 0.5;
  };

  const dispose = (): void => {
    for (const item of disposables) item.dispose();
  };

  return { group, update, dispose };
}
