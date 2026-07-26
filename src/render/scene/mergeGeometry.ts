import * as THREE from 'three';

/**
 * Merges transformed primitives into a single geometry.
 *
 * Draw calls, not triangles, are the budget that matters here: a skiff built
 * from twenty small meshes costs twenty draw calls, and six of them on a grid
 * cost a hundred and twenty — more than the entire rest of the scene put
 * together. Merging everything that shares a material collapses that to one
 * call per material, for exactly the same pixels.
 *
 * Written out rather than pulled from `three/examples`, because the example
 * helper is not part of the published entry point and this is twenty lines.
 */

export interface MergePart {
  geometry: THREE.BufferGeometry;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /**
   * Per-part colour, written into a vertex-colour attribute.
   *
   * The escape hatch for the one case merging cannot otherwise reach: an
   * assembly whose parts are different *colours* but the same material. A
   * rider's dark gear and their crew-coloured shoulder yoke are two draw calls
   * as two materials and one as two vertex colours, and six skiffs make that
   * difference six times over. Supply it on every part or none — a mixed set
   * would leave the rest black.
   */
  color?: THREE.ColorRepresentation;
}

export function mergeGeometries(parts: readonly MergePart[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const tint = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const vector = new THREE.Vector3();

  for (const part of parts) {
    // Non-indexed keeps the merge trivial; these are tens of triangles each.
    const source = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    const positionAttribute = source.getAttribute('position');
    const normalAttribute = source.getAttribute('normal');

    matrix.compose(
      new THREE.Vector3(...(part.position ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(part.rotation ?? [0, 0, 0]))),
      new THREE.Vector3(...(part.scale ?? [1, 1, 1])),
    );
    normalMatrix.getNormalMatrix(matrix);

    for (let i = 0; i < positionAttribute.count; i++) {
      vector.fromBufferAttribute(positionAttribute, i).applyMatrix4(matrix);
      positions.push(vector.x, vector.y, vector.z);
      if (normalAttribute) {
        vector.fromBufferAttribute(normalAttribute, i).applyMatrix3(normalMatrix).normalize();
        normals.push(vector.x, vector.y, vector.z);
      }
      if (part.color !== undefined) {
        tint.set(part.color);
        colors.push(tint.r, tint.g, tint.b);
      }
    }

    if (source !== part.geometry) source.dispose();
    part.geometry.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    merged.computeVertexNormals();
  }
  if (colors.length === positions.length) {
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  merged.computeBoundingSphere();
  return merged;
}
