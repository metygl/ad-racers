import type * as THREE from 'three';

/**
 * Which textures a material owns, and therefore has to release.
 *
 * Most maps in this game are *shared*: one procedural canvas per family or per
 * surface, cached by key and torn down once by `disposeTextures()`. A few are
 * not. `familyMaterial` and the skiff's `panel` both clone a shared map so they
 * can set their own `repeat`, and a clone is a second `THREE.Texture` with its
 * own GPU bookkeeping - three refcounts the underlying source, so a clone that
 * is never disposed holds that source allocated for the life of the page even
 * after the original has gone.
 *
 * Nothing about a material says which of its maps are shared and which are its
 * own, and guessing is how this leaked: the vehicle teardown disposed materials
 * and geometry and left roughly three cloned textures per skiff behind on every
 * race rebuild, and course teardown did the same for every piece of scenery.
 * So ownership is *recorded* at the point the clone is made, and
 * `disposeMaterial` is the only correct way to release a material afterwards.
 */

const owned = new WeakMap<THREE.Material, THREE.Texture[]>();

/**
 * Records that `material` owns `texture` outright. Returns the texture, so a
 * clone can be registered inline where it is made.
 */
export function ownTexture<T extends THREE.Texture>(material: THREE.Material, texture: T): T {
  const list = owned.get(material);
  if (list) list.push(texture);
  else owned.set(material, [texture]);
  return texture;
}

/** Releases a material and every texture it owns. */
export function disposeMaterial(material: THREE.Material): void {
  for (const texture of owned.get(material) ?? []) texture.dispose();
  owned.delete(material);
  material.dispose();
}

/** Releases every material on an object, with the textures each one owns. */
export function disposeMaterialsOf(object: THREE.Object3D): void {
  const material = (object as THREE.Mesh).material;
  if (Array.isArray(material)) for (const one of material) disposeMaterial(one);
  else if (material) disposeMaterial(material);
}
