import * as THREE from 'three';
import { clamp01, damp, lerp } from '../../core/math';
import { COMBAT } from '../../game/config';
import type { RacerProfile } from '../../game/racers';
import type { RacerState } from '../../game/sim/state';
import { mergeGeometries } from './mergeGeometry';
import type { MergePart } from './mergeGeometry';

/**
 * A skiff: pilot on the spine, wrench in the outrigger pod.
 *
 * The silhouette is the point. At 45 m/s with six of these on screen the player
 * has to tell them apart in a glance, so each one is a long low hull in the
 * crew colour, a swept fin, and an offset pod on a visible spar.
 *
 * Everything that does not move is merged by material, so a skiff costs three
 * draw calls rather than twenty. Six cars built the naive way came to a hundred
 * and twenty calls — more than the whole rest of the scene combined.
 */

const HULL_LENGTH = 4.2;
const HULL_WIDTH = 1.7;
const POD_OFFSET = 1.85;
const HALF_PI = Math.PI / 2;

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
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [body, trim, dark];

  /*
   * Crew colour goes on the big masses. From behind, at speed, the chassis and
   * the fin are most of what the player sees, and telling six skiffs apart in a
   * glance is the whole job of the paint.
   */
  const bodyParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(HULL_LENGTH, 0.55, HULL_WIDTH), position: [0, 0.55, 0] },
    // Swept nose: a four-sided cone reads as a wedge from every angle.
    {
      geometry: new THREE.ConeGeometry(0.8, 1.8, 4),
      position: [HULL_LENGTH / 2 + 0.5, 0.85, 0],
      rotation: [0, Math.PI / 4, -HALF_PI],
    },
    // Swept tail fin: the strongest silhouette cue from directly behind, which
    // is where the player sees five of these for the whole race.
    {
      geometry: new THREE.BoxGeometry(1.1, 1.25, 0.16),
      position: [-HULL_LENGTH / 2 + 0.35, 1.6, 0],
      rotation: [0, 0, -0.35],
    },
    ...[-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.CylinderGeometry(0.3, 0.34, 1.4, 8),
        position: [-HULL_LENGTH / 2 + 0.35, 0.6, side * 0.66],
        rotation: [0, 0, HALF_PI],
      }),
    ),
  ];

  const darkParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(HULL_LENGTH * 0.8, 0.4, HULL_WIDTH * 0.74), position: [0.1, 1.0, 0] },
    { geometry: new THREE.BoxGeometry(1.4, 0.36, 1.05), position: [-0.2, 1.34, 0] },
    { geometry: new THREE.BoxGeometry(0.28, 0.18, POD_OFFSET), position: [-0.3, 0.72, POD_OFFSET / 2] },
    ...[-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.CylinderGeometry(0.31, 0.31, 0.18, 8),
        position: [-HULL_LENGTH / 2 - 0.36, 0.6, side * 0.66],
        rotation: [0, 0, HALF_PI],
      }),
    ),
  ];

  const trimParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(0.14, 0.5, 0.95), position: [0.55, 1.5, 0], rotation: [0, 0, 0.42] },
    {
      geometry: new THREE.BoxGeometry(0.2, 1.25, 0.2),
      position: [-HULL_LENGTH / 2 + 0.72, 1.68, 0],
      rotation: [0, 0, -0.35],
    },
  ];

  for (const [parts, material] of [
    [bodyParts, body],
    [darkParts, dark],
    [trimParts, trim],
  ] as const) {
    const geometry = mergeGeometries(parts);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    group.add(mesh);
    disposables.push(geometry);
  }

  // --- animated parts ------------------------------------------------------
  // These move independently, so they stay separate: an incoming strike has to
  // be readable, and a rider slumping when struck is the clearest tell there is.
  const pilotGeometry = new THREE.CapsuleGeometry(0.28, 0.46, 3, 6);
  const pilot = new THREE.Mesh(pilotGeometry, trim);
  pilot.position.set(-0.3, 1.76, 0);
  pilot.castShadow = castShadow;
  group.add(pilot);
  disposables.push(pilotGeometry);

  /*
   * Exhaust glow: camera-facing additive discs, not a cone. A solid cone
   * pointing down the barrel of a chase camera is a bright spike across the
   * middle of the screen — which is exactly where the road is.
   */
  const thrustMaterial = new THREE.MeshBasicMaterial({
    color: profile.colors.glow,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  disposables.push(thrustMaterial);
  const thrustGeometry = mergeGeometries(
    [-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.CircleGeometry(0.19, 12),
        position: [-HULL_LENGTH / 2 - 0.46, 0.6, side * 0.66],
        rotation: [0, -HALF_PI, 0],
      }),
    ),
  );
  const thrust = new THREE.Mesh(thrustGeometry, thrustMaterial);
  thrust.name = 'thrust';
  group.add(thrust);
  disposables.push(thrustGeometry);

  // --- outrigger pod -------------------------------------------------------
  const pod = new THREE.Group();
  pod.position.set(-0.3, 0.62, POD_OFFSET);
  pod.name = 'pod';
  group.add(pod);

  const podGeometry = new THREE.CapsuleGeometry(0.46, 0.9, 4, 8);
  const podShell = new THREE.Mesh(podGeometry, body);
  podShell.rotation.z = HALF_PI;
  podShell.castShadow = castShadow;
  pod.add(podShell);
  disposables.push(podGeometry);

  const wrenchGeometry = new THREE.CapsuleGeometry(0.26, 0.42, 3, 6);
  const wrench = new THREE.Mesh(wrenchGeometry, trim);
  wrench.position.set(0, 0.62, 0);
  pod.add(wrench);
  disposables.push(wrenchGeometry);

  // At rest the grapple arm is folded back along the hull. Only a swing brings
  // it out, which is what makes an incoming strike readable from behind.
  const arm = new THREE.Group();
  arm.position.set(0, 0.5, 0);
  arm.rotation.y = -Math.PI * 0.62;
  pod.add(arm);

  const armGeometry = mergeGeometries([
    { geometry: new THREE.BoxGeometry(0.14, 0.14, 1.5), position: [0, 0, 0.85] },
    { geometry: new THREE.IcosahedronGeometry(0.24, 0), position: [0, 0, 1.55] },
  ]);
  const armMesh = new THREE.Mesh(armGeometry, trim);
  arm.add(armMesh);
  disposables.push(armGeometry);

  // --- animation state ----------------------------------------------------
  let lean = 0;
  let pitch = 0;
  let armAngle = 0;

  const update = (racer: RacerState, elapsed: number): void => {
    group.position.set(racer.pos.x, racer.y + 0.15, racer.pos.z);
    // Simulation headings are measured on the XZ plane with +X at zero, and the
    // model faces +X too, so the yaw is a straight negation into three.js's
    // convention.
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
    // The pod sits to one side of the hull; a strike to the other side swings
    // the whole pod assembly across rather than reaching through the chassis.
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
