import type { Vec2 } from '../../core/math';
import type { Path, SurfaceId } from '../track/types';
import type { VehicleSpec } from '../racers';

/** One frame of driver intent. Identical shape for the player and the AI. */
export interface ControlInput {
  /**
   * True when the throttle is supplied by the platform rather than pressed.
   *
   * Touch has no accelerate button by design, so its throttle is always open.
   * That makes throttle useless on its own as a signal that the player has
   * *decided* to go, which is exactly what the rolling start needs to know
   * before it carries an idle car into the first corner.
   */
  automaticThrottle: boolean;
  /** -1 (full left) to 1 (full right). */
  steer: number;
  /** 0 to 1. */
  throttle: number;
  /** 0 to 1. */
  brake: boolean;
  drift: boolean;
  boost: boolean;
  /**
   * Hop. Deliberately its own input and never folded into `drift`; see the
   * note on `HOP` in `config.ts`.
   */
  hop: boolean;
  /** -1 strikes to the left, 1 to the right, 0 does not strike. */
  strike: -1 | 0 | 1;
  /** Request a respawn back onto the track. */
  respawn: boolean;
}

export function emptyInput(): ControlInput {
  return {
    steer: 0,
    throttle: 0,
    brake: false,
    drift: false,
    boost: false,
    hop: false,
    strike: 0,
    respawn: false,
    automaticThrottle: false,
  };
}

export type StrikePhase = 'idle' | 'windup' | 'active' | 'recovery';

export interface StrikeState {
  /**
   * Whether a rival is currently inside the strike envelope on each side.
   *
   * Exposed as *state* rather than inferred from events because the HUD has to
   * say it **before** the player commits. A review attempted six strikes over a
   * full race, landed none, and could not tell whether it had chosen the wrong
   * side, lacked overlap, was out of reach, was on cooldown or simply mistimed
   * it — the interface said `POD ARM READY` throughout. Reach is the single
   * most useful thing it could have said instead.
   */
  reachLeft: boolean;
  reachRight: boolean;
  phase: StrikePhase;
  /** Seconds remaining in the current phase. */
  timer: number;
  side: -1 | 1;
  /** Seconds until another strike may start. */
  cooldown: number;
  /** Racers already hit by the current swing, so one swing lands once each. */
  hitThisSwing: number[];
}

export interface GuardEntry {
  attacker: number;
  hits: number;
  /** Seconds until this guard entry expires. */
  timer: number;
}

export interface DriftState {
  active: boolean;
  /** Sign of the drift direction; 0 when not yet committed. */
  direction: number;
  charge: number;
}

export interface AiState {
  difficultyId: string;
  /** 0-1; how far the driver will push the tyres. */
  skill: number;
  /** 0-1; how eagerly it uses the companion. */
  aggression: number;
  /** 0-1; how willing it is to take a shortcut. */
  boldness: number;
  /** Chance per second of a small, self-correcting mistake. */
  mistakeRate: number;
  /** 0-1; how much surge it will spend rather than hoard. */
  surgeDiscipline: number;
  /** Fraction of the skiff's straight-line pace this driver asks for. */
  pace: number;
  /** Baseline lateral bias, so cars do not stack on one line. */
  lineBias: number;
  /** Reaction delay, seconds. */
  reaction: number;
  /** Slow wander phase for organic-looking line variation. */
  noisePhase: number;
  targetLateral: number;
  smoothedTargetLateral: number;
  /** Speed the driver is currently asking for; surfaced for tests and tuning. */
  targetSpeed: number;
  overtakeTimer: number;
  overtakeSide: number;
  strikeCooldown: number;
  mistakeTimer: number;
  /** Minimum remaining commitment to the current drift, seconds. */
  driftHold: number;
  /** Minimum remaining commitment to the current boost, seconds. */
  boostHold: number;
  recovery: 'none' | 'reverse' | 'realign';
  recoveryTimer: number;
  /** Shortcut chosen for the current lap, or null for the main line. */
  branchChoice: string | null;
  /** Main-line distance at which the current branch decision was made. */
  branchDecidedAt: number;
  /** Rolling record of applied catch-up, for the fairness assertion. */
  catchUpScale: number;
}

export interface RacerState {
  index: number;
  profileId: string;
  spec: VehicleSpec;
  isPlayer: boolean;

  pos: Vec2;
  /** Elevation of the vehicle body. */
  y: number;
  heading: number;
  velocity: Vec2;
  verticalVelocity: number;
  airborne: boolean;
  /** Smoothed steering actually applied, after input shaping. */
  steer: number;
  /** Signed slip angle, exposed for drift smoke and the HUD. */
  slip: number;

  surge: number;
  boosting: boolean;
  /** True while sitting in a rival's wake; feeds drag relief and surge gain. */
  slipstreaming: boolean;
  /** 0-1 charge towards a wake snap, built by holding the tow. */
  towCharge: number;
  /** Seconds left in which a banked tow charge can still be snapped. */
  towRelease: number;
  /** Seconds of post-impact engine assist remaining. */
  recoveryBoost: number;
  /** Seconds until another post-impact assist may be granted. */
  recoveryCooldown: number;
  /** Seconds until another hop is allowed. */
  hopCooldown: number;
  /** Seconds since the last landing, used for the hop-into-drift handshake. */
  sinceLanding: number;
  /** Continuous seconds spent airborne; resets on touchdown. */
  airTime: number;
  /** Peak clearance above the ground this flight, which distinguishes a crest. */
  airClearance: number;
  /** Hops taken in quick succession; each one pays less than the last. */
  hopChain: number;
  /** Seconds of lockout before the same wall may bill another impact. */
  wallImpactLock: number;
  /**
   * Unbroken seconds spent overlapping a barrier.
   *
   * Distinct from `wallImpactLock`, which bounds what a contact may *cost*.
   * This measures how long the hull has failed to get clear, and it is what
   * drives the escape slide — a review measured a single understandable
   * mistake becoming a twenty-second pin that neither neutral nor full
   * opposite steering could break, because at three metres a second the
   * steering has almost no yaw authority left to point the nose out with.
   */
  wallContactTime: number;
  /** Unbroken seconds spent overlapping a track obstacle. */
  obstacleContactTime: number;
  /** Road height at take-off, and the greatest drop below it while airborne. */
  airGroundStart: number;
  airGroundDrop: number;
  /** Main-line distance at the previous step, for measuring progress rate. */
  lastProgressDistance: number;
  /** Whether the player has ever steered. Ends the opening assist for good. */
  hasSteered: boolean;
  drift: DriftState;
  strike: StrikeState;
  /** Seconds of degraded control remaining after being struck. */
  stagger: number;
  guards: GuardEntry[];
  /** Strikes landed this race, shown on the results screen. */
  strikesLanded: number;
  strikesTaken: number;

  /** Path the racer is currently being tracked against. */
  path: Path;
  mainDistance: number;
  previousMainDistance: number;
  lateral: number;
  /** Half-width of the corridor at the racer's current position. */
  currentHalfWidth: number;
  onTrack: boolean;
  surface: SurfaceId;

  lapsCompleted: number;
  nextCheckpoint: number;
  checkpointsPassed: number;
  /** Main-line distance of the last checkpoint claimed; anchors the score. */
  lastCheckpointDistance: number;
  /** Monotone ordering key used for live positions. */
  progress: number;
  position: number;
  /** True only after crossing the finish line for the final required lap. */
  completed: boolean;
  finished: boolean;
  finishTime: number;
  /** Final classification, filled in when the racer crosses the line. */
  finishPosition: number;
  lapTimes: number[];
  bestLap: number;
  currentLapStart: number;

  stuckTimer: number;
  /**
   * Continuous time spent below walking pace. Unlike `stuckTimer` this is not
   * reset by the AI's recovery manoeuvres, so a car that keeps failing to free
   * itself still reaches the respawn threshold instead of looping forever.
   */
  wedgeTimer: number;
  wrongWayTimer: number;
  /** Seconds of collision cooldown, so one bump is not counted many times. */
  contactCooldown: number;

  ai: AiState | null;
}

export type SimEvent =
  | { type: 'countdown'; value: number }
  | { type: 'raceStart' }
  | { type: 'lap'; racer: number; lap: number; time: number }
  | { type: 'checkpoint'; racer: number; checkpoint: number }
  | { type: 'finish'; racer: number; position: number; time: number }
  | { type: 'raceEnd' }
  | { type: 'strikeSwing'; racer: number; side: -1 | 1 }
  /** A swing that reached the end of its active window without contact. */
  | { type: 'strikeMiss'; racer: number; side: -1 | 1 }
  /**
   * An input the simulation refused, and why. Silent rejection is what makes a
   * mechanic feel arbitrary even when it is completely deterministic.
   */
  | { type: 'strikeRejected'; racer: number; reason: 'cooldown' | 'airborne' | 'staggered' | 'tooEarly' | 'busy' }
  | { type: 'strikeHit'; attacker: number; target: number; strength: number; pos: Vec2 }
  | { type: 'strikeCounter'; a: number; b: number }
  | { type: 'collision'; racer: number; other: number | null; speed: number; pos: Vec2 }
  | { type: 'wallHit'; racer: number; speed: number; pos: Vec2 }
  | { type: 'driftRelease'; racer: number; tier: number }
  | { type: 'boostStart'; racer: number }
  | { type: 'hop'; racer: number }
  | { type: 'towSnap'; racer: number; strength: number }
  /**
   * `quality` is 0-1: level and aligned scores 1, a heavy sideways arrival 0.
   * `airTime` and `clearance` are carried because the renderer scales the
   * landing dust by them, and because a landing that scores zero is otherwise
   * impossible to diagnose from the outside.
   */
  | {
      type: 'jumpLand';
      racer: number;
      clean: boolean;
      speed: number;
      quality: number;
      airTime: number;
      clearance: number;
    }
  | { type: 'respawn'; racer: number }
  | { type: 'surfaceChange'; racer: number; surface: SurfaceId }
  | { type: 'hazard'; racer: number; kind: string; pos: Vec2 };
