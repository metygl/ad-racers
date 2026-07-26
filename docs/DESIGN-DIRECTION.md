# Design direction

This document governs the second-generation build of AD Racers. It records the
research the direction rests on, draws an explicit line between *transferable
design principles* and *protected expression*, and states the pillars every
later decision is measured against.

Its companion is [ART-BIBLE.md](./ART-BIBLE.md), which covers how the game
looks and sounds. The earlier [DESIGN-RESEARCH.md](./DESIGN-RESEARCH.md)
covers the mid-1990s arcade lineage the original game took its shape from and
is still accurate; this document sits alongside it rather than replacing it.

---

## The two reference directions

The brief names two high-level directions to blend. Neither is a model to copy;
both are studied for *why* they work.

### Direction A — immediate, playful, readable chaos

Represented by the current Mario Kart generation. What the research actually
establishes:

- **Drift charge thresholds are uniform across the whole roster.** Mario Kart
  World returned to identical mini-turbo charge times for every character and
  vehicle combination, as in Mario Kart Wii, 7 and Wii U ([Super Mario Wiki —
  Mario Kart World][mkw]). The principle: *the skill mechanic must not be a
  stat.* If a character choice changes how long a drift takes to pay, the
  player is choosing their skill ceiling in a menu.
- **Expressiveness is a readability tool, not decoration.** Reviewers noted the
  driving is "much more expressive, with the tilt and suspension travel as you
  drift through corners more cartoony, but also subtly more informative for
  what your kart is doing" ([Super Mario Wiki][mkw]). The principle:
  *exaggerated body motion is telemetry.* Every degree of roll should be
  legible as grip state.
- **A second use for the drift button is a real cost.** The charge-jump shares
  its button with drift, and reviewers found that going for a grind rail "feels
  too risky" because any steering input turns the attempt into a drift, which
  "flummoxes muscle memory" ([Super Mario Wiki][mkw]). The principle:
  *overloading the highest-frequency input punishes the exact players who use
  it most.* We take the lesson, not the mechanic.

### Direction B — velocity, precision, spectacle

Represented by the current Shin'en anti-gravity racer. What the research
establishes:

- **A binary state the player toggles, matched against colour-coded track
  zones, creates constant micro-decisions at speed.** Fast Fusion asks players
  to switch between two phases to match boost strips, with "perfect timing
  required for aligning vehicles to the correct phase" ([Nintendo Life][nl],
  [Traxion][traxion]). The principle: *a single binary state, telegraphed by
  colour, converts a straight into a skill test.* The expression — two named
  phases, those colours, those strips — is theirs.
- **A dedicated vertical input opens the track upward.** Fusion's jump reaches
  shortcuts, orbs above the road, and adjacent lanes ([Nintendo Life][nl]). The
  principle: *verticality multiplies the value of an existing layout* far more
  cheaply than adding layouts.
- **Fewer, larger, entirely new courses beat a long list of variants.** Twelve
  new courses were judged a better set than the previous game's thirty-six
  ([Nintendo Life][nl]). The principle: *count is not content.*
- **Execution over novelty.** The consensus is that it "doesn't break new
  ground for the genre, but the execution is brilliant, with a phenomenal sense
  of speed" ([Nintendo Life][nl]). The principle: *polish is the feature.*

### Sense of speed, generally

Speed is a camera problem before it is a physics problem: field of view, follow
distance, shake, and the density of things passing close to the lens do more
than the number in `topSpeed` ([Game Design Skills][gds], [Game Rant][gr]).
Motion blur has fallen out of favour and is not required — crisp visuals with
strong parallax read faster than a smeared frame ([Game Rant][gr]).

---

## The originality line

This is the part that matters most, so it is stated as a table rather than
prose. **Everything in the right column is forbidden in this repository.**

| Transferable principle (taken) | Protected expression (never taken) |
| --- | --- |
| Drift charge is uniform across the roster | Mini-turbo, its spark colours, its tier names |
| Exaggerated body motion as grip telemetry | Any specific kart, bike or character silhouette |
| Don't overload the highest-frequency input | Any specific control layout or button glyph |
| A binary player state matched to track zones | Two-phase colour switching, its palette, its name |
| A vertical input that opens the layout upward | Any specific jump, orb, or rail system |
| Fewer, larger, wholly original courses | Any course layout, landmark or theme from any game |
| Catch-up must be bounded and honest | Any specific rubber-band curve or item-distribution table |
| Speed is sold by the camera | Any specific HUD, typeface, iconography or trade dress |

AD Racers keeps and deepens its **own** vocabulary throughout: skiffs, crews, a
pilot on the spine and a wrench in the outrigger pod, the Reclaim Circuit,
Surge, the pod arm, the Long Quiet. No name, character, logo, vehicle, layout,
item, environment, interface, icon, sound, texture, mesh, animation or story
element originates outside this repository. See
[PROVENANCE.md](./PROVENANCE.md).

**Where we deliberately diverge.** Both references distribute chaos through
items or pickups that spawn on the road. AD Racers does not, and will not: the
pod arm is positional, Surge is earned, and nothing is randomly awarded. That
is the design's own identity and it is also the strongest possible originality
guarantee — a game with no item roulette cannot be accused of copying one.

---

## Pillars

Every mechanic in the game answers to these five. A feature that cannot be
justified against one of them does not ship.

### 1. The first corner teaches, the hundredth still rewards

A player who has never touched the game must take the first corner
successfully with throttle and steering alone. Every layer above that — braking
for entry, drifting for Surge, the tow, the pod arm, the counter, the line
through a shortcut — is optional, discoverable, and worth real time.

**Test of the pillar:** a scripted player using only throttle and steering
finishes every course; a scripted player using the full mechanic set is
measurably and substantially faster. Asserted in `tests/unit/mastery.test.ts`.

### 2. Every mechanic has four beats

Anticipation, execution, payoff, recovery. A mechanic missing one of them is
unfinished:

| Mechanic | Anticipation | Execution | Payoff | Recovery |
| --- | --- | --- | --- | --- |
| Drift | Charge tier pips, rising audio, body roll | Hold through the corner | Surge + impulse, tier flare | Release scrubs, no spin |
| Surge | Gauge fills, ready chime | Held burst | Speed, FOV, streaks | Drains, cannot be spammed |
| Pod arm | 0.16 s windup, arm rears visibly | Alongside position | Stagger + Surge | Guard decay, counter window |
| Hop / air | Crest shading, horizon rise | Timed hop | Clean landing Surge | Bad landing costs speed only |
| Shortcut | Mouth lit and signed | Commit early | Shorter | Worse surface, never a wall |

### 3. Chaos is readable, and driving decides

Reversals must be possible and must be *seen coming*. Nothing may remove
control for longer than it takes to read what happened. No chain punishment:
every disruptive effect decays hard on repetition and has a counter.

**Test of the pillar:** a full race of maximum combat moves the winning time by
under 8%; guard decay and counters are asserted in `combat.test.ts`.

### 4. The opponent is a driver, not a difficulty number

Opponents run the player's physics, get no extra grip or power, and have no
knowledge of the player's inputs. Difficulty changes *when and how* they drive,
never *what their car is*. Catch-up is bounded at ±3%, applies to opponents
only, and can be switched off.

### 5. Determinism is not negotiable

The simulation stays free of `three`, the DOM, `Math.random` and `Date.now`.
Same seed and same inputs produce a bit-identical race. This is what lets a
whole race be a unit test, and it is the foundation everything above rests on.

---

## What the second generation adds

Each entry names the pillar it serves and the reason it exists.

**Hop and air control** (pillars 1, 2). A short hop off any surface with real
air control. It opens crests and shortcut mouths upward, gives the drift a
clean initiation gesture, and — critically — is on its *own* input, never
sharing with drift, because the research says sharing punishes exactly the
players who use both.

**Charge tiers with a visible ladder** (pillars 1, 2). Drift charge thresholds
are identical for every crew, so the skill mechanic is never a stat. Crews
differ in top speed, engine, grip, mass and reach — never in what a drift is
worth.

**Wake, not items** (pillars 1, 3). The tow is deepened into a positional
resource with a visible cone: it relieves drag, fills Surge, and — new — a
*wake snap* pays a burst for pulling out of the tow cleanly at the right
moment. Strategy from position, not from a pickup.

**Course escalation** (pillar 3). Each course changes across its laps: shutters
open, a conveyor starts, the tide comes in. The change is announced a lap ahead
and is identical for every racer, so it is drama rather than a dice roll.

**Circuit mode** (pillar 1). Three-course championships with aggregated
standings, so a race has consequences beyond itself, and a bad round is
recoverable. Local-only, no accounts, no network.

---

## Sources

- [Super Mario Wiki — *Mario Kart World*][mkw] — drift charge uniformity, charge
  jump, wall ride and rail ride, and the shared-button criticism.
- [Nintendo Life — *Fast Fusion* review][nl] — phase switching, the jump button,
  course count and the execution-over-novelty verdict.
- [Traxion — *Fast Fusion* review][traxion] — phase/boost-strip timing.
- [Game Design Skills — racing game design][gds] — FOV, camera and speed cues.
- [Game Rant — racing games with the best sense of speed][gr] — camera primacy,
  motion blur's decline.

[mkw]: https://www.mariowiki.com/Mario_Kart_World
[nl]: https://www.nintendolife.com/reviews/nintendo-switch-2/fast-fusion
[traxion]: https://traxion.gg/fast-fusion-review/
[gds]: https://gamedesignskills.com/game-design/racing/
[gr]: https://gamerant.com/racing-games-best-sense-feel-speed/
