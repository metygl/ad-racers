# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Orientation

AD Racers is an original browser racing game. Start with `README.md`, then
`docs/ARCHITECTURE.md`. Run `npm run verify` before proposing changes.

## The invariant everything depends on

**The simulation, track, and AI core in `src/game/` must never import `three`,
touch the DOM, or call `Math.random` or `Date.now`.** The browser input adapter
under `src/game/input/` is the deliberate boundary exception. The simulation runs headlessly in Node, which is what lets a
whole race be a unit test (`tests/support/headless.ts`). Breaking this does not
fail loudly — it quietly removes the project's ability to test its own AI.

`tests/unit/determinism.test.ts` asserts the `Math.random` half of it.

## The handedness rule

**Rotating a heading by +90° on the `(x, z)` plane gives the vehicle's *right*.**
The sim plane is three.js's plane, three.js is right-handed with +Y up, so +Z
points at the viewer. The rule is stated once on `rotate` in `src/core/math.ts`;
use `rightOf` / `leftOf` / `rightNormal` from there and never re-derive it.

This is worth its own section because getting it backwards is *invisible*: the
simulation and AI can agree with each other while both are wrong in screen
space. `tests/unit/handedness.test.ts` therefore asserts through the camera the
renderer builds.

## Sharp edges

These cost real debugging time. Each is documented at its site in the code.

- **Post-processing owns tone mapping and the sRGB encode.** The scene renders
  into a half-float target in linear light with three's tone mapping *off*;
  `src/render/post/Composer.ts` does ACES and the encode after the bloom.
  Three.js does not encode when drawing into a linear render target, so a
  composite that forgets it makes the whole game look like dusk.
- **Read `renderer.info` immediately after the scene draw.** It resets on every
  `render()` call, so anything read after the post passes describes a
  full-screen triangle. This silently reduced the draw-call budget test to
  "1 < 100".
- **Skiff models use `YXZ` Euler order.** They face +X, so roll is about local X
  and pitch about local Z; three's default `XYZ` order applies `rotation.z`
  first and turns it into a pitch.
- **Scenery must clear the run-off, not just the road.** Only declared obstacles
  are collidable, so a tree two metres off the tarmac is one the player drives
  *through*, camera and all.
- **A branch must meet the road in the right place *and* the right direction.**
  `chordAlong` blends into the main line at both mouths so the merge is
  tangential; where it has eased back on it inherits the road's half-width and
  drops its own edge, because physics projects a racer onto exactly one path and
  two overlapping corridors means hitting a wall that is not there.
- **A point past the end of an open path clamps, and its `lateral` becomes
  meaningless.** Withdraw the projection's preference bonus wherever it clamps
  at an end, or a finished branch keeps hold of the racer and reports positions
  tens of metres out.
- **Place shortcut hazards by fraction, never by control-point index.**
  `chordAlong` samples densely; a `slice(2, 5)` silently moves when that density
  changes. Use `atFractions`.
- **Per-skiff meshes are multiplied by six, and by two again if they cast.**
  A shadow-casting mesh is drawn twice, so six skiffs is twelve skiffs of
  geometry. Merge anything that moves together, instance anything that moves
  independently (the strut stations are one `InstancedMesh` per skiff), give
  parts that differ only in colour a `MergePart.color` vertex attribute rather
  than a second material, and let only the player cast into the shadow map.
- **Measure draw calls with the grid bunched, not mid-race.** With the field
  strung out most rivals are frustum-culled, and a number sampled there is
  roughly half the real one. The honest sample is the frame after the green
  light, on High, with shadows on.
- **Track projection scores by true distance, not lateral offset.** When
  `closestPointOnSegment` clamps to a segment end, the lateral component stops
  meaning "how far away this is". Scoring by it makes progress jump tens of
  metres per frame.
- **Velocity is re-projected onto the rotated basis each step.** Rebuilding it
  from pre-rotation components welds velocity to heading, so slip is zero and
  drifting does nothing.
- **Never wait on the wall clock in browser tests.** The loop caps catch-up
  steps, so on a slow renderer simulated time deliberately runs behind real
  time. Use `waitForRaceTime` / `waitForSteps` from `tests/e2e/support.ts`.
- **Dust particles must not be additively blended.** Six cars kicking up grass
  becomes a white sheet across the screen.
- **Run-off pushes the car back positionally, not with a force.** A force
  strong enough to beat the engine settles the car at zero speed, where
  steering has no authority — permanently stuck.
- **AI `skill` is capped well below 1 on purpose.** Targeting 0.86 of the grip
  limit is measurably *slower* and dirtier than 0.72. Difficulty comes from
  `pace`, `reaction` and `mistakeRate`.
- **Pick obscure ports for local servers.** 5173 and 4173 were both already
  serving unrelated projects on this machine, and Playwright happily tested one
  of them.

- **The Saltflat difficulty ladder is thin: Ace beats Pro by 0.86 s over three
  seeds.** Any physics change at all can invert it, and `tests/unit/ai.test.ts`
  will say so. Two attempts at F4's body-angle bound were rejected this way
  before a value above the measured envelope worked; the census that produced it
  is in `docs/VERTICAL-SLICE.md`.
- **Bound the *settled* slip angle, never the mid-step one.** Within a step the
  body rotates before the tyres pull the velocity round to follow it, so the
  instantaneous angle is far larger than the one that persists. Past the peak
  slip angle the tyre curve multiplies grip by more than ten, which is also why
  no sequence of inputs can reach an extreme slip state — a test that needs one
  has to write the velocity directly.

## Tuning

Physics, combat, drift, hop, landing, tow, recovery and speed-class constants
all live in `src/game/config.ts`. Change values there, never inline. After any
change run `npm test` — the AI, fairness, balance and mechanics suites are the
guard rails, and they will catch a change that makes the game worse rather than
merely different.

Two balance facts worth not rediscovering:

- **Cornering is grip limited everywhere; top speed only pays on straights.**
  So the stat mapping in `racers.ts` weights speed more heavily than grip. At a
  14% speed spread against a 39% grip spread the low-grip crew was measurably
  shut out of the podium entirely.
- **Drift charge thresholds are global and must stay that way.** Making the
  skill mechanic a stat means the player picks their skill ceiling in a menu.

## Design intent

`docs/DESIGN-DIRECTION.md` holds the five pillars every mechanic answers to,
and — importantly for anything touching the look or the feel — an explicit
table separating transferable design principles from protected expression.
`docs/ART-BIBLE.md` holds the value hierarchy, which is enforceable rather than
aspirational: scenery is never brighter than the road, and only racers, hazards
and effects reach the top band.

## Deployment

The public repository has GitHub Pages enabled with GitHub Actions as its
source. See `docs/DEPLOYMENT.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
