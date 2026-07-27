import * as THREE from 'three';
import { clamp01 } from '../../core/math';
import { COMBAT, DRIFT, TOW } from '../../game/config';
import type { RacerProfile } from '../../game/racers';
import type { RacerState } from '../../game/sim/state';
import { SURFACES } from '../../game/track/types';
import { helmetTexture, liveryTexture, particleTexture, plateTexture } from '../textures/procedural';
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
export interface CrewBuild {
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
/**
 * Exported so the garage can draw the same machine the scene builds.
 *
 * One table, two consumers. A selection screen that draws its own idea of a
 * crew's shape can drift out of agreement with the model, and then the player
 * learns the wrong silhouette from the one place they have time to study it.
 */
export const CREW_SILHOUETTES: Record<string, CrewBuild> = {
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
  /** Finish pose, 0 for last place through 1 for a win. */
  setCelebration: (intensity: number) => void;
  dispose: () => void;
}

/**
 * A hull panel.
 *
 * Every one carries the shared plating map: seams, rivets, streaks and scrapes.
 * A flat-shaded box in a crew colour has no *surface*, and that was the largest
 * single component of the art review's "placeholder-level" verdict — these are
 * three-hundred-year-old machines rebuilt in a shed, and their plating should
 * read as panels that were cut, bolted and then weathered at different rates.
 *
 * The map is shared and its repeat is per material, so the whole grid still
 * costs one texture.
 */
function panel(color: number, roughness = 0.55, metalness = 0.35, repeat = 1.6): THREE.MeshStandardMaterial {
  const map = plateTexture().clone();
  map.needsUpdate = true;
  map.repeat.set(repeat, repeat);
  return new THREE.MeshStandardMaterial({ color, map, roughness, metalness, flatShading: true });
}

export function buildVehicle(profile: RacerProfile, castShadow: boolean): VehicleVisual {
  const fin = CREW_SILHOUETTES[profile.id] ?? DEFAULT_BUILD;

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
  trim.emissiveIntensity = 0.42;
  /*
   * The body carries a little of it too.
   *
   * Running lights on the trim alone leave the *hull* — which is most of the
   * silhouette and all of the crew colour — as a black shape after dark. A
   * skiff has to be identifiable as its crew at race distance on every course,
   * and on the night course nothing but the machine's own light does that.
   */
  body.emissive = new THREE.Color(profile.colors.body);
  // Kept below the bloom threshold on every course: this exists so the hull is
  // *visible* after dark, not so it glows.
  body.emissiveIntensity = 0.12;
  const dark = panel(0x1b1f26, 0.7, 0.2, 2.4);
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
    /*
     * The tail fin, built rather than extruded.
     *
     * A review called this "a huge featureless rectangular fin", and it was: a
     * single 1.1 x H box. It is the largest flat area on the machine and the
     * one the player stares at for a whole race, so it is the worst possible
     * place to have nothing. It is now a tapered blade with a swept leading
     * edge, a lightening cut-out through the middle, and a stiffening rib down
     * the outside — the shape a crew would actually cut from plate, and enough
     * negative space that the silhouette reads as fabricated rather than
     * moulded.
     */
    ...Array.from({ length: fin.blades }, (_, i): MergePart[] => {
      const side = fin.blades === 1 ? 0 : (i === 0 ? -1 : 1) * halfWidth * 0.62;
      const root: [number, number, number] = [-HULL_LENGTH / 2 + 0.35, 0.95 + fin.height / 2, side];
      const sweep: [number, number, number] = [0, 0, -fin.sweep];
      return [
        // Lower half: full chord, carrying the load into the hull.
        {
          geometry: new THREE.BoxGeometry(1.15, fin.height * 0.42, 0.16),
          position: [root[0], 0.95 + fin.height * 0.21, side],
          rotation: sweep,
        },
        // Upper half: shorter chord, so the blade tapers instead of ending.
        {
          geometry: new THREE.BoxGeometry(0.72, fin.height * 0.46, 0.14),
          position: [root[0] - fin.height * 0.14, 0.95 + fin.height * 0.68, side],
          rotation: sweep,
        },
        // Leading-edge spar: the diagonal that makes it a blade, not a slab.
        {
          geometry: new THREE.BoxGeometry(0.2, fin.height * 0.9, 0.2),
          position: [root[0] + 0.42, 0.95 + fin.height * 0.46, side],
          rotation: [0, 0, -fin.sweep - 0.16],
        },
        // Two ribs across the cut-out, which is what reads at distance.
        ...[0.34, 0.62].map((at): MergePart => ({
          geometry: new THREE.BoxGeometry(0.9, 0.11, 0.22),
          position: [root[0] - fin.height * (at - 0.3) * 0.3, 0.95 + fin.height * at, side],
          rotation: sweep,
        })),
      ];
    }).flat(),
    /*
     * The thruster cans, with the mechanical detail a can actually has: a
     * body, a narrower throat, and a flared bell. Three stacked cylinders
     * instead of one is the difference between "an engine" and "a tube".
     */
    ...[-1, 1].flatMap((side): MergePart[] => [
      {
        geometry: new THREE.CylinderGeometry(0.3, 0.34, 1.1, 8),
        position: [-HULL_LENGTH / 2 + 0.5, 0.6, side * halfWidth * 0.78],
        rotation: [0, 0, HALF_PI],
      },
      {
        geometry: new THREE.CylinderGeometry(0.22, 0.28, 0.22, 8),
        position: [-HULL_LENGTH / 2 - 0.14, 0.6, side * halfWidth * 0.78],
        rotation: [0, 0, HALF_PI],
      },
      {
        geometry: new THREE.CylinderGeometry(0.36, 0.24, 0.34, 8),
        position: [-HULL_LENGTH / 2 - 0.38, 0.6, side * halfWidth * 0.78],
        rotation: [0, 0, HALF_PI],
      },
    ]),
    /*
     * A cowl over the nose with a real intake under it.
     *
     * The nose was a bare four-sided cone. A cowl that stands proud of it, with
     * a shadowed gap beneath, gives the front of the machine a hard edge and a
     * hole — the two things that read as engineering at any distance.
     */
    {
      geometry: new THREE.BoxGeometry(noseLength * 0.72, 0.16, halfWidth * 1.25),
      position: [HULL_LENGTH / 2 + noseLength * 0.16, 1.02, 0],
      rotation: [0, 0, 0.06],
    },
    ...[-1, 1].map((side): MergePart => ({
      geometry: new THREE.BoxGeometry(noseLength * 0.5, 0.3, 0.14),
      position: [HULL_LENGTH / 2 + noseLength * 0.2, 0.86, side * halfWidth * 0.52],
    })),
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
  /*
   * Both sides of a strut station are one mesh, because they always move
   * together.
   *
   * Six skiffs times four stations times two sides is forty-eight draw calls
   * for something with no independent motion — enough on its own to take the
   * scene from seventy calls to a hundred and forty-six and blow the budget the
   * browser suite enforces. A pair per station is the same animation for half
   * the cost.
   */
  const strutGeometry = mergeGeometries(
    [-1, 1].flatMap((side): MergePart[] => [
      { geometry: new THREE.CylinderGeometry(0.07, 0.09, 0.42, 6), position: [0, 0.2, side * halfWidth * 0.82] },
      { geometry: new THREE.CylinderGeometry(0.26, 0.3, 0.16, 8), position: [0, -0.02, side * halfWidth * 0.82] },
    ]),
  );
  disposables.push(strutGeometry);
  /*
   * All of a skiff's strut stations are one instanced draw.
   *
   * Merging the two sides of a station halved the cost once; instancing the
   * stations finishes the job. Three or four stations per skiff, six skiffs and
   * a shadow pass is between thirty-six and forty-eight draw calls for the
   * suspension alone, and the suspension is not what the frame is about.
   *
   * Each station still moves independently — that is the entire point of having
   * them — so the rig writes a per-instance matrix rather than a node
   * transform. `StrutProxy` gives it the same `position.y` interface it had
   * when these were nodes, so the rig does not have to know.
   */
  const strutMesh = new THREE.InstancedMesh(strutGeometry, dark, fin.struts.length);
  strutMesh.name = 'struts';
  strutMesh.castShadow = castShadow;
  strutMesh.frustumCulled = false;
  strutMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chassis.add(strutMesh);

  const strutMatrix = new THREE.Matrix4();
  const struts = fin.struts.map((along, index) => {
    const proxy = new THREE.Object3D();
    proxy.position.set((along * HULL_LENGTH) / 2, 0.16, 0);
    // Seed the buffer, so a skiff drawn before its first rig update is not a
    // pile of struts at the origin.
    strutMatrix.makeTranslation(proxy.position.x, proxy.position.y, proxy.position.z);
    strutMesh.setMatrixAt(index, strutMatrix);
    return proxy;
  });
  strutMesh.instanceMatrix.needsUpdate = true;

  /** Pushes the proxies' positions into the instance buffer. */
  const syncStruts = (): void => {
    struts.forEach((proxy, index) => {
      strutMatrix.makeTranslation(proxy.position.x, proxy.position.y, proxy.position.z);
      strutMesh.setMatrixAt(index, strutMatrix);
    });
    strutMesh.instanceMatrix.needsUpdate = true;
  };

  // --- animated parts ------------------------------------------------------
  // These move independently, so they stay separate: an incoming strike has to
  // be readable, and a rider slumping when struck is the clearest tell there is.

  /*
   * The rider.
   *
   * The art review's single word for the crews was "placeholder", and a capsule
   * on the spine was the most literal example of it in the game: at any
   * distance it read as cargo. A rider is what makes a skiff a machine somebody
   * is *driving*, and the parts that carry that are entirely conventional —
   * shoulders that are wider than the hips, arms that reach forward to
   * something, a head that sits above and behind them, and a helmet with a
   * visor. None of it is detailed; all of it is proportioned.
   *
   * The body is one merged mesh and the head is a second, and the split is not
   * arbitrary. Two of the three things a rider has to say — *braced* and
   * *hit* — are said by the torso, and the third, *where they are looking*, can
   * only be said by a head that turns independently. Six cars pay two draw
   * calls each for that, which is the cheapest characterisation in the game.
   */
  const GEAR = 0x2a2f36;
  const riderBodyParts: MergePart[] = [
    // Hips, sunk into the spine: the rider sits *in* the machine.
    { geometry: new THREE.BoxGeometry(0.34, 0.26, 0.42), position: [-0.06, -0.3, 0], color: GEAR },
    // Torso, tapering up to the shoulders and leaning forward over the tank.
    { geometry: new THREE.BoxGeometry(0.44, 0.5, 0.46), position: [0.05, -0.02, 0], rotation: [0, 0, 0.22], color: GEAR },
    // Shoulders — the widest point, which is what makes the silhouette human.
    { geometry: new THREE.BoxGeometry(0.26, 0.2, 0.62), position: [0.12, 0.2, 0], color: GEAR },
    // Upper arms, out and forward to the grips.
    ...[-1, 1].map((side): MergePart => ({
      geometry: new THREE.CylinderGeometry(0.075, 0.085, 0.44, 5),
      position: [0.26, 0.06, side * 0.29],
      rotation: [0, 0, -1.05],
      color: GEAR,
    })),
    // Forearms, down onto the bars. Two segments rather than one straight rod:
    // a bent elbow is most of what says a person is holding on.
    ...[-1, 1].map((side): MergePart => ({
      geometry: new THREE.CylinderGeometry(0.06, 0.07, 0.34, 5),
      position: [0.5, -0.08, side * 0.31],
      rotation: [0, 0, -0.55],
      color: GEAR,
    })),
    // Knees, drawn up under the tank.
    ...[-1, 1].map((side): MergePart => ({
      geometry: new THREE.BoxGeometry(0.4, 0.18, 0.16),
      position: [0.16, -0.4, side * 0.19],
      rotation: [0, 0, 0.35],
      color: GEAR,
    })),
    // The shoulder yoke, in the crew's colour: one bright horizontal at the top
    // of the body, which is what says "this rider is on that team" at 40 m.
    // A vertex colour rather than a second material, so the rider is one draw.
    {
      geometry: new THREE.BoxGeometry(0.24, 0.11, 0.66),
      position: [0.12, 0.22, 0],
      color: profile.colors.trim,
    },
  ];
  /*
   * The rider wears the crew's colour, they are not *made* of it.
   *
   * Built in the trim material, the rider merged into the roll hoop and the
   * flank stripes around them and the whole assembly read as one pale lump.
   * A person is legible because they are a *different* value from the machine
   * they are sitting on — dark gear, one bright band at the eyes — which is
   * exactly how a real rider reads against a bike at distance. The shoulders
   * keep the crew colour so the affiliation still carries.
   */
  const gear = panel(0xffffff, 0.86, 0.05, 3.2);
  gear.vertexColors = true;
  disposables.push(gear);
  const riderGeometry = mergeGeometries(riderBodyParts);
  const riderBody = new THREE.Mesh(riderGeometry, gear);
  riderBody.castShadow = castShadow;
  disposables.push(riderGeometry);

  /*
   * The helmet.
   *
   * A cylinder rather than a sphere, because the visor has to be a *band* and a
   * band wraps a cylinder without the texture pinching at the poles. The visor
   * lives in the emissive map, so it survives a night course — an unlit visor
   * disappears exactly when the silhouette matters most, and a head with no
   * bright band at 30 px on screen is a lump rather than a person.
   */
  const helmetMaps = helmetTexture(profile.colors.trim);
  const helmetMaterial = new THREE.MeshStandardMaterial({
    map: helmetMaps.map,
    emissiveMap: helmetMaps.emissive,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.85,
    roughness: 0.32,
    metalness: 0.1,
  });
  disposables.push(helmetMaterial);
  const helmetGeometry = mergeGeometries([
    { geometry: new THREE.CylinderGeometry(0.19, 0.185, 0.34, 12), position: [0, 0, 0], rotation: [HALF_PI, 0, 0] },
    // The chin bar, which is what stops the head reading as a ball.
    { geometry: new THREE.BoxGeometry(0.2, 0.12, 0.3), position: [0.15, -0.09, 0] },
  ]);
  const head = new THREE.Mesh(helmetGeometry, helmetMaterial);
  head.position.set(0.02, 0.42, 0);
  head.castShadow = castShadow;
  disposables.push(helmetGeometry);

  /*
   * Both hang off a pivot at the hips rather than off the chassis directly.
   *
   * The rider's poses are all rotations about where they are strapped in, so a
   * lean and a slump both have to turn about a point low in the body. Rotating
   * a mesh whose origin is at its centre pivots them about the sternum, which
   * reads as a doll being tipped rather than a person bracing.
   */
  const pilot = new THREE.Group();
  pilot.position.set(-0.3, 1.5, 0);
  pilot.add(riderBody);
  pilot.add(head);
  chassis.add(pilot);

  /*
   * The flank livery: crew mark, number and hand-lettering.
   *
   * A decal quad on each side, both merged into one mesh. Drawn rather than
   * modelled, because geometry for a race number costs draw calls on the one
   * part of the skiff a player only ever sees in profile, and because paint is
   * what team graphics actually *are*.
   */
  const liveryMaterial = new THREE.MeshBasicMaterial({
    map: liveryTexture(profile.id, profile.colors.trim, profile.id.length * 37 + profile.id.charCodeAt(0)),
    transparent: true,
    // Painted onto the hull, so it must never light differently from it and
    // must never sort in front of the thruster glow.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  disposables.push(liveryMaterial);
  const liveryGeometry = mergeGeometries(
    [-1, 1].map((side): MergePart => ({
      geometry: new THREE.PlaneGeometry(1.7, 0.85),
      position: [0.1, 0.62, side * (halfWidth + 0.05)],
      rotation: [0, side * HALF_PI, 0],
    })),
  );
  const livery = new THREE.Mesh(liveryGeometry, liveryMaterial);
  livery.name = 'livery';
  chassis.add(livery);
  disposables.push(liveryGeometry);

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

  /*
   * The pod: a working station, not a capsule.
   *
   * A review read this as "a pale faceted torso or egg attached to a dark
   * faceted ball" — because it was a capsule with a capsule on it. What makes
   * it read as a place someone works is the furniture: an open cradle with a
   * lip to brace against, a bracket where the arm is anchored, and a rack of
   * salvage behind. All merged into the existing hull materials, so the whole
   * station is still one draw call.
   */
  const podGeometry = mergeGeometries([
    // The cradle: a tub, open at the top, rather than a sealed pill.
    { geometry: new THREE.BoxGeometry(1.5, 0.5, 0.92), position: [0, 0, 0] },
    { geometry: new THREE.BoxGeometry(1.6, 0.14, 1.02), position: [0, 0.26, 0] },
    // A raked front so it has a direction.
    { geometry: new THREE.BoxGeometry(0.5, 0.42, 0.8), position: [0.86, 0.02, 0], rotation: [0, 0, 0.34] },
    // The bracket the arm is anchored to.
    { geometry: new THREE.BoxGeometry(0.3, 0.44, 0.34), position: [-0.62, 0.18, -0.3] },
    // A rack of salvage behind the seat: the crew carry their own spares.
    ...[-0.28, 0, 0.28].map((at): MergePart => ({
      geometry: new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6),
      position: [-0.5, 0.3, at],
      rotation: [0, 0, HALF_PI * 0.9],
    })),
  ]);
  const podShell = new THREE.Mesh(podGeometry, body);
  podShell.castShadow = castShadow;
  pod.add(podShell);
  disposables.push(podGeometry);

  /*
   * Vex: a person braced in the cradle, working.
   *
   * The read has to survive being small and mostly seen from behind, so the
   * silhouette is doing all of it: shoulders wider than the hips, a head that
   * sits forward of them because they are leaning out to watch the road, and
   * one arm out along the pod's lip holding on. The gear takes the dark value
   * and the shoulders the crew colour, exactly as the rider does, so the two of
   * them read as the same crew at a glance.
   */
  const companionParts: MergePart[] = [
    { geometry: new THREE.BoxGeometry(0.34, 0.44, 0.36), position: [-0.02, 0.42, 0], rotation: [0, 0, 0.18], color: GEAR },
    { geometry: new THREE.BoxGeometry(0.2, 0.16, 0.54), position: [0.04, 0.62, 0], color: profile.colors.trim },
    // The arm out along the lip, which is what says "holding on".
    { geometry: new THREE.CylinderGeometry(0.06, 0.07, 0.5, 5), position: [0.26, 0.5, 0.24], rotation: [0.4, 0, -0.9], color: GEAR },
    // Knees drawn up in the tub.
    { geometry: new THREE.BoxGeometry(0.38, 0.16, 0.3), position: [0.22, 0.26, 0], rotation: [0, 0, 0.5], color: GEAR },
  ];
  const wrenchGeometry = mergeGeometries(companionParts);
  const wrench = new THREE.Mesh(wrenchGeometry, gear);
  wrench.position.set(0, 0.1, 0);
  wrench.castShadow = castShadow;
  pod.add(wrench);
  disposables.push(wrenchGeometry);

  /*
   * Vex's head, separate for the same reason Bramble's is: where a crew member
   * is *looking* is the cheapest character animation there is, and a companion
   * who tracks the road ahead reads as a person rather than as cargo.
   */
  const companionHeadGeometry = mergeGeometries([
    { geometry: new THREE.CylinderGeometry(0.15, 0.145, 0.26, 10), rotation: [HALF_PI, 0, 0] },
    { geometry: new THREE.BoxGeometry(0.16, 0.1, 0.24), position: [0.12, -0.07, 0] },
  ]);
  const companionHead = new THREE.Mesh(companionHeadGeometry, helmetMaterial);
  companionHead.position.set(0.06, 0.86, 0);
  wrench.add(companionHead);
  disposables.push(companionHeadGeometry);

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
  /*
   * The scrap ring is one mesh, spun as a whole.
   *
   * Six chips as six meshes is thirty-six draw calls across a full grid for a
   * ring that rotates rigidly — the individual orbits were never
   * distinguishable at race distance, and the read the player actually gets is
   * "the ring is tightening and spinning faster", which a single merged ring
   * gives for one call.
   */
  const chipGeometry = mergeGeometries(
    Array.from({ length: 6 }, (_, i): MergePart => {
      const angle = (i / 6) * Math.PI * 2;
      return {
        geometry: new THREE.TetrahedronGeometry(0.11, 0),
        position: [Math.cos(angle) * 0.62, Math.sin(angle * 1.7) * 0.08, Math.sin(angle) * 0.62],
        rotation: [angle * 1.3, angle, 0],
      };
    }),
  );
  disposables.push(chipGeometry);
  const chipRing = new THREE.Mesh(chipGeometry, debrisMaterial);
  debris.add(chipRing);

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
      head,
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
    syncStruts();
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
    const thrustScale = racer.boosting ? 1.15 : 0.7 + speedFactor * 0.45;
    // A little flicker, so the flame is alive rather than a decal.
    const flicker = 1 + Math.sin(phase * 37) * 0.06;
    thrust.scale.set(1, thrustScale * flicker, thrustScale * flicker);
    thrustMaterial.opacity = racer.boosting ? 0.42 : 0.12 + speedFactor * 0.18;
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
      debris.rotation.y = phase * (4 + clampField * 14);
      const radius = 1 - (clampField * 0.22) / 0.62;
      debris.scale.set(radius, 1, radius);
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
    setCelebration: (intensity: number) => {
      rig.setCelebration(intensity);
    },
    setSwingLanded: (landed: boolean) => {
      swingLanded = landed;
    },
    dispose,
  };
}
