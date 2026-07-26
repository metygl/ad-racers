import * as THREE from 'three';
import { clamp01 } from '../../core/math';
import { COMBAT, DRIFT, TOW } from '../../game/config';
import type { RacerProfile } from '../../game/racers';
import type { RacerState } from '../../game/sim/state';
import { SURFACES } from '../../game/track/types';
import { particleTexture } from '../textures/procedural';
import { SkiffRig } from './skiffRig';
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

/**
 * The mechanical character of one crew's skiff.
 *
 * Not a colour scheme with a different fin. Each crew built their machine out
 * of different salvage for a different job, and the proportions say which:
 * where the hover pods sit, how the hull is braced, how tall the roll hoop is,
 * how the pod arm is counterweighted. The art review's silhouette test is the
 * bar — identifiable as a black shape at 64 px — and shape is the only thing
 * that survives fog, distance and colour blindness together.
 */
interface CrewBuild {
  /** Tail fin height, in metres. */
  height: number;
  /** How far the fin rakes back, in radians. */
  sweep: number;
  /** One blade, or a split pair. */
  blades: 1 | 2;
  /** Nose length multiplier — long needle through to blunt. */
  nose: number;
  /** Shoulder width multiplier. */
  shoulder: number;
  /**
   * Where the hover struts sit along the hull, -1 at the tail to +1 at the
   * nose. Three is the usual arrangement; a heavy crew runs four.
   */
  struts: readonly number[];
  /** Height of the roll hoop over the pilot. 0 means none. */
  hoop: number;
  /** Radius of the pod arm's counterweight. Heavier crews swing heavier. */
  counterweight: number;
  /** Number of exposed truss bays in the outrigger spar. */
  trussBays: number;
}

/**
 * Per-crew silhouette. Colour is never the only cue, so each crew's proportions
 * differ enough to be read as a black shape at 64 px — the art bible's
 * silhouette test.
 */
const CREW_BUILDS: Record<string, CrewBuild> = {
  // Hero build. Narrow, tall-finned and long-nosed: a machine built to be
  // thrown at an apex in a service tunnel, with the struts pulled inboard so
  // nothing catches on a wall.
  thornline: {
    height: 1.55, sweep: 0.42, blades: 1, nose: 1.05, shoulder: 0.84,
    struts: [0.72, -0.35, -0.82], hoop: 0.78, counterweight: 0.26, trussBays: 3,
  },
  foundry: {
    height: 0.85, sweep: 0.12, blades: 1, nose: 0.62, shoulder: 1.3,
    struts: [0.7, 0.05, -0.5, -0.88], hoop: 0.5, counterweight: 0.38, trussBays: 4,
  },
  nightgrove: {
    height: 1.2, sweep: 0.5, blades: 2, nose: 1.05, shoulder: 0.94,
    struts: [0.68, -0.3, -0.85], hoop: 0.62, counterweight: 0.3, trussBays: 3,
  },
  emberworks: {
    height: 0.95, sweep: 0.62, blades: 1, nose: 1.55, shoulder: 0.78,
    struts: [0.82, -0.45, -0.9], hoop: 0.34, counterweight: 0.22, trussBays: 2,
  },
  boneyard: {
    height: 1.35, sweep: 0.0, blades: 2, nose: 0.76, shoulder: 1.18,
    struts: [0.66, 0.0, -0.55, -0.9], hoop: 0.94, counterweight: 0.36, trussBays: 4,
  },
  greenline: {
    height: 0.7, sweep: 0.3, blades: 1, nose: 0.7, shoulder: 0.76,
    struts: [0.74, -0.4, -0.86], hoop: 0.44, counterweight: 0.2, trussBays: 2,
  },
};

const DEFAULT_BUILD: CrewBuild = {
  height: 1.2, sweep: 0.35, blades: 1, nose: 1, shoulder: 1,
  struts: [0.7, -0.35, -0.85], hoop: 0.6, counterweight: 0.28, trussBays: 3,
};

export interface VehicleVisual {
  group: THREE.Group;
  /** Applies one frame of simulation state. */
  update: (racer: RacerState, elapsed: number) => void;
  /** A one-off physical knock, from a collision or a landed strike. */
  knock: (strength: number) => void;
  /**
   * Tells the rig whether the swing in progress connected.
   *
   * The recovery pose is the *only* visual difference between a hit and a miss,
   * and a review found the active and recovery frames "nearly
   * indistinguishable" — so combat read as random even where it was
   * deterministic.
   */
  setSwingLanded: (landed: boolean) => void;
  dispose: () => void;
}

function panel(color: number, roughness = 0.55, metalness = 0.35): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
}

export function buildVehicle(profile: RacerProfile, castShadow: boolean): VehicleVisual {
  const fin = CREW_BUILDS[profile.id] ?? DEFAULT_BUILD;

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
  /*
   * A faint self-illumination on the trim, on every course.
   *
   * The art bible puts racers in the top value band *everywhere*, and on a night
   * course a purely lit skiff is a silhouette however well the scene is exposed
   * — six identical black shapes, which is the one thing the crew colours exist
   * to prevent. The emissive is small enough to be invisible in daylight and
   * decisive after dark, and it is on the trim rather than the body so it reads
   * as running lights rather than as a glowing car.
   */
  trim.emissive = new THREE.Color(profile.colors.glow);
  trim.emissiveIntensity = 0.55;
  /*
   * The body carries a little of it too.
   *
   * Running lights on the trim alone leave the *hull* — which is most of the
   * silhouette and all of the crew colour — as a black shape after dark. A
   * skiff has to be identifiable as its crew at race distance on every course,
   * and on the night course nothing but the machine's own light does that.
   */
  body.emissive = new THREE.Color(profile.colors.body);
  body.emissiveIntensity = 0.22;
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
    /*
     * The roll hoop over the pilot.
     *
     * Two uprights and a bar — the single most useful piece of hard-surface
     * detail on the machine, because it is the one part that reads as a
     * *structure* rather than a moulded shell, and because its height is the
     * clearest per-crew silhouette difference after the fin.
     */
    ...(fin.hoop > 0
      ? [
          ...[-1, 1].map(
            (side): MergePart => ({
              geometry: new THREE.BoxGeometry(0.12, fin.hoop, 0.12),
              position: [-0.62, 1.5 + fin.hoop / 2, side * halfWidth * 0.5],
            }),
          ),
          {
            geometry: new THREE.BoxGeometry(0.12, 0.12, halfWidth * 1.0 + 0.12),
            position: [-0.62, 1.5 + fin.hoop, 0],
          } as MergePart,
        ]
      : []),
  ];

  const darkParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(HULL_LENGTH * 0.8, 0.4, halfWidth * 1.48), position: [0.1, 1.0, 0] },
    { geometry: new THREE.BoxGeometry(1.4, 0.36, 1.05), position: [-0.2, 1.34, 0] },
    /*
     * The outrigger spar, as an exposed truss rather than a solid bar.
     *
     * This is the part that tells the whole story of the machine: the pod is
     * *bolted on*, by a crew, out of what they had. A smooth fairing would say
     * the opposite. Negative space between the bays is what makes it read as
     * salvage at race distance and not as a moulded wing.
     */
    { geometry: new THREE.BoxGeometry(0.16, 0.1, POD_OFFSET), position: [-0.3, 0.78, POD_OFFSET / 2] },
    { geometry: new THREE.BoxGeometry(0.16, 0.1, POD_OFFSET), position: [-0.3, 0.6, POD_OFFSET / 2] },
    ...Array.from({ length: fin.trussBays }, (_, i): MergePart => {
      const at = ((i + 0.5) / fin.trussBays) * POD_OFFSET;
      return {
        geometry: new THREE.BoxGeometry(0.09, 0.24, 0.09),
        position: [-0.3, 0.69, at],
        rotation: [i % 2 === 0 ? 0.5 : -0.5, 0, 0],
      };
    }),
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

  /*
   * Hover struts.
   *
   * Separate nodes because they move independently — that is the point. A
   * hovercraft with a rigid body has no mass; struts that compress under
   * braking and extend in the air are the cheapest possible way to say
   * otherwise, and they are what a landing actually reads through.
   */
  const strutGeometry = mergeGeometries([
    { geometry: new THREE.CylinderGeometry(0.07, 0.09, 0.42, 6), position: [0, 0.2, 0] },
    { geometry: new THREE.CylinderGeometry(0.26, 0.3, 0.16, 10), position: [0, -0.02, 0] },
  ]);
  disposables.push(strutGeometry);
  const struts = fin.struts.map((along) => {
    const strut = new THREE.Group();
    strut.position.set((along * HULL_LENGTH) / 2, 0.16, 0);
    const left = new THREE.Mesh(strutGeometry, dark);
    left.position.z = -halfWidth * 0.82;
    const right = new THREE.Mesh(strutGeometry, dark);
    right.position.z = halfWidth * 0.82;
    left.castShadow = castShadow;
    right.castShadow = castShadow;
    strut.add(left, right);
    chassis.add(strut);
    return strut;
  });

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
   * A flat ground shadow the rig spreads and fades with height.
   *
   * Separate from the real shadow map, which is off entirely on the low tier
   * and in any case cannot say "you are four metres up" at a glance. This one
   * is the altimeter a player actually uses to time a landing.
   */
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    map: glowSprite,
    transparent: true,
    // Light enough to read as contact rather than as a hole in the ground. It
    // has to work on the night course, where the road is already dark and an
    // opaque blob under the skiff makes the machine harder to see, not easier.
    opacity: 0.22,
    depthWrite: false,
    fog: false,
  });
  const shadowGeometry = new THREE.PlaneGeometry(HULL_LENGTH * 1.35, HULL_LENGTH * 0.95);
  const groundShadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  groundShadow.rotation.x = -HALF_PI;
  groundShadow.position.y = 0.03;
  groundShadow.renderOrder = 0;
  disposables.push(shadowGeometry, shadowMaterial);

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

  /*
   * The boom: a shaft, a grapple head, and a counterweight on the *short* side.
   *
   * The counterweight is what makes the mechanism legible — it is the reason a
   * person in a pod can swing something heavy at speed, and it gives the arm a
   * readable pivot so a wind-up looks like a wind-up rather than a limb moving.
   */
  const armGeometry = mergeGeometries([
    { geometry: new THREE.BoxGeometry(0.14, 0.14, 1.5), position: [0, 0, 0.85] },
    { geometry: new THREE.BoxGeometry(0.1, 0.1, 0.5), position: [0, 0, -0.3] },
    { geometry: new THREE.IcosahedronGeometry(0.24, 0), position: [0, 0, 1.55] },
    { geometry: new THREE.IcosahedronGeometry(fin.counterweight, 0), position: [0, 0, -0.58] },
  ]);
  const armMesh = new THREE.Mesh(armGeometry, trim);
  arm.add(armMesh);
  disposables.push(armGeometry);

  /*
   * ## The drift ladder, in AD Racers' own language
   *
   * A player mid-corner is looking at the road and the car, not at a gauge in
   * the corner, so the tier ladder has to be legible *on the machine*.
   *
   * The first version of this stepped through cyan, then orange, then magenta,
   * and an independent art review flagged that progression as uncomfortably
   * close to a recognisable one from another game. It was also lazy: a colour
   * ramp says nothing about what a salvage skiff is actually doing.
   *
   * What it does instead is mechanical, and it is the same fiction as the rest
   * of the machine — a wrench in an outrigger pod, winding a counterweight:
   *
   *   Tier 1, *wound*      — the counterweight draws back and locks. One steady
   *                          band of light along the pod spar.
   *   Tier 2, *loaded*     — scrap the skiff has picked up starts orbiting the
   *                          pod's magnetic clamp, and the flank slots begin to
   *                          vent. Two bands, and the debris ring appears.
   *   Tier 3, *overpressure* — the vents blow properly, the debris ring snaps
   *                          tight, and the whole rig shudders. Three bands,
   *                          fast pulse.
   *
   * Every tier is the *crew's own trim colour*. The tier is carried by how many
   * bands are lit, whether debris is orbiting, and the pulse rate — never by
   * hue. That makes it original, it makes it read in fog and at distance, and
   * it makes it colour-blind safe by construction rather than by exception.
   */
  const chargeMaterial = new THREE.MeshBasicMaterial({
    color: profile.colors.trim,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  disposables.push(chargeMaterial);

  /** One lit band per tier, stacked up the pod spar. */
  const chargeBands = [0, 1, 2].map((tier) => {
    const geometry = new THREE.BoxGeometry(0.62, 0.05, 0.1);
    const band = new THREE.Mesh(geometry, chargeMaterial);
    band.position.set(-0.3, 0.5 + tier * 0.17, POD_OFFSET * 0.55);
    band.visible = false;
    disposables.push(geometry);
    group.add(band);
    return band;
  });

  /*
   * Conductive scrap, held in the pod's clamp field. Six chips on a ring that
   * tightens and spins faster as the charge builds — the mechanical tell that
   * the machine is storing something, rather than a light getting brighter.
   */
  const debrisMaterial = new THREE.MeshStandardMaterial({
    color: profile.colors.trim,
    emissive: new THREE.Color(profile.colors.glow),
    emissiveIntensity: 0.5,
    roughness: 0.4,
    metalness: 0.6,
    flatShading: true,
    transparent: true,
    opacity: 0,
  });
  disposables.push(debrisMaterial);
  const debris = new THREE.Group();
  debris.position.set(-0.3, 0.68, POD_OFFSET);
  group.add(debris);
  const chipGeometry = new THREE.TetrahedronGeometry(0.11, 0);
  disposables.push(chipGeometry);
  const chips = Array.from({ length: 6 }, (_, i) => {
    const chip = new THREE.Mesh(chipGeometry, debrisMaterial);
    chip.userData.phase = (i / 6) * Math.PI * 2;
    debris.add(chip);
    return chip;
  });

  /*
   * Pressure venting from the flank slots. Two flat plumes that only appear at
   * the top tier and on release — the loudest thing the rig does, and the
   * anticipation for the payout.
   */
  const ventMaterial = new THREE.MeshBasicMaterial({
    color: 0xdfe8ea,
    map: glowSprite,
    transparent: true,
    opacity: 0,
    blending: THREE.NormalBlending,
    depthWrite: false,
    fog: false,
  });
  disposables.push(ventMaterial);
  const ventGeometry = mergeGeometries(
    [-1, 1].map(
      (side): MergePart => ({
        geometry: new THREE.PlaneGeometry(0.9, 0.6),
        position: [-0.4, 0.75, side * (halfWidth + 0.45)],
        rotation: [-HALF_PI, 0, 0],
      }),
    ),
  );
  const vents = new THREE.Mesh(ventGeometry, ventMaterial);
  vents.renderOrder = 2;
  group.add(vents);
  disposables.push(ventGeometry);

  group.add(groundShadow);

  // --- animation ------------------------------------------------------------
  /*
   * Every body channel lives in the rig. The model owns geometry and effect
   * materials; the rig owns *motion*, because motion is the part that has to
   * explain the physics and it needs springs with memory rather than a pile of
   * per-frame lerps.
   */
  const rig = new SkiffRig(
    {
      chassis,
      struts,
      pilot,
      pod,
      companion: wrench,
      arm,
      shadow: groundShadow,
      shadowMaterial,
    },
    fin.struts,
  );
  let phase = profile.id.length * 0.7;
  /** Whether the current swing has connected, for the recovery pose. */
  let swingLanded = false;


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

    rig.update(racer, dt, SURFACES[racer.surface].roughness);
    rig.updateArm(racer, dt, COMBAT.windup, COMBAT.recovery, swingLanded);

    /*
     * Exhaust brightness and size track the throttle and the boost, and the
     * boost core is deliberately small.
     *
     * The previous version produced a white-green bloom that covered most of
     * the lower half of the frame and hid the skiff inside it. Energy has to
     * originate from a readable emitter and leave the player's silhouette and
     * the road visible; a payoff the player cannot see through is not a payoff.
     */
    const thrustScale = racer.boosting ? 1.35 : 0.7 + speedFactor * 0.5;
    // A little flicker, so the flame is alive rather than a decal.
    const flicker = 1 + Math.sin(phase * 37) * 0.06;
    thrust.scale.set(1, thrustScale * flicker, thrustScale * flicker);
    thrustMaterial.opacity = racer.boosting ? 0.6 : 0.14 + speedFactor * 0.22;
    thrust.visible = speed > 1.5 || racer.boosting;
    // Thrusters stay with the hull, which is what the chassis node carries.
    thrust.position.y = chassis.position.y;

    // The hover cushion brightens under load and while boosting, and fades out
    // entirely in the air — where, self-evidently, there is nothing to hover on.
    cushionMaterial.opacity = racer.airborne ? 0 : 0.08 + speedFactor * 0.05 + (racer.boosting ? 0.08 : 0);
    cushion.scale.setScalar(1 + Math.sin(phase * 9) * 0.03 + (racer.boosting ? 0.14 : 0));

    // The tow cone: invisible until there is charge worth spending.
    const towReady = clamp01((racer.towCharge - TOW.minCharge) / Math.max(0.01, 1 - TOW.minCharge));
    wakeMaterial.opacity = towReady * 0.13 * (racer.slipstreaming ? 1 : 0.45);
    wake.visible = wakeMaterial.opacity > 0.005;
    wake.scale.set(1, 0.7 + towReady * 0.5, 1);

    /*
     * The drift ladder: bands, debris, vents. Tier is carried by *count and
     * rhythm*, never by hue — see the note where these are built.
     */
    const tier = racer.drift.active
      ? DRIFT.tiers.reduce((best, threshold, index) => (racer.drift.charge >= threshold ? index : best), -1)
      : -1;
    const charging = racer.drift.active;
    const pulse = 0.5 + Math.sin(phase * (14 + Math.max(0, tier) * 11)) * 0.5;
    chargeMaterial.opacity = charging ? 0.35 + pulse * 0.45 : 0;
    chargeBands.forEach((band, index) => {
      // Below the first tier the lowest band glows faintly, so the player can
      // see the drift is registering before it is worth anything.
      band.visible = charging && (index <= tier || (index === 0 && tier < 0));
      band.scale.setScalar(index <= tier ? 1 : 0.55);
    });

    const clampField = charging ? clamp01((racer.drift.charge - (DRIFT.tiers[0] ?? 0.34)) / 0.4) : 0;
    debrisMaterial.opacity = clampField * 0.95;
    debris.visible = clampField > 0.02;
    if (debris.visible) {
      // The ring tightens and spins faster the more the rig is holding.
      const radius = 0.62 - clampField * 0.22;
      const spin = phase * (4 + clampField * 14);
      for (const chip of chips) {
        const angle = spin + (chip.userData.phase as number);
        chip.position.set(Math.cos(angle) * radius, Math.sin(angle * 1.7) * 0.08, Math.sin(angle) * radius);
        chip.rotation.set(angle * 1.3, angle, 0);
      }
    }

    // Venting is the top tier only: the loudest thing the rig does, and the
    // anticipation the payout needs.
    const overpressure = tier >= 2 ? 1 : 0;
    ventMaterial.opacity = overpressure * (0.12 + pulse * 0.16);
    vents.visible = ventMaterial.opacity > 0.01;
    vents.scale.setScalar(1 + pulse * 0.25);

  };

  const dispose = (): void => {
    for (const item of disposables) item.dispose();
  };

  return {
    group,
    update,
    knock: (strength: number) => rig.knock(strength),
    setSwingLanded: (landed: boolean) => {
      swingLanded = landed;
    },
    dispose,
  };
}
