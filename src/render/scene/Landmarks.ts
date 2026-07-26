import * as THREE from 'three';
import type { Track } from '../../game/track/buildTrack';
import type { LandmarkDefinition, PathSample } from '../../game/track/types';
import { familyMaterial } from '../materials/families';
import { mergeGeometries } from './mergeGeometry';
import type { MergePart } from './mergeGeometry';

/**
 * Landmarks: hand-placed structures at named points on a lap.
 *
 * Scenery is scattered, and scattering is the right tool for a thousand reeds.
 * It is the wrong tool for the thing a driver navigates by. ART-03 and ART-04's
 * shared complaint was that the courses are "repetitive" — and a scattered
 * course is repetitive *by construction*, because every metre of it is drawn
 * from the same distribution as every other metre. There is nothing to
 * recognise, so there is nowhere to be.
 *
 * A landmark is placed at one specific fraction of the lap, it is large enough
 * to be seen from elsewhere on the course, and it is the only one of its kind.
 * That is what makes a lap have *places* in it: the wall you brake at, the arch
 * you aim through, the light you can see from the far side of the infield and
 * use to know where you are. It is also the cheapest possible course identity —
 * three draw calls buy a skyline that a thousand more instances cannot.
 */

/** Builds one landmark's geometry, in local space with +X along the track. */
function landmarkParts(kind: LandmarkDefinition['kind'], scale: number): MergePart[] {
  switch (kind) {
    /*
     * The Vault — a collapsed dome rib, arching over the road.
     *
     * The signature set piece of Glasshouse Vigil, and the one thing on the
     * course a player drives *through*. It sits at the mouth of the Nave, so
     * the longest straight in the game starts with a gate: you can see who is
     * in front of you framed inside it, which is exactly the moment the tow
     * decision gets made.
     */
    case 'arch': {
      const parts: MergePart[] = [];
      const segments = 13;
      /*
       * The span is set by the run-off, not by taste.
       *
       * The legs have to stand outside the width a car can legitimately be
       * flung to, or the arch is a pair of pillars a player drives through
       * after a bad landing. At the Nave's 13.5 m half-width plus the run-off
       * margin that is 22.3 m each side, so the rib spans fifty metres — which
       * is also, conveniently, the right size for a dome rib over an arcology.
       */
      const span = 44 * scale;
      const rise = 30 * scale;
      /*
       * Each segment is long enough to reach the next one.
       *
       * Sizing a segment by `span / segments` is the obvious thing and it is
       * wrong: that is the *horizontal* spacing, and the arc between two
       * samples is longer than its chord everywhere except the crown. The
       * first version of this shipped an arch with a visible gap between every
       * rib segment, which at night read as a dashed line across the sky
       * rather than as a structure. Measuring the real chord and overlapping it
       * slightly is what makes it continuous.
       */
      const at = (i: number): [number, number] => {
        const angle = Math.PI * (i / (segments - 1));
        return [Math.sin(angle) * rise, -Math.cos(angle) * (span / 2)];
      };
      for (let i = 0; i < segments; i++) {
        const angle = Math.PI * (i / (segments - 1));
        const [y, z] = at(i);
        const [ny, nz] = at(Math.min(segments - 1, i + 1));
        const [py, pz] = at(Math.max(0, i - 1));
        const chord = Math.max(Math.hypot(ny - y, nz - z), Math.hypot(y - py, z - pz));
        // The rib thins towards the crown, because that is how an arch that
        // is still standing after three hundred years was built.
        const thickness = (1.5 - Math.sin(angle) * 0.6) * scale;
        parts.push({
          geometry: new THREE.BoxGeometry(2.6 * scale, thickness * 2.2, chord * 1.15),
          position: [0, y, z],
          rotation: [angle - Math.PI / 2, 0, 0],
        });
      }
      // The glazing bars that still span between the ribs, most of them gone.
      for (let i = 2; i < segments - 2; i += 2) {
        const t = i / (segments - 1);
        const angle = Math.PI * t;
        parts.push({
          geometry: new THREE.BoxGeometry(11 * scale, 0.32 * scale, 0.32 * scale),
          position: [0, Math.sin(angle) * rise, -Math.cos(angle) * (span / 2)],
        });
      }
      return parts;
    }
    /*
     * The Standing Wall — the one face of the arcology still upright.
     *
     * Placed along the outside of the Frames chicane, where a driver has a wall
     * on their right anyway. Its job is to give that section a *back*: a
     * chicane between two invisible barriers is a corridor, and a chicane
     * running along a hundred metres of ruined glazing is a place.
     */
    case 'wall': {
      const parts: MergePart[] = [];
      const bays = 7;
      for (let i = 0; i < bays; i++) {
        const x = (i - (bays - 1) / 2) * 13 * scale;
        // A ragged top line: every bay is a different height, and two of them
        // have come down entirely.
        const height = i === 2 || i === 5 ? 5 * scale : (16 + Math.sin(i * 2.1) * 6) * scale;
        parts.push({ geometry: new THREE.BoxGeometry(1.1 * scale, height, 1.1 * scale), position: [x, height / 2, 0] });
        if (i < bays - 1) {
          parts.push({
            geometry: new THREE.BoxGeometry(13 * scale, 0.9 * scale, 0.8 * scale),
            position: [x + 6.5 * scale, Math.min(height, 12 * scale), 0],
          });
        }
      }
      return parts;
    }
    /*
     * The Beacon — a single mast far taller than the rest, still lit.
     *
     * The navigation landmark. It stands at the top of the Terraces, which is
     * the highest point of the course, and it is visible from most of the lap —
     * so a driver in the Cistern at the bottom of the course can see where the
     * climb goes. That is a real navigational aid, not decoration: this is a
     * night course, and knowing which way is "up the hill" without being able
     * to see the road is the difference between committing and lifting.
     */
    case 'beacon': {
      const parts: MergePart[] = [];
      const height = 46 * scale;
      // A lattice, not a pole: four legs drawing in towards the top with cross
      // bracing, so it reads as a structure at any distance.
      for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
        parts.push({
          geometry: new THREE.CylinderGeometry(0.22 * scale, 0.4 * scale, height, 5),
          position: [sx * 1.9 * scale, height / 2, sz * 1.9 * scale],
          rotation: [sz * 0.045, 0, -sx * 0.045],
        });
      }
      for (let i = 1; i < 7; i++) {
        const y = (i / 7) * height;
        parts.push({ geometry: new THREE.BoxGeometry(4.4 * scale, 0.24 * scale, 0.24 * scale), position: [0, y, -1.8 * scale] });
        parts.push({ geometry: new THREE.BoxGeometry(0.24 * scale, 0.24 * scale, 4.4 * scale), position: [1.8 * scale, y, 0] });
      }
      return parts;
    }
  }
}

/** The lamp head on a beacon, in the emitter family so it actually glows. */
function beaconHead(scale: number, accent: number): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const height = 46 * scale;
  return {
    geometry: mergeGeometries([
      { geometry: new THREE.CylinderGeometry(2.4 * scale, 1.6 * scale, 2.6 * scale, 8), position: [0, height + 1.3 * scale, 0] },
    ]),
    material: familyMaterial('emitter', {
      color: 0x2b3540,
      emissive: accent,
      // Bright, and deliberately the brightest thing on the course that is not
      // a skiff. It is what the course is *for* — a light kept running.
      emissiveIntensity: 2.2,
      repeat: 1,
    }),
  };
}

/**
 * Places every landmark a course declares.
 *
 * One draw call each. Positions come from the same centreline the physics uses,
 * so a landmark can never end up describing a corner the course does not have.
 */
export function buildLandmarks(track: Track, heightAt: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const landmarks = track.definition.landmarks ?? [];
  if (landmarks.length === 0) return group;

  const samples = track.main.samples;
  const theme = track.definition.theme;

  for (const landmark of landmarks) {
    const index = Math.min(samples.length - 1, Math.max(0, Math.round(landmark.at * samples.length)));
    const sample = samples[index] as PathSample;
    const lateral = landmark.lateral * sample.halfWidth;
    const x = sample.pos.x + sample.normal.x * lateral;
    const z = sample.pos.z + sample.normal.z * lateral;
    const scale = landmark.scale ?? 1;

    const geometry = mergeGeometries(landmarkParts(landmark.kind, scale));
    const material = familyMaterial(landmark.kind === 'wall' ? 'corroded' : 'structure', {
      color: new THREE.Color(theme.shoulderColor).multiplyScalar(landmark.kind === 'wall' ? 0.78 : 0.92),
      repeat: 4,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `landmark-${landmark.kind}`;
    mesh.position.set(x, heightAt(x, z) - 0.5, z);
    // Aligned to the track tangent, so an arch spans the road rather than
    // standing across it at whatever angle the world axes happen to give.
    mesh.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z) - Math.PI / 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);

    if (landmark.kind === 'beacon') {
      const head = beaconHead(scale, theme.kerbColor ?? theme.speedLineColor);
      const headMesh = new THREE.Mesh(head.geometry, head.material);
      headMesh.name = 'landmark-beacon-head';
      headMesh.position.copy(mesh.position);
      headMesh.rotation.copy(mesh.rotation);
      group.add(headMesh);
    }
  }

  return group;
}
