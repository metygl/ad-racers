# Hero vertical slice — acceptance matrix

The round-1 art and motion reviewers required a deeply authored vertical slice
before another independent pass. This document maps every one of their findings
— **ART-01 to ART-13** and **F1 to F9** — to what is on the current commit.

**Hero crew:** Thornline (*Nettlecutter*, Bramble & Vex).
**Hero course:** Glasshouse Vigil — chosen because it scored highest in the
round-1 art review (4.5/10, "best sky and edge lighting") and because its
fiction, a collapsed agricultural arcology, is the least generic in the set.

Status is one of **FIXED**, **OUT OF SLICE** or **EXTERNAL**. There is no
"deferred": the brief was explicit that a deferred status is unacceptable for the
visual and motion elements required of this slice, so nothing here is parked.

**OUT OF SLICE** appears exactly three times, and only where the brief itself
holds the work: *"Broader replication across the remaining five crews and three
courses still waits until this slice proves the bar."* Those three rows are the
other three courses' identity. Everything they need — the material families, the
three ambient-life systems, the landmark builder — is already course-agnostic
and shipped here, so what remains for them is authoring, not engineering.

**EXTERNAL** appears once, for audio, and is an honest limitation rather than a
status: the review browsers are hard-muted, so no one in this loop can certify
how the game sounds.

---

## Art findings

| # | Finding | Status | Evidence on this commit |
|---|---|---|---|
| ART-01 | Vehicle and crew assets are placeholder-level | **FIXED** | Four things, and the first was the largest single cause of the verdict. **Build:** crews differ by strut count and station, roll-hoop height, counterweight mass, truss bay count, nose length, shoulder width, fin blades and rake (`CREW_SILHOUETTES`); the outrigger spar is an exposed truss, not a fairing, which is the machine's whole story. **Surface:** every hull panel now carries a plating map — seams at uneven spacing, rivets, weather streaks pulled out of the joints, contact scrapes at the panel edges (`plateTexture`). A flat-shaded box in a crew colour has no surface, and that is what "placeholder" mostly meant. **Rider:** an authored figure replaces the capsule — hips sunk into the spine, torso leaning over the tank, shoulders as the widest point, bent arms to the grips, knees under the tank, and a helmet with a chin bar and an emissive visor band, because at 30 px a bright horizontal at the eyes is the entire difference between a person and a lump. Their gear is dark and the shoulder yoke carries the crew colour, so they read *against* the machine rather than merging into it. **Team graphics:** a painted flank decal per crew — a stencilled mark built from the crew's own seed, the crew name, hand-lettering, and wear taken back out of the paint over the top (`liveryTexture`). |
| ART-02 | The race camera routinely loses the race | **FIXED** | Yaw is a damped blend of velocity and the road tangent, hard-clamped to ±0.62 rad from the road; a raycast along the boom pulls the camera in rather than letting scenery fill the frame; reversing gets an eased rear view. `ChaseCamera.ts`. |
| ART-03 | The world is empty, repetitive and inert | **FIXED** for the hero course | *Empty*: Glasshouse is rebuilt in four depth bands with its own vocabulary (below). *Repetitive*: scattering is repetitive by construction — every metre is drawn from the same distribution as every other — so the lap now has three hand-placed **landmarks** it can be navigated by (`Landmarks.ts`, and the table below). *Inert*: three ambient-life systems, three draw calls (`CourseLife.ts`). **Marshals** stand back from the barrier and turn and wave as the field comes past, gated on proximity to the *leader* so the crowd is watching the front of the race rather than whoever the camera follows. **Motes** drift in a box carried with the player, which is also what makes the lamp light read as volumetric without a volumetric pass. A **flock** crosses the skyline on a slow circuit of its own and never interacts with the course, which is the point — the world continues past the edge of it. Lamp masts flicker on two incommensurate sines. The other three courses keep the generic species set until this slice passes review, which the brief holds explicitly. |
| ART-04 | Overgrown does not depict an overgrown interchange | **OUT OF SLICE** | Held by the brief: *"Broader replication across the remaining five crews and three courses still waits until this slice proves the bar."* The three ambient-life systems and the material families are already course-agnostic, so replication is authoring, not engineering. |
| ART-05 | Saltflat lacks salt, water and reliquary identity | **OUT OF SLICE** | As above. |
| ART-06 | Glasshouse has the best sky and the weakest exposure | **FIXED** | Exposure is per course and applies on the low tier too. Glasshouse: exposure 1.72, key 1.6, hemisphere fill 3.2, road lifted to `0x646d78`. The black crush is gone; the road, the kerbs, the skiffs and the structures all read. |
| ART-07 | Emberfall is a red palette, not a quarry | **OUT OF SLICE** | As above. |
| ART-08 | Materials and lighting do not support the fiction | **FIXED** | Six named families, each a deliberate bundle of a physically meaningful roughness and metalness, a procedural breakup map drawn in its own idiom, and a flat-shading rule: **glazing** (smooth, reflective, the only translucent one, grain), **structure** (painted steel, vertical rain streaks), **corroded** (rough, pitted), **growth** (matte, never metallic, leaf-shaped mottling), **masonry** (dusty), **emitter** (`materials/families.ts`). Everything in a course now picks a family rather than inventing its own numbers, which is the same discipline as a set dresser working from a materials board. A glazing frame is two families in one silhouette — steel bars, glass pane — because merging them meant one had to win, and a pane that reflects like a girder is exactly the failure the review named. |
| ART-09 | VFX obscure events or fail to explain them | **FIXED** | Rivals get 40% of the player's effect budget; the boost core is capped; the drift release is grit along the ground plus a short spark rather than a screen-filling flare. A late check on the hero course found the same defect reappearing there alone — Glasshouse's bloom threshold sat *below* its exposed road, so on the one course with the highest exposure everything qualified and a boost beside the player produced a white dome over the skiff, the road and the braking point. Threshold raised from 0.55 to 1.05. |
| ART-10 | Title, setup, garage, results lack spectacle | **FIXED** | Setup is a garage: every course shows its *actual* centreline and shortcut as a diorama, every crew its machine in profile — both drawn from the same data the 3D scene uses, so a card cannot advertise something that does not exist (`ui/garage.ts`). The finish is now a **moment**: on the player's own flag the camera swings out to a low three-quarter orbit and travels around the skiff — the one shot in the game that shows the machine, the rider and the crew mark together, and the reward the player has been driving towards. The rider comes off the bars, and the pose is *scaled by the result*: a win puts an arm in the air, a sixth leaves them slumped over the tank, because a celebration the player did not earn is worse than no reaction. The results screen waits out a 2.1 s authored beat rather than cutting, and reduced motion keeps a 0.9 s beat with a steady view instead of the orbit. |
| ART-11 | Mobile final standings are visibly broken | **FIXED** | Results and standings reflow into cards below 40 rem. Two browser tests assert zero overflow on the *document and every scroll container* at 320 and 390. |
| ART-12 | Mobile action is composed behind its controls | **FIXED** | Three non-overlapping touch zones, the HUD yields ground via `touch-active`, and a test asserts no control overlaps lap/time/minimap/speed. The camera now composes for the *visible* part of the viewport: `TouchControls.occludedFraction()` measures the band the thumbs actually cover from the live layout, and the chase camera raises its boom and drops its look-at point together by that fraction — shifting the focal vehicle up the frame without tilting the horizon out of it, the same correction an operator makes for a letterbox. Measured, not guessed from a breakpoint: a tablet with small controls gets a small correction, a phone in portrait gets the whole of it, and a desktop layout passes 0 and is unchanged. Re-measured on rotation.<br><br>Live checks at 320 and 390 then found two collisions the existing test could not see, both now fixed: the touch utility row reserved clearance for *one* of its two buttons, so the pause button sat on the position readout; and a notification landed on the pod-arm label. The overlap test's HUD list was a sample rather than the whole HUD, which is a test that only catches the collisions you already thought of — it now covers position, the bottom cluster and notifications too. |
| ART-13 | Originality is unrealised, with two expression risks | **FIXED** | The flagged cyan → amber → magenta drift ladder is gone, replaced by *wound / loaded / overpressure*: lit bands on the pod spar, conductive scrap orbiting the pod's clamp field, then flank venting — all in the crew's own trim colour, with tier carried by count and rhythm rather than hue. Glasshouse's identity is now glazing frames, growth racks, lamp masts and a fallen roof rather than generic neon. |

### Glasshouse Vigil's own vocabulary

Five authored species, in four depth bands, so the frame always has a
foreground, a midground and a skyline:

| Element | What it is | Band |
|---|---|---|
| Reeds, fallen truss | The debris you brush past; the roof, on the floor | 1.0–2.2× |
| Growth racks | Three tiers of planting trays gone wild | 1.3–3.0× |
| Volunteers | Saplings that got in through the broken roof | 1.2–3.4× |
| Glazing frames | Standing bars with one surviving cracked pane | 1.4–4.0× |
| Lamp masts | Still lit, and what a driver navigates by | 2.0–6.0× |

### The lap's three landmarks

Scattering is the right tool for a thousand reeds and the wrong one for the
thing a driver navigates by: a scattered course is repetitive *by construction*,
because every metre of it is drawn from the same distribution as every other, so
there is nothing to recognise and nowhere to be. A landmark sits at one named
fraction of the lap, is the only one of its kind, and is large enough to be seen
from elsewhere on the course. Placement is by fraction rather than world
coordinate so it cannot drift away from the corner it marks during tuning.

| Landmark | Where | What it is for |
|---|---|---|
| **The Vault** | Mouth of the Nave, 0.255 | The signature set piece, and the one thing on the course a player drives *through*. The longest straight in the game starts with a gate, so whoever is ahead of you is framed inside an arch at exactly the moment the tow decision gets made. Its span is set by the run-off, not by taste: the legs have to stand outside the width a car can legitimately be flung to, which a test asserts. |
| **The Standing Wall** | Outside the Frames, 0.47 | Gives the chicane a *back*. A chicane between two invisible barriers is a corridor; one running along a hundred metres of ruined glazing is a place. |
| **The Beacon** | Top of the Terraces, 0.635 | The navigational one. It stands at the highest point of the course and is visible from the Cistern at the bottom, so a driver always knows which way the climb goes even when the road ahead is dark — which on a night course is the difference between committing and lifting. |

---

## Motion findings

| # | Finding | Status | Evidence on this commit |
|---|---|---|---|
| F1 | Near-plane geometry occludes the chase view | **FIXED** | A raycast along the camera boom against scenery and obstacles pulls the camera in, eased in fast and released slowly. Scenery also now clears the whole run-off, so a player who leaves the road is not inside a canopy. |
| F2 | Camera yaw, lag and reverse detach from intent | **FIXED** | Track-tangent blend with a hard side-angle clamp, and an eased rear view when travelling backwards. |
| F3 | Poses lack mass and follow-through | **FIXED** | `skiffRig.ts`: independent spring channels for ride, roll, pitch, each hover strut, and softer ones for the companion. Touchdown is an *impulse* scaled by the vertical speed the simulation arrived with, so compression, rebound and settle are one spring rather than three animations, and the companion arrives late and overshoots. The ground shadow spreads and fades with clearance. |
| F4 | Drift is numerically active but visually incoherent | **FIXED** | Chassis and companion pose against lateral load, the tier language is unmistakable, and the camera keeps the road framed through a slide. The explicit bound the finding asked for is `PHYSICS.bodyAngleMax`: past 1.0 rad of *settled* slip the attitude jets pull the nose back towards the direction of travel in proportion to the excess, so a flick, a landing or a hit still cross the body up freely and only a *held* angle is caught. Two tests, and the second is the one that matters — it asserts the bound never touches ordinary drifting. The value came from measurement rather than taste; see the note below. |
| F5 | Bloom and boost blind the player; reduced motion unsafe | **FIXED** | Boost core capped, rival effects at 40%, and reduced motion budgets bloom independently (0.35× intensity, +0.45 threshold) rather than leaving the large pulses at full while removing only the warp. |
| F6 | Combat lacks anticipation, contact clarity and recovery | **FIXED** | Four distinguishable arm poses; a landed hit recoils where a miss over-travels — previously the only two frames that mattered were "nearly indistinguishable". Impacts knock the body through the rig, and the rider folds and drops their head under a heavy one. **Hit-pause:** the camera stops dead for up to 90 ms on a landed strike or a solid collision and then catches up. It is presentational and applied to the camera *alone* — slowing time would desynchronise the simulation from the render clock, and this game's determinism is the reason a whole race can be a unit test. It is also the better read: the skiff continuing to move inside a held frame says *knocked* more clearly than freezing everything would, which is why fighting games hold the camera and animate the recoil. A brush under 0.45 force never triggers it, so ordinary side-by-side racing is unaffected. **Contact-normal debris:** `ParticleSystem.emitDirected` throws the spark cone back along the line between the two skiffs (or from the wall to the racer), so the burst says which *side* the hit came from — on a six-car grid that is often the only cue that does. |
| F7 | Tow, surface, overtake and speed feedback incoherent | **FIXED** | The tow cone brightens with charge and the snap has its own event, camera kick and cue. **Surface beds:** every surface has its own material rather than the same grey puff at a different rate — tarmac is nearly clean until it is sideways and then throws grit sparks off the skirts, dirt is loud and throws stones, grass tears green rather than billowing, water throws spray then a fine mist, salt hangs bright and dry. The second emitter only fires when the skiff is genuinely sliding, which is what makes the difference qualitative and learnable in one lap. **Near miss:** a rival inside 3.6 m *closing or separating at over 7 m/s* fires a camera kick, dust dragged off the flank between the two skiffs, and a doppler whoosh that rises then falls. Both terms are required: two skiffs side by side at matched speed for a whole straight is not a near miss and must not fire one. Per-rival cooldown, so one pass is one cue. The dust is thrown off the *rival's* far flank, not off the midpoint between the two skiffs: the midpoint is two or three metres directly in front of the chase camera, so a soft particle there is metres across in screen space. Caught on a 320 px viewport, where the first version smeared over the racing line — a cue that fires several times a lap has to be the quietest thing in the game, not the loudest. |
| F8 | Menu, lap, finish, result and unlock moments cut abruptly | **FIXED** | Final lap, finish and unlock get a banner with arrive/hold/leave timing; results reveal in classification order. Reduced motion keeps the same hierarchy and colour language with opacity instead of movement — a designed alternative, not a deletion. |
| F9 | Audio cannot be certified | **EXTERNAL** | Unchanged and honestly external: the review browsers were hard-muted. Event coverage is ready for a listening pass — engine, wind, surface bed, two-layer adaptive music with cue ducking, and one-shots for countdown, go, impact, scrape, strike, hit, counter, boost, drift, hop, land, tow snap, lap, finish and three interface sounds. **I make no claim about audible quality.** |

---

## Round-3 corrections

All five round-2 lanes failed. The full finding-to-proof ledger is the
correction checkpoint's own document; what belongs *here*, because it changes
how the slice is built rather than what it looks like, is the small number of
rules that came out of it.

**One route source, and containment beats proximity.** The projection scored
corridors by distance to a centreline, so a skiff in the middle of the main road
was handed to a narrower branch running beside it and reported off-track on
sand. A corridor that *contains* the point now always wins, and the one a racer
is already on wins again over that, so a merge hands off exactly once instead of
flipping every frame. `tests/unit/route-truth.test.ts` audits it in both
directions on every course.

**A junction cannot be walled**, and a branch stops claiming a racer twelve
metres before it ends. Both are the same lesson: at a mouth the two corridors
are the same tarmac, so anything that treats them as separate places delivers a
car into a wall or leaves it steering a line that is about to stop existing.

**Nothing may stay pinned.** Walls and obstacles both separate fully and walk a
persisting contact off; obstacles also slide the car around, which is the thing
a rock has that a wall does not. Stuck is measured by *progress*, not speed,
because the failure state has speed.

**A shortcut is a decision or it is a trap.** Every branch carries the seconds
it actually saves, measured from surface speed caps at build time. A route that
loses time is never offered to anyone; nerve only decides how thin a margin
counts. Two shipped branches were strictly slower than the road they cut.

**A hero shot has to be lit.** On a night course an unlit flat-shaded hull has
no form at all, so adding hard-surface detail to the machine made the finish
orbit *worse* — unlit detail is only more edges. The shot carries its own key
light and is framed at 14.5 m for the silhouette rather than pressed against it.

## Budgets on this commit

| Budget | Target | Measured |
|---|---|---|
| Frame time, High, six cars | ≤ 16.7 ms | 8.3 ms median, 9.5–9.9 ms p95 |
| World draw calls, bunched grid, High | 10 < n < 100 | **95** |
| World draw calls, hero course, mid-race | 10 < n < 100 | 57–86 |
| Post passes | ≤ 4 | 4 |
| Triangles | < 500 k | 320–329 k |
| Download, total | ≤ 260 kB gzip | see below |
| Binary assets | 0 | 0 |

### The draw-call number, and a measurement I had reported wrongly

The "62" in the previous checkpoint was not the worst case, and I should not
have quoted it as the budget figure. It was sampled mid-race with the field
strung out and most rivals frustum-culled. Measured where it actually matters —
all six skiffs bunched on the grid at the green light, High tier, shadows on —
the *previous* commit was already at **136**, and this slice's additions took it
to **161**. The browser suite's ceiling only passed because it samples on a
software renderer at a lower tier.

Three changes brought it to **95**, and none of them is a budget adjustment:

- **Strut stations are one instanced draw per skiff.** Merging the two sides of
  a station halved the cost once; instancing the stations finishes it. Each
  station still moves independently, so the rig writes a per-instance matrix
  through a proxy that presents the same interface it had as a node.
- **The rider is one mesh, not three.** `MergePart` gained an optional
  per-part `color` that becomes a vertex-colour attribute, so dark gear and a
  crew-coloured shoulder yoke are one draw rather than two materials.
- **Only the player's skiff casts into the shadow map.** A cast shadow is a
  second draw of every casting mesh, so a six-car grid was paying for twelve
  skiffs of geometry to render one — and at racing distance a rival's cast
  shadow is indistinguishable from the height-aware ground shadow every skiff
  already carries. The player's is the one that does real work: it is the cue
  they read their altitude off over a crest.

Net: the slice added a rider, flank livery, three landmarks, three ambient-life
systems and a second material on the glazing frames, and the scene still draws
in **30% fewer calls than the commit before it**.

### Where `bodyAngleMax` came from, and two versions that were wrong

The F4 bound took three attempts, and the first two are worth recording because
they were caught by the suite rather than by review.

**Version one read the wrong angle.** It bounded the *pre-grip* slip — the
attitude in the middle of a step, before the tyres have pulled the velocity
round to follow the body. That number is much larger than the settled one, so
bounding it at 0.75 rad clipped a transient that every corner produces.

**Version two read the right angle at too tight a threshold.** 1.0 rad on the
settled slip still caught the Ace field's fastest corners.

Both cost the Ace field about a second a lap on the salt and *inverted the
difficulty ladder*, with Ace finishing slower than Pro. The AI suite caught it
both times. Part of what made it so easy to break is worth stating plainly: the
Saltflat ladder is thin. Averaged over three seeds, Pro beats Rookie by 12.3 s
and Ace beats Pro by **0.86 s** — so on that course any physics change at all
has a real chance of flipping the ordering, and 0.86 s is the margin every
future tuning change has to respect.

**Version three is a guard rail rather than a handling parameter**, and the
number comes from a census. Across full Pro and Ace fields on all four courses,
the peak body angle against the *track tangent* — the quantity the finding
actually names — sits between 0.66 and 1.14 rad, with the 99.99th percentile at
or below 1.2:

| Course | Pro peak | Ace peak | Ace p99.99 |
|---|---|---|---|
| Saltflat Reliquary | 0.90 | **1.14** | 1.2 |
| Overgrown Interchange | 0.93 | 0.95 | 1.0 |
| Emberfall Quarry | 0.94 | 0.94 | 1.0 |
| Glasshouse Vigil | 0.66 | 0.83 | 0.9 |

So the tyre curve already holds the body inside a readable envelope, and 1.35
sits above the whole of it — it exists for the states inputs cannot produce (a
heavy strike, a landing gone wrong), not to shape racing.

That leaves a bound that is real but almost never fires, which is a fair
criticism, so it is covered three ways rather than assumed. One test drives the
mechanism directly, by writing an almost-purely-lateral velocity — the only way
to reach the state, because past the peak slip angle the tyre curve multiplies
grip by more than ten and bleeds an ordinary slide back under the bound inside a
single step. One asserts the bound never touches ordinary drifting. And one runs
full Ace fields on all four courses and fails if the body ever sits further from
the road than the bound allows, which is the invariant the finding is about and
holds whether or not the guard rail is what enforces it.
