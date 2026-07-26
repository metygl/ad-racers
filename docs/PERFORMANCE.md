# Performance

## Budgets

| Budget | Target | Measured | Enforced by |
| --- | --- | --- | --- |
| Frame time, desktop | ≤ 16.7 ms (60 fps) | **8.3 ms median, 10.0 ms p95** | Measured by hand; see below |
| Draw calls | < 100 | **58** | `tests/e2e/race.spec.ts` |
| Triangles | < 500 k | **344 k** | Performance overlay |
| Particles | ≤ 800 (High) | Hard cap, pre-allocated | `ParticleSystem` budget |
| JS heap | < 150 MB | **31 MB** | Performance overlay |
| Download, total | ≤ 260 kB gzip | **177.7 kB** | `npm run check:budget` |
| Download, our code | ≤ 80 kB gzip | **44.0 kB** | `npm run check:budget` |
| Simulation rate | exactly 120 Hz | **120 steps/s** | `tests/e2e/race.spec.ts` |
| Network during a race | none | none | No `fetch` in `src/` |

## Desktop measurement

Apple silicon laptop, Chrome, hardware WebGL, 1440 × 900, High quality,
Overgrown Interchange, six cars, mid-race with the player at full throttle:

```
120 fps · median 8.3 ms · p95 10.0 ms
steps/s 120 · quality high
draws 58 · tris 344k · particles 0
heap 31 MB
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
| Attract-mode race behind menus | **not run** | run | run |

Low never trades away anything the *simulation* can see, so a race plays
identically on every tier.

## How the budgets are held

**Draw calls are structural, not incidental.** Scenery is one `InstancedMesh`
per species — a thousand trees are one call. The road, shoulder and barrier are
three merged buffer geometries per path. Particles are two instanced quad
meshes. Adding more trees costs nothing in draw calls.

> The browser tests caught this one. Each skiff was built from about twenty
> small meshes, so six cars on a grid cost roughly a hundred and twenty draw
> calls — more than the entire rest of the scene put together, and the reason
> the measured figure was 160 rather than the 88 seen from a favourable camera
> angle. Merging each skiff's static parts by material took the whole scene from
> 160 to **58**, and the heap from 49 MB to 31 MB, for identical pixels.

**Particles are pre-allocated.** The pool is fixed at construction and the
oldest slot is recycled when it is exhausted, so nothing is allocated after
startup and the budget is a hard number rather than a hope. Trails from racers
more than 90 m from the camera are not emitted at all — they were filling the
pool and starving the effects that matter.

**Textures are generated once** into canvases at load and uploaded as
`CanvasTexture`s. Nothing is fetched, decoded or streamed at runtime, so there
is no asset pop-in: the world is complete on the first frame it is shown.

**The simulation is decoupled from the frame rate.** Fixed 120 Hz steps with a
capped accumulator (8 steps per frame maximum). A slow frame cannot be "paid
back" as a burst of simulation, and a stalled tab cannot spiral.

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
177.7 kB gzipped and the world is generated in code.

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
