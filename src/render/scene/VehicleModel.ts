import * as THREE from 'three';
import { clamp01, damp, lerp } from '../../core/math';
import { COMBAT, DRIFT, TOW } from '../../game/config';
import type { RacerProfile } from '../../game/racers';
import type { RacerState } from '../../game/sim/state';
import { particleTexture } from '../textures/procedural';
import { mergeGeometries } from './mergeGeometry';
import type { MergePart } from './mergeGeometry';

/**
 * A skiff: pilot on the spine, wrench in the outrigger pod.
 *
 * The silhouette is the point. At 48 m/s with six of these on screen the player
 * has to tell them apart in a glance, so each one is a long low hull in the
 * crew colour, a swept fin, and an offset pod on a visible spar — and the fin
 * profile differs per crew, so the identification survives fog, distance and
 * colour blindness alike.
 *
 * Everything that does not move is merged by material, so a skiff costs four
 * draw calls rather than twenty. Six cars built the naive way came to a hundred
 * and twenty calls — more than the whole rest of the scene combined.
 *
 * ## The rotation order, which is not incidental
 *
 * The model's local axes are +X forward, +Y up, +Z right. That makes roll a
 * rotation about local **X**, pitch a rotation about local **Z**, and yaw about
 * local Y. Three.js's default `XYZ` Euler order composes as `Rx·Ry·Rz`, which
 * applies `rotation.z` *first*, in the body frame — so under the default order
 * `rotation.z` is a pitch and `rotation.x` becomes a rotation about the world X
 * axis whose meaning changes with heading.
 *
 * An earlier version set `rotation.z = lean` and `rotation.x = pitch` under the
 * default order, which meant the body pitched when it should have banked and
 * rolled by an amount that depended on which way the course happened to be
 * pointing. `YXZ` composes as `Ry·Rx·Rz` — yaw, then roll about the body's own
 * forward axis, then pitch about its own lateral axis — which is the standard
 * decomposition and the only one where these three numbers mean what they are
 * named.
 */

const HULL_LENGTH = 4.2;
const HULL_WIDTH = 1.7;
const POD_OFFSET = 1.85;
const HALF_PI = Math.PI / 2;

/** How much of the crew's fin character is expressed as height vs. sweep. */
interface FinProfile {
  height: number;
  sweep: number;
  /** Number of fin blades: one, or a split pair. */
  blades: 1 | 2;
  /** Nose length multiplier — long needle through to blunt. */
  nose: number;
  /** Shoulder width multiplier. */
  shoulder: number;
}

/**
 * Per-crew silhouette. Colour is never the only cue, so each crew's proportions
 * differ enough to be read as a black shape at 64 px — the art bible's
 * silhouette test.
 */
const FIN_PROFILES: Record<string, FinProfile> = {
  thornline: { height: 1.55, sweep: 0.42, blades: 1, nose: 1.0, shoulder: 0.86 },
  foundry: { height: 0.85, sweep: 0.12, blades: 1, nose: 0.62, shoulder: 1.28 },
  nightgrove: { height: 1.2, sweep: 0.5, blades: 2, nose: 1.05, shoulder: 0.94 },
  emberworks: { height: 0.95, sweep: 0.62, blades: 1, nose: 1.5, shoulder: 0.8 },
  boneyard: { height: 1.35, sweep: 0.0, blades: 2, nose: 0.78, shoulder: 1.16 },
  greenline: { height: 0.7, sweep: 0.3, blades: 1, nose: 0.72, shoulder: 0.78 },
};

const DEFAULT_FIN: FinProfile = { height: 1.2, sweep: 0.35, blades: 1, nose: 1, shoulder: 1 };

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
  const fin = FIN_PROFILES[profile.id] ?? DEFAULT_FIN;

  const group = new THREE.Group();
  group.name = `skiff-${profile.id}`;
  // See the note at the top of this file. This one line is the difference
  // between a body that banks into a corner and a body that noses up in one.
  group.rotation.order = 'YXZ';

  /*
   * The hull hangs off a *chassis* group, and the chassis is what carries roll,
   * pitch and suspension travel. Applying them to the outer group instead would
   * move the thrusters and the pod arm with the body, which is wrong twice: a
   * hover skiff's jets stay level with the ground, and a pod arm that dips
   * when the body dips changes its reach mid-swing.
   */
  const chassis = new THREE.Group();
  chassis.rotation.order = 'YXZ';
  group.add(chassis);

  const body = panel(profile.colors.body);
  const trim = panel(profile.colors.trim, 0.45, 0.5);
  const dark = panel(0x1b1f26, 0.7, 0.2);
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [body, trim, dark];

  const noseLength = 1.8 * fin.nose;
  const halfWidth = (HULL_WIDTH / 2) * fin.shoulder;

  /*
   * Crew colour goes on the big masses. From behind, at speed, the chassis and
   * the fin are most of what the player sees, and telling six skiffs apart in a
   * glance is the whole job of the paint.
   */
  const bodyParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(HULL_LENGTH, 0.55, halfWidth * 2), position: [0, 0.55, 0] },
    // A tapered mid-section, so the hull is not a slab from the side.
    { geometry: new THREE.BoxGeometry(HULL_LENGTH * 0.62, 0.3, halfWidth * 2.24), position: [-0.2, 0.42, 0] },
    // Swept nose: a four-sided cone reads as a wedge from every angle.
    {
      geometry: new THREE.ConeGeometry(0.8 * fin.shoulder, noseLength, 4),
      position: [HULL_LENGTH / 2 + noseLength * 0.28, 0.85, 0],
      rotation: [0, Math.PI / 4, -HALF_PI],
    },
    // Swept tail fin (or a split pair): the strongest silhouette cue from
    // directly behind, which is where the player sees five of these all race.
    ...Array.from({ length: fin.blades }, (_, i): MergePart => {
      const side = fin.blades === 1 ? 0 : (i === 0 ? -1 : 1) * halfWidth * 0.62;
      return {
        geometry: new THREE.BoxGeometry(1.1, fin.height, 0.16),
        position: [-HULL_LENGTH / 2 + 0.35, 0.95 + fin.height / 2, side],
        rotation: [0, 0, -fin.sweep],
      };
    }),
    ...[-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.CylinderGeometry(0.3, 0.34, 1.4, 8),
        position: [-HULL_LENGTH / 2 + 0.35, 0.6, side * halfWidth * 0.78],
        rotation: [0, 0, HALF_PI],
      }),
    ),
  ];

  const darkParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(HULL_LENGTH * 0.8, 0.4, halfWidth * 1.48), position: [0.1, 1.0, 0] },
    { geometry: new THREE.BoxGeometry(1.4, 0.36, 1.05), position: [-0.2, 1.34, 0] },
    { geometry: new THREE.BoxGeometry(0.28, 0.18, POD_OFFSET), position: [-0.3, 0.72, POD_OFFSET / 2] },
    // Intake slots along the flanks, which catch the key light and stop the
    // hull reading as one untextured block.
    ...[-1, 1].flatMap((side) =>
      [0.8, 0.1, -0.6].map(
        (along): MergePart => ({
          geometry: new THREE.BoxGeometry(0.5, 0.14, 0.12),
          position: [along, 0.72, side * (halfWidth + 0.02)],
        }),
      ),
    ),
    ...[-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.CylinderGeometry(0.31, 0.31, 0.18, 8),
        position: [-HULL_LENGTH / 2 - 0.36, 0.6, side * halfWidth * 0.78],
        rotation: [0, 0, HALF_PI],
      }),
    ),
  ];

  const trimParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(0.14, 0.5, 0.95), position: [0.55, 1.5, 0], rotation: [0, 0, 0.42] },
    {
      geometry: new THREE.BoxGeometry(0.2, fin.height, 0.2),
      position: [-HULL_LENGTH / 2 + 0.72, 0.95 + fin.height / 2, 0],
      rotation: [0, 0, -fin.sweep],
    },
    // A stripe along each flank, in the trim colour: reads as a racing number
    // board at distance and gives the crew a second colour cue.
    ...[-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.BoxGeometry(1.6, 0.24, 0.06),
        position: [0.35, 0.55, side * (halfWidth + 0.03)],
      }),
    ),
  ];

  for (const [parts, material] of [
    [bodyParts, body],
    [darkParts, dark],
    [trimParts, trim],
  ] as const) {
    const geometry = mergeGeometries(parts);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    chassis.add(mesh);
    disposables.push(geometry);
  }

  // --- animated parts ------------------------------------------------------
  // These move independently, so they stay separate: an incoming strike has to
  // be readable, and a rider slumping when struck is the clearest tell there is.
  const pilotGeometry = new THREE.CapsuleGeometry(0.28, 0.46, 3, 6);
  const pilot = new THREE.Mesh(pilotGeometry, trim);
  pilot.position.set(-0.3, 1.76, 0);
  pilot.castShadow = castShadow;
  chassis.add(pilot);
  disposables.push(pilotGeometry);

  /*
   * Exhaust glow: camera-facing additive discs, not a cone. A solid cone
   * pointing down the barrel of a chase camera is a bright spike across the
   * middle of the screen — which is exactly where the road is.
   */
  /*
   * Every additive element on the skiff uses the same soft radial falloff
   * texture, and that is not decoration.
   *
   * A flat additive disc has a hard edge and a uniform interior, so several of
   * them overlapping — thruster, hover cushion, drift sparks, all on one car —
   * sum to a saturated white blob with a visible outline, and the bloom then
   * makes a lantern of it. This was exactly the failure mode of the first pass
   * at this rig: six skiffs became six featureless lights. A falloff sprite
   * sums to something with a centre and an edge however many of them stack.
   */
  const glowSprite = particleTexture();
  const thrustMaterial = new THREE.MeshBasicMaterial({
    color: profile.colors.glow,
    map: glowSprite,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  disposables.push(thrustMaterial);
  const thrustGeometry = mergeGeometries(
    [-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.PlaneGeometry(0.62, 0.62),
        position: [-HULL_LENGTH / 2 - 0.46, 0.6, side * halfWidth * 0.78],
        rotation: [0, -HALF_PI, 0],
      }),
    ),
  );
  const thrust = new THREE.Mesh(thrustGeometry, thrustMaterial);
  thrust.name = 'thrust';
  group.add(thrust);
  disposables.push(thrustGeometry);

  /*
   * The hover cushion: a flat additive disc under the hull, brightest when the
   * skiff is loaded up. It is the cheapest possible contact shadow's opposite —
   * it says "this thing is held off the ground by something", which a wheeled
   * car does not need to say and a hover skiff very much does.
   */
  const cushionMaterial = new THREE.MeshBasicMaterial({
    color: profile.colors.glow,
    map: glowSprite,
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const cushionGeometry = new THREE.PlaneGeometry(4.4, 4.4);
  const cushion = new THREE.Mesh(cushionGeometry, cushionMaterial);
  cushion.rotation.x = -HALF_PI;
  cushion.position.y = 0.06;
  cushion.renderOrder = 1;
  group.add(cushion);
  disposables.push(cushionGeometry, cushionMaterial);

  /*
   * The tow cone: a translucent wedge behind the skiff that brightens as the
   * wake snap charges. This is the anticipation beat for the tow mechanic —
   * without a visible tell the snap fires out of nowhere and reads as a bug.
   */
  const wakeMaterial = new THREE.MeshBasicMaterial({
    color: 0xbfe9ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const wakeGeometry = new THREE.ConeGeometry(2.2, 12, 10, 1, true);
  const wake = new THREE.Mesh(wakeGeometry, wakeMaterial);
  wake.rotation.z = HALF_PI;
  wake.position.set(-7, 0.7, 0);
  wake.renderOrder = 1;
  group.add(wake);
  disposables.push(wakeGeometry, wakeMaterial);

  // --- outrigger pod -------------------------------------------------------
  const pod = new THREE.Group();
  pod.position.set(-0.3, 0.62, POD_OFFSET);
  pod.name = 'pod';
  chassis.add(pod);

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

  /*
   * Drift charge, shown on the skiff itself rather than only on the HUD.
   *
   * A player mid-corner is looking at the road and the car, not at a gauge in
   * the corner, so the tier ladder has to be legible *on the machine*. Two
   * additive sparks either side of the tail step through the tier colours as
   * the charge banks, which is the anticipation beat the payoff needs.
   */
  const sparkMaterial = new THREE.MeshBasicMaterial({
    color: 0x9fd8ff,
    map: glowSprite,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const sparkGeometry = mergeGeometries(
    [-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.PlaneGeometry(1.1, 1.1),
        position: [-HULL_LENGTH / 2 - 0.1, 0.4, side * (halfWidth + 0.12)],
        rotation: [-HALF_PI, 0, 0],
      }),
    ),
  );
  const sparks = new THREE.Mesh(sparkGeometry, sparkMaterial);
  sparks.renderOrder = 2;
  group.add(sparks);
  disposables.push(sparkGeometry, sparkMaterial);

  // --- animation state ----------------------------------------------------
  let roll = 0;
  let pitch = 0;
  let armAngle = 0;
  let hover = 0;
  let hoverVelocity = 0;
  let damage = 0;
  let phase = profile.id.length * 0.7;

  const TIER_COLORS = [0x9fd8ff, 0xffc46b, 0xff7ad9];
  const tierColor = new THREE.Color();

  const update = (racer: RacerState, elapsed: number): void => {
    const dt = Math.min(0.1, elapsed);
    phase += dt;
    group.position.set(racer.pos.x, racer.y + 0.15, racer.pos.z);
    // Simulation headings are measured on the XZ plane with +X at zero, and the
    // model faces +X too, so the yaw is a straight negation into three.js's
    // convention. See the handedness rule in `src/core/math.ts`.
    group.rotation.y = -racer.heading;

    const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
    const speedFactor = clamp01(speed / 50);

    /*
     * Suspension, as a spring rather than a damped follow.
     *
     * A skiff that simply eases towards its target height has no *character*:
     * it never overshoots, so a landing has no compression and a crest has no
     * float. A second-order spring gives both for free, and the overshoot is
     * the single clearest read the player gets on how hard they just landed.
     */
    const load = racer.airborne ? -0.34 : clamp01(Math.abs(racer.slip) / 0.5) * 0.1 - speedFactor * 0.04;
    const stiffness = 90;
    const damping = 13;
    hoverVelocity += (load - hover) * stiffness * dt - hoverVelocity * damping * dt;
    hover += hoverVelocity * dt;
    hover = Math.max(-0.45, Math.min(0.45, hover));
    chassis.position.y = hover;

    /*
     * Roll reads lateral load; pitch reads acceleration. Both are telemetry,
     * per the art bible, so both are exaggerated well past physical and both
     * are damped enough to be readable rather than twitchy.
     *
     * The skiff banks *into* the corner, like an aircraft rather than a car
     * leaning onto its outside springs. That is a deliberate stylisation: on a
     * hovercraft the outward lean reads as a mistake, and the inward bank makes
     * the direction of a slide legible from directly behind — which is the one
     * angle the player almost always has.
     */
    const slideRoll = clamp01(Math.abs(racer.slip) / 0.55) * Math.sign(racer.slip) * 0.34;
    const steerRoll = racer.steer * 0.16;
    roll = damp(roll, slideRoll + steerRoll, 9, dt);
    chassis.rotation.x = roll;

    const targetPitch = racer.airborne
      ? 0.16
      : clamp01(hoverVelocity * -0.5) * 0.1 - clamp01(speedFactor) * 0.05 + (racer.boosting ? -0.05 : 0);
    pitch = damp(pitch, targetPitch, 8, dt);
    chassis.rotation.z = pitch;

    // Exhaust brightness and size track the throttle and the boost.
    const thrustScale = racer.boosting ? 1.9 : 0.7 + speedFactor * 0.6;
    // A little flicker, so the flame is alive rather than a decal.
    const flicker = 1 + Math.sin(phase * 37) * 0.06;
    thrust.scale.set(1, thrustScale * flicker, thrustScale * flicker);
    thrustMaterial.opacity = racer.boosting ? 0.85 : 0.16 + speedFactor * 0.26;
    thrust.visible = speed > 1.5 || racer.boosting;
    thrust.position.y = hover;

    // The hover cushion brightens under load and while boosting, and fades out
    // entirely in the air — where, self-evidently, there is nothing to hover on.
    cushionMaterial.opacity = racer.airborne ? 0 : 0.09 + speedFactor * 0.06 + (racer.boosting ? 0.14 : 0);
    cushion.scale.setScalar(1 + Math.sin(phase * 9) * 0.03 + (racer.boosting ? 0.25 : 0));

    // The tow cone: invisible until there is charge worth spending.
    const towReady = clamp01((racer.towCharge - TOW.minCharge) / Math.max(0.01, 1 - TOW.minCharge));
    wakeMaterial.opacity = towReady * 0.13 * (racer.slipstreaming ? 1 : 0.45);
    wake.visible = wakeMaterial.opacity > 0.005;
    wake.scale.set(1, 0.7 + towReady * 0.5, 1);

    // Drift charge ladder, on the machine.
    const tier = racer.drift.active
      ? DRIFT.tiers.reduce((best, threshold, index) => (racer.drift.charge >= threshold ? index : best), -1)
      : -1;
    if (tier >= 0) {
      tierColor.setHex(TIER_COLORS[Math.min(tier, TIER_COLORS.length - 1)] ?? 0xffffff);
      sparkMaterial.color.copy(tierColor);
      // Pulse faster at higher tiers: the rhythm alone tells the player which
      // tier they are on without reading a colour.
      sparkMaterial.opacity = 0.34 + Math.sin(phase * (18 + tier * 10)) * 0.18;
      sparks.visible = true;
    } else if (racer.drift.active) {
      // Charging, but not yet worth anything: a dim ember, so the player can see
      // the drift is registering.
      sparkMaterial.color.setHex(0x6fa8cc);
      sparkMaterial.opacity = 0.08 + racer.drift.charge * 0.28;
      sparks.visible = true;
    } else {
      sparks.visible = false;
    }

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
    pod.rotation.y = damp(pod.rotation.y, racer.strike.phase === 'idle' ? 0 : side === -1 ? Math.PI : 0, 14, dt);
    armAngle = damp(armAngle, target, 22, dt);
    arm.rotation.x = armAngle * 0.35;
    arm.rotation.y = -Math.PI * 0.62 + armAngle;

    /*
     * Impact reaction. A struck skiff slumps its riders and shudders for a
     * moment — the shudder decays on its own, so the tell is unmistakable at
     * the instant of the hit and completely gone a second later rather than
     * lingering as a permanent wobble.
     */
    damage = Math.max(damage - dt * 2.2, clamp01(racer.stagger / COMBAT.staggerTime));
    const stagger = clamp01(racer.stagger / COMBAT.staggerTime);
    pilot.rotation.z = stagger * 0.5 + Math.sin(phase * 44) * damage * 0.08;
    wrench.rotation.z = -stagger * 0.5;
    chassis.rotation.y = Math.sin(phase * 31) * damage * 0.05;
  };

  const dispose = (): void => {
    for (const item of disposables) item.dispose();
  };

  return { group, update, dispose };
}
