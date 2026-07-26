import { Rng, hashSeed } from '../../core/rng';
import { clamp, clamp01, distance, dot, fromHeading, normalize } from '../../core/math';
import type { Vec2 } from '../../core/math';
import { COLLISION, FIXED_STEP, HAZARDS, PHYSICS, RACE, SURGE } from '../config';
import type { Track } from '../track/buildTrack';
import { getRacer, toVehicleSpec } from '../racers';
import type { DifficultyProfile } from '../ai/driver';
import { driveAi } from '../ai/driver';
import { stepCombat } from './combat';
import { updatePositions, updateRaceProgress } from './race';
import { stepVehicle } from './vehicle';
import type { ControlInput, RacerState, SimEvent } from './state';
import { emptyInput } from './state';

/**
 * Hard bound on the catch-up multiplier applied to AI engine output.
 *
 * This is the number that decides whether the game feels fair. At 3% a
 * trailing pack closes a gap by roughly one car length every ten seconds —
 * enough that a race stays alive, far too little to erase a mistake or to be
 * visible as a car "magically" reeling you in. `tests/unit/fairness.test.ts`
 * asserts nothing ever exceeds it.
 */
export const CATCHUP_LIMIT = 0.03;

export type RacePhase = 'countdown' | 'running' | 'finished';

export interface RaceSetup {
  track: Track;
  /** Racer profile ids, in grid order; index 0 is the player unless spectating. */
  entries: { profileId: string; isPlayer: boolean }[];
  difficulty: DifficultyProfile;
  seed: number;
  /** Whether the bounded catch-up assist is enabled. */
  catchUp: boolean;
}

/**
 * The whole deterministic world.
 *
 * Given the same `RaceSetup` and the same sequence of player inputs, this
 * produces bit-identical results on every machine. No `Math.random`, no
 * `Date.now`, no floating frame delta — the caller feeds it whole fixed steps.
 */
export class Simulation {
  readonly track: Track;
  readonly racers: RacerState[];
  readonly setup: RaceSetup;
  readonly rng: Rng;

  phase: RacePhase = 'countdown';
  /** Seconds until the lights go out; negative once running. */
  countdown: number = RACE.countdown;
  /** Seconds since the lights went out. */
  raceTime = 0;
  /** Steps executed, used by tests and the replay-safe restart check. */
  steps = 0;
  events: SimEvent[] = [];

  private finishedCount = 0;
  private postRaceTimer = 0;
  private lastCountdownAnnounced = Infinity;

  constructor(setup: RaceSetup) {
    this.setup = setup;
    this.track = setup.track;
    this.rng = new Rng(setup.seed);
    this.racers = setup.entries.map((entry, i) => this.createRacer(entry, i));
    updatePositions(this.racers);
  }

  private createRacer(entry: { profileId: string; isPlayer: boolean }, index: number): RacerState {
    const track = this.track;
    const profile = getRacer(entry.profileId);
    const spec = toVehicleSpec(profile.stats);

    // Grid: two columns, staggered back from the line, all behind checkpoint 0.
    const row = Math.floor(index / 2);
    const column = index % 2 === 0 ? -1 : 1;
    const gridDistance = track.length - (row + 1) * RACE.gridRowSpacing;
    const sample = track.sampleMain(gridDistance);
    const lateral = column * RACE.gridLateral;
    const pos: Vec2 = {
      x: sample.pos.x + sample.normal.x * lateral,
      z: sample.pos.z + sample.normal.z * lateral,
    };

    const difficulty = this.setup.difficulty;
    return {
      index,
      profileId: profile.id,
      spec,
      isPlayer: entry.isPlayer,
      pos,
      y: sample.y,
      heading: Math.atan2(sample.tangent.z, sample.tangent.x),
      velocity: { x: 0, z: 0 },
      verticalVelocity: 0,
      airborne: false,
      steer: 0,
      slip: 0,
      surge: 0,
      boosting: false,
      slipstreaming: false,
      drift: { active: false, direction: 0, charge: 0 },
      strike: { phase: 'idle', timer: 0, side: 1, cooldown: 0, hitThisSwing: [] },
      stagger: 0,
      guards: [],
      strikesLanded: 0,
      strikesTaken: 0,
      path: track.main,
      mainDistance: gridDistance,
      previousMainDistance: gridDistance,
      lateral,
      currentHalfWidth: sample.halfWidth,
      onTrack: true,
      surface: sample.surface,
      lapsCompleted: -1,
      nextCheckpoint: 0,
      checkpointsPassed: 0,
      lastCheckpointDistance: gridDistance,
      progress: 0,
      position: index + 1,
      completed: false,
      finished: false,
      finishTime: 0,
      finishPosition: 0,
      lapTimes: [],
      bestLap: Infinity,
      currentLapStart: 0,
      stuckTimer: 0,
      wedgeTimer: 0,
      wrongWayTimer: 0,
      contactCooldown: 0,
      ai: entry.isPlayer
        ? null
        : {
            difficultyId: difficulty.id,
            // Spread the field slightly around the difficulty's nominal skill
            // so the pack strings out instead of driving as one block.
            skill: clamp(difficulty.skill + (index % 3) * 0.018 - 0.018, 0.6, 1),
            aggression: clamp01(difficulty.aggression + ((index % 4) - 1.5) * 0.06),
            boldness: clamp01(difficulty.boldness + ((index % 5) - 2) * 0.07),
            mistakeRate: difficulty.mistakeRate,
            surgeDiscipline: difficulty.surgeDiscipline,
            // A touch of per-entry variation so the field does not run in
            // lockstep at a single pace.
            pace: clamp(difficulty.pace + ((index % 3) - 1) * 0.012, 0.6, 1),
            lineBias: ((index % 4) - 1.5) / 1.5,
            reaction: difficulty.reaction,
            noisePhase: (hashSeed(profile.id, this.setup.seed) % 1000) / 159.15,
            targetLateral: 0,
            targetSpeed: 0,
            smoothedTargetLateral: lateral,
            overtakeTimer: 0,
            overtakeSide: 0,
            strikeCooldown: 0,
            mistakeTimer: 0,
            driftHold: 0,
            boostHold: 0,
            recovery: 'none',
            recoveryTimer: 0,
            branchChoice: null,
            branchDecidedAt: -1,
            catchUpScale: 1,
          },
    };
  }

  get player(): RacerState | null {
    return this.racers.find((r) => r.isPlayer) ?? null;
  }

  /** Drains the event queue. The caller is expected to do this every frame. */
  drainEvents(): SimEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /**
   * Advances exactly one fixed step.
   * `playerInput` is ignored for AI-only fields; AI racers produce their own.
   */
  step(playerInput: ControlInput): void {
    const dt = FIXED_STEP;
    this.steps += 1;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      // `Math.ceil` on a small negative produces -0, which would reach the HUD
      // and the tests as a distinct value from 0.
      const announce = Math.max(0, Math.ceil(this.countdown));
      if (announce < this.lastCountdownAnnounced && announce >= 0) {
        this.lastCountdownAnnounced = announce;
        this.events.push({ type: 'countdown', value: announce });
      }
      if (this.countdown <= 0) {
        this.phase = 'running';
        this.events.push({ type: 'raceStart' });
      }
    } else if (this.phase === 'running') {
      this.raceTime += dt;
    }

    const running = this.phase === 'running';
    if (running) this.updateSlipstream(dt);

    const leaderProgress = Math.max(...this.racers.map((r) => r.progress));

    for (const racer of this.racers) {
      const input = this.inputFor(racer, playerInput, dt, running);
      const engineScale = this.catchUpScale(racer, leaderProgress);
      if (racer.ai) racer.ai.catchUpScale = engineScale;

      stepCombat(racer, input, { dt, raceTime: this.raceTime, events: this.events, racers: this.racers });

      stepVehicle(racer, input, {
        track: this.track,
        dt,
        raceTime: this.raceTime,
        events: this.events,
        rng: this.rng,
        offTrackSurface: this.track.definition.offTrackSurface,
        engineScale,
        running,
      });

      const speed = Math.hypot(racer.velocity.x, racer.velocity.z);
      if (running && !racer.finished && speed < RACE.stuckSpeed) {
        racer.wedgeTimer += dt;
      } else if (speed > RACE.stuckSpeed * 2) {
        racer.wedgeTimer = 0;
      }

      if (input.respawn && !racer.finished) this.respawn(racer);
    }

    this.resolveRacerCollisions(dt);
    this.resolveObstacles();
    if (running) this.applyHazards(dt);

    for (const racer of this.racers) {
      const wasFinished = racer.finished;
      if (running) {
        updateRaceProgress(racer, { track: this.track, raceTime: this.raceTime, events: this.events });
      }
      if (racer.finished && !wasFinished) {
        this.finishedCount += 1;
        racer.finishPosition = this.finishedCount;
        this.events.push({
          type: 'finish',
          racer: racer.index,
          position: racer.finishPosition,
          time: racer.finishTime,
        });
      }
    }

    updatePositions(this.racers);

    if (this.phase === 'running' && this.finishedCount > 0) {
      /*
       * The post-race clock runs from the first finisher, unconditionally.
       *
       * Gating it on the player having finished sounds kinder — it stops a
       * player on a bad final lap being classified early — but it means a
       * player who never finishes at all keeps the race alive forever. The
       * generous timeout covers the bad-lap case properly, and a race that can
       * hang is worse than one that eventually calls time.
       */
      this.postRaceTimer += dt;
      const everyoneDone = this.racers.every((r) => r.finished);
      const player = this.player;
      const playerSettled = player !== null && player.finished && this.postRaceTimer > 2.5;
      if (everyoneDone || playerSettled || this.postRaceTimer > RACE.postRaceTimeout) {
        this.endRace();
      }
    }
  }

  private endRace(): void {
    // Classify anyone still running by their live position, so the results
    // screen is complete even if the timeout fired.
    const unfinished = this.racers.filter((r) => !r.finished).sort((a, b) => b.progress - a.progress);
    for (const racer of unfinished) {
      racer.finished = true;
      racer.finishTime = Infinity;
      this.finishedCount += 1;
      racer.finishPosition = this.finishedCount;
    }
    updatePositions(this.racers);
    this.phase = 'finished';
    this.events.push({ type: 'raceEnd' });
  }

  private inputFor(racer: RacerState, playerInput: ControlInput, dt: number, running: boolean): ControlInput {
    if (racer.isPlayer) {
      if (!running) {
        // On the grid the player may pre-load throttle but nothing else moves.
        return { ...playerInput, brake: false, boost: false, strike: 0 };
      }
      return playerInput;
    }
    const input = driveAi(racer, {
      track: this.track,
      racers: this.racers,
      dt,
      raceTime: this.raceTime,
      rng: this.rng,
      running,
    });
    if (!running) return { ...input, throttle: 1, brake: false, boost: false, strike: 0 };

    // AI racers self-rescue rather than sitting in a wall waiting for a human.
    if (racer.wedgeTimer > RACE.respawnTime) input.respawn = true;
    return input;
  }

  /**
   * Bounded, symmetric catch-up. Scales with how far behind the leader a racer
   * is, saturating at `CATCHUP_LIMIT`. Applies to AI only — the player's car
   * is never secretly slowed down or sped up.
   */
  private catchUpScale(racer: RacerState, leaderProgress: number): number {
    if (!this.setup.catchUp || !racer.ai || racer.finished) return 1;
    const behind = leaderProgress - racer.progress;
    // Full assist at 120 m behind, none at the front.
    const t = clamp01(behind / 120);
    const scale = 1 + t * CATCHUP_LIMIT;
    return clamp(scale, 1 - CATCHUP_LIMIT, 1 + CATCHUP_LIMIT);
  }

  /** Marks racers sitting in a rival's wake, which relieves drag and builds surge. */
  private updateSlipstream(dt: number): void {
    for (const racer of this.racers) {
      racer.slipstreaming = false;
      if (racer.finished) continue;
      const forward = fromHeading(racer.heading);
      for (const other of this.racers) {
        if (other.index === racer.index) continue;
        const rel: Vec2 = { x: other.pos.x - racer.pos.x, z: other.pos.z - racer.pos.z };
        const ahead = dot(rel, forward);
        if (ahead < 2.5 || ahead > SURGE.slipstreamRange) continue;
        const lateralOffset = Math.abs(rel.x * -Math.sin(racer.heading) + rel.z * Math.cos(racer.heading));
        if (lateralOffset > SURGE.slipstreamHalfWidth) continue;
        if (Math.abs(other.y - racer.y) > 3) continue;
        racer.slipstreaming = true;
        racer.surge = Math.min(SURGE.max, racer.surge + SURGE.slipstreamGain * dt);
        break;
      }
    }
  }

  /**
   * Pairwise racer collisions. Resolved as positional separation plus an
   * impulse exchange weighted by mass, then a hard separation term so two
   * skiffs can never end up welded together.
   */
  private resolveRacerCollisions(dt: number): void {
    const minDist = COLLISION.radius * 2;
    for (let i = 0; i < this.racers.length; i++) {
      const a = this.racers[i] as RacerState;
      for (let j = i + 1; j < this.racers.length; j++) {
        const b = this.racers[j] as RacerState;
        if (Math.abs(a.y - b.y) > 2.6) continue;
        const dist = distance(a.pos, b.pos);
        if (dist >= minDist || dist < 1e-6) continue;

        const n = normalize({ x: b.pos.x - a.pos.x, z: b.pos.z - a.pos.z });
        const overlap = minDist - dist;
        const totalMass = a.spec.mass + b.spec.mass;
        const aShare = b.spec.mass / totalMass;
        const bShare = a.spec.mass / totalMass;

        a.pos = { x: a.pos.x - n.x * overlap * aShare, z: a.pos.z - n.z * overlap * aShare };
        b.pos = { x: b.pos.x + n.x * overlap * bShare, z: b.pos.z + n.z * overlap * bShare };

        const relVel: Vec2 = { x: b.velocity.x - a.velocity.x, z: b.velocity.z - a.velocity.z };
        const closing = dot(relVel, n);
        if (closing < 0) {
          const impulse = -closing * (1 + COLLISION.restitution);
          a.velocity = { x: a.velocity.x - n.x * impulse * aShare, z: a.velocity.z - n.z * impulse * aShare };
          b.velocity = { x: b.velocity.x + n.x * impulse * bShare, z: b.velocity.z + n.z * impulse * bShare };

          if (-closing > 4 && a.contactCooldown <= 0 && b.contactCooldown <= 0) {
            a.contactCooldown = 0.2;
            b.contactCooldown = 0.2;
            this.events.push({
              type: 'collision',
              racer: a.index,
              other: b.index,
              speed: -closing,
              pos: { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 },
            });
          }
        } else {
          // Already separating but still overlapping: push apart over time so
          // two cars grinding along a wall do not lock.
          const push = COLLISION.separationRate * dt;
          a.velocity = { x: a.velocity.x - n.x * push * aShare, z: a.velocity.z - n.z * push * aShare };
          b.velocity = { x: b.velocity.x + n.x * push * bShare, z: b.velocity.z + n.z * push * bShare };
        }
      }
    }
  }

  /** Static obstacle collisions, resolved as a swept circle against a circle. */
  private resolveObstacles(): void {
    for (const racer of this.racers) {
      for (const obstacle of this.track.obstacles) {
        const minDist = obstacle.radius + COLLISION.radius;
        const dx = racer.pos.x - obstacle.x;
        const dz = racer.pos.z - obstacle.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= minDist || dist < 1e-6) continue;

        const nx = dx / dist;
        const nz = dz / dist;
        racer.pos = { x: obstacle.x + nx * minDist, z: obstacle.z + nz * minDist };

        const into = -(racer.velocity.x * nx + racer.velocity.z * nz);
        if (into <= 0) continue;
        const restitution = obstacle.restitution ?? PHYSICS.obstacleRestitution;
        racer.velocity = {
          x: (racer.velocity.x + nx * into * (1 + restitution)) * 0.92,
          z: (racer.velocity.z + nz * into * (1 + restitution)) * 0.92,
        };
        racer.drift.active = false;
        racer.drift.charge = 0;
        if (racer.contactCooldown <= 0) {
          racer.contactCooldown = 0.2;
          this.events.push({
            type: 'collision',
            racer: racer.index,
            other: null,
            speed: into,
            pos: { ...racer.pos },
          });
        }
      }
    }
  }

  private applyHazards(dt: number): void {
    for (const racer of this.racers) {
      for (const hazard of this.track.hazards) {
        if (distance(racer.pos, { x: hazard.x, z: hazard.z }) > hazard.radius) continue;
        switch (hazard.kind) {
          case 'boostPad': {
            if (racer.contactCooldown > 0) break;
            racer.contactCooldown = 0.5;
            racer.surge = Math.min(SURGE.max, racer.surge + HAZARDS.boostPadSurge);
            const forward = fromHeading(racer.heading);
            racer.velocity = {
              x: racer.velocity.x + forward.x * HAZARDS.boostPadImpulse,
              z: racer.velocity.z + forward.z * HAZARDS.boostPadImpulse,
            };
            this.events.push({ type: 'hazard', racer: racer.index, kind: 'boostPad', pos: { ...racer.pos } });
            break;
          }
          case 'mud': {
            const factor = Math.pow(HAZARDS.mudSpeedMultiplier, dt);
            racer.velocity = { x: racer.velocity.x * factor, z: racer.velocity.z * factor };
            break;
          }
          case 'gust': {
            const dir = hazard.direction ?? 0;
            const strength = (hazard.strength ?? 1) * HAZARDS.gustStrength;
            racer.velocity = {
              x: racer.velocity.x + Math.cos(dir) * strength * dt,
              z: racer.velocity.z + Math.sin(dir) * strength * dt,
            };
            break;
          }
        }
      }
    }
  }

  /**
   * Puts a racer back on the centreline at the point they had already reached.
   * Deliberately grants no progress, so respawning can never be a shortcut.
   */
  respawn(racer: RacerState): void {
    const sample = this.track.sampleMain(racer.mainDistance);
    racer.pos = { ...sample.pos };
    racer.y = sample.y;
    racer.heading = Math.atan2(sample.tangent.z, sample.tangent.x);
    const forward = fromHeading(racer.heading);
    racer.velocity = { x: forward.x * 8, z: forward.z * 8 };
    racer.verticalVelocity = 0;
    racer.airborne = false;
    racer.drift = { active: false, direction: 0, charge: 0 };
    racer.stagger = 0;
    racer.boosting = false;
    racer.stuckTimer = 0;
    racer.wedgeTimer = 0;
    racer.wrongWayTimer = 0;
    racer.path = this.track.main;
    if (racer.ai) racer.ai.recovery = 'none';
    this.events.push({ type: 'respawn', racer: racer.index });
  }

  /** True when the player is pointing the wrong way for long enough to warn. */
  isPlayerWrongWay(): boolean {
    const player = this.player;
    if (!player || this.phase !== 'running' || player.finished) return false;
    const projection = this.track.project(player.pos, player.path);
    const alignment = dot(fromHeading(player.heading), projection.tangent);
    return alignment < -0.3 && Math.hypot(player.velocity.x, player.velocity.z) > 3;
  }

  /** Ordered final classification. */
  results(): RacerState[] {
    return [...this.racers].sort((a, b) => a.finishPosition - b.finishPosition);
  }
}

export { emptyInput };
