# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Orientation

AD Racers is an original browser racing game. Start with `README.md`, then
`docs/ARCHITECTURE.md`. Run `npm run verify` before proposing changes.

## The invariant everything depends on

**`src/game/` must never import `three`, touch the DOM, or call `Math.random`
or `Date.now`.** The simulation runs headlessly in Node, which is what lets a
whole race be a unit test (`tests/support/headless.ts`). Breaking this does not
fail loudly — it quietly removes the project's ability to test its own AI.

`tests/unit/determinism.test.ts` asserts the `Math.random` half of it.

## Sharp edges

These cost real debugging time. Each is documented at its site in the code.

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

## Tuning

Physics, combat, drift and race constants live in `src/game/config.ts`. Change
values there, never inline. After any change run `npm test` — the AI, fairness
and balance suites are the guard rails, and they will catch a change that makes
the game worse rather than merely different.

## Deployment

Blocked on an account decision, not on code. See `docs/DEPLOYMENT.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
