# AD Racers

An original single-player arcade racing game that runs in a browser. Three
hundred years after the Long Quiet, the motorways are green again — and the
salvage crews race on them.

Six crews. Three courses. Two seats per skiff: a pilot on the spine and a
wrench in the outrigger pod who can swing a grapple arm at anyone running
alongside.

No backend, no accounts, no analytics, no ads, no asset files. One runtime
dependency. 178 kB gzipped, and it runs offline once loaded.

---

## Premise

The Reclaim Circuit is where salvage crews settle who gets the next dig site.
You race a two-seat hover-skiff over three laps against five opponents, on
reclaimed motorway, a dry salt lake, or a basalt quarry at last light.

Three things decide a race:

- **The line.** Cornering is grip-limited, so corner entry is a real decision
  and braking is worth doing.
- **Surge.** The only boost, and it must be earned — by drifting, by
  slipstreaming, by landing cleanly off a crest. Nothing spawns on the road.
- **The pod arm.** Your wrench can strike a rival alongside. It telegraphs, it
  cannot chain, and it is worth about a third of a second — enough to break a
  tow, never enough to substitute for driving.

## Playing

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | `W` / `↑` | Right trigger, `A` |
| Brake / reverse | `S` / `↓` | Left trigger, `B` |
| Steer | `A` `D` / `←` `→` | Left stick, D-pad |
| Drift | `Space` / `L Shift` | `X` |
| Surge | `L` / `L Ctrl` | `Y` |
| Strike left | `Q` / `,` | Left bumper |
| Strike right | `E` / `.` | Right bumper |
| Recover | `R` | Left stick click |
| Camera | `C` | Right stick click |
| Pause | `Esc` / `P` | Start |

Every action except pause is rebindable in **Settings → Controls**. Escape
always pauses.

**Touch** is offered on devices with a genuine coarse pointer: a steering strip
under the left thumb, action pads under the right, and a permanent
auto-throttle — holding an accelerator with the same thumb you steer with is
the usual reason touch racing games are unplayable, so the game does not ask.

### Getting quicker

- Hold the drift *through* the corner. Charge banks in tiers; the third pays
  nearly three times the first.
- Sit in a rival's wake on a straight. The tow relieves drag and fills Surge.
- Spend Surge on the exit of a corner, not the entry.
- A strike into a rival's braking zone costs them more than one on a straight.
- Two riders swinging at once **counter** — both stagger, neither is hurt. A
  well-timed counter beats a strike.

## Courses

| Course | Character | Shortcut |
| --- | --- | --- |
| **Overgrown Interchange** | Wide, fast, forgiving. A flyover crest that launches you. | Collapsed Slip Road — shorter, but broken dirt with rubble in it |
| **Saltflat Reliquary** | The top-speed course. Enormous width, long sweeps, a crosswind. | The Lagoon Line — straighter, but standing water halves your grip |
| **Emberfall Quarry** | Technical. Narrow walled benches, blind crests, steep elevation. | The Conveyor — two skiffs wide, walled, with spoil on it |

Every shortcut is genuinely shorter and genuinely worse in some other way. Both
halves of that are asserted by test.

## Difficulty

**Rookie**, **Pro** and **Ace** differ by roughly 10-13% of race time. They
change how close to the limit an opponent drives, how quickly it reacts, how
often it makes a mistake, and how readily it uses the pod arm — never how much
grip or power it has. Opponents run the same physics as you.

The optional **"Keep the pack close"** assist gives trailing *opponents* up to
3% extra engine output. It never applies to you, it is far too small to erase a
mistake, and it can be switched off.

## Browser support

Needs WebGL 2 (with a WebGL 1 fallback) and ES2022.

| Browser | Status |
| --- | --- |
| Chrome / Edge 111+ | Supported, primary target |
| Firefox 110+ | Supported |
| Safari 16.4+ | Supported |
| Mobile Chrome / Safari | Supported with touch controls |

Without WebGL the game says so plainly, with a reason and a suggestion — it
never shows a blank canvas. Blocked `localStorage` (private browsing) degrades
to "settings are not remembered", not an error.

## Accessibility

- Full keyboard operation, including a skip link, visible focus, roving
  radiogroups and a focus trap in dialogs.
- `prefers-reduced-motion` removes camera shake and speed streaks entirely, and
  is exposed as a setting.
- `prefers-contrast: more` is honoured, and is also a setting.
- Live region announces laps, positions and results without moving focus.
- The canvas is `aria-hidden`; everything it conveys is also text.
- All targets ≥ 44 px; nothing depends on hover.
- Layout verified at 320, 390, 768, 1024 and 1440 CSS pixels, with safe-area
  insets and browser zoom.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | ESLint with type-aware rules |
| `npm test` | 158 unit tests |
| `npm run test:e2e` | Browser tests against the production build |
| `npm run check:assets` | Fail if an undocumented binary asset exists |
| `npm run check:budget` | Fail if the download exceeds its budget |
| `npm run licenses` | Dependency licence table |
| `npm run verify` | Everything except the browser tests |

### Testing strategy

The simulation has no renderer, DOM or timing dependency, so a whole race runs
inside a unit test in about a second. That is the foundation everything else
rests on:

- **Determinism** — same seed and inputs produce a bit-identical race; no
  `Math.random` anywhere in the simulation.
- **Track geometry** — no course self-intersects, projection is monotonic,
  every shortcut is genuinely shorter.
- **Rules** — checkpoints cannot be skipped or claimed off-corridor; a lap
  cannot be teleported.
- **AI** — every opponent finishes every course at every difficulty, stays on
  the road, and each level is measurably faster than the one below.
- **Fairness** — catch-up never exceeds ±3% and never touches the player.
- **Combat** — range, cooldown, guard decay, counters, and a hard cap on how
  much a whole race of strikes is worth.
- **Physics** — top speed matches the card, braking beats coasting, drifts
  slide without spinning, nothing tunnels through an obstacle.
- **Saves** — an old save migrates rather than resetting.
- **Audio** — no buffer clips, and every loop point is seamless.

Browser tests cover menu-to-finish, pause/resume, resize, five viewports,
keyboard-only navigation, focus trapping, reduced motion, high contrast, WebGL
failure, context loss and unavailable storage.

The gamepad seam is tested with a synthetic Standard Gamepad injected at
`navigator.getGamepads()` — Playwright cannot plug in a controller, but
everything downstream of that call is our code, so trigger throttle, stick
deadzone, button edges and pad detection are all genuinely exercised.

## Deployment

The site is a static bundle with hashed filenames and a configurable base path.
`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`, deriving the base path from the repository name so a fork under
a different name works unchanged.

> **⚠ The live site is not yet enabled.** This repository is private, and the
> account's current plan does not permit GitHub Pages from a private
> repository — the API returns
> `Your current plan does not support GitHub Pages for this repository.`
> (HTTP 422). The build and workflow are complete and will publish as soon as
> either the repository is made public or the account is upgraded. See
> [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

Meanwhile the production build runs anywhere that serves static files:

```bash
npm run build
npx serve dist          # or any static host
BASE_PATH=/ npm run build   # to serve from a domain root
```

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). The one idea worth knowing:
**the simulation does not know the renderer exists.**

```
src/core/     maths, seeded RNG, versioned storage, instrumentation
src/game/     track geometry, physics, combat, rules, opponent AI
src/render/   three.js scene, camera, particles, quality tiers
src/audio/    waveform synthesis and the Web Audio graph
src/app/      screens, HUD, the fixed-step game loop
```

## Assets and licensing

Every texture, mesh and sound is generated by code at load time. There is not a
single `.png`, `.glb` or `.mp3` in the repository, and CI fails if one appears.
One runtime dependency: three.js (MIT).

- [docs/ASSET-PIPELINE.md](./docs/ASSET-PIPELINE.md) — how it is generated, and
  why Blender and image-to-3D were evaluated and rejected
- [docs/PROVENANCE.md](./docs/PROVENANCE.md) — licences, originality, and what
  is stored locally
- [docs/DESIGN-RESEARCH.md](./docs/DESIGN-RESEARCH.md) — source-linked research
  into the mid-1990s arcade racers this takes its shape from, and what was
  deliberately *not* taken

AD Racers is an original game. It contains no names, characters, logos, track
layouts, environments, dialogue, music, sound effects, code, screenshots,
meshes or textures from any existing title.

## Performance

8.3 ms median frame time on a modern laptop, 58 draw calls, 344 k triangles,
31 MB heap, 178 kB download. Full evidence and the lower-tier profile in
[docs/PERFORMANCE.md](./docs/PERFORMANCE.md).

## Known limitations

- **The live site is not enabled** — see Deployment above. This is a plan
  restriction, not a build problem.
- **Software WebGL is functional but not smooth.** Verified in CI under
  SwiftShader; a real mobile GPU sits far above that, but there is no hardware
  mobile measurement in this repository yet.
- **Single player only.** There is no local or online multiplayer.
- **Gamepad rebinding is fixed.** Keyboard bindings are fully rebindable;
  gamepad buttons use the Standard Gamepad layout and are not remappable.
- **Best times are per course, not per difficulty.** The difficulty a record
  was set on is stored and shown, but a single slot is kept per course.
- **Opponents drift only where it pays.** They use it on the technical course
  and rarely on the fast ones, which is correct but means the flashiest part of
  the driving model is mostly the player's.

## Roadmap

Genuinely optional depth, not missing core gameplay — everything the game needs
to be a complete game is present.

- A championship across all three courses with aggregated standings
- Ghost replay of your best lap, which the deterministic simulation already
  supports
- A fourth course at night, for a lighting direction the current three do not
  cover
- Per-difficulty record slots
- Remappable gamepad buttons
