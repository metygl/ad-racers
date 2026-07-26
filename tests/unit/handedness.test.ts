import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fromHeading, leftOf, rightOf } from '../../src/core/math';
import { applyStrike, isInStrikeEnvelope } from '../../src/game/sim/combat';
import { COMBAT } from '../../src/game/config';
import { Simulation } from '../../src/game/sim/simulation';
import { emptyInput } from '../../src/game/sim/state';
import type { RacerState, SimEvent } from '../../src/game/sim/state';
import { getDifficulty } from '../../src/game/ai/driver';
import { getTrack } from '../../src/game/track/tracks';

/**
 * Left and right, pinned down in screen space.
 *
 * This suite exists because the game shipped with its steering mirrored, and
 * the reason it survived every other test is worth stating plainly: the whole
 * codebase was *self-consistently* wrong. The simulation's +90° basis vector
 * was named `leftOf` when in three.js's Y-up right-handed world it is the
 * vehicle's right; `stepVehicle` negated the yaw to compensate; the AI negated
 * its own steering to compensate for that. Every internal invariant held. Only
 * a human pressing "right" could tell.
 *
 * So these tests deliberately do not assert on the simulation's own vocabulary.
 * They build the camera the renderer builds, project world positions through
 * it, and assert on which way the pixels move. That is the only frame of
 * reference a player has, and it is the one that was wrong.
 */

const FPS = 120;

function soloRace(): Simulation {
  return new Simulation({
    track: getTrack('overgrown-interchange'),
    entries: [{ profileId: 'thornline', isPlayer: true }],
    difficulty: getDifficulty('pro'),
    seed: 7,
    catchUp: false,
  });
}

/**
 * The chase camera, reproduced exactly as `ChaseCamera` builds it: sat behind
 * the racer along its direction of travel, looking ahead down the same line.
 */
function chaseCameraFor(racer: RacerState): THREE.PerspectiveCamera {
  const yaw = Math.atan2(racer.velocity.z, racer.velocity.x);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 4200);
  camera.position.set(racer.pos.x - Math.cos(yaw) * 10.6, racer.y + 4, racer.pos.z - Math.sin(yaw) * 10.6);
  camera.lookAt(racer.pos.x + Math.cos(yaw) * 6, racer.y + 1.35, racer.pos.z + Math.sin(yaw) * 6);
  camera.updateMatrixWorld();
  return camera;
}

/** Normalised device X of a world point: -1 is the left edge of the screen. */
function screenX(camera: THREE.PerspectiveCamera, x: number, z: number): number {
  return new THREE.Vector3(x, 0, z).project(camera).x;
}

/** Runs a solo racer up to speed in a straight line and returns it. */
function upToSpeed(sim: Simulation, seconds = 6): RacerState {
  for (let i = 0; i < FPS * seconds; i++) sim.step({ ...emptyInput(), throttle: 1 });
  const player = sim.player;
  if (!player) throw new Error('no player');
  return player;
}

describe('the handedness rule', () => {
  it('puts the +90° rotation on the vehicle’s right, where three.js does', () => {
    // At heading 0 the nose is +X and up is +Y, so right = forward × up = +Z.
    const forward = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const right = forward.clone().cross(up).normalize();

    expect(right.x).toBeCloseTo(rightOf(0).x, 12);
    expect(right.z).toBeCloseTo(rightOf(0).z, 12);
    expect(leftOf(0).x).toBeCloseTo(-right.x, 12);
    expect(leftOf(0).z).toBeCloseTo(-right.z, 12);
  });

  it('agrees with the camera: the vehicle’s right is screen right', () => {
    const sim = soloRace();
    const player = upToSpeed(sim);
    const camera = chaseCameraFor(player);

    const right = rightOf(player.heading);
    const here = screenX(camera, player.pos.x, player.pos.z);
    const toTheRight = screenX(camera, player.pos.x + right.x * 8, player.pos.z + right.z * 8);

    expect(toTheRight).toBeGreaterThan(here);
  });
});

describe('steering', () => {
  it('moves the skiff to the right of the screen when the player steers right', () => {
    const sim = soloRace();
    const player = upToSpeed(sim);
    const camera = chaseCameraFor(player);
    const before = screenX(camera, player.pos.x, player.pos.z);

    for (let i = 0; i < FPS * 1.2; i++) sim.step({ ...emptyInput(), throttle: 1, steer: 1 });

    expect(screenX(camera, player.pos.x, player.pos.z)).toBeGreaterThan(before);
  });

  it('moves it to the left of the screen when the player steers left', () => {
    const sim = soloRace();
    const player = upToSpeed(sim);
    const camera = chaseCameraFor(player);
    const before = screenX(camera, player.pos.x, player.pos.z);

    for (let i = 0; i < FPS * 1.2; i++) sim.step({ ...emptyInput(), throttle: 1, steer: -1 });

    expect(screenX(camera, player.pos.x, player.pos.z)).toBeLessThan(before);
  });

  it('turns the nose the same way the skiff travels', () => {
    const sim = soloRace();
    const player = upToSpeed(sim);
    const startHeading = player.heading;

    for (let i = 0; i < FPS; i++) sim.step({ ...emptyInput(), throttle: 1, steer: 1 });

    // A right turn increases the heading, and the model yaw the renderer applies
    // (`rotation.y = -heading`) must rotate the nose the same way.
    expect(player.heading).toBeGreaterThan(startHeading);
    const before = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, -startHeading, 0));
    const after = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, -player.heading, 0));
    // Cross product about +Y is negative for a clockwise-from-above turn, which
    // with +Z towards the viewer is a turn to the right.
    expect(before.clone().cross(after).y).toBeLessThan(0);
  });

  it('reverses the steering when the skiff is going backwards, as a car does', () => {
    const sim = soloRace();
    const player = upToSpeed(sim, 1);
    // Brake all the way through zero into reverse.
    for (let i = 0; i < FPS * 4; i++) sim.step({ ...emptyInput(), brake: true });
    const reversing = player.velocity.x * Math.cos(player.heading) + player.velocity.z * Math.sin(player.heading);
    expect(reversing).toBeLessThan(-1);

    const startHeading = player.heading;
    for (let i = 0; i < FPS; i++) sim.step({ ...emptyInput(), brake: true, steer: 1 });
    expect(player.heading).toBeLessThan(startHeading);
  });
});

describe('the companion strike', () => {
  /** Two racers side by side, `offset` metres out on the given side. */
  function pair(side: -1 | 1): { attacker: RacerState; target: RacerState; sim: Simulation } {
    const sim = new Simulation({
      track: getTrack('overgrown-interchange'),
      entries: [
        { profileId: 'thornline', isPlayer: true },
        { profileId: 'foundry', isPlayer: false },
      ],
      difficulty: getDifficulty('pro'),
      seed: 3,
      catchUp: false,
    });
    const [attacker, target] = sim.racers as [RacerState, RacerState];
    attacker.heading = 0.4;
    target.heading = 0.4;
    const out = side === 1 ? rightOf(attacker.heading) : leftOf(attacker.heading);
    target.pos = { x: attacker.pos.x + out.x * 2.4, z: attacker.pos.z + out.z * 2.4 };
    return { attacker, target, sim };
  }

  it('reaches a rival on the right when striking right, and not one on the left', () => {
    const right = pair(1);
    expect(isInStrikeEnvelope(right.attacker, right.target, 1)).toBe(true);
    expect(isInStrikeEnvelope(right.attacker, right.target, -1)).toBe(false);
  });

  it('reaches a rival on the left when striking left, and not one on the right', () => {
    const left = pair(-1);
    expect(isInStrikeEnvelope(left.attacker, left.target, -1)).toBe(true);
    expect(isInStrikeEnvelope(left.attacker, left.target, 1)).toBe(false);
  });

  it('shoves the victim outwards, away from the attacker', () => {
    for (const side of [-1, 1] as const) {
      const { attacker, target } = pair(side);
      target.velocity = { x: 0, z: 0 };
      const events: SimEvent[] = [];
      applyStrike(attacker, target, side, 1, { dt: 1 / FPS, raceTime: 10, events, racers: [attacker, target] });

      const out = side === 1 ? rightOf(attacker.heading) : leftOf(attacker.heading);
      const outwards = target.velocity.x * out.x + target.velocity.z * out.z;
      expect(outwards).toBeGreaterThan(COMBAT.shove * 0.5);
    }
  });
});

describe('the audio listener', () => {
  it('pans a rival alongside to the ear on that side', () => {
    // Reproduces `AudioEngine`'s pan term against a known-good right vector.
    const yaw = 1.13;
    const right = rightOf(yaw);
    const forward = fromHeading(yaw);
    const pan = (dx: number, dz: number): number => -Math.sin(yaw) * dx + Math.cos(yaw) * dz;

    expect(pan(right.x * 10, right.z * 10)).toBeGreaterThan(9);
    expect(pan(-right.x * 10, -right.z * 10)).toBeLessThan(-9);
    // A rival dead ahead belongs in the middle of the mix, not in one ear.
    expect(Math.abs(pan(forward.x * 10, forward.z * 10))).toBeLessThan(1e-9);
  });
});
