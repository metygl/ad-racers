/**
 * Central tuning table for the simulation.
 *
 * Everything here is in SI units: metres, seconds, radians. The values were
 * tuned by playing, but they live in one place so the balance tests in
 * `tests/unit/balance.test.ts` can assert the relationships that matter (for
 * example: combat must never be worth more than a corner's worth of time).
 */

/** The simulation always advances in whole steps of this length. */
export const FIXED_STEP = 1 / 120;
/** Hard cap on catch-up steps per frame, so a stalled tab cannot spiral. */
export const MAX_STEPS_PER_FRAME = 8;

export const PHYSICS = {
  /** Aerodynamic drag, applied to v². */
  dragCoefficient: 0.0009,
  /** Rolling resistance, applied to v. */
  rollingResistance: 0.06,
  /**
   * Engine force tapers towards zero at `topSpeed * powerFalloffHeadroom`, and
   * a hard clamp holds the vehicle at `topSpeed`. The headroom is what makes
   * the clamp reachable, so a skiff's advertised top speed is the speed it
   * actually does — which `tests/unit/vehicle.test.ts` asserts.
   */
  powerFalloff: 1.7,
  powerFalloffHeadroom: 1.3,
  /** Braking deceleration on reference tarmac. */
  brakeForce: 46,
  /** Reverse is deliberately slow; it is a recovery tool, not a tactic. */
  reverseMaxSpeed: 9,
  reverseForce: 14,
  /** Peak yaw rate at the speed where steering is most responsive. */
  maxYawRate: 2.35,
  /** Steering authority curve: full at this speed, tapering above and below. */
  steeringPeakSpeed: 18,
  steeringHighSpeedFalloff: 0.42,
  /** How quickly the steering input follows the raw control input. */
  steerResponse: 9.5,
  /** Lateral velocity bleed-off rate on reference tarmac. */
  lateralGrip: 11.0,
  /**
   * Converts a skiff's grip stat into the peak lateral acceleration it can
   * actually hold, which in turn caps yaw rate at speed.
   *
   * Without this cap the model corners at `v / yawRate` regardless of speed,
   * which means braking never buys anything and every corner is flat out. This
   * is the single constant that makes corner entry a decision.
   */
  gripToLateralAccel: 1.65,
  /**
   * How far the grip-based yaw cap is relaxed while drifting.
   *
   * This is what actually produces a drift. The cap normally holds yaw to
   * exactly the rate the velocity vector can turn, so the skiff never points
   * anywhere but where it is going. Lifting it lets the nose rotate ahead of
   * the velocity, and the gap between the two is the slide. The velocity still
   * curves at the grip-limited rate, so a drift is not a free faster corner —
   * it is a way to rotate the car early and bank surge for the exit.
   */
  driftYawLimitBonus: 4.0,
  /**
   * Slip angle (radians) the tyres hold happily. Past it, grip climbs steeply,
   * which is what stops a slide turning into a spin: without this the reduced
   * drift grip has no equilibrium and the skiff rotates until it is travelling
   * sideways and stops.
   */
  peakSlipAngle: 0.17,
  driftPeakSlipAngle: 0.62,
  /** How hard grip rises per radian of slip beyond the peak. */
  slipRecoveryGain: 9,
  /** Gravity, used for the light airborne model over crests and ramps. */
  gravity: 22,
  /** Vertical speed below which a landing counts as clean. */
  cleanLandingSpeed: 7,
  /** Impact speed above which a wall hit spins the vehicle. */
  wallSpinThreshold: 22,
  /** Fraction of speed retained after a square-on wall hit. */
  wallRestitution: 0.42,
  /** Fraction of speed retained after hitting a static obstacle. */
  obstacleRestitution: 0.35,
  /**
   * How far past an open track edge a racer may stray before an invisible
   * outer barrier stops them. Wide enough that a big slide off a fast corner
   * is survivable, tight enough that nobody can drive to the horizon.
   */
  offTrackMargin: 13,
  /**
   * Inward acceleration applied out in the run-off, in m/s². Enough to pull a
   * car back across the grass in a couple of seconds, gentle enough that it
   * never fights a driver who is deliberately running wide.
   */
  runOffReturn: 11,
  /** Distance past the limit at which the return force reaches full strength. */
  runOffFullReturn: 8,
  /** Extra drag out in the run-off, per second. */
  runOffDrag: 1.6,
  /**
   * Beyond `runOffFullReturn` the inward pull climbs steeply. It has to end up
   * stronger than the engine, or a car pointed at the horizon with the throttle
   * open simply drives away from the course forever.
   */
  runOffHardGain: 5,
  /** Absolute outer clamp, measured past the run-off limit. */
  runOffMaxOvershoot: 30,
  /** Steering authority retained while airborne. */
  airborneSteering: 0.22,
  /** Speed scrubbed off per unit of lateral slide, so a drift costs something. */
  driftScrub: 0.32,
} as const;

export const DRIFT = {
  /** Minimum speed before a drift can be initiated. */
  minSpeed: 12,
  /** Lateral grip multiplier while drifting. */
  gripMultiplier: 0.44,
  /** Yaw rate multiplier while drifting. */
  yawMultiplier: 1.38,
  /** Charge gained per second at full slip. */
  chargeRate: 0.75,
  /** Charge decays this fast when the drift stops being productive. */
  chargeDecay: 0.9,
  /** Charge thresholds for the three boost tiers. */
  tiers: [0.34, 0.7, 1.0] as const,
  /** Surge granted when releasing at each tier. */
  tierSurge: [0.17, 0.31, 0.48] as const,
  /** Instant forward impulse (m/s) granted at each tier. */
  tierImpulse: [1.6, 3.4, 5.6] as const,
} as const;

export const SURGE = {
  max: 1,
  /** Consumption per second while boosting. */
  drain: 0.46,
  /** Minimum charge needed to trigger a boost. */
  triggerThreshold: 0.2,
  /** Top-speed multiplier while boosting. */
  speedMultiplier: 1.19,
  /** Engine force multiplier while boosting. */
  forceMultiplier: 1.5,
  /** Surge per second gained while in another racer's slipstream. */
  slipstreamGain: 0.24,
  /** Slipstream also directly reduces drag by this fraction. */
  slipstreamDragRelief: 0.45,
  /** Distance behind a rival at which slipstream starts working. */
  slipstreamRange: 16,
  /** Lateral tolerance for the slipstream cone. */
  slipstreamHalfWidth: 2.4,
  /** Surge granted for a clean landing off a crest. */
  cleanLandingGain: 0.09,
  /** Surge granted to the attacker on a successful strike. */
  hitGain: 0.11,
} as const;

/**
 * The rider-and-companion strike. The companion rides an outrigger pod and
 * swings a counterweighted grapple arm at a rival alongside.
 *
 * Design intent: a strike is worth roughly 0.35 s of track time against an
 * even opponent — enough to break a tow, never enough to substitute for
 * driving. `tests/unit/balance.test.ts` pins that budget.
 */
export const COMBAT = {
  windup: 0.16,
  active: 0.14,
  recovery: 0.3,
  /** Lockout measured from the start of the strike. */
  cooldown: 1.5,
  /** Lateral reach measured from the vehicle centre. */
  reach: 3.7,
  /** Strikes cannot connect closer than this; the pod arm needs room. */
  minReach: 0.7,
  /** Longitudinal window, relative to the attacker (negative is behind). */
  forwardMin: -2.1,
  forwardMax: 3.3,
  /** Speed multiplier applied to a struck rival. */
  speedPenalty: 0.86,
  /** Sideways shove imparted to a struck rival. */
  shove: 4.6,
  /** How long a struck rival's steering is degraded. */
  staggerTime: 0.55,
  /** Steering authority retained while staggered. */
  staggerSteering: 0.35,
  /** Grip retained while staggered. */
  staggerGrip: 0.72,
  /** Repeat strikes on the same rival decay by this factor each time. */
  guardDecay: 0.6,
  /** Guard resets once this long passes without another strike. */
  guardWindow: 3,
  /** Guard never drops the effect below this fraction. */
  guardFloor: 0.25,
  /** Striking someone who is mid-strike counters both riders. */
  counterStagger: 0.35,
  /** Nobody may strike during the opening seconds of a race. */
  graceAfterStart: 2,
} as const;

export const COLLISION = {
  /** Racer collision radius. */
  radius: 1.35,
  /** How much of the closing speed is returned as separation. */
  restitution: 0.35,
  /** Extra separation applied per second while overlapping, to unstick pairs. */
  separationRate: 14,
  /** Speed lost by both parties in a hard side-swipe. */
  swipeSpeedLoss: 0.94,
} as const;

export const RACE = {
  /** Countdown length in seconds; the lights step once per second. */
  countdown: 3,
  /** Grid row spacing along the track. */
  gridRowSpacing: 7,
  /** Grid lateral stagger. */
  gridLateral: 2.4,
  /** Time after the winner finishes before the race is force-ended. */
  postRaceTimeout: 22,
  /**
   * Corridor tolerance, in multiples of the local half-width, within which a
   * checkpoint still registers. Wider than the road so a legitimate wide line
   * counts, tight enough that cutting across the infield does not.
   */
  checkpointCorridor: 2.6,
  /** A racer is considered stuck below this speed. */
  stuckSpeed: 2.2,
  /** ...for this long. */
  stuckTime: 1.6,
  /** Respawn is offered after being stuck this long, and is instant for AI. */
  respawnTime: 3.2,
} as const;

export const HAZARDS = {
  boostPadSurge: 0.3,
  boostPadImpulse: 6,
  mudSpeedMultiplier: 0.55,
  gustStrength: 9,
} as const;
