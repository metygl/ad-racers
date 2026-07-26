import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Simulation } from '../../src/game/sim/simulation';
import { getTrack } from '../../src/game/track/tracks';
import { emptyInput } from '../../src/game/sim/state';
import { getDifficulty } from '../../src/game/ai/driver';

describe('steering handedness probe', () => {
  it('reports which way the world moves when the player steers right', () => {
    const track = getTrack('overgrown-interchange');
    const sim = new Simulation({
      track,
      entries: [{ profileId: 'thornline', isPlayer: true }],
      difficulty: getDifficulty('pro'),
      seed: 1,
      catchUp: false,
    });
    const player = sim.player!;
    // Get up to speed straight.
    for (let i = 0; i < 120 * 6; i++) sim.step({ ...emptyInput(), throttle: 1 });
    const h0 = player.heading;
    const p0 = { ...player.pos };

    // Camera basis at this instant, exactly as ChaseCamera builds it.
    const yaw = Math.atan2(player.velocity.z, player.velocity.x);
    const camPos = new THREE.Vector3(p0.x - Math.cos(yaw) * 10, 4, p0.z - Math.sin(yaw) * 10);
    const cam = new THREE.PerspectiveCamera(62, 1.6, 0.5, 4200);
    cam.position.copy(camPos);
    cam.lookAt(p0.x + Math.cos(yaw) * 6, 1.35, p0.z + Math.sin(yaw) * 6);
    cam.updateMatrixWorld();
    const before = new THREE.Vector3(p0.x, 0, p0.z).project(cam);

    for (let i = 0; i < 120 * 1.2; i++) sim.step({ ...emptyInput(), throttle: 1, steer: 1 });

    const after = new THREE.Vector3(player.pos.x, 0, player.pos.z).project(cam);
    const screenDx = after.x - before.x;

    // Model yaw as the renderer applies it.
    const modelBefore = new THREE.Object3D();
    modelBefore.rotation.y = -h0;
    const modelAfter = new THREE.Object3D();
    modelAfter.rotation.y = -player.heading;
    const fwdBefore = new THREE.Vector3(1, 0, 0).applyEuler(modelBefore.rotation);
    const fwdAfter = new THREE.Vector3(1, 0, 0).applyEuler(modelAfter.rotation);
    // Signed turn about world +Y: positive = counter-clockwise seen from above
    // (which, with +Z toward the viewer, is a turn to the vehicle's LEFT).
    const turnY = fwdBefore.clone().cross(fwdAfter).y;

    console.log(JSON.stringify({
      headingDelta: player.heading - h0,
      screenDx,
      turnAboutY: turnY,
      verdict: screenDx < 0 ? 'car moved LEFT on screen' : 'car moved RIGHT on screen',
    }, null, 2));
    expect(Number.isFinite(screenDx)).toBe(true);
  });
});
