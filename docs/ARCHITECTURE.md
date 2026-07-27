# Architecture

## The one idea that matters

**The simulation does not know the renderer exists.**

The simulation, track, and AI core imports nothing from `three`, nothing from
the DOM, and calls neither `Math.random` nor `Date.now`. The browser input
adapter under `src/game/input/` is intentionally outside that deterministic
core. The simulation advances in whole fixed steps of
`1/120 s` and takes a `ControlInput` — the same struct whether it came from a
keyboard, a gamepad, a thumb pad or the opponent AI.

Three things fall out of that, and they are the reason the game works:

1. **A whole race runs in a unit test.** `tests/support/headless.ts` simulates
   six cars over three laps in about a second. "Can the AI drive every course
   from every grid slot at every difficulty?" is an assertion, not a hope.
2. **Frame rate cannot change the result.** A stutter, a background tab, a
   breakpoint — none of them alter the race, because none of them alter the
   step count fed to the simulation.
3. **Restart is a genuine retry.** Same seed, same inputs, same race, down to
   the last float.

```
 input (keyboard / gamepad / touch)          opponent AI
                    │                              │
                    └──────────► ControlInput ◄────┘
                                      │
                    ┌─────────────────▼─────────────────┐
                    │  Simulation   (fixed 120 Hz)      │
                    │  vehicle · combat · race rules    │
                    │  no DOM, no three.js, no Math.random │
                    └─────────────────┬─────────────────┘
                          reads only  │  SimEvent[]
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        GameRenderer               Hud / screens          AudioEngine
```

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Maths, seeded RNG, versioned storage, frame instrumentation. No game knowledge. |
| `src/game/track/` | Spline geometry, track definitions, projection, checkpoints. |
| `src/game/sim/` | Vehicle physics, combat, race rules, the `Simulation` orchestrator. |
| `src/game/ai/` | Opponent driver and difficulty profiles. |
| `src/game/input/` | Browser-facing device adapter and rebindable bindings; deliberately outside the deterministic simulation core. |
| `src/render/` | Three.js scene construction, camera, particles, post-processing, quality tiers. |
| `src/audio/` | Waveform synthesis and the Web Audio graph. |
| `src/app/` | Screen flow, HUD, the game loop that ties it together. |

Dependencies point strictly downwards: `app → render/audio → game → core`.
`game` never imports from `render`, `audio` or `app`.

---

## Handedness, and the bug it caused

**Rotating a heading by +90° on the `(x, z)` plane yields the vehicle's
*right*, not its left.**

The simulation's `(x, z)` plane *is* three.js's `(x, z)` plane — the renderer
maps them straight across — and three.js is right-handed with +Y up, so +Z
points towards the viewer. At heading 0 the nose is +X and the vehicle's right
is `forward × up = X̂ × Ŷ = Ẑ`, which is exactly the +90° rotation. The same
holds for the chase camera, whose screen-right axis `lookAt` builds as
`up × (eye − target)`.

This is the opposite of the intuition you get from sketching `(x, z)` on paper
with z up the page, and getting it backwards is not cosmetic. The first
simulation commit named that vector `leftOf`; `stepVehicle` then negated its
yaw to agree with the name, and the AI negated its own steering output to agree
with *that*. Every internal invariant held. The only observer who could tell
was a player pressing "right" and turning left — for the entire life of the
project until it was found.

The rule now lives once, on `rotate` in `src/core/math.ts`, with `rightOf`,
`leftOf` and `rightNormal` exported from the same place.
`tests/unit/handedness.test.ts` pins it down in *screen space*: it builds the
camera the renderer builds, projects world positions through it, and asserts
which way the pixels move. That is the only frame of reference a player has,
and it is the one that was wrong.

---

## Track geometry

Everything about a course — the mesh you see, the corridor you collide with,
the checkpoints, the AI's reference line and the minimap — is derived from a
single Catmull-Rom spline. There is no second source of truth, which is why the
AI can drive every course the renderer can draw.

**Centripetal parameterisation** (α = 0.5), not uniform. Uniform Catmull-Rom
overshoots when control points are unevenly spaced, which is exactly what a
hand-authored track does at a hairpin — and an overshooting centreline puts the
racing line outside the road.

**Courses are authored as a radius profile**, not as raw XZ points
(`src/game/track/authoring.ts`). A radius sampled in angle order is
star-shaped, so the loop *cannot* self-intersect. A self-intersecting track
breaks projection, checkpoints and AI navigation simultaneously; making that
structurally impossible is better than testing for it (though
`tests/unit/track.test.ts` tests for it anyway).

### Projection

`Track.project(point)` answers "where on the course is this?" via a uniform
broadphase grid, returning distance along the main line, signed lateral offset,
surface, edge kind and elevation.

> **A bug worth remembering.** Candidates were originally scored by their
> *lateral offset*. When `closestPointOnSegment` clamps to a segment end the
> lateral component stops meaning "how far away this is" — a segment 60 m
> further round the lap can sit almost exactly on the query point's normal and
> score as though it were underneath the car. Progress jumped tens of metres
> back and forth every frame, and the AI sawed at the wheel. Scoring by true
> distance to the clamped point fixed it. See `buildTrack.ts`.

### Shortcuts, and why they are legal by construction

A shortcut is an open path whose control points are drawn as a chord between
two points on the main centreline (`chordAlong`). At build time its endpoints
are projected onto the main line to derive the span of main-line distance it
covers, and its own arc length maps **linearly** into that span.

The consequence: riding a shortcut still sweeps main-line progress
*continuously* from entry to exit, so every checkpoint in between is passed in
order. A legal shortcut is legal without any special-casing, and a shortcut
cannot skip a gate even in principle.

Cutting across the infield, by contrast, gains nothing: checkpoints only
register within 2.6× the local half-width, and progress is anchored to the last
checkpoint claimed rather than to raw position.

Because `chordAlong` interpolates between two points *on the road*, the
shortest possible branch is the straight line — so a shortcut is guaranteed to
be shorter, and `bulge` is purely a shaping control. `tests/unit/track.test.ts`
asserts every shipped shortcut saves between 20 m and 12% of a lap.

---

## Vehicle physics

An arcade model in SI units, tuned in `src/game/config.ts`. The parts that
matter:

**Grip-limited cornering.** Yaw rate is capped at `latAccelMax / speed`, so the
fastest a corner of radius *R* can be taken is `sqrt(latAccelMax · R)`.

> Without this cap the model corners at `v / yawRate` regardless of speed,
> which means braking buys nothing and every corner is flat out. This was the
> single most important physics change in the project: it is what turned corner
> entry into a decision.

**Slip is real.** Velocity is re-projected onto the *rotated* basis each step,
so the gap between where the skiff points and where it is going is a genuine
slip angle.

> Originally the velocity was rebuilt from the pre-rotation components, which
> welded it to the heading — slip was identically zero, and drifting therefore
> did nothing at all.

**A tyre curve past the peak.** Beyond `peakSlipAngle` grip climbs steeply.
That gives a slide a stable equilibrium instead of letting it run away into a
spin, which is what makes a drift something you *hold*.

**Drift is a trade.** While drifting the grip-based yaw cap is relaxed 4×, so
the nose rotates ahead of the velocity — but the velocity still curves at the
grip-limited rate. A drift does not corner faster; it rotates the car early and
banks Surge, and it scrubs speed while you hold it.

**Run-off is a slide, not a wall.**

> An inward *force* has to exceed the engine to work at all, and once it does, a
> car pointed outwards at full throttle settles at exactly zero speed — where
> the steering has no authority either, so it is stuck permanently. Sliding the
> car back positionally never fights the throttle and cannot stall.

**Crests launch on the right condition.** Following the ground needs
`d²y/ds² · v²` of downward acceleration; past a fraction of gravity, the skiff
carries on straight.

> Comparing predicted heights one step apart cannot work: at 48 m/s a single
> 8 ms step covers 40 cm, over which even a sharp crest drops well under a
> millimetre — less than any sane epsilon.

**In the air the grip yaw cap is lifted entirely.** Nothing is touching the
ground, so nothing limits how fast the skiff can be pointed.

> Leaving the cap on is what made crests a coin flip: the cap tightens with
> speed, and a crest is taken at speed, so precisely when air control mattered
> most there was none. Air steering is `steerYawRate` alone, already scaled by
> `airborneSteering`, with a slow auto-align towards the direction of travel so
> a landing is a skill rather than a lottery.

**Trail braking lifts the grip cap a little.** Load transfers onto the nose and
it bites, which makes the brake a *steering* input as well as a speed one and
keeps corner entry a continuous decision rather than a single yes-or-no.

---

## The second-generation mechanics

Each has the four beats `docs/DESIGN-DIRECTION.md` requires — anticipation,
execution, payoff, recovery — and each is pinned at its boundaries in
`tests/unit/mechanics.test.ts`.

**Hop** is on its own input and never shares one with drift. The reasoning is
recorded at `HOP` in `config.ts`: the current Mario Kart generation shares its
charge jump with the drift button, and reviewers found any steering input turns
a jump attempt into a drift. Overloading the highest-frequency input punishes
the players who use it most.

**Landing quality** scores how level *and* how straight a landing was, with an
air-time floor so it cannot be farmed by tapping hop down a straight.

**The tow snap** is the game's strategic layer, and the reason there is still
nothing on the road to pick up. Holding a rival's wake banks charge; leaving it
inside a short window spends that charge as a burst. The resource is a
*position*, which has to be earned by racing and which the car in front can
deny by moving.

**Impact recovery** is a short, rate-limited engine assist after a genuine hit.
Being knocked about is only fair if getting back is possible; it is always
worth less than the impact took, so a crash stays a net loss.

**Speed classes** scale top speed and engine force for the whole field
identically, with grip rising by less than the pace so the fast classes corner
harder rather than merely covering ground faster.

---

## Combat

The companion rides an outrigger pod and swings a counterweighted grapple arm
at a rival alongside. Four design rules, all enforced in `sim/combat.ts`:

- **Positional, not a projectile.** You have to earn the alongside position
  first, so racing well is the prerequisite for using it at all.
- **It telegraphs.** A 0.16 s windup, during which the renderer visibly rears
  the arm back. Nothing lands during the windup.
- **It cannot chain.** Repeat hits on the same rival decay by 0.6× each, with a
  floor of 0.25. Nobody gets stun-locked out of a race.
- **It is symmetric.** The AI goes through exactly this code with exactly these
  timings. Difficulty changes *when* it swings, never what a swing does.

Two riders swinging simultaneously **counter**: both stagger, no damage. That
is the skill ceiling of the mechanic — a well-timed counter beats a strike.

The budget: a strike is worth roughly a third of a second against an even
opponent. `tests/unit/combat.test.ts` runs a full race with opponent aggression
at zero and asserts the winning time moves by under 8%.

---

## Surge and drifting

Surge is the only speed boost, and it must be earned:

| Source | Yield |
| --- | --- |
| Drift release, by charge tier | 0.17 / 0.31 / 0.48 |
| Slipstream | 0.24 per second in the tow |
| Clean landing off a crest | 0.09 |
| Landing a strike | 0.11 |
| Boost pad | 0.30 |

Spending it costs 0.46/s for +19% top speed and +50% engine force. There are no
pickups on the road and nothing is randomly awarded.

---

## Opponent AI

The AI produces the same `ControlInput` a player does and runs through the same
physics. There is no separate "AI vehicle model", no extra grip, and no
knowledge of the player's inputs.

**Path following** is pure pursuit plus an explicit cross-track term.

> Two failure modes worth recording. The lookahead must exceed the skiff's own
> minimum turning radius, or pure pursuit demands a corner the car physically
> cannot take, saturates the steering and oscillates itself off the road. And
> pure pursuit alone leaves a standing lateral offset — the car happily runs
> parallel to the road, just beside it — which is what the cross-track term
> fixes.

**Corner speed** comes from centreline curvature via `sqrt(limit / k)`, using
the *same* expression the physics uses, so the prediction matches what the car
will actually do.

**`skill` is capped well below 1**, even at Ace, and that is not timidity: the
model reads curvature from the centreline while the car drives an offset line
with a control lag. Measured across all four courses, targeting 0.86 of the
limit is both dirtier *and slower* than targeting 0.72.

Difficulty separation therefore comes from `pace`, `reaction` and
`mistakeRate`. Measured spread, Rookie → Ace: **10-13% of race time**, asserted
in `tests/unit/ai.test.ts`.

**Recovery** is a reverse/realign state machine, backed by a `wedgeTimer` the
manoeuvres cannot reset — so a car that keeps failing to free itself still
reaches the respawn threshold instead of cycling forever.

**Catch-up** is capped at ±3%, opponents only, and switchable off. See
[DESIGN-RESEARCH.md § rubber-banding](./DESIGN-RESEARCH.md#a-note-on-rubber-banding).

---

## Rendering

`WebGLRenderer` at three quality tiers, with an adaptive monitor that acts only
on a full sampling window of consistent evidence and never raises a tier after
it has had to drop one — oscillating quality is worse than the frame rate it
protects against.

### The colour pipeline, which is the part that goes wrong quietly

The scene draws into a **half-float target in linear light with tone mapping
off**, and `src/render/post/Composer.ts` does bloom, ACES, the grade, the
vignette, the radial speed warp and the chromatic fringe in one composite pass
before encoding to sRGB.

Two orderings matter and neither is obvious:

1. **Tone mapping runs after the bloom, not before.** Mapping first compresses
   every highlight to near 1 before the bright pass sees it, so the bloom has
   no intensity information left and a thruster flares exactly like the sun.
   That is the whole reason the target is half float.
2. **The composite must encode to sRGB itself.** Three.js applies the encode
   when a material draws straight to the canvas, but *not* when it draws into a
   render target with a linear colour space. Leaving it out writes linear values
   into an sRGB framebuffer, and the entire game comes out looking like it is
   being viewed at dusk through a filter — which is exactly what happened on the
   first build of this chain.

The chain is three reduced-resolution draws plus one full-screen composite, and
it is off entirely on the low tier. The art bible's rule governs every
parameter: post supports readability and never conceals weak art. The bloom
threshold sits above the road's value band so the road can never bloom, the
vignette is capped, and every motion-derived term scales to exactly zero under
reduced motion.

### Model rotation order

Skiff models face +X with +Y up, which makes roll a rotation about local X and
pitch a rotation about local Z. Three's default `XYZ` Euler order composes as
`Rx·Ry·Rz`, applying `rotation.z` first — so under the default order
`rotation.z` is a *pitch* and `rotation.x` becomes a world-axis rotation whose
meaning changes with heading. The models use `YXZ`, which is the only order
where those three numbers mean what they are named.

Draw calls are kept low structurally: scenery is one `InstancedMesh` per
species, the road is a handful of merged ribbons, and particles are two
instanced quad meshes.

> Particles are split into **additive glow** and **alpha-blended smoke**.
> Rendering dust additively turns six skiffs kicking up grass into a white
> sheet across the screen — the first playable build was unusable for exactly
> this reason.

The chase camera follows the **velocity**, not the heading. Chasing the nose
whips the camera round during a drift, which is both nauseating and useless:
you want to see where you are going.

---

## Application loop

```ts
const resolving = simulation.resolvingAfterPlayer;
const stepBudget = resolving ? RESOLVE_STEPS_PER_FRAME : MAX_STEPS_PER_FRAME;
const accumulatedBudget = FIXED_STEP * stepBudget;
accumulator += resolving ? accumulatedBudget : elapsed;
accumulator = min(accumulator, accumulatedBudget);
while (accumulator >= FIXED_STEP && steps < stepBudget) {
  if (simulation.phase === 'finished') break;
  simulation.step(input);
  accumulator -= FIXED_STEP;
}
renderer.render(simulation, elapsed);
```

During live driving, capping the accumulator is what stops a long stall from
being "paid back" as a burst of simulation the player never sees. After the
player finishes, the accumulator instead receives a deterministic simulated
budget of 160 steps per rendered frame. This resolves the remaining field
quickly without making its result depend on wall-clock elapsed time. The loop
stops stepping on the race-ending step, including throughout the authored
finish hold. A hidden tab pauses the race outright, which is both correct and
the cheapest possible power saving.

---

## Where the invariants are enforced

| Invariant | Test |
| --- | --- |
| Same seed and inputs → identical race | `determinism.test.ts` |
| No `Math.random` in the simulation | `determinism.test.ts` |
| Batched steps give the same result as single steps | `determinism.test.ts` |
| No course self-intersects | `track.test.ts` |
| Projection is monotonic along the centreline | `track.test.ts` |
| Every shortcut is genuinely shorter | `track.test.ts` |
| Checkpoints cannot be skipped or claimed off-corridor | `rules.test.ts` |
| Every opponent finishes every course at every difficulty | `ai.test.ts` |
| Each difficulty is measurably faster than the one below | `ai.test.ts` |
| Combat is worth under 8% of race time | `combat.test.ts` |
| Catch-up never exceeds ±3% and never touches the player | `fairness.test.ts` |
| Top speed matches the advertised figure | `vehicle.test.ts` |
| Nothing tunnels through an obstacle | `vehicle.test.ts` |
| Saves migrate rather than reset | `settings.test.ts` |
| No audio buffer clips | `audio.test.ts` |
| Every looping bed is seamless at its join | `audio.test.ts` |
| Steer right moves the skiff right *on screen* | `handedness.test.ts` |
| Strike left reaches the rival on your left | `handedness.test.ts` |
| Hop, landing quality, tow snap and recovery hold at their bounds | `mechanics.test.ts` |
| Every opponent finishes every course at every speed class | `mechanics.test.ts` |
| Throttle and steering alone can finish a course | `mechanics.test.ts` |
| Post-finish resolve is wall-clock independent and stops at race end | `race.spec.ts` |
| A championship cannot be won by one heroic round | `circuit.test.ts` |
| A speed class opens only on a podium in the class below | `circuit.test.ts` |
