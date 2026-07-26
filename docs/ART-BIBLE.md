# Art and presentation bible

The rules the whole game is drawn and mixed to. Companion to
[DESIGN-DIRECTION.md](./DESIGN-DIRECTION.md).

Everything here is enforceable: colours live in `src/render/palette.ts`, track
themes in each course file, typography and spacing in `src/styles.css`, and the
audio identity in `src/audio/`. There are no image, mesh or sound files — see
[ASSET-PIPELINE.md](./ASSET-PIPELINE.md).

---

## The one-line brief

**Sun-bleached salvage machinery, moving impossibly fast through a world that
has been quietly reclaimed by plants and weather for three hundred years.**

Warm, hand-built, slightly agricultural vehicles. Cool, enormous, indifferent
environments. The tension between those two is the look.

---

## Value hierarchy

The single most important rule, because it is what keeps the road readable at
48 m/s. Stated as a strict ordering of luminance:

| Layer | Value band | Rationale |
| --- | --- | --- |
| Racers, strike flare, boost | 0.55 – 1.00 | Must never be lost against anything |
| Road surface and its markings | 0.28 – 0.50 | The one place the eye returns to |
| Shoulder, kerb, barrier | 0.35 – 0.62 | Edges read brighter than the road |
| Near terrain and set dressing | 0.14 – 0.34 | Always darker than the road |
| Mid vistas and architecture | 0.10 – 0.26 | Silhouette only |
| Sky and far atmosphere | 0.30 – 0.85 | Bright, but desaturated and flat |

**Consequences that are not negotiable.** Scenery is never brighter than the
road. Nothing but a racer, a hazard marker or an effect ever reaches the top
band. Distant vistas carry no high-frequency detail, so they read as depth
rather than as noise.

## Colour

Three families, and nothing outside them.

**Environment** — desaturated, wide, and specific to each course. Saturation
stays under 0.35 for everything that is not a racer or an effect. Each course
owns one accent hue used sparingly for the things a driver must find: kerbs,
shortcut mouths, hazard markers.

**Crews** — six saturated identities, chosen so that any two are separable at
40 m from behind, in fog, and for the common forms of colour blindness. Each
crew is a body colour, a trim colour and a glow colour, and the glow is the one
that has to survive tone mapping: it is what a player tracks in a pack.

| Crew | Body | Read as | Silhouette cue |
| --- | --- | --- | --- |
| Thornline | deep green | dark, cool | Tallest fin, narrow hull |
| Foundry Six | rust orange | warm, heavy | Broad shoulders, blunt nose |
| Nightgrove | violet | dark, cool | Swept twin fin |
| Emberworks | red | hot, light | Long low needle nose |
| Boneyard | bone white | pale, neutral | Squared cage, high pod |
| Greenline | cyan | bright, cool | Small, round, short fin |

Colour is never the only cue. Every crew is separable by silhouette alone, and
every UI state that uses colour also uses a shape, an icon or a word.

**Effects** — the only place full saturation and values above 0.9 are allowed:
Surge, drift tier flare, strike impact, boost pads, shortcut mouths.

## Shape language

**Vehicles are built, not moulded.** Flat-shaded planes, visible fasteners,
asymmetry from the outrigger pod. The reading is "assembled from what the
Reclaim gave up", which is why nothing is chrome and nothing is smooth.

**Environments are eroded.** Everything the world built has been softened by
three centuries of weather; everything the crews built is sharp, recent and
slightly wrong. A course reads as the collision of those two.

**Silhouette test.** Every vehicle and every landmark must be identifiable as a
solid black shape at 64 px. Anything that fails is redesigned, not repainted.

## Materials

Four material behaviours, no more, so the whole game shades coherently:

1. **Painted metal** — mid roughness, low metalness, flat shaded. Vehicle
   bodies, barriers, machinery.
2. **Worn structure** — high roughness, no metalness. Concrete, stone, rammed
   earth, bark.
3. **Growth** — high roughness, slight translucency in the lighting rig, gentle
   wind motion. Foliage, reeds, moss.
4. **Emissive** — unlit, additive, fog-exempt. Thrusters, Surge, markers,
   hazard lights. Never used for anything the player cannot act on.

## Scale

The player's skiff is ~4.2 m long. Everything is measured against it:

| Element | Height | Reading |
| --- | --- | --- |
| Barrier | 1.35 m | Waist-high — clearly a limit, not a wall |
| Roadside marker | 2.4 m | Head height, rhythmic, countable |
| Trees, reeds | 6 – 18 m | Canopy, parallax |
| Pylons, chimneys, spires | 25 – 60 m | Landmarks, navigable |
| Vistas | 120 m+ | Horizon, never approached |

Every course carries at least three **landmarks** that are visible from more
than one point on the lap, so a player can place themselves on the course
without the minimap.

## Lighting

One directional key with shadows, one hemisphere fill, and a per-course rim
value. No point lights in the world — they cost draw calls and buy nothing at
this scale.

- **Key** carries the course's time of day and is the only shadow caster. Its
  shadow camera follows the focused racer.
- **Fill** is a hemisphere: sky colour above, ground colour below. This is what
  keeps a flat-shaded vehicle from going black on its shadow side.
- **Rim** is baked into the sky gradient and the fog colour rather than a
  light, so it costs nothing.

Tone mapping is ACES filmic throughout, exposure tuned per course, output in
sRGB. Fog is exponential-squared and always matches the horizon band of the
sky, because a mismatch is the single most obvious tell of a cheap 3D scene.

## Post-processing budget

Post is allowed to *support readability* and forbidden to *conceal weak art*.
The whole chain is one extra full-screen pass on medium and high, and is off on
low.

| Effect | Purpose | Bound |
| --- | --- | --- |
| Bloom | Sell emissive intensity | Threshold above the road's value band, so the road never blooms |
| Colour grade | Course identity, contrast | Lift/gamma/gain only; no LUT files |
| Vignette | Draw the eye to the centre | Under 18% at the corners |
| Speed warp | Velocity cue | Radial, scales with speed, **zero** under reduced motion |
| Chromatic fringe | Boost punctuation | Under 1.5 px, boost only, off under reduced motion |

Anything that would make the road, a rival, or a hazard harder to see is cut,
regardless of how good it looks in a screenshot.

## Motion

- **Camera follows velocity, never heading.** Chasing the nose whips the frame
  round in a drift, which is nauseating and hides the road.
- **Body motion is telemetry.** Roll reads lateral load, pitch reads
  acceleration, suspension travel reads surface. All three are damped, and all
  three are *readable*, not merely present.
- **Anticipation before every payoff.** Nothing large happens without a frame
  of warning: the arm rears before it swings, the tier pips fill before the
  flare, the shortcut mouth lights before the split.
- **Shake is punctuation.** Impulse only, decayed fast, capped, and scaled to
  zero by reduced motion. Continuous rumble comes from the surface and never
  exceeds a tenth of an impact.
- **Nothing oscillates at the frequency that makes people ill.** No sustained
  camera motion between 0.2 and 0.4 Hz at amplitude, which is the band motion
  sickness research consistently implicates.

## Reduced motion

Not a degraded mode — a first-class one. With it on: no camera shake, no speed
warp, no chromatic fringe, no screen-space streaks, no UI parallax, no
auto-playing background race. Everything those conveyed is still conveyed, by
colour, by a number, or by a static cue. The game must be fully readable and
fully winnable with it on.

## Typography and interface

- One family: a system UI stack, so there is no font file and no download.
- Four sizes only, on a 1.333 scale, plus one oversized display size used for
  the countdown, the position and the finish.
- **Numbers that change are tabular.** A lap timer whose digits shift width is
  unreadable at speed.
- Spacing is a 4 px grid. Nothing is spaced by eye.
- Panels are one surface treatment: a dark translucent slab, a hairline top
  edge, a single accent line. No panel has more than one accent.
- Minimum target 44 px; minimum contrast 4.5:1 for text, 3:1 for meaningful
  graphics, both verified with the high-contrast setting on and off.
- The HUD occupies the frame's edges only. The centre third of the screen, top
  to bottom, is the road and stays clear of everything except the countdown and
  a finish flourish.

## Sound identity

Original synthesis, generated at load, no sample files.

- **Engine** — three layered voices per skiff: a low body tone that carries
  load, a mid harmonic that carries RPM, and a filtered noise bed that carries
  surface. Crews differ in the harmonic ratio, so a rival is identifiable by
  ear.
- **Wind** — filtered noise, cutoff and gain driven by speed. This, not the
  engine, is what sells the top end.
- **Surface** — a noise bed per surface, crossfaded on change. Tarmac is nearly
  silent; grass, gravel and water are not.
- **Impacts** — short, dry, pitched down with mass. A heavy skiff hits lower.
- **Combat** — the windup is a rising metallic tension, the connect is a single
  hard transient, the counter is a bright ringing cancel. All three must be
  distinguishable with eyes on the road.
- **Surge** — a rising filter sweep on trigger, a sustained harmonic bed while
  held, a soft release. Never a continuous drone.
- **Music** — a slow harmonic bed with rhythmic elements that layer in with
  race intensity. It never masks a cue: the combat, Surge and lap channels duck
  the music, not the reverse.
- **Interface** — three sounds total: move, confirm, back. Short, quiet,
  pitched from the same series as the music so they never clash.

**Rules.** Nothing autoplays before a user gesture. The master bus is limited
so no combination of six engines, weather and impacts can clip. Every loop is
crossfaded at its seam and asserted seamless in `tests/unit/audio.test.ts`.
Music, effects and master are independently adjustable, and all three go to
true silence at zero.

## The pixel-picky checklist

Applied to every screenshot and every live pass:

1. Is the road the brightest large thing after the racers?
2. Can six crews be told apart at 40 m, in fog, from behind?
3. Does anything pop in, or change LOD, inside 60 m?
4. Is there any visibly empty or procedural-looking dead zone in frame?
5. Does the horizon band of the sky match the fog colour exactly?
6. Is any text clipped, overlapping, or below 4.5:1 at any of the five widths?
7. Does any effect make the road, a rival or a hazard harder to see?
8. Is every animated element still animating when the camera is far away, and
   is that worth what it costs?
9. Does the frame have a foreground, a midground and a background?
10. Would a still from this frame be worth looking at?
