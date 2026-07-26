import { dot, fromHeading, leftOf, rightOf } from '../../core/math';
import type { Vec2 } from '../../core/math';
import { COMBAT, SURGE } from '../config';
import type { ControlInput, RacerState, SimEvent } from './state';

/**
 * The companion strike.
 *
 * Every skiff carries a wrench in the outrigger pod who can swing a
 * counterweighted grapple arm at a rival running alongside. The design rules
 * this file enforces:
 *
 *  - It is a *positional* move, not a projectile: you have to earn the
 *    alongside position first, which means racing well is the prerequisite.
 *  - It telegraphs. `windup` is long enough (0.16 s) to see and react to, and
 *    the renderer rears the pod arm back during it.
 *  - It cannot chain. Repeat hits on the same rival decay hard, so nobody gets
 *    stun-locked out of a race.
 *  - It is symmetric. The AI goes through exactly this code path with exactly
 *    these timings; difficulty changes *when* it swings, never what a swing does.
 */

export interface CombatContext {
  dt: number;
  raceTime: number;
  events: SimEvent[];
  racers: RacerState[];
}

/** Unit vector pointing out along the striking side. */
function towards(headingRad: number, side: -1 | 1): Vec2 {
  return side === 1 ? rightOf(headingRad) : leftOf(headingRad);
}

export function canStartStrike(racer: RacerState, raceTime: number): boolean {
  return (
    racer.strike.phase === 'idle' &&
    racer.strike.cooldown <= 0 &&
    racer.stagger <= 0 &&
    !racer.airborne &&
    raceTime >= COMBAT.graceAfterStart &&
    !racer.finished
  );
}

/** Advances one racer's strike state machine and resolves any hits. */
export function stepCombat(racer: RacerState, input: ControlInput, ctx: CombatContext): void {
  const strike = racer.strike;

  if (input.strike !== 0 && canStartStrike(racer, ctx.raceTime)) {
    strike.phase = 'windup';
    strike.timer = COMBAT.windup;
    strike.side = input.strike;
    strike.cooldown = COMBAT.cooldown;
    strike.hitThisSwing = [];
    ctx.events.push({ type: 'strikeSwing', racer: racer.index, side: strike.side });
  }

  if (strike.phase === 'idle') return;

  strike.timer -= ctx.dt;

  if (strike.phase === 'active') resolveSwing(racer, ctx);

  if (strike.timer <= 0) {
    switch (strike.phase) {
      case 'windup':
        strike.phase = 'active';
        strike.timer = COMBAT.active;
        // Resolve on the first active frame too, so a swing that starts and
        // ends inside one step still connects.
        resolveSwing(racer, ctx);
        break;
      case 'active':
        strike.phase = 'recovery';
        strike.timer = COMBAT.recovery;
        break;
      case 'recovery':
        strike.phase = 'idle';
        strike.timer = 0;
        break;
    }
  }
}

/** Multiplier for a strike, given how often this attacker has already landed. */
export function guardMultiplier(target: RacerState, attackerIndex: number): number {
  const guard = target.guards.find((g) => g.attacker === attackerIndex);
  if (!guard) return 1;
  return Math.max(COMBAT.guardFloor, Math.pow(COMBAT.guardDecay, guard.hits));
}

function registerGuard(target: RacerState, attackerIndex: number): void {
  const guard = target.guards.find((g) => g.attacker === attackerIndex);
  if (guard) {
    guard.hits += 1;
    guard.timer = COMBAT.guardWindow;
  } else {
    target.guards.push({ attacker: attackerIndex, hits: 1, timer: COMBAT.guardWindow });
  }
}

/** True when `target` is inside `attacker`'s strike envelope on `side`. */
export function isInStrikeEnvelope(attacker: RacerState, target: RacerState, side: -1 | 1): boolean {
  // A tiered track can put two racers on top of each other in plan view; the
  // pod arm does not reach across a height difference.
  if (Math.abs(attacker.y - target.y) > 2.5) return false;

  const rel: Vec2 = { x: target.pos.x - attacker.pos.x, z: target.pos.z - attacker.pos.z };
  const forward = fromHeading(attacker.heading);
  const ahead = dot(rel, forward);
  // Measured straight out along the striking side, so it is always "how far out
  // on the side the arm is swinging towards".
  const lateral = dot(rel, towards(attacker.heading, side));

  const reach = attacker.spec.reach;
  return (
    lateral >= COMBAT.minReach &&
    lateral <= reach &&
    ahead >= COMBAT.forwardMin &&
    ahead <= COMBAT.forwardMax
  );
}

function resolveSwing(attacker: RacerState, ctx: CombatContext): void {
  const side = attacker.strike.side;
  for (const target of ctx.racers) {
    if (target.index === attacker.index || target.finished) continue;
    if (attacker.strike.hitThisSwing.includes(target.index)) continue;
    if (!isInStrikeEnvelope(attacker, target, side)) continue;

    attacker.strike.hitThisSwing.push(target.index);

    // Two riders swinging at each other at the same moment cancel out. This is
    // the skill ceiling of the mechanic: a well-timed counter beats a strike.
    if (target.strike.phase === 'windup' || target.strike.phase === 'active') {
      attacker.stagger = Math.max(attacker.stagger, COMBAT.counterStagger);
      target.stagger = Math.max(target.stagger, COMBAT.counterStagger);
      attacker.strike.phase = 'recovery';
      attacker.strike.timer = COMBAT.recovery;
      target.strike.phase = 'recovery';
      target.strike.timer = COMBAT.recovery;
      ctx.events.push({ type: 'strikeCounter', a: attacker.index, b: target.index });
      continue;
    }

    const strength = guardMultiplier(target, attacker.index);
    registerGuard(target, attacker.index);

    applyStrike(attacker, target, side, strength, ctx);
  }
}

/** Applies the mechanical effect of a landed strike. Exported for tests. */
export function applyStrike(
  attacker: RacerState,
  target: RacerState,
  side: -1 | 1,
  strength: number,
  ctx: CombatContext,
): void {
  const massRatio = attacker.spec.mass / target.spec.mass;
  const shove = COMBAT.shove * strength * attacker.spec.shove * Math.min(1.6, massRatio);

  // Push the target away from the attacker, in the attacker's frame, so a
  // strike always sends the victim outwards rather than through you.
  const pushDir = towards(attacker.heading, side);
  target.velocity = {
    x: target.velocity.x + pushDir.x * shove,
    z: target.velocity.z + pushDir.z * shove,
  };

  const speedLoss = 1 - (1 - COMBAT.speedPenalty) * strength;
  target.velocity = { x: target.velocity.x * speedLoss, z: target.velocity.z * speedLoss };

  target.stagger = Math.max(target.stagger, COMBAT.staggerTime * strength);
  target.drift.active = false;
  target.drift.charge = 0;
  target.strikesTaken += 1;

  attacker.strikesLanded += 1;
  attacker.surge = Math.min(SURGE.max, attacker.surge + SURGE.hitGain * strength);

  ctx.events.push({
    type: 'strikeHit',
    attacker: attacker.index,
    target: target.index,
    strength,
    pos: { x: (attacker.pos.x + target.pos.x) / 2, z: (attacker.pos.z + target.pos.z) / 2 },
  });
}
