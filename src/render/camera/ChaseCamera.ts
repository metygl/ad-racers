import * as THREE from 'three';
import { clamp01, damp, lerp, wrapAngle } from '../../core/math';
import type { RacerState } from '../../game/sim/state';

/**
 * The chase camera.
 *
 * Almost all of the "feel" of a racing game lives here. The rules this one
 * follows:
 *
 *  - Follow the *velocity*, not the heading. Chasing the nose makes the camera
 *    whip round during a drift, which is both nauseating and useless — you want
 *    to see where you are going, which is where the skiff is going.
 *  - Never rotate faster than the player can read. The yaw is critically damped
 *    with a hard rate limit.
 *  - Sell speed with the field of view and the follow distance, not with shake.
 *  - When the player is looking at a countdown or a results screen, sit still.
 */

export type CameraMode = 'chase' | 'close' | 'orbit';

const MODE_SETTINGS: Record<CameraMode, { distance: number; height: number; look: number }> = {
  chase: { distance: 10.6, height: 4.0, look: 6 },
  close: { distance: 7.2, height: 2.9, look: 5 },
  orbit: { distance: 14, height: 6, look: 0 },
};

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

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.5, 4200);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Adds a shake impulse, in arbitrary units; 1 is a solid wall hit. */
  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount * this.shakeScale);
  }

  /** Snaps the camera behind a racer with no interpolation. */
  reset(racer: RacerState): void {
    this.yaw = racer.heading;
    this.shake = 0;
    this.orbitAngle = 0;
    this.initialised = false;
    this.apply(racer, 1 / 60, true);
  }

  update(racer: RacerState, elapsed: number, roughness: number): void {
    this.shake = Math.max(0, this.shake - elapsed * 2.4);
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

    // Aim the camera down the direction of travel once there is any, falling
    // back to the heading at a standstill.
    const travelling = speed > 3;
    const desiredYaw = travelling ? Math.atan2(racer.velocity.z, racer.velocity.x) : racer.heading;
    if (snap || !this.initialised) {
      this.yaw = desiredYaw;
      this.initialised = true;
    } else {
      // Damped approach with a hard rate limit. The limit is what stops a spin
      // from throwing the camera round faster than the eye can track.
      const delta = wrapAngle(desiredYaw - this.yaw);
      const step = delta * (1 - Math.exp(-6.5 * elapsed));
      const maxStep = 2.6 * elapsed;
      this.yaw = wrapAngle(this.yaw + Math.max(-maxStep, Math.min(maxStep, step)));
    }

    // Pull back and lift slightly with speed, which reads as acceleration
    // without touching the field of view.
    const speedFactor = clamp01(speed / 50);
    const distance = settings.distance + speedFactor * 2.1 + (racer.boosting ? 1.1 : 0);
    const height = settings.height + speedFactor * 0.55;

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
    // Deterministic wobble from the clock rather than random numbers, so shake
    // never introduces nondeterminism and never jitters at low frame rates.
    const t = performance.now() / 1000;
    const shakeX = Math.sin(t * 47) * shakeAmount * 0.34;
    const shakeY = Math.sin(t * 61 + 1.7) * shakeAmount * 0.28;

    this.camera.position.set(this.position.x + shakeX, this.position.y + shakeY, this.position.z);

    // Look slightly ahead of the skiff so the road, not the tail fin, is the
    // centre of the frame.
    const lookAhead = settings.look + speedFactor * 5;
    this.camera.lookAt(
      racer.pos.x + Math.cos(this.yaw) * lookAhead,
      racer.y + 1.35,
      racer.pos.z + Math.sin(this.yaw) * lookAhead,
    );

    // Field of view widens with speed and snaps wider on boost. This is the
    // single most effective speed cue available and costs nothing.
    const targetFov = 62 + speedFactor * 9 + (racer.boosting ? 7 : 0);
    this.fov = snap ? targetFov : lerp(this.fov, targetFov, 1 - Math.exp(-5 * elapsed));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
