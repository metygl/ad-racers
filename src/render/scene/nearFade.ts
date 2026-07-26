import * as THREE from 'three';

/**
 * Course furniture that gets out of the camera's way.
 *
 * The round-2 motion review's one Critical finding was that Glasshouse
 * "geometry repeatedly enters the near plane as a black wedge with a mint
 * underside", blocking the forward sightline at the grid, during collisions,
 * during boost, on desktop, on mobile, in every quality tier and with reduced
 * motion on. The art review reported the same object as a wedge "cutting
 * diagonally through the desktop start". It is the start gantry: a beam with a
 * lit underside, hanging seven metres over a grid the chase camera sits behind
 * and below.
 *
 * The existing protection was a single ray cast backwards from the racer, which
 * can only find something between the camera and the car. It cannot see an
 * object the camera is about to pass *through*, and it does not consider the
 * frustum at all.
 *
 * This is the other half: anything registered here fades out as the camera
 * closes on it and is gone before it can fill the frame. Fading rather than
 * culling, because a large structure vanishing in one frame reads as a bug;
 * and by distance rather than by screen coverage, because distance is stable
 * whatever the camera is doing and cannot oscillate.
 *
 * Only *big* things belong here — gantries, arches, standing walls. Small
 * scenery is handled by the boom raycast, and a course that faded everything
 * near the camera would dissolve as you drove through it.
 */

/** Distance at which a registered structure has faded out completely. */
const GONE = 9;
/** Distance at which it is still fully drawn. */
const SOLID = 26;

interface Faded {
  object: THREE.Object3D;
  materials: (THREE.Material & { opacity: number; transparent: boolean })[];
  /** Whatever opacity the material was authored with. */
  base: number[];
}

export class NearFade {
  private readonly entries: Faded[] = [];
  private readonly worldPosition = new THREE.Vector3();

  /**
   * Registers an object and every material it draws with.
   *
   * The materials are made transparent up front rather than at fade time: a
   * material switching to transparent mid-frame forces a shader recompile, and
   * doing that while the player drives under an arch is a visible hitch.
   */
  add(object: THREE.Object3D): void {
    const materials: (THREE.Material & { opacity: number; transparent: boolean })[] = [];
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const typed = material as THREE.Material & { opacity: number; transparent: boolean };
        typed.transparent = true;
        typed.depthWrite = true;
        if (!materials.includes(typed)) materials.push(typed);
      }
    });
    if (materials.length === 0) return;
    this.entries.push({ object, materials, base: materials.map((m) => m.opacity) });
  }

  /** Fades everything registered against the camera's current position. */
  update(camera: THREE.Camera): void {
    for (const entry of this.entries) {
      entry.object.getWorldPosition(this.worldPosition);
      const distance = this.worldPosition.distanceTo(camera.position);
      const visibility = Math.max(0, Math.min(1, (distance - GONE) / (SOLID - GONE)));
      entry.materials.forEach((material, index) => {
        material.opacity = (entry.base[index] ?? 1) * visibility;
      });
      // Below a pixel of contribution there is nothing to draw, and skipping it
      // keeps a fully faded structure off the draw-call budget entirely.
      entry.object.visible = visibility > 0.02;
    }
  }

  clear(): void {
    this.entries.length = 0;
  }
}
