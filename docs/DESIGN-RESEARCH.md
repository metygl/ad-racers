# Design research

AD Racers is an original game. It takes its *shape* — a two-seat vehicle, a
companion who can swing at rivals, arcade handling, a small set of themed
courses — from a recognisable strand of mid-1990s arcade racing, of which
Core Design's *BC Racers* (1994) is the clearest example. This document records
what that research actually found, what was taken, what was deliberately not
taken, and where the design departs on purpose.

**Nothing from any existing game is present in this repository.** No names,
characters, crews, logos, track layouts, environments, dialogue, music, sound
effects, code, screenshots, meshes or textures. Every asset here is generated
by code in `src/`, and every name is invented. See
[PROVENANCE.md](./PROVENANCE.md).

---

## What the research established

Sources are listed at the bottom; claims below are attributed inline.

### The vehicle and the companion

The defining feature of the inspiration is a two-person vehicle: one character
drives while a second "fights off opponents using clubs, punches, kicks, etc."
([MobyGames][moby], [Wikipedia][wiki]). Both riders could attack — on the Sega
CD version the driver could target racers on their left while the sidekick in
the sidecar swung to the right, a symmetry that was cut down in the later ports
so that you could only strike to one side ([MobyGames][moby]).

Reviewers were consistent that the *idea* was better than the execution. The
two-player split of driving and fighting was singled out as something that
"should have been used more in other games" ([MobyGames][moby]), while the
single-player attack itself was criticised as "only one offensive skill … a
rudimentary attack at your disposal that relies on an arbitrary condition, and
it unfortunately doesn't cause enough damage to be worthwhile"
([Sega-16][sega16]).

**What AD Racers takes:** the two-seat vehicle and the close-range,
positional strike. **What it changes:** strikes work to *both* sides, which is
the version the reviews preferred and which the later ports abandoned; and the
mechanic is given real depth — a telegraphed windup, a counter if two riders
swing simultaneously, and hard diminishing returns on repeat hits. See
[ARCHITECTURE.md § Combat](./ARCHITECTURE.md#combat).

### Progression and track structure

The inspiration advertised 32 tracks, which in practice were "eight major
tracks with four variations of difficulty for each" ([Defunct Games][defunct]),
across four difficulty settings — Easy, Medium, Hard and Rockhard
([MobyGames][moby]). Races were four laps ([Wikipedia][wiki]). Each of the
eight courses had a distinct look — "a bedrock-style neighborhood, a dense
jungle, a creepy cave with lava pits, a desert track" ([Defunct
Games][defunct]).

**What AD Racers takes:** small, strongly themed courses, and difficulty as a
first-class choice. **What it changes:** it does not inflate the course count
by re-labelling the same track four times. Three courses that are genuinely
different in layout, surface, width and hazard are worth more than twelve
variations, and three laps is a better length than four for a browser session.

### Power-ups and boost

Notably, the inspiration had no Mario Kart-style pickups: "there are no
power-ups, except for a turbo" ([Wikipedia][wiki]), and the turbo could be
triggered "every few seconds" ([Wikipedia][wiki]) giving roughly "30% faster
for ten seconds" ([Defunct Games][defunct]).

**What AD Racers takes:** the no-pickups stance. Nothing spawns on the road
and nothing is randomly awarded, so a race is decided by driving.
**What it changes:** the free, on-a-timer turbo is replaced by **Surge**, which
must be *earned* — by drifting, by clean landings, by slipstreaming, and to a
small degree by landing strikes. A boost you earn rewards skill; a boost on a
cooldown just adds a key to press. See [ARCHITECTURE.md § Surge](./ARCHITECTURE.md#surge-and-drifting).

### Scoring

Points were awarded for damaging opponents, and could place you first overall
"even if you came in second" ([MobyGames][moby]).

**What AD Racers deliberately rejects:** combat outranking the race result.
The finishing order is the result. Strikes are recorded on the results screen
because they are interesting, but they never change who won. This is enforced
by test, not just by intent (`tests/unit/combat.test.ts`, "is worth far less
than driving well").

### Camera and presentation

Three viewpoints were offered, "all essentially from behind, just at different
angles", and switching between them required pausing ([Defunct
Games][defunct]). Presentation was the most consistently criticised aspect
across every port: a "choppy frame rate and prominent slowdown"
([Wikipedia][wiki]), and gameplay that looked "much worse … muddy animation,
choppy graphics, and intangible visuals" ([Defunct Games][defunct]). The audio
fared no better — the tyre skid sound "is so incessantly repetitive that it's
all you can hear through most of the game" ([Sega-16][sega16]).

**What AD Racers takes:** a chase camera as the default, and a second, closer
option.
**What it changes:** the camera switches instantly on a key, never through a
pause menu. Frame rate is treated as a feature with a budget and an adaptive
quality system rather than something that happens to you
([PERFORMANCE.md](./PERFORMANCE.md)). And the surface audio is mixed as a
*layer* under the engine and speed cues, at a level set by how rough the
surface actually is, precisely so it never becomes the only thing you hear.

### The most useful finding

The harshest review summarised the game as "the very definition of a functional
game that is absolutely no fun" ([Sega-16][sega16]), with the attack
undermined by not mattering enough and the driving undermined by not asking
anything of you — "all you do is skid around turn after turn without anything
to show for it" ([Sega-16][sega16]).

That diagnosis shaped the whole design more than any individual feature did:

- **Corners must ask a question.** The physics has a real grip limit, so
  cornering speed is bounded by `sqrt(latAccelMax / curvature)` and braking is
  worth doing. An early version of this project had no such limit, and corners
  were flat out — exactly the failure the review describes. See
  `PHYSICS.gripToLateralAccel` in `src/game/config.ts`.
- **Drifting must pay.** Holding a slide banks Surge, which is the only way to
  get one. It also scrubs speed, so it is a trade rather than a free win.
- **Strikes must matter, but not decide.** Budgeted at roughly a third of a
  second of track time against an even opponent.
- **Every course needs a decision in it.** Each has a shortcut that is
  genuinely shorter but genuinely worse in some other way — broken dirt with
  rubble, standing water, a walled ledge two skiffs wide.

---

## What was deliberately not taken

| Element of the inspiration | Status here |
| --- | --- |
| Prehistoric / caveman setting | Not used. AD Racers is set three centuries after an industrial collapse, on reclaimed motorways. |
| Any character, crew or vehicle name | Not used. All six crews, twelve riders and six skiffs are original. |
| Parody names of real musicians | Not used, and not imitated. |
| Track layouts and environments | Not used. All three courses are authored from scratch in `src/game/track/tracks/`. |
| Art, audio, code, screenshots | Not used. Everything is generated procedurally by this repository. |
| Damage-based scoring overriding finishing order | Rejected on design grounds, as above. |
| Turbo on a timer | Replaced with earned Surge. |
| 8 tracks × 4 difficulty re-skins | Rejected; three distinct courses instead. |

---

## Modern pipeline evaluation

The brief asked whether current 3D tooling — Three.js versus Babylon.js, Blender
MCP, scripted glTF export, image-to-3D — would materially improve quality.

**Renderer: Three.js `WebGLRenderer` (r0.185).** Three.js ships production
WebGPU support via `WebGPURenderer` with automatic WebGL fallback, and reports
of 2-10× gains on draw-call-heavy scenes ([utsubo][three2026],
[AppScale][appscale]). That is real, but it is not this game's bottleneck: AD
Racers runs at **88 draw calls**, well inside the ~100 guideline those same
sources give ([utsubo tips][threetips]), because scenery is instanced and the
road is a handful of merged ribbons. WebGPU would buy nothing measurable here
while costing a second render path to test and a less reliable headless story
for CI. Recorded as evaluated and deferred.

**Asset pipeline: procedural, in-repository.** Blender is not on `PATH` in this
environment, and the brief forbids installing system-wide software or changing
global configuration. Adding a Blender step would also make CI depend on a
large binary that GitHub's runners do not have, for assets that are — at this
art direction — simple stacked primitives. Image-to-3D services were rejected
outright on provenance grounds: an asset whose training data and licence cannot
be stated is not something this repository can honestly ship.

Everything is therefore generated by code at load time: geometry from
primitives, textures onto a canvas, audio into `AudioBuffer`s. The result is
that the entire download is 178 kB gzipped with **zero binary assets**, every
pixel and sample is traceable to a source file, and a race can start with the
network unplugged. See [ASSET-PIPELINE.md](./ASSET-PIPELINE.md).

---

## Sources

- [BC Racers — Wikipedia][wiki]
- [BC Racers — MobyGames][moby]
- [BC Racers (32X) — Sega-16][sega16]
- [BC Racers — Defunct Games (Sega 32X review)][defunct]
- [What's New in Three.js (2026): WebGPU, New Workflows & Beyond — utsubo][three2026]
- [100 Three.js Tips That Actually Improve Performance (2026) — utsubo][threetips]
- [Three.js in Production 2026: WebGPU, Perf & Fallback — AppScale][appscale]
- [An Architecture Overview for AI in Racing Games — Game AI Pro][gameaipro]
- [Rubber-Banding as a Design Requirement — Game Developer][rubber]

[wiki]: https://en.wikipedia.org/wiki/BC_Racers
[moby]: https://www.mobygames.com/game/5566/bc-racers/
[sega16]: https://www.sega-16.com/2008/08/bc-racers/
[defunct]: http://www.defunctgames.com/review/904/bc-racers
[three2026]: https://www.utsubo.com/blog/threejs-2026-what-changed
[threetips]: https://www.utsubo.com/blog/threejs-best-practices-100-tips
[appscale]: https://appscale.blog/en/blog/threejs-production-3d-web-2026-webgpu-realtime-standards
[gameaipro]: https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter38_An_Architecture_Overview_for_AI_in_Racing_Games.pdf
[rubber]: https://www.gamedeveloper.com/design/rubber-banding-as-a-design-requirement

### A note on rubber-banding

The racing-AI literature describes rubber-banding as a system that "attempts to
change the AI speed to best match the player's over the course of the race,
with the objective normally being to beat the player at the start but to be
losing at the finish" ([Game AI Pro][gameaipro]), and arcade cabinets are
described as using it aggressively — significant speed boosts for computer
karts when the player is far ahead ([Game Developer][rubber]).

AD Racers uses a far weaker version and says so out loud. The assist is capped
at **±3% engine output**, applies only to opponents, only scales with distance
behind the leader, and is exposed as a setting the player can switch off. At
that magnitude it keeps the pack from stringing out over three laps without
ever being able to erase a mistake — which is the specific thing that makes
aggressive rubber-banding feel like cheating. `CATCHUP_LIMIT` in
`src/game/sim/simulation.ts` is the single constant, and
`tests/unit/fairness.test.ts` asserts nothing ever exceeds it.
