# Hero vertical slice — acceptance matrix

The round-1 art and motion reviewers required a deeply authored vertical slice
before another independent pass. This document maps every one of their findings
— **ART-01 to ART-13** and **F1 to F9** — to what is on the current commit.

**Hero crew:** Thornline (*Nettlecutter*, Bramble & Vex).
**Hero course:** Glasshouse Vigil — chosen because it scored highest in the
round-1 art review (4.5/10, "best sky and edge lighting") and because its
fiction, a collapsed agricultural arcology, is the least generic in the set.

Status is one of **FIXED**, **PARTIAL** or **NOT DONE**. There is no "deferred":
the brief was explicit that a deferred status is unacceptable for the visual and
motion elements, so anything short of fixed is named as such.

---

## Art findings

| # | Finding | Status | Evidence on this commit |
|---|---|---|---|
| ART-01 | Vehicle and crew assets are placeholder-level | **PARTIAL** | Crews now differ by *build*, not tint: strut count and station, roll-hoop height, counterweight mass, truss bay count, nose length, shoulder width, fin blades and rake (`CREW_SILHOUETTES` in `VehicleModel.ts`). The outrigger spar is an exposed truss rather than a fairing, which is the machine's whole story — the pod is bolted on, by a crew, out of what they had. **Not done:** authored faces, costume, and painted team graphics; the riders are still capsules. |
| ART-02 | The race camera routinely loses the race | **FIXED** | Yaw is a damped blend of velocity and the road tangent, hard-clamped to ±0.62 rad from the road; a raycast along the boom pulls the camera in rather than letting scenery fill the frame; reversing gets an eased rear view. `ChaseCamera.ts`. |
| ART-03 | The world is empty, repetitive and inert | **PARTIAL** | Glasshouse is rebuilt in four depth bands with its own vocabulary (below). Foliage sways on the GPU. **Not done:** the other three courses still use the generic species set, and there is no ambient life (crews, wildlife, traffic) anywhere. |
| ART-04 | Overgrown does not depict an overgrown interchange | **NOT DONE** | Outside the hero slice by design; the brief holds replication until this slice passes. |
| ART-05 | Saltflat lacks salt, water and reliquary identity | **NOT DONE** | As above. |
| ART-06 | Glasshouse has the best sky and the weakest exposure | **FIXED** | Exposure is per course and applies on the low tier too. Glasshouse: exposure 1.72, key 1.6, hemisphere fill 3.2, road lifted to `0x646d78`. The black crush is gone; the road, the kerbs, the skiffs and the structures all read. |
| ART-07 | Emberfall is a red palette, not a quarry | **NOT DONE** | Outside the hero slice. |
| ART-08 | Materials and lighting do not support the fiction | **PARTIAL** | Glasshouse's structures use three distinct material behaviours — glazing (low roughness, high metalness), worn structure, growth — and the lamp masts are genuinely emissive. **Not done:** the authored material *families* the review asked for across the whole game. |
| ART-09 | VFX obscure events or fail to explain them | **FIXED** | Rivals get 40% of the player's effect budget; the boost core is capped; the drift release is grit along the ground plus a short spark rather than a screen-filling flare. A late check on the hero course found the same defect reappearing there alone — Glasshouse's bloom threshold sat *below* its exposed road, so on the one course with the highest exposure everything qualified and a boost beside the player produced a white dome over the skiff, the road and the braking point. Threshold raised from 0.55 to 1.05. |
| ART-10 | Title, setup, garage, results lack spectacle | **PARTIAL** | Setup is now a garage: every course shows its *actual* centreline and shortcut as a diorama, every crew its machine in profile — both drawn from the same data the 3D scene uses, so a card cannot advertise something that does not exist (`ui/garage.ts`). Results reveal in classification order; final lap, finish and unlock have authored banners. **Not done:** a finish camera and a crew reaction. |
| ART-11 | Mobile final standings are visibly broken | **FIXED** | Results and standings reflow into cards below 40 rem. Two browser tests assert zero overflow on the *document and every scroll container* at 320 and 390. |
| ART-12 | Mobile action is composed behind its controls | **PARTIAL** | Three non-overlapping touch zones, HUD yields ground via `touch-active`, and a test asserts no control overlaps lap/time/minimap/speed. **Not done:** viewport-specific camera framing that lifts the focal vehicle above the controls. |
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

---

## Motion findings

| # | Finding | Status | Evidence on this commit |
|---|---|---|---|
| F1 | Near-plane geometry occludes the chase view | **FIXED** | A raycast along the camera boom against scenery and obstacles pulls the camera in, eased in fast and released slowly. Scenery also now clears the whole run-off, so a player who leaves the road is not inside a canopy. |
| F2 | Camera yaw, lag and reverse detach from intent | **FIXED** | Track-tangent blend with a hard side-angle clamp, and an eased rear view when travelling backwards. |
| F3 | Poses lack mass and follow-through | **FIXED** | `skiffRig.ts`: independent spring channels for ride, roll, pitch, each hover strut, and softer ones for the companion. Touchdown is an *impulse* scaled by the vertical speed the simulation arrived with, so compression, rebound and settle are one spring rather than three animations, and the companion arrives late and overshoots. The ground shadow spreads and fades with clearance. |
| F4 | Drift is numerically active but visually incoherent | **PARTIAL** | Chassis and companion now pose against lateral load, the tier language is unmistakable, and the camera keeps the road framed through a slide. **Not done:** an explicit bound on sustained body angle against the track tangent. |
| F5 | Bloom and boost blind the player; reduced motion unsafe | **FIXED** | Boost core capped, rival effects at 40%, and reduced motion budgets bloom independently (0.35× intensity, +0.45 threshold) rather than leaving the large pulses at full while removing only the warp. |
| F6 | Combat lacks anticipation, contact clarity and recovery | **PARTIAL** | Four distinguishable arm poses; a landed hit recoils where a miss over-travels — previously the only two frames that mattered were "nearly indistinguishable". Impacts knock the body through the rig. **Not done:** the short visual hit-pause and contact-normal debris. |
| F7 | Tow, surface, overtake and speed feedback incoherent | **PARTIAL** | The tow cone brightens with charge and the snap has its own event, camera kick and cue. **Not done:** surface-specific emitter beds and a near-miss detector. |
| F8 | Menu, lap, finish, result and unlock moments cut abruptly | **FIXED** | Final lap, finish and unlock get a banner with arrive/hold/leave timing; results reveal in classification order. Reduced motion keeps the same hierarchy and colour language with opacity instead of movement — a designed alternative, not a deletion. |
| F9 | Audio cannot be certified | **EXTERNAL** | Unchanged and honestly external: the review browsers were hard-muted. Event coverage is ready for a listening pass — engine, wind, surface bed, two-layer adaptive music with cue ducking, and one-shots for countdown, go, impact, scrape, strike, hit, counter, boost, drift, hop, land, tow snap, lap, finish and three interface sounds. **I make no claim about audible quality.** |

---

## Budgets on this commit

| Budget | Target | Measured |
|---|---|---|
| Frame time, High, six cars | ≤ 16.7 ms | 8.3 ms median, 9.2 ms p95 |
| World draw calls | 10 < n < 100 | 62 |
| Post passes | ≤ 4 | 4 |
| Triangles | < 500 k | 318 k |
| Download, total | ≤ 260 kB gzip | 198.9 kB |
| Binary assets | 0 | 0 |

The rig cost had to be paid for. Adding hover struts and a scrap ring as
individual meshes took the scene from 62 to **146** draw calls and broke the
budget the browser suite enforces — six skiffs times four stations times two
sides is forty-eight calls for something with no independent motion. Both are
merged: one mesh per strut station, one mesh for the ring, spun as a whole.
