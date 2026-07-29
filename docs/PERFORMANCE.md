# Performance

## Budgets

| Budget | Target | Measured | Enforced by |
| --- | --- | --- | --- |
| Frame time, desktop | ≤ 16.7 ms (60 fps) | **8.3 ms median, 9.5–9.9 ms p95** | Measured by hand; see below |
| Draw calls, world | 10 < n < 100 | **95** on a bunched grid | `tests/e2e/race.spec.ts` |
| Draw calls, post | ≤ 4 | **4** | `tests/e2e/race.spec.ts` |
| Triangles | < 500 k | **320 k–329 k** | Performance overlay |
| Particles | ≤ 800 (High) | Hard cap, pre-allocated | `ParticleSystem` budget |
| JS heap | < 150 MB | **42–48 MB** | Performance overlay |
| Download, total | ≤ 260 kB gzip | **213.8 kB** | `npm run check:budget` |
| Download, our code | ≤ 84 kB gzip | **77.7 kB** | `npm run check:budget` |
| Simulation rate | exactly 120 Hz | **119–121 steps/s** | `tests/e2e/race.spec.ts` |
| Network during a race | none | none | No `fetch` in `src/` |

### The download budget moved once, on purpose

Our own code was 73.7 kB gzipped before the garage landed and is 77.7 kB after,
so the 80 kB ceiling was raised to 84 kB - the same 8% margin the old number
carried, rather than a rounder one. What bought it: the selected crew's
machine is now built by the production race model and lit on a turntable behind
the setup and results screens, the AI carries a per-crew tactical layer, scenery
dissolves per instance around the camera, and night courses draw route markers.

The number is meant to be argued with rather than nudged. If it moves again it
should be for something the player can point at, and the entry above should say
what.

### The draw-call floor is part of the budget

The overlay used to read `renderer.info` at the end of the frame. That works
until there is a post-processing chain, at which point the counters describe
the last full-screen triangle and nothing else: the overlay reported **one**
draw call for the whole game, and the browser suite's ceiling assertion quietly
became "1 < 100". The counters are now captured immediately after the world is
drawn and before any post pass runs, and the test asserts a **floor** as well as
a ceiling. A world drawn in fewer than ten calls is not a world; it is a broken
measurement.

## Desktop measurement

Apple silicon laptop, Chrome, hardware WebGL, 1440 × 900, High quality,
six cars, High quality with shadows and the post chain on:

```
Bunched grid at green   median 8.3 ms · p95 9.5–9.9 ms · draws 95 +4 post
Hero course, mid-race   draws 57–86 · tris 320k–329k
```

120 fps is the display refresh rate, so the renderer is refresh-capped rather
than GPU-bound; the 8.3 ms median against a 16.7 ms 60 fps budget is the real
headroom figure. Reproduce it by enabling **Settings → Show performance
overlay**.

## Lower-tier profile — tested honestly

The Low tier is not a guess. It was exercised under **software WebGL**
(SwiftShader, no GPU at all) in the browser test suite, which is a harder
environment than any real phone: every triangle is rasterised on the CPU.

The game remains **functionally correct** there — the race runs, the HUD
updates, the loop never spirals — but it is not smooth. That is an honest
statement, not a passing grade: software rasterisation is a worst case, and a
real mobile GPU sits far above it.

What the Low tier actually changes:

| Setting | Low | Medium | High |
| --- | --- | --- | --- |
| Pixel ratio cap | 1 | 1.5 | 2 |
| Shadows | off | 1024 | 2048 |
| Scenery density | 35% | 70% | 100% |
| Scenery distance | 260 m | 420 m | 650 m |
| Particle budget | 120 | 340 | 800 |
| Terrain resolution | 10 m | 6 m | 4 m |
| Speed streaks | off | on | on |
| Antialiasing | off | on | on |
| Post-processing chain | **off** | on | on |
| Attract-mode race behind menus | **not run** | run | run |

The post chain is switched off on Low and not as a token gesture: it costs a
full-screen read plus three reduced-resolution draws, which on the class of
device that lands on Low is a meaningful fraction of the frame. The art bible
requires the game to be readable without it, so turning it off costs atmosphere
and nothing else — the tone mapping and the grade have equivalents in three's
own pipeline, which the renderer switches back on when the composer is absent.

Low never trades away anything the *simulation* can see, so a race plays
identically on every tier.

## How the budgets are held

**Draw calls are structural, not incidental.** Scenery is one `InstancedMesh`
per species — a thousand trees are one call. The road, shoulder and barrier are
three merged buffer geometries per path. Particles are two instanced quad
meshes. Adding more trees costs nothing in draw calls.

> The browser tests caught this one. Each skiff was originally built from about
> twenty small meshes, so six cars on a grid cost more than the rest of the
> scene. Static parts are now merged by material, independently moving strut
> stations are instanced, and only the player casts into the shadow map. The
> bunched-grid worst case is 95 calls.

**Particles are pre-allocated.** The pool is fixed at construction and the
oldest slot is recycled when it is exhausted, so nothing is allocated after
startup and the budget is a hard number rather than a hope. Trails from racers
more than 90 m from the camera are not emitted at all — they were filling the
pool and starving the effects that matter.

**Textures are generated once** into canvases at load and uploaded as
`CanvasTexture`s. Nothing is fetched, decoded or streamed at runtime, so there
is no asset pop-in: the world is complete on the first frame it is shown.

**The simulation is decoupled from the frame rate.** During live driving, a slow
frame cannot be "paid back" as a burst of simulation, and a stalled tab cannot
spiral. [ARCHITECTURE.md § Application loop](./ARCHITECTURE.md#application-loop)
owns the exact pacing and post-finish resolve contract.

> A consequence worth understanding: under a very slow renderer the race
> deliberately runs *behind* wall-clock time rather than skipping ahead. This
> is why the browser tests wait on simulated time, never on `setTimeout`.

**Work stops when the tab is hidden.** `visibilitychange` pauses the race
outright — the cheapest possible power saving, and the correct behaviour for a
game.

**Attract mode is skipped on the Low tier.** A phone should not simulate and
render a six-car demonstration race behind a menu.

## Adaptive quality

`AdaptiveQuality` samples frame times and moves tiers only on unambiguous
evidence:

- A full 90-frame window before any decision.
- Judged on the **90th percentile**, not the mean — a smooth 60 fps with one
  200 ms hitch is a very different experience from a steady 45 fps, and only
  the second is worth changing settings over.
- Six-second cooldown after any change.
- **Never raises a tier again after it has had to drop one.** Oscillating
  quality is more annoying than the frame rate it is trying to protect.

The initial guess is conservative — Medium unless the device clearly warrants
High — because opening at High and stuttering through the countdown is worse
than starting lower and being promoted.

## WebGL context loss

`webglcontextlost` is handled: the default is prevented (signalling intent to
restore), the race is paused, and an explanatory panel with a reload action is
shown rather than a frozen canvas. On restore the world is rebuilt rather than
trusting that every GPU resource survived. Covered by
`tests/e2e/presentation.spec.ts`.

## Load time

There is no loading bar because there is nothing to load. The download is
the measured total in the budget table above, and the world is generated in
code.

The one measurable cost at startup is building the first course — the spline is
resampled, the terrain heightfield is projected against the track corridor, and
scenery is scattered. That is why the first course is warmed during boot, while
the title screen is already interactive.

## Reproducing these numbers

```bash
npm run build && npm run check:budget   # download budget
npm run test:e2e                        # draw calls, fixed step, frame loop
npm run dev                             # then Settings → Show performance overlay
```
