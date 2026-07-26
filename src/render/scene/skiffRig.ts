import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import type { RacerState } from '../../game/sim/state';

/**
 * The state-driven body rig.
 *
 * A skiff's job, visually, is to *explain the physics*. An independent motion
 * review found the previous rig failed that: a rigid upright body through a
 * hop, a companion welded in a fixed pose, a blob shadow that said nothing
 * about height, and a landing where vertical speed went from -5.35 m/s to zero
 * in one step with no compression, no rebound and no follow-through anywhere in
 * the frame. The physics changed and the image did not.
 *
 * This is the rig that fixes that. It owns no geometry — the model hands it
 * nodes and it drives them — and it is a set of *independent channels*, each
 * with its own spring, because that is what produces follow-through: the
 * chassis reaches its new attitude before the struts do, and the companion
 * reaches it after both.
 *
 * Every channel is a critically-ish damped second-order spring rather than an
 * exponential approach. The difference is the whole point: an exponential
 * follow can never overshoot, so it can never *land*. Compression, rebound and
 * settle are one spring with the right constants, not three animations.
 */

/** One spring channel: position, velocity, and the constants that shape it. */
class Spring {
  value: number;
  private velocity = 0;

  constructor(
    initial: number,
    private readonly stiffness: number,
    private readonly damping: number,
  ) {
    this.value = initial;
  }

  step(target: number, dt: number): number {
    // Semi-implicit Euler: stable at the stiffnesses a landing needs, where an
    // explicit integrator visibly rings at low frame rates.
    this.velocity += (target - this.value) * this.stiffness * dt - this.velocity * this.damping * dt;
    this.value += this.velocity * dt;
    return this.value;
  }

  /** Kicks the channel without moving it, which is what an impact does. */
  impulse(amount: number): void {
    this.velocity += amount;
  }

  reset(value: number): void {
    this.value = value;
    this.velocity = 0;
  }
}

export interface RigNodes {
  /** Carries roll, pitch and ride height. Everything bolted to the hull. */
  chassis: THREE.Object3D;
  /** Hover struts, front to back; each compresses independently. */
  struts: THREE.Object3D[];
  /** The pilot on the spine. */
  pilot: THREE.Object3D;
  /** The outrigger pod, which the companion rides in. */
  pod: THREE.Object3D;
  /** The companion themself, inside the pod. */
  companion: THREE.Object3D;
  /** The counterweighted boom. */
  arm: THREE.Object3D;
  /** Flat ground shadow; scaled and faded by height. */
  shadow: THREE.Object3D;
  shadowMaterial: THREE.Material & { opacity: number };
}

/** Where each strut sits along the hull, -1 at the tail to +1 at the nose. */
export type StrutPlacement = readonly number[];

export class SkiffRig {
  private readonly ride = new Spring(0, 150, 16);
  private readonly roll = new Spring(0, 90, 13);
  private readonly pitch = new Spring(0, 80, 12);
  private readonly strutSprings: Spring[];
  /** The companion lags the chassis; these are their own, softer springs. */
  private readonly braceRoll = new Spring(0, 46, 9);
  private readonly bracePitch = new Spring(0, 40, 8);
  private readonly armSwing = new Spring(0, 260, 22);
  private readonly podTurn = new Spring(0, 120, 16);

  private previousSpeed = 0;
  private previousVertical = 0;
  private wasAirborne = false;
  private clock = 0;
  /** Decaying shudder after a hit, so an impact reads for a moment and stops. */
  private shudder = 0;

  constructor(
    private readonly nodes: RigNodes,
    private readonly placement: StrutPlacement,
  ) {
    this.strutSprings = placement.map(() => new Spring(0, 190, 15));
  }

  reset(racer: RacerState): void {
    this.ride.reset(0);
    this.roll.reset(0);
    this.pitch.reset(0);
    for (const spring of this.strutSprings) spring.reset(0);
    this.braceRoll.reset(0);
    this.bracePitch.reset(0);
    this.previousSpeed = Math.hypot(racer.velocity.x, racer.velocity.z);
    this.previousVertical = racer.verticalVelocity;
    this.wasAirborne = racer.airborne;
    this.shudder = 0;
  }

  /**
   * Applies one frame. `elapsed` is wall-clock; the rig is frame-rate
   * independent and deliberately does not read the simulation's fixed step,
   * because it is presentation and must never feed back into the race.
   */
  update(racer: RacerState, elapsed: number, surfaceRoughness: number): void {
    const dt = Math.min(0.05, elapsed);
    this.clock += dt;
    const nodes = this.nodes;

    const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
    const speedFactor = clamp01(speed / 50);
    const acceleration = dt > 1e-4 ? (speed - this.previousSpeed) / dt : 0;
    this.previousSpeed = speed;

    /*
     * Touchdown.
     *
     * Detected on the *transition*, and the compression is an impulse rather
     * than a target, because a landing is a thing that happens to the body
     * rather than a pose the body adopts. The impulse scales with the vertical
     * speed the simulation actually arrived with, so a skim and a slam are
     * visibly different events rather than the same animation at two speeds.
     */
    if (this.wasAirborne && !racer.airborne) {
      const impact = clamp01(Math.abs(this.previousVertical) / 14);
      this.ride.impulse(-6.5 * impact);
      this.pitch.impulse(1.8 * impact);
      for (const spring of this.strutSprings) spring.impulse(-9 * impact);
      this.braceRoll.impulse(2.2 * impact);
      this.bracePitch.impulse(-3.4 * impact);
    }
    if (!racer.airborne) this.previousVertical = racer.verticalVelocity;
    this.wasAirborne = racer.airborne;

    /*
     * Chassis attitude.
     *
     * Roll reads lateral load and banks *into* the slide — a deliberate
     * stylisation for a hovercraft, where an outward lean reads as a mistake,
     * and the one that makes the direction of a slide legible from directly
     * behind, which is the angle the player almost always has.
     *
     * Pitch reads longitudinal acceleration, measured rather than asked for:
     * keying off the throttle pitches the nose up when the car is against a
     * wall and going nowhere.
     */
    const slide = clamp(racer.slip, -0.8, 0.8);
    const targetRoll = clamp(slide * 0.42 + racer.steer * 0.13, -0.4, 0.4);
    const targetPitch = racer.airborne
      ? 0.2
      : clamp(-acceleration * 0.012 - speedFactor * 0.03, -0.16, 0.2);
    const targetRide = racer.airborne ? 0.16 : -speedFactor * 0.06;

    this.roll.step(targetRoll, dt);
    this.pitch.step(targetPitch, dt);
    this.ride.step(targetRide, dt);

    this.shudder = Math.max(0, this.shudder - dt * 3.2);
    if (racer.stagger > 0) this.shudder = Math.max(this.shudder, clamp01(racer.stagger / 0.55));

    nodes.chassis.position.y = clamp(this.ride.value, -0.42, 0.5);
    nodes.chassis.rotation.x = this.roll.value + Math.sin(this.clock * 41) * this.shudder * 0.04;
    nodes.chassis.rotation.z = this.pitch.value;
    nodes.chassis.rotation.y = Math.sin(this.clock * 33) * this.shudder * 0.05;

    /*
     * Hover struts.
     *
     * Each one carries the terrain and the body's own attitude at its own
     * position along the hull, so the front pair compress under braking and the
     * rear pair under power — which is the cheapest possible way to make a
     * hovercraft read as having mass. A rough surface adds a small independent
     * jitter per strut, phase-offset so they never move as one.
     */
    const rumble = surfaceRoughness * clamp01(speed / 30);
    this.strutSprings.forEach((spring, index) => {
      const along = this.placement[index] ?? 0;
      // Positive pitch is nose-up, which unloads the front and loads the rear.
      const load = -this.pitch.value * along * 1.6 - this.roll.value * 0.2;
      const jitter = Math.sin(this.clock * (23 + index * 7)) * rumble * 0.05;
      const target = racer.airborne ? 0.14 : load + jitter;
      const value = clamp(spring.step(target, dt), -0.3, 0.26);
      const strut = nodes.struts[index];
      if (strut) strut.position.y = value;
    });

    /*
     * The companion braces, lags, and follows through.
     *
     * They are not bolted to the hull: they are a person in a pod holding on.
     * Their springs are softer than the chassis's, so they arrive late and
     * overshoot slightly — which is the entire read on "that landing was
     * heavy". Under lateral load they brace *against* it, which is what a
     * person does and the opposite of what a rigid child object does.
     */
    const braceRoll = this.braceRoll.step(-this.roll.value * 1.35, dt);
    const bracePitch = this.bracePitch.step(-this.pitch.value * 1.1 - clamp(acceleration * 0.006, -0.3, 0.3), dt);
    nodes.companion.rotation.x = clamp(braceRoll, -0.7, 0.7);
    nodes.companion.rotation.z = clamp(bracePitch, -0.6, 0.6);

    // The pilot is strapped to the spine, so they move less and sooner.
    nodes.pilot.rotation.x = clamp(-this.roll.value * 0.55, -0.4, 0.4);
    nodes.pilot.rotation.z = clamp(-this.pitch.value * 0.6, -0.35, 0.35);

    /*
     * Height-aware shadow.
     *
     * A blob that never changes tells the player nothing. Spreading and fading
     * it with altitude is the only cue that says how high a jump actually got,
     * and it is the cue a player uses to time a landing.
     */
    const height = clamp01((racer.y - (racer.y - this.ride.value)) / 6);
    const air = racer.airborne ? clamp01(racer.airClearance / 4) : height * 0.2;
    nodes.shadow.scale.setScalar(1 + air * 1.5);
    nodes.shadowMaterial.opacity = 0.22 * (1 - air * 0.7);
  }

  /**
   * Drives the pod arm through wind-up, strike and recovery.
   *
   * Kept separate from `update` because it is an *event* channel: the phases
   * come from the simulation's own state machine, and the poses have to be
   * distinguishable at a glance — a review found the active and recovery frames
   * "nearly indistinguishable", so a player could not tell a hit from a miss.
   */
  updateArm(racer: RacerState, elapsed: number, windup: number, recovery: number, landedHit: boolean): void {
    const dt = Math.min(0.05, elapsed);
    const nodes = this.nodes;

    let target = 0;
    switch (racer.strike.phase) {
      case 'windup':
        // Drawn back and *held*, with the counterweight visibly loaded. The
        // further through the wind-up, the further back — so the timing of the
        // release is readable from outside.
        target = -0.75 * clamp01(1 - racer.strike.timer / Math.max(0.01, windup)) - 0.2;
        break;
      case 'active':
        target = 1.7;
        break;
      case 'recovery':
        /*
         * A landed hit recoils; a miss over-travels and drifts home.
         *
         * This is the only visual difference between the two outcomes, and
         * without it combat reads as random even when it is deterministic.
         */
        target = landedHit
          ? 0.5 + clamp01(racer.strike.timer / Math.max(0.01, recovery)) * 0.9
          : 1.9 * clamp01(racer.strike.timer / Math.max(0.01, recovery));
        break;
      case 'idle':
        target = 0;
        break;
    }

    const swing = this.armSwing.step(target, dt);
    nodes.arm.rotation.x = swing * 0.3;
    nodes.arm.rotation.y = -Math.PI * 0.62 + swing;

    // The pod turns to face the striking side rather than reaching through the
    // hull. Side -1 is the player's left; the pod lives on the right.
    const side = racer.strike.side;
    const facing = racer.strike.phase === 'idle' ? 0 : side === -1 ? Math.PI : 0;
    nodes.pod.rotation.y = this.podTurn.step(facing, dt);
  }

  /** A one-off knock, for a collision or a landed strike. */
  knock(strength: number): void {
    this.shudder = Math.min(1, this.shudder + strength);
    this.ride.impulse(-3.5 * strength);
    this.roll.impulse(2.2 * strength);
    this.braceRoll.impulse(-3.6 * strength);
  }
}
