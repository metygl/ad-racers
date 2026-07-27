/**
 * The AD Racers cast and their skiffs.
 *
 * Setting: three hundred years after the Long Quiet, the old motorways are
 * green again. Salvage crews build "skiffs" — two-seat hover-bikes with a
 * bolted-on outrigger pod — out of whatever the Reclaim gives up. A skiff
 * carries a pilot on the spine and a wrench in the pod, and the Reclaim
 * Circuit is where the crews settle who gets the next dig site.
 *
 * All names, crews, machines and silhouettes here are original to this
 * project. See docs/PROVENANCE.md.
 */

import { SPEED_CLASSES } from './config';
import type { SpeedClass } from './config';

export interface RacerStats {
  /** 0-1; maps to top speed. */
  topSpeed: number;
  /** 0-1; maps to engine force. */
  acceleration: number;
  /** 0-1; maps to lateral grip. */
  grip: number;
  /** 0-1; heavier skiffs win collisions and resist shoves. */
  weight: number;
  /** 0-1; scales the companion's reach and shove. */
  reach: number;
}

export interface RacerProfile {
  id: string;
  /** Pilot name. */
  pilot: string;
  /** Wrench (outrigger companion) name. */
  wrench: string;
  crew: string;
  skiff: string;
  /** Short character line shown on the select card. */
  blurb: string;
  stats: RacerStats;
  /** Body, trim and glow colours, as hex numbers. */
  colors: { body: number; trim: number; glow: number };
}

export const RACERS: readonly RacerProfile[] = [
  {
    id: 'thornline',
    pilot: 'Bramble',
    wrench: 'Vex',
    crew: 'Thornline',
    skiff: 'Nettlecutter',
    blurb: 'Grew up racing service tunnels. Turns in before anyone else dares.',
    stats: { topSpeed: 0.62, acceleration: 0.78, grip: 0.88, weight: 0.34, reach: 0.55 },
    colors: { body: 0x2f7d4f, trim: 0xd8f06a, glow: 0x8dff9e },
  },
  {
    id: 'foundry',
    pilot: 'Kilo',
    wrench: 'Pip',
    crew: 'Foundry Six',
    skiff: 'Anvilback',
    blurb: 'Built the skiff out of a bridge girder. It shows, in both directions.',
    stats: { topSpeed: 0.58, acceleration: 0.52, grip: 0.6, weight: 0.95, reach: 0.82 },
    colors: { body: 0xb4562a, trim: 0xf0a04b, glow: 0xffcb6b },
  },
  {
    id: 'nightgrove',
    pilot: 'Sable',
    wrench: 'Moth',
    crew: 'Nightgrove',
    skiff: 'Duskwing',
    blurb: 'Runs without lamps. Says the pod tells her where the walls are.',
    stats: { topSpeed: 0.72, acceleration: 0.66, grip: 0.7, weight: 0.55, reach: 0.9 },
    colors: { body: 0x3b3560, trim: 0x9d8bd8, glow: 0xc9a6ff },
  },
  {
    id: 'emberworks',
    pilot: 'Rusk',
    wrench: 'Tinder',
    crew: 'Emberworks',
    skiff: 'Cinderjack',
    blurb: 'Fastest thing in the Reclaim, right up until the first proper corner.',
    stats: { topSpeed: 0.96, acceleration: 0.84, grip: 0.42, weight: 0.48, reach: 0.5 },
    colors: { body: 0xc0392b, trim: 0xffb03a, glow: 0xff7a3c },
  },
  {
    id: 'boneyard',
    pilot: 'Marrow',
    wrench: 'Cobb',
    crew: 'Boneyard',
    skiff: 'Ossuary',
    blurb: 'Slow to wake up, impossible to move once it is going.',
    stats: { topSpeed: 0.68, acceleration: 0.38, grip: 0.74, weight: 0.86, reach: 0.72 },
    colors: { body: 0xcfc6ad, trim: 0x7a6f5b, glow: 0xe8e0c4 },
  },
  {
    id: 'greenline',
    pilot: 'Juniper',
    wrench: 'Sprocket',
    crew: 'Greenline',
    skiff: 'Sapling',
    blurb: 'Never wins the straights. Somehow keeps arriving first anyway.',
    stats: { topSpeed: 0.5, acceleration: 0.92, grip: 0.96, weight: 0.4, reach: 0.45 },
    colors: { body: 0x1f9bb5, trim: 0xa8f0e0, glow: 0x7fe8ff },
  },
] as const;

/** Derived, absolute vehicle parameters used by the physics. */
export interface VehicleSpec {
  /** Top speed on tarmac, m/s. */
  topSpeed: number;
  /** Engine force at zero speed, m/s². */
  enginePower: number;
  /** Lateral grip rate. */
  grip: number;
  /** Mass in arbitrary but consistent units; only ratios matter. */
  mass: number;
  /** Companion reach, m. */
  reach: number;
  /** Multiplier on the shove imparted by a successful strike. */
  shove: number;
}

/**
 * Maps the 0-1 designer-facing stats onto physics numbers, at a speed class.
 *
 * Kept narrow on purpose: the spread between the fastest and slowest skiff is
 * about 12% of top speed, so character choice flavours a race without deciding
 * it. What a crew never changes is *how a drift charges* — those thresholds are
 * global. Making the skill mechanic a stat means the player picks their skill
 * ceiling in a menu, which is the thing the current Mario Kart generation
 * deliberately reverted; see `docs/DESIGN-DIRECTION.md`.
 *
 * The speed class scales the whole field identically, so it moves the game
 * rather than the balance.
 */
export function toVehicleSpec(stats: RacerStats, speedClass: SpeedClass = SPEED_CLASSES[0] as SpeedClass): VehicleSpec {
  /*
   * The speed/grip trade is deliberately weighted towards speed.
   *
   * Cornering is grip limited everywhere on a lap while top speed only pays on
   * the straights, so a naive stat mapping makes grip strictly dominant and the
   * low-grip archetype — the one whose whole character is "fastest thing in the
   * Reclaim, right up until the first proper corner" — can never podium. It was
   * measurably shut out at a 14% speed spread against a 39% grip spread.
   * Widening speed and narrowing grip puts the fast crew back on the podium on
   * the open courses without letting it near the top of the technical one,
   * which is exactly the shape the character asks for.
   *
   * It needs re-checking after any physics change, and has needed it twice.
   * Giving the hull a real two-lobe shape moved contact from "centres within
   * 2.7 m" to "noses within 4.4 m", which is a different pack, and a census of
   * twenty races put Emberworks back down to a single podium against
   * Greenline's eighteen. The spreads here are the dial for that.
   *
   * `tests/unit/fairness.test.ts` asserts every crew reaches a podium
   * somewhere, which is what pins this down.
   */
  return {
    topSpeed: (43.4 + stats.topSpeed * 12.2) * speedClass.scale,
    enginePower: (20 + stats.acceleration * 9) * speedClass.scale,
    grip: (9.95 + stats.grip * 2.45) * speedClass.gripScale,
    mass: 0.78 + stats.weight * 0.5,
    reach: 3.2 + stats.reach * 1.0,
    shove: 0.82 + stats.reach * 0.4,
  };
}

export function getRacer(id: string): RacerProfile {
  const found = RACERS.find((r) => r.id === id);
  if (!found) throw new Error(`Unknown racer: ${id}`);
  return found;
}

export function normalizeRacerId(id: string): string {
  return RACERS.some((racer) => racer.id === id) ? id : (RACERS[0]?.id ?? 'thornline');
}
