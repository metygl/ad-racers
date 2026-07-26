/**
 * Central tuning table for the simulation.
 *
 * Everything here is in SI units: metres, seconds, radians. The values were
 * tuned by playing, but they live in one place so focused unit tests can assert
 * the relationships that matter (for example: combat must never be worth more
 * than a corner's worth of time).
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
  /**
   * How quickly the *physics* steering command follows the raw control input.
   *
   * Deliberately fast. The chassis lean is smoothed separately in the renderer,
   * which is where smoothing belongs: filtering the command itself made a tap
   * hold 0.44 of lock 250 ms after release and left rapid countersteer stuck
   * near zero, so the practical technique became holding full lock and reacting
   * to the boundary. Visual smoothness must never cost input precision.
   */
  steerResponse: 26,
  /**
   * Extra response applied when the input opposes the current command.
   *
   * Catching a slide is the one moment where lag is unacceptable, so reversing
   * the wheel cancels the accumulated command far faster than building it.
   */
  steerReversalGain: 2.6,
  /** Response when the input returns to centre, so releasing is crisp too. */
  steerReleaseGain: 1.8,
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
  /**
   * The hard bound on sustained body angle, in radians. About 77°.
   *
   * Motion finding F4 asked for this explicitly: grip alone gives a slide an
   * equilibrium but not a *limit*, so a heavy strike or a landing gone wrong
   * can in principle leave the machine holding an angle no driver would, with
   * the nose pointing somewhere the skiff is never going to go.
   *
   * It is a guard rail, not a handling parameter, and the number says so. A
   * census across full Pro and Ace fields on all four courses put the peak
   * body angle against the *track tangent* — the quantity the finding names —
   * between 0.66 and 1.14 rad, with the 99.99th percentile at or below 1.2. So
   * the tyre curve already holds the body inside a readable envelope, and this
   * sits above the whole of it.
   *
   * Two tighter values were tried first and both were wrong, in ways worth
   * recording. At 0.75 rad *measured on the pre-grip angle* it clipped a
   * transient that every corner produces — within a step the body rotates
   * before the tyres pull the velocity round with it, so that angle is much
   * larger than the settled one. At 1.0 rad on the settled angle it still
   * clipped the Ace field's fastest corners. Both cost about a second a lap on
   * the salt and *inverted the difficulty ladder*, which the AI suite caught.
   * On a course where Ace beats Pro by 0.86 s, a bound that also catches good
   * driving is worth less than no bound at all.
   */
  bodyAngleMax: 1.35,
  /**
   * How hard the attitude jets pull the nose back per radian past the bound,
   * in rad/s per rad. Strong enough to bound the angle within a few tenths of
   * a second, weak enough that a flick, a landing or a hit still crosses the
   * body up freely — the bound is on the *sustained* angle, not the transient.
   */
  bodyAngleRecovery: 3.2,
  /** Gravity, used for the light airborne model over crests and ramps. */
  gravity: 22,
  /** Vertical speed below which a landing counts as clean. */
  cleanLandingSpeed: 7,
  /**
   * Fraction of gravity at which a crest launches the skiff.
   *
   * A strictly ballistic test (the ground falling away faster than 1 g) needs a
   * ramp sharper than a Catmull-Rom centreline through nodes tens of metres
   * apart can produce, so a real flyover would never actually launch anyone.
   * Triggering at half a g models the suspension unloading and gives the crest
   * the air it visibly deserves, without letting every gentle rise become a jump.
   */
  airborneThreshold: 0.42,
  /**
   * Minimum excess over the launch threshold, as a fraction of gravity, before
   * a rise counts as a crest at all.
   *
   * Every gentle undulation on a course sits just the wrong side of a bare
   * threshold, and each one fired a launch and a landing. Requiring a margin
   * turns "the ground is slightly convex here" into "this is a jump".
   */
  crestMinExcess: 0.14,
  /**
   * Upward shove applied at the moment a crest launches, in multiples of the
   * excess acceleration over the threshold.
   *
   * Without it the "launch" is not one. Triggering below 1 g means the ballistic
   * path never actually separates from the ground, so the skiff set itself
   * airborne and landed again on the very next step, over and over: a headless
   * race over the flyover produced 2,219 landings of 0.12 s each and a peak
   * clearance of 4 cm. Nobody ever got air, and every one of those landings
   * fired a `jumpLand` event. The impulse is what turns a modelled suspension
   * unload into flight the player can see and score.
   */
  crestUnload: 9,
  /** Ceiling on that shove, so a very sharp crest is not a catapult. */
  crestUnloadMax: 8.5,
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
   * Inward slide out in the run-off, per second per metre past the limit. A
   * car 10 m out slides back at 6 m/s, which clears a big excursion in a couple
   * of seconds without ever taking control away from the driver.
   */
  runOffReturn: 0.6,
  /** Cap on the inward slide, so a huge excursion is not yanked back. */
  runOffMaxReturnSpeed: 14,
  /** Extra drag out in the run-off, per second. */
  runOffDrag: 1.6,
  /**
   * Steering authority retained while airborne.
   *
   * Deliberately generous compared to a ground vehicle: a crest is a skill
   * moment, and a skiff with no air authority turns every jump into a coin
   * flip about where you land. It is still well under ground authority, so air
   * is not a faster way round a corner.
   */
  airborneSteering: 0.5,
  /**
   * How hard the skiff rotates towards its direction of travel while airborne.
   *
   * This is what makes a clean landing achievable rather than lucky: left
   * alone, a car that took off mid-slide lands still sideways and spears off.
   * The auto-align is slow enough that a player who does nothing still lands
   * untidily; it removes the unfair case, not the skill.
   */
  airborneAlign: 1.5,
  /** Speed scrubbed off per unit of lateral slide, so a drift costs something. */
  driftScrub: 0.32,
  /**
   * Extra yaw authority while braking hard at speed.
   *
   * Trail braking: shifting load onto the nose lets it bite. Without this,
   * braking is purely a speed control and the only reason to touch it is to
   * avoid running wide, which makes corner entry a single decision rather than
   * a continuous one.
   */
  brakeTurnBonus: 0.34,
} as const;

/**
 * The hop.
 *
 * A short vertical shove off the ground, on its *own* input. It never shares a
 * button with drift, and that is a considered decision rather than an
 * oversight: the current Mario Kart generation puts its charge jump on the
 * drift button, and reviewers found that any steering input turns a jump
 * attempt into a drift, which "flummoxes muscle memory" and makes the jump feel
 * too risky to go for. See `docs/DESIGN-DIRECTION.md`. Overloading the
 * highest-frequency input punishes precisely the players who use it most.
 *
 * What it buys: clearing a kerb or a patch of spoil, reaching a raised
 * shortcut mouth, and a tactile way into a drift — land while turning and the
 * drift starts with a charge head start, which is the arcade-racing handshake
 * this game was missing.
 */
export const HOP = {
  /** Upward velocity imparted, m/s. */
  impulse: 6.2,
  /** Lockout between hops. */
  cooldown: 0.45,
  /**
   * Consecutive hops inside this window are treated as a chain and pay less
   * each time. Five flat hops on a straight raised Surge from 0.25 to 0.81 in
   * under four seconds, which is a farm rather than a mechanic.
   */
  chainWindow: 2.6,
  /** Reward multiplier per additional hop in a chain. */
  chainDecay: 0.35,
  /** Minimum speed before a hop does anything; a parked skiff cannot pogo. */
  minSpeed: 4,
  /** Speed cost, so hopping down a straight is never free. */
  speedCost: 0.6,
  /**
   * Charge granted to a drift begun within `landingWindow` of touching down.
   * Not enough to reach a tier on its own — it rewards the timing, it does not
   * pay for it.
   */
  landingDriftCharge: 0.14,
  landingWindow: 0.3,
} as const;

/**
 * Landing quality.
 *
 * A crest pays out for arriving level and pointed where you are going. This is
 * the payoff beat for the air-control mechanic: without it, air time is
 * something that happens to you rather than something you fly.
 */
export const LANDING = {
  /** Slip angle (radians) at or below which a landing counts as aligned. */
  alignedSlip: 0.1,
  /**
   * Slip angle beyond which alignment scores nothing.
   *
   * Tightened hard: a landing 16 degrees (0.28 rad) out of line still paid, so
   * a player could hop, hold full lock, and be rewarded for arriving crooked.
   */
  sloppySlip: 0.26,
  /** Heading must be within this of the track tangent, in radians. */
  alignedToTrack: 0.34,
  /** Minimum ground speed for a landing to score at all. */
  minSpeed: 20,
  /** Surge for a perfectly level, perfectly aligned landing. */
  perfectSurge: 0.2,
  /** Forward impulse (m/s) for the same. */
  perfectImpulse: 3.2,
  /**
   * Airborne seconds needed before a landing can score at all.
   *
   * A plain hop clears roughly 0.55 s, so this alone never gated the flat-hop
   * farm. It is now backed by `minRise`: a landing pays for taking a *crest*
   * well, and a crest is a place where the ground fell away.
   */
  minAirTime: 0.45,
  /**
   * Metres of clearance above the ground the flight must reach to score.
   *
   * A hop reaches about 0.9 m by construction (`impulse² / 2g`), so anything
   * above that cannot be produced by tapping hop on the flat — while a crest,
   * where the ground falls away underneath, clears several metres.
   */
  minClearance: 1.4,
  /**
   * How far the road must fall away beneath the skiff, in metres, for air to
   * count as a crest rather than a pogo.
   *
   * The hop impulse alone reaches the clearance threshold on flat tarmac, so
   * clearance could never tell the two apart. This can, and it is the whole
   * gate on the flat-hop Surge farm.
   */
  minCrestDrop: 0.8,
} as const;

export const DRIFT = {
  /** Minimum speed before a drift can be initiated. */
  minSpeed: 12,
  /**
   * Charge only accrues on a surface a racing line actually uses.
   *
   * Holding drift out on the grass filled the tier ladder to maximum at 9 m/s,
   * paid 0.57 Surge, and let the player rocket back to 37 m/s — a completely
   * reliable way to fill the primary speed resource without solving a single
   * corner. Reward has to require being on the road, at pace, and genuinely
   * loaded up.
   */
  minChargeSpeed: 24,
  /** Slip below this contributes nothing: a straight-line hold is not a drift. */
  minChargeSlip: 0.12,
  /** Charge bleeds at this rate per second while off the drivable corridor. */
  offTrackDecay: 1.6,
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
 * The tow, and the snap out of it.
 *
 * Sitting in a rival's wake already relieves drag and fills Surge. The snap
 * adds the decision on top: hold the tow long enough and pulling out of it
 * pays a burst, so a straight becomes "when do I go" rather than "hold the
 * throttle". It is the game's answer to strategic chaos without a single item
 * on the road — the resource is a *position*, which you have to earn by racing
 * and which your rival can deny by moving.
 *
 * Deliberately small: a snap is worth roughly a car length. It decides who
 * gets to the corner first, never who wins the race.
 */
export const TOW = {
  /** Seconds in the wake needed to fully charge a snap. */
  chargeTime: 1.4,
  /** Charge bleeds away this fast once out of the wake. */
  decayRate: 0.7,
  /** Window after leaving the wake in which the snap can still fire. */
  releaseWindow: 0.55,
  /** Forward impulse at full charge, m/s. */
  impulse: 5.4,
  /** Surge at full charge. */
  surge: 0.16,
  /** Charge below which nothing fires, so a brush past a rival pays nothing. */
  minCharge: 0.55,
} as const;

/**
 * Recovery after a heavy hit.
 *
 * Being knocked about is only fair if getting back is possible. For a short
 * window after a genuine impact the engine pulls harder, which converts "I have
 * lost this race" into "I have lost two seconds". It is rate-limited so it can
 * never be farmed by driving into walls, and it is smaller than the speed the
 * impact took, so a crash is always a net loss.
 */
export const RECOVERY = {
  /** Closing speed above which an impact grants the assist. */
  impactThreshold: 12,
  /** Seconds the assist lasts. */
  duration: 1.3,
  /** Engine force multiplier while it lasts. */
  forceMultiplier: 1.3,
  /** Minimum seconds between assists. */
  cooldown: 3.5,
} as const;

/**
 * Speed classes.
 *
 * A single coherent multiplier on the pace of the whole field, applied to top
 * speed and engine force alike. Difficulty changes *who you race*; the class
 * changes *how fast the game is*. Keeping them separate means a player can take
 * a familiar opponent field somewhere genuinely faster, which is the
 * replayability the original build was missing.
 *
 * The classes are deliberately far apart. A 5% step is a stat; a 15% step is a
 * different game, and the top class is meant to be intimidating.
 */
export interface SpeedClass {
  id: string;
  label: string;
  description: string;
  /** Multiplier on top speed and engine force, for every racer alike. */
  scale: number;
  /** Multiplier on grip, so the fastest class is not merely faster. */
  gripScale: number;
}

export const SPEED_CLASSES: readonly SpeedClass[] = [
  {
    id: 'reclaim',
    label: 'Reclaim',
    description: 'The circuit as the crews run it. Fast enough to hurt, slow enough to learn.',
    scale: 1,
    gripScale: 1,
  },
  {
    id: 'cascade',
    label: 'Cascade',
    description: 'Open class. A third again as quick, and the corners arrive a lot sooner.',
    scale: 1.16,
    // Grip rises with speed, but not proportionally: corner speed goes as the
    // square root of grip, so matching the pace exactly would leave cornering
    // untouched and the class would only be a longer straight.
    gripScale: 1.1,
  },
  {
    id: 'longquiet',
    label: 'Long Quiet',
    description: 'What the skiffs will do if you ask. Nothing about this is forgiving.',
    scale: 1.32,
    gripScale: 1.19,
  },
] as const;

export function getSpeedClass(id: string): SpeedClass {
  return SPEED_CLASSES.find((c) => c.id === id) ?? (SPEED_CLASSES[0] as SpeedClass);
}

/**
 * The rider-and-companion strike. The companion rides an outrigger pod and
 * swings a counterweighted grapple arm at a rival alongside.
 *
 * Design intent: a strike is worth roughly 0.35 s of track time against an
 * even opponent — enough to break a tow, never enough to substitute for
 * driving. `tests/unit/combat.test.ts` pins that budget.
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
  /**
   * Radius of one of the two lobes a skiff's hull is made of.
   *
   * A skiff is 4.2 m long and 1.7 m wide. A single 1.35 m circle described
   * neither: two cars could sit 2.7 m apart, which physics called clear, while
   * four metres of hull visibly occupied the same space — a motion review found
   * "three or more skiffs visually occupy the same space" with the contact
   * point buried between the bodies, so the player could not tell which skiff
   * hit which side or which way they had been shoved.
   *
   * Two lobes along the length is the cheapest shape that is actually a car.
   * At this radius and offset the hull is 4.4 m by 2.3 m, which is slightly
   * *tighter* side to side than the old circle, so door-to-door racing gets
   * closer rather than further apart, and nose-to-tail contact happens where
   * the noses are rather than when the centres are within 2.7 m.
   */
  radius: 1.15,
  /** How far each lobe sits from the hull's centre, along its heading. */
  lobeOffset: 1.05,
  /**
   * After a wall impact, the same wall cannot bill again until the racer has
   * been clear of it for this long.
   *
   * Without it a neutral-steer graze renewed the impact every frame and bled
   * 41 m/s down to 5 m/s over a couple of seconds of rail grinding, which is
   * neither learnable nor recoverable. One contact is one impact.
   */
  wallImpactLockout: 0.8,
  /** Metres of clearance that count as having left the wall. */
  wallClearance: 0.6,
  /** Ceiling on the fraction of speed a single wall impact may remove. */
  maxWallSpeedLoss: 0.42,
  /**
   * How fast a *persisting* wall contact is walked off the barrier, in metres
   * per second per second of unbroken contact, and its ceiling.
   *
   * Zero for a clean graze, which should cost speed and nothing else. A contact
   * that survives half a second is one the driver cannot steer out of, because
   * yaw authority falls away with speed — so the escape has to be positional
   * and it has to grow, or the car is pinned until it is retired.
   */
  wallEscapeRate: 5,
  wallEscapeMax: 6,
  /** How much of the closing speed is returned as separation. */
  restitution: 0.35,
  /** Extra separation applied per second while overlapping, to unstick pairs. */
  separationRate: 14,
} as const;

export const RACE = {
  /** Countdown length in seconds; the lights step once per second. */
  countdown: 3,
  /** Grid row spacing along the track. */
  gridRowSpacing: 7,
  /** Grid lateral stagger. */
  gridLateral: 2.4,
  /**
   * Absolute safety valve, measured from the point where there is no human
   * race left to run. It exists only so a wedged opponent cannot hang the
   * results screen; it must be generous enough that an opponent having a bad
   * race is still classified on merit rather than by the clock.
   */
  postRaceTimeout: 75,
  /**
   * Continuous seconds below walking pace after which a racer still out on
   * track counts as retired rather than merely slow. Used to end a race whose
   * only remaining runners have genuinely stopped.
   */
  retirementTime: 12,
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
  /**
   * How long a *player* may be trapped before the race rescues them, seconds.
   *
   * Longer than the AI's, because a human reversing out of a barrier on purpose
   * registers as no forward progress and must be given room to finish the job.
   * Short enough that nobody watches a three-lap race end at the first corner.
   */
  playerRespawnTime: 5.5,
  /**
   * How long after the green light a car that has not moved holds its grid
   * slot against the launching pack, seconds.
   *
   * Long enough to cover the whole launch, short enough that it is over before
   * anyone could use it as cover. It expires immediately once the car moves.
   */
  gridGrace: 4,
  /**
   * How large a predicted saving a driver needs before taking a shortcut, in
   * seconds, from the most cautious nerve to the boldest.
   *
   * The cautious end is deliberately above what a marginal branch offers: a
   * Rookie should take only the obvious cut. The bold end is just above zero,
   * so an Ace takes anything that pays at all — but nobody takes a route that
   * loses time, which is the failure that made every crew drive into
   * Glasshouse's flooded tunnel.
   */
  branchMarginCautious: 0.9,
  branchMarginBold: 0.15,
  /**
   * How long the opening steering assist lasts for a player who has not yet
   * touched the wheel, seconds. Roughly the first corner.
   */
  launchWait: 12,
} as const;

export const HAZARDS = {
  boostPadSurge: 0.3,
  boostPadImpulse: 6,
  mudSpeedMultiplier: 0.55,
  gustStrength: 9,
  /**
   * How much of a gust still reaches a racer tucked hard into its lee.
   *
   * The counter has to be worth real time or it is not a counter, and it has to
   * cost something or it is not a decision — the lee is the outside of the
   * corridor, so taking it gives up the inside line for whatever comes next.
   */
  gustLee: 0.25,
} as const;
