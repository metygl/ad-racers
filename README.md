# AD Racers

An original single-player arcade racing game that runs in a browser. Three
hundred years after the Long Quiet, the motorways are green again — and the
salvage crews race on them.

Six crews. Four courses. Three speed classes. Two seats per skiff: a pilot on
the spine and a wrench in the outrigger pod who can swing a grapple arm at
anyone running alongside.

**Play it:** <https://metygl.github.io/ad-racers/>

This is an explicitly unfinished public preview of the round-3 snapshot. It is
live for play and sharing, not a declaration that the larger milestone or its
independent review is complete.

No backend, no accounts, no analytics, no ads, no asset files. One runtime
dependency, an enforced download budget, and it runs offline once loaded. See
[Performance](#performance) for the current measurements.

---

## Premise

The Reclaim Circuit is where salvage crews settle who gets the next dig site.
You race a two-seat hover-skiff over three laps against five opponents, on
reclaimed motorway, a dry salt lake, a collapsed arcology after dark, or a
basalt quarry at last light.

Four things decide a race:

- **The line.** Cornering is grip-limited, so corner entry is a real decision.
  Braking is worth doing, and braking hard sharpens the turn-in.
- **Surge.** The only boost, and it must be earned — by drifting, by taking a
  crest cleanly, by working a rival's wake. Nothing spawns on the road, and
  nothing is randomly awarded. There is no item roulette in this game.
- **The tow.** Sit in a rival's wake and a snap charges. Pull out with it
  banked and you get a burst — so a straight is a decision about *when*, and
  the resource is a position you had to earn.
- **The pod arm.** Your wrench can strike a rival alongside. It telegraphs, it
  cannot chain, and it is worth about a third of a second — enough to break a
  tow, never enough to substitute for driving.

**Circuit** runs a championship across all four courses. Points every round,
everyone scores, and finishing on the podium opens the next speed class.

## Playing

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | `W` / `↑` | Right trigger, `A` |
| Brake / reverse | `S` / `↓` | Left trigger, `B` |
| Steer | `A` `D` / `←` `→` | Left stick, D-pad |
| Drift | `L Shift` / `J` | `X` |
| Hop | `Space` / `K` | Bottom face button |
| Surge | `L` / `L Ctrl` | `Y` |
| Strike left | `Q` / `,` | Left bumper |
| Strike right | `E` / `.` | Right bumper |
| Recover | `R` | Left stick click |
| Camera | `C` | Right stick click |
| Pause | `Esc` / `P` | Start |

**Hop has its own button and never shares one with Drift.** That is a
considered decision: the current Mario Kart generation puts its charge jump on
the drift button, and reviewers found any steering input turns a jump attempt
into a drift. Overloading the highest-frequency input punishes exactly the
players who use it most. See [docs/DESIGN-DIRECTION.md](./docs/DESIGN-DIRECTION.md).

Every keyboard action except pause is rebindable in **Settings → Controls**.
Gamepad buttons use the fixed Standard Gamepad layout. Escape always pauses.

**Touch** is offered on devices with a genuine coarse pointer: a steering strip
under the left thumb, action pads under the right, and a permanent
auto-throttle — holding an accelerator with the same thumb you steer with is
the usual reason touch racing games are unplayable, so the game does not ask.

**One press is one strike.** The pod arm is a request rather than a held state,
so holding a strike control never produces a second swing or a stream of
refusals; release it and press again to swing again. The same rule applies on
every device, and nothing that was already held when a menu closed counts as a
press - resuming with the button that confirmed Resume does not hop.

### Getting quicker

- Hold the drift *through* the corner. Charge banks in three tiers, shown as
  pips on the HUD and as sparks on the skiff itself; the third pays nearly
  three times the first. The thresholds are identical for every crew — the
  skill mechanic is never a stat.
- Sit in a rival's wake on a straight. The tow relieves drag, fills Surge and
  charges a snap; pull out with the snap banked and it fires.
- Hop into a crest so you leave it level, and land straight. A level, aligned
  landing pays Surge and a shove; a sideways one pays nothing.
- Brake *into* the corner rather than before it. Load on the nose buys turn-in.
- Spend Surge on the exit of a corner, not the entry.
- A strike into a rival's braking zone costs them more than one on a straight.
- Two riders swinging at once **counter** — both stagger, neither is hurt. A
  well-timed counter beats a strike.

## Courses

| Course | Character | Shortcut |
| --- | --- | --- |
| **Overgrown Interchange** | Wide, fast, forgiving. A flyover crest that launches you. | Collapsed Slip Road — shorter, but broken dirt with rubble in it |
| **Saltflat Reliquary** | The top-speed course. Enormous width, long sweeps, a crosswind. | The Lagoon Line — straighter, but standing water halves your grip |
| **Glasshouse Vigil** | Night. Long committed corners, a walled chicane, and the Nave — the longest straight on the Circuit. | The Rootway — shorter and flat, but it gives up the crest and there is water on the floor |
| **Emberfall Quarry** | Technical. Narrow walled benches, blind crests, steep elevation. | The Conveyor — two skiffs wide, walled, with spoil on it |

Every shortcut is genuinely shorter and genuinely worse in some other way. Both
halves of that are asserted by test.

## Difficulty

**Rookie**, **Pro** and **Ace** differ by roughly 10-13% of race time. They
change how close to the limit an opponent drives, how quickly it reacts, how
often it makes a mistake, how readily it uses the pod arm, and how hard it
covers the line you are coming down - never how much grip or power it has.
Opponents run the same physics as you.

Difficulty is the *competence* layer and is shared by the whole field. Which of
several legal choices a driver prefers is the *crew* layer, and it is fixed per
crew: who hugs the inside, who will take any cut going, who sits in your wake to
the last metre, who swings the moment you draw alongside. Each crew's card names
its tactics, so you know what to watch for, and the six average out - a crew
changes who does what, not how fast the field is.

Separately, three **speed classes** — Reclaim, Cascade and Long Quiet — scale
the pace of the whole field, player included. Difficulty changes *who you
race*; the class changes *how fast the game is*. Cascade and Long Quiet are
earned by finishing a Circuit on the podium in the class below, and a locked
class is always shown with what opens it.

The optional **"Keep the pack close"** assist gives trailing *opponents* up to
3% extra engine output. It never applies to you, it is far too small to erase a
mistake, and it can be switched off.

## Browser support

Needs WebGL 2 and ES2022.

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
| `npm test` | Unit suite, including whole races simulated headlessly |
| `npm run test:e2e` | Browser suite against the production build |
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

They wait on *simulated* time rather than the wall clock, because the loop caps
how much simulation a single rendered frame may catch up - so under software
WebGL a race deliberately runs behind real time. The corollary is that waiting
for race time costs rendering time: a test that needs to be past the countdown
and the strike grace uses `skipRaceTime`, which advances the simulation without
drawing, and only tests that are *about* the loop's pacing wait on it for real.

The gamepad seam is tested with a synthetic Standard Gamepad injected at
`navigator.getGamepads()` — Playwright cannot plug in a controller, but
everything downstream of that call is our code, so trigger throttle, stick
deadzone, button edges and pad detection are all genuinely exercised.

## Deployment

The site is a static bundle with hashed filenames and a configurable base path.
`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`, deriving the base path from the repository name so a fork under
a different name works unchanged.

**Live site:** <https://metygl.github.io/ad-racers/>

For the current Pages status and deployment details, see
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

The production build also runs anywhere that serves static files:

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
src/render/   three.js scene, camera, particles, post-processing, quality tiers
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
- [docs/DESIGN-DIRECTION.md](./docs/DESIGN-DIRECTION.md) — the pillars, and an
  explicit table separating transferable design principles from protected
  expression
- [docs/ART-BIBLE.md](./docs/ART-BIBLE.md) — colour, value hierarchy,
  silhouette, materials, motion, post-processing budget and sound identity
- [docs/VERTICAL-SLICE.md](./docs/VERTICAL-SLICE.md) — the hero-slice acceptance
  matrix, mapping every independent art and motion finding to fixed, partial or
  not done

AD Racers is an original game. It contains no names, characters, logos, track
layouts, environments, dialogue, music, sound effects, code, screenshots,
meshes or textures from any existing title.

## Performance

Budgets and measurements, including the cost of the post-processing chain, are
in [docs/PERFORMANCE.md](./docs/PERFORMANCE.md). `npm run check:budget` fails
the build on a download regression, and the browser suite asserts both a frame
time and a draw-call ceiling.

## Known limitations

- **Software WebGL is functional but not smooth.** Verified in CI under
  SwiftShader; a real mobile GPU sits far above that, but there is no hardware
  mobile measurement in this repository yet.
- **Single player only.** There is no local or online multiplayer.
- **Best times are per course, not per difficulty or class.** The difficulty
  and speed class a record was set on are stored and shown, but a single slot
  is kept per course.
- **Opponents drift only where it pays.** They use it on the technical course
  and rarely on the fast ones, which is correct but means the flashiest part of
  the driving model is mostly the player's.
- **The garage stage is one machine, not a workshop.** The selected crew's
  skiff is built by the production race model and lit on a turntable behind the
  setup and results screens; there is no walk-around, no part inspection and no
  livery editing.

## Roadmap

This preview intentionally ships before the larger visual-overhaul milestone is
complete. [docs/VERTICAL-SLICE.md](./docs/VERTICAL-SLICE.md) owns the current
review status. Possible later additions beyond that work include:

- Ghost replay of your best lap, which the deterministic simulation already
  supports
- Per-difficulty and per-class record slots
- Remappable gamepad buttons
- A split-screen second player, which the fixed-step simulation would take
  without structural change
