# Architecture

## The one idea that matters

**The simulation does not know the renderer exists.**

`src/game/` imports nothing from `three`, nothing from the DOM, and calls
neither `Math.random` nor `Date.now`. It advances in whole fixed steps of
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
| `src/game/input/` | Device abstraction and rebindable bindings. |
| `src/render/` | Three.js scene construction, camera, particles, quality tiers. |
| `src/audio/` | Waveform synthesis and the Web Audio graph. |
| `src/app/` | Screen flow, HUD, the game loop that ties it together. |

Dependencies point strictly downwards: `app → render/audio → game → core`.
`game` never imports from `render`, `audio` or `app`.

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
with a control lag. Measured across all three courses, targeting 0.86 of the
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
accumulator += elapsed;
accumulator = min(accumulator, FIXED_STEP * MAX_STEPS_PER_FRAME);
while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
  simulation.step(input);
  accumulator -= FIXED_STEP;
}
renderer.render(simulation, elapsed);
```

Capping the accumulator is what stops a long stall from being "paid back" as a
burst of simulation the player never sees. A hidden tab pauses the race
outright, which is both correct and the cheapest possible power saving.

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
