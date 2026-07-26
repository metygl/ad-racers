import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../../core/math';
import type { RacerState } from '../../game/sim/state';

/**
 * The chase camera.
 *
 * Almost all of the "feel" of a racing game lives here — the research is
 * consistent that players read speed off the camera long before they read it
 * off the speedometer, and that field of view and follow distance do more work
 * than motion blur ever did. The rules this one follows:
 *
 *  - **Follow the velocity, not the heading.** Chasing the nose makes the
 *    camera whip round during a drift, which is both nauseating and useless —
 *    you want to see where you are going, which is where the skiff is going.
 *  - **Never rotate faster than the player can read.** The yaw is damped with a
 *    hard rate limit.
 *  - **Sell speed with the frame, not with shake.** Field of view, follow
 *    distance, height and a small roll do the work; shake is punctuation.
 *  - **Every impulse decays.** Nothing the camera does persists into the next
 *    corner, so the frame always settles back to a readable baseline.
 *  - **When the player is reading a countdown or a results screen, sit still.**
 */

export type CameraMode = 'chase' | 'close' | 'far' | 'orbit';

/**
 * How much the camera favours the road's direction over the skiff's.
 *
 * The number that decides whether a drift is readable. At zero the view is
 * welded to the velocity and swings to a side-on shot mid-slide; at one it
 * ignores the car entirely and never conveys rotation. Two thirds keeps the
 * apex in frame while still showing the slide.
 */
const TRACK_YAW_WEIGHT = 0.62;
/** Hard limit on how far the view may sit from the road's direction. */
const MAX_TRACK_OFFSET = 0.62;
/** Closest the camera may ever be pulled, so the skiff stays in frame. */
const MIN_DISTANCE = 4.2;

const MODE_SETTINGS: Record<CameraMode, { distance: number; height: number; look: number; fov: number }> = {
  chase: { distance: 10.6, height: 4.0, look: 6, fov: 62 },
  close: { distance: 7.2, height: 2.9, look: 5, fov: 66 },
  // A wider, higher seat for players who want to see the whole corner coming.
  // Not a cheat: it trades the sensation of speed for the information.
  far: { distance: 14.5, height: 5.6, look: 8, fov: 58 },
  orbit: { distance: 14, height: 6, look: 0, fov: 55 },
};

export const CAMERA_MODES: readonly { id: CameraMode; label: string }[] = [
  { id: 'chase', label: 'Chase' },
  { id: 'close', label: 'Close' },
  { id: 'far', label: 'Wide' },
];

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** Multiplier on all shake, so Reduced Motion can switch it off entirely. */
  shakeScale = 1;

  private yaw = 0;
  private position = new THREE.Vector3();
  private target = new THREE.Vector3();
  private fov = 62;
  private shake = 0;
  private orbitAngle = 0;
  private initialised = false;
  private roll = 0;
  private dip = 0;
  private kick = 0;
  private clock = 0;
  private previousSpeed = 0;
  /** Heading of the road under the racer, supplied by the renderer. */
  private trackYaw: number | null = null;
  /** 0-1 blend into the reverse view, so it eases rather than snapping. */
  private reverse = 0;
  /** 0-1 how far the camera has been pulled in to clear an occluder. */
  private occlusion = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.5, 4200);
  }

  /**
   * The direction the camera is looking, as a plain simulation-space heading.
   *
   * Exposed because the audio listener needs it, and reading it back out of
   * `camera.rotation.y` does not work: that is an Euler angle extracted from a
   * `lookAt` matrix which also carries pitch, so it is neither the view heading
   * nor a fixed offset from it. Panning built on it put a rival directly
   * alongside in the centre of the mix and a rival dead ahead hard in one ear.
   */
  get listenerYaw(): number {
    return this.yaw;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Adds a shake impulse, in arbitrary units; 1 is a solid wall hit. */
  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount * this.shakeScale);
  }

  /**
   * Pulls the camera back sharply and lets it ease home — the punch that makes
   * a boost or a drift release feel like it did something. Distinct from shake:
   * shake is noise, this is a deliberate, readable move.
   */
  addKick(amount: number): void {
    this.kick = Math.min(1.6, this.kick + amount * this.shakeScale);
  }

  /** Drops the camera briefly, for a landing. */
  addDip(amount: number): void {
    this.dip = Math.min(1.4, this.dip + amount * this.shakeScale);
  }

  /** Snaps the camera behind a racer with no interpolation. */
  reset(racer: RacerState): void {
    this.yaw = racer.heading;
    this.shake = 0;
    this.kick = 0;
    this.dip = 0;
    this.roll = 0;
    this.orbitAngle = 0;
    this.initialised = false;
    this.reverse = 0;
    this.occlusion = 0;
    this.trackYaw = null;
    this.previousSpeed = Math.hypot(racer.velocity.x, racer.velocity.z);
    this.apply(racer, 1 / 60, true);
  }

  /**
   * Tells the camera which way the road runs here.
   *
   * The camera is not allowed to read the track itself — that would put game
   * knowledge in the renderer — so the caller, which already has the
   * projection, hands it over.
   */
  setTrackYaw(yaw: number): void {
    this.trackYaw = yaw;
  }

  /**
   * How far the camera may sit behind the racer before something solid is in
   * the way. The renderer measures this against the world; the camera only
   * has to respect it.
   */
  setClearance(fraction: number): void {
    // Eased towards, and released faster than it is applied: snapping in on a
    // thin trunk and out again is worse than the occlusion.
    const target = clamp01(1 - fraction);
    this.occlusion = target > this.occlusion ? Math.min(target, this.occlusion + 0.25) : target;
  }

  update(racer: RacerState, elapsed: number, roughness: number): void {
    this.clock += elapsed;
    // A skiff travelling backwards gets a rear view, eased over ~200 ms.
    const alongNose = racer.velocity.x * Math.cos(racer.heading) + racer.velocity.z * Math.sin(racer.heading);
    const wantsReverse = alongNose < -2 ? 1 : 0;
    this.reverse = damp(this.reverse, wantsReverse, 6, elapsed);
    this.shake = Math.max(0, this.shake - elapsed * 2.4);
    this.kick = Math.max(0, this.kick - elapsed * 3.4);
    this.dip = Math.max(0, this.dip - elapsed * 4.2);
    // Continuous rumble from the surface, on top of impulse shake.
    if (roughness > 0) this.shake = Math.max(this.shake, roughness * 0.09 * this.shakeScale);
    this.apply(racer, elapsed, false);
  }

  private apply(racer: RacerState, elapsed: number, snap: boolean): void {
    const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
    const settings = MODE_SETTINGS[this.mode];

    if (this.mode === 'orbit') {
      this.orbitAngle += elapsed * 0.22;
      const x = racer.pos.x + Math.cos(this.orbitAngle) * settings.distance;
      const z = racer.pos.z + Math.sin(this.orbitAngle) * settings.distance;
      this.camera.position.set(x, racer.y + settings.height, z);
      this.camera.lookAt(racer.pos.x, racer.y + 1.2, racer.pos.z);
      return;
    }

    /*
     * Yaw is a blend of where the skiff is going and where the *road* goes, and
     * it is clamped against the track tangent.
     *
     * Following raw velocity alone swung the view to a wide side-on shot during
     * a drift and left the player low and left of frame with the track-forward
     * composition gone entirely, which is disorienting and a genuine
     * motion-sickness risk. Weighting the track tangent keeps the next apex in
     * the middle of the screen, which is the information the player needs
     * precisely when the car is sideways.
     *
     * Reversing gets its own target rather than a forward view held for four
     * seconds while the car travels backwards at the cap.
     */
    const travelling = speed > 3;
    const velocityYaw = travelling ? Math.atan2(racer.velocity.z, racer.velocity.x) : racer.heading;
    const trackYaw = this.trackYaw ?? velocityYaw;
    const blended = velocityYaw + wrapAngle(trackYaw - velocityYaw) * TRACK_YAW_WEIGHT;
    // Never more than this far from the road's direction, however sideways the
    // skiff gets. This is the hard side-angle limit a drift used to blow past.
    const clampedToTrack = trackYaw + clamp(wrapAngle(blended - trackYaw), -MAX_TRACK_OFFSET, MAX_TRACK_OFFSET);
    const reversing = this.reverse > 0.5;
    const desiredYaw = reversing ? wrapAngle(clampedToTrack + Math.PI) : clampedToTrack;
    if (snap || !this.initialised) {
      this.yaw = desiredYaw;
      this.initialised = true;
    } else {
      // Damped approach with a hard rate limit. The limit is what stops a spin
      // from throwing the camera round faster than the eye can track.
      const delta = wrapAngle(desiredYaw - this.yaw);
      const step = delta * (1 - Math.exp(-6.5 * elapsed));
      const maxStep = 2.6 * elapsed;
      this.yaw = wrapAngle(this.yaw + clamp(step, -maxStep, maxStep));
    }

    /*
     * Longitudinal acceleration, measured rather than asked for.
     *
     * The renderer has no access to the throttle, and it should not: a camera
     * that keys off the input punches forward on a throttle press even when the
     * skiff is against a wall and not moving. Differencing the speed gives the
     * camera the acceleration the *player actually experienced*, which is the
     * thing worth dramatising.
     */
    const acceleration = elapsed > 1e-4 ? (speed - this.previousSpeed) / elapsed : 0;
    this.previousSpeed = speed;

    // Pull back and lift with speed, which reads as acceleration without
    // touching the field of view. The kick is a short additional pull on top.
    const speedFactor = clamp01(speed / 50);
    const surge = racer.boosting ? 1.1 : 0;
    /*
     * Occlusion pulls the camera *in* towards the racer rather than fading the
     * offending geometry, because at this art direction a half-transparent tree
     * reads worse than a closer camera. The floor keeps the skiff in frame.
     */
    const wanted = settings.distance + speedFactor * 2.1 + surge + this.kick * 1.6;
    const distance = Math.max(MIN_DISTANCE, wanted * (1 - this.occlusion * 0.72));
    const height = settings.height + speedFactor * 0.55 - this.dip * 0.9;

    const behindX = -Math.cos(this.yaw);
    const behindZ = -Math.sin(this.yaw);
    this.target.set(
      racer.pos.x + behindX * distance,
      racer.y + height,
      racer.pos.z + behindZ * distance,
    );

    if (snap) {
      this.position.copy(this.target);
    } else {
      // Position is damped separately from yaw and a little slower, so a kerb
      // strike moves the car in frame instead of moving the whole world.
      this.position.x = damp(this.position.x, this.target.x, 11, elapsed);
      this.position.y = damp(this.position.y, this.target.y, 8, elapsed);
      this.position.z = damp(this.position.z, this.target.z, 11, elapsed);
    }

    const shakeAmount = this.shake * this.shakeScale;
    /*
     * Deterministic wobble from the camera's own clock rather than
     * `performance.now()` or a random number.
     *
     * Two frequencies that are not multiples of each other, so the pattern does
     * not resolve into a visible beat — and both well above 3 Hz, which keeps
     * the shake clear of the low-frequency band motion-sickness research
     * implicates. The art bible forbids sustained camera motion in that band.
     */
    const t = this.clock;
    const shakeX = (Math.sin(t * 47) * 0.6 + Math.sin(t * 71.3) * 0.4) * shakeAmount * 0.34;
    const shakeY = (Math.sin(t * 61 + 1.7) * 0.6 + Math.sin(t * 89.1) * 0.4) * shakeAmount * 0.26;

    this.camera.position.set(this.position.x + shakeX, this.position.y + shakeY, this.position.z);

    // Look slightly ahead of the skiff so the road, not the tail fin, is the
    // centre of the frame. The look-ahead grows with speed, which is what keeps
    // the corner in frame when there is less time to react to it.
    const lookAhead = settings.look + speedFactor * 5;
    this.camera.lookAt(
      racer.pos.x + Math.cos(this.yaw) * lookAhead,
      racer.y + 1.35 - this.dip * 0.4,
      racer.pos.z + Math.sin(this.yaw) * lookAhead,
    );

    /*
     * A small camera roll into the slide.
     *
     * Two or three degrees, no more. Enough that a drift *feels* committed
     * rather than merely looking sideways, and far short of the amount that
     * turns a corner into a fairground ride. It goes to zero with the shake
     * scale, so reduced motion removes it along with everything else.
     */
    const targetRoll = clamp(racer.slip * 0.14 + racer.steer * 0.03, -0.09, 0.09) * this.shakeScale;
    this.roll = damp(this.roll, targetRoll, 5, elapsed);
    this.camera.rotateZ(this.roll);

    /*
     * Field of view: the single most effective speed cue available, and it
     * costs nothing.
     *
     * Three terms. A baseline that grows with speed; a snap wider on boost; and
     * a term driven by measured acceleration, which is what makes a tow snap or
     * a drift release read as a shove rather than as a number going up. The
     * acceleration term is clamped hard so a collision cannot throw the frame.
     */
    const accelPunch = clamp(acceleration * 0.16, -2.5, 4.5);
    const targetFov = settings.fov + speedFactor * 9 + (racer.boosting ? 7 : 0) + accelPunch + this.kick * 4;
    this.fov = snap ? targetFov : lerp(this.fov, targetFov, 1 - Math.exp(-5 * elapsed));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
