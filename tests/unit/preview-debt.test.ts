import { describe, expect, it } from 'vitest';
import { COMBAT, FIXED_STEP } from '../../src/game/config';
import { DEFAULT_KEY_BINDINGS } from '../../src/game/input/bindings';
import { InputManager } from '../../src/game/input/InputManager';
import { RACERS } from '../../src/game/racers';
import { Simulation } from '../../src/game/sim/simulation';
import { classify } from '../../src/game/sim/race';
import { emptyInput } from '../../src/game/sim/state';
import type { ControlInput } from '../../src/game/sim/state';
import { bloomBudget, defaultPostSettings } from '../../src/render/post/Composer';
import { buildSetup, runHeadlessRace, scriptedPlayer } from '../support/headless';

/**
 * Drives the `InputManager`'s keyboard listeners without a DOM.
 *
 * The unit suite runs in Node - deliberately, because the whole point of the
 * simulation being renderer-free is that a race is a unit test - so the
 * listeners are attached to a stand-in and the events are the three fields the
 * manager actually reads.
 */
function fakeKeyboard(input: InputManager): (type: 'keydown' | 'keyup', code: string) => void {
  const listeners = new Map<string, (event: Event) => void>();
  const target = {
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window;
  input.attach(target);
  return (type, code) => {
    const event = { code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault: () => {} };
    listeners.get(type)?.(event as unknown as Event);
  };
}

/**
 * The round-3 preview's accepted debt, one assertion per defect.
 *
 * Each of these reproduces something a live review or the pipeline found in the
 * shipped preview build and pins the corrected behaviour, so the specific way
 * each one was wrong cannot come back. They are gathered in one file because
 * what they have in common is provenance rather than subject.
 */

describe('crest launch does not inherit the previous flight', () => {
  /*
   * `airGroundStart` and `airGroundDrop` measure how far the *road* fell away
   * between take-off and the lowest point underneath the skiff, and they are
   * the only thing that distinguishes a crest from a hop on a straight - which
   * is what stops the landing reward being farmed by tapping hop on a flat
   * road. The hop branch opened those books; the crest branch did not, so a
   * launch inherited whatever the last hop had left in them. Downhill, a stale
   * take-off height turns a ripple into a flyover.
   */
  it('opens a fresh ledger on every launch, however the air started', () => {
    for (const trackId of ['glasshouse-vigil', 'emberfall-quarry', 'overgrown-interchange']) {
      const airborne = new Map<number, boolean>();
      let launches = 0;

      runHeadlessRace({
        trackId,
        difficultyId: 'ace',
        playerIndex: null,
        maxSeconds: 200,
        onStep: (sim) => {
          for (const racer of sim.racers) {
            const was = airborne.get(racer.index) ?? false;
            airborne.set(racer.index, racer.airborne);
            if (was || !racer.airborne) continue;
            launches += 1;
            /*
             * The invariant, checked on the very step the flight begins: a new
             * flight has measured no drop yet, and its take-off height is the
             * road it just left - not one from somewhere else on the course.
             */
            expect(racer.airGroundDrop, `${trackId}: a launch inherited a drop`).toBe(0);
            /*
             * Against the road's elevation along its length, with the banking
             * taken back out - the same quantity the ledger records, because a
             * lane change across a banked corner is not the road going
             * anywhere. See `profileY` in `vehicle.ts`.
             */
            const projection = sim.track.project(racer.pos, racer.path);
            const profileY = projection.y - Math.sin(projection.bank) * projection.lateral;
            expect(
              Math.abs(racer.airGroundStart - profileY),
              `${trackId}: a launch inherited a take-off height`,
            ).toBeLessThan(1);
          }
        },
      });

      expect(launches, `${trackId}: nothing left the ground, so this proves nothing`).toBeGreaterThan(0);
    }
  }, 600000);
});

describe('a projected classification is not a DNF', () => {
  /*
   * The simulation carefully extrapolates a credible time for anyone still
   * running when the race is called, and every presentation surface then read
   * `completed ? time : 'DNF'` and threw it away - so a player on the last lap
   * of a timed-out race was told they did not finish, beside a best lap two
   * seconds off the winner's.
   */
  it('classifies a racer who stopped most of the way round on their own pace', () => {
    const drive = scriptedPlayer('pro');
    /*
     * Drive properly, then stop dead. The field finishes, the abandoned car
     * retires on the wedge timer, and the race is called with it a long way
     * round - which is exactly the state the projection exists for.
     */
    const result = runHeadlessRace({
      trackId: 'saltflat-reliquary',
      entries: 4,
      playerIndex: 0,
      maxSeconds: 420,
      playerInput: (sim, step): ControlInput => {
        const player = sim.player;
        const round = sim.track.length * sim.track.laps;
        if (player && player.progress > round * 0.45) return emptyInput();
        return drive(sim, step);
      },
    });

    expect(result.finished).toBe(true);
    const player = result.sim.player;
    if (!player) throw new Error('no player');

    expect(classify(player)).toBe('projected');
    expect(player.completed).toBe(false);
    expect(Number.isFinite(player.finishTime)).toBe(true);
    // The projection is a *time*, not a placeholder: it has to be slower than
    // the winner and faster than infinity, or it says nothing.
    const winner = result.results[0];
    expect(winner && classify(winner)).toBe('finished');
    expect(player.finishTime).toBeGreaterThan(winner?.finishTime ?? 0);
  });

  it('still calls a racer who never moved a DNF', () => {
    /*
     * Genuinely never moved. Sitting on the grid with no input is not enough:
     * the game steers and throttles for a player who has not touched anything
     * yet, which is a deliberate first-race courtesy, so the car is pinned back
     * to its grid slot after every step instead.
     */
    let grid: { x: number; z: number } | null = null;
    const result = runHeadlessRace({
      trackId: 'saltflat-reliquary',
      entries: 4,
      playerIndex: 0,
      maxSeconds: 420,
      onStep: (sim) => {
        const player = sim.player;
        if (!player) return;
        grid ??= { ...player.pos };
        player.pos = { ...grid };
        player.velocity = { x: 0, z: 0 };
      },
    });

    const player = result.sim.player;
    if (!player) throw new Error('no player');
    expect(classify(player)).toBe('dnf');
    expect(Number.isFinite(player.finishTime)).toBe(false);
  });
});

describe('reduced motion actually reaches the bright pass', () => {
  /*
   * The lift was applied to the shared threshold uniform *after* the bright
   * pass had already drawn, and the next frame's bright pass overwrote it
   * before drawing - so reduced motion dimmed the bloom while still extracting
   * the whole frame into it, which is the opposite of the intent.
   */
  it('lifts the threshold and cuts the intensity together', () => {
    const settings = defaultPostSettings();
    const full = bloomBudget({ ...settings, motion: 1 });
    const reduced = bloomBudget({ ...settings, motion: 0 });

    expect(full.threshold).toBe(settings.bloomThreshold);
    expect(full.intensity).toBe(settings.bloomIntensity);
    expect(full.vignette).toBe(settings.vignette);

    expect(reduced.threshold).toBeGreaterThan(full.threshold);
    expect(reduced.intensity).toBeLessThan(full.intensity);
    expect(reduced.vignette).toBeLessThan(full.vignette);
    // It is a budget, not a switch: an unlit night course still needs bloom.
    expect(reduced.intensity).toBeGreaterThan(0);
  });
});

describe('one press is one strike request', () => {
  /*
   * The live review measured one 100 ms tap producing twelve identical
   * `Already swinging` refusals and twelve refusal sounds, because a held
   * control was submitted to the simulation on every fixed step. The rising
   * edge is taken at the input boundary so the whole chain - simulation, HUD
   * and audio - sees one request.
   */
  const poll = (input: InputManager, frames: number): number[] =>
    Array.from({ length: frames }, () => input.poll(FIXED_STEP).strike);

  it('reports a strike on the press and nothing while it is held', () => {
    const input = new InputManager(DEFAULT_KEY_BINDINGS);
    input.setEnabled(true);

    input.setTouchState({ strike: 1 });
    const held = poll(input, 30);
    expect(held[0]).toBe(1);
    expect(held.slice(1).every((value) => value === 0)).toBe(true);
    expect(held.filter((value) => value !== 0)).toHaveLength(1);
  });

  it('reports a second strike only after the control is released', () => {
    const input = new InputManager(DEFAULT_KEY_BINDINGS);
    input.setEnabled(true);

    input.setTouchState({ strike: 1 });
    poll(input, 20);
    input.setTouchState({ strike: 0 });
    poll(input, 2);
    input.setTouchState({ strike: 1 });
    expect(input.poll(FIXED_STEP).strike).toBe(1);
  });

  it('treats the other side as a separate, deliberate request', () => {
    const input = new InputManager(DEFAULT_KEY_BINDINGS);
    input.setEnabled(true);

    input.setTouchState({ strike: 1 });
    expect(input.poll(FIXED_STEP).strike).toBe(1);
    input.setTouchState({ strike: -1 });
    expect(input.poll(FIXED_STEP).strike).toBe(-1);
  });

  it('does not produce a rejection storm from a held control', () => {
    const sim = new Simulation(buildSetup({ trackId: 'saltflat-reliquary', entries: 2, playerIndex: 0 }));
    while (sim.phase === 'countdown') {
      sim.step(emptyInput());
      sim.drainEvents();
    }
    // Past the opening lockout.
    while (sim.raceTime < COMBAT.graceAfterStart + 0.2) {
      sim.step(emptyInput());
      sim.drainEvents();
    }

    const input = new InputManager(DEFAULT_KEY_BINDINGS);
    input.setEnabled(true);
    input.setTouchState({ strike: 1, accelerate: true });

    let rejections = 0;
    let swings = 0;
    // A full second of holding, at the simulation's own rate.
    for (let step = 0; step < 120; step++) {
      sim.step(input.poll(FIXED_STEP));
      for (const event of sim.drainEvents()) {
        if (event.type === 'strikeRejected' && event.racer === 0) rejections += 1;
        if (event.type === 'strikeSwing' && event.racer === 0) swings += 1;
      }
    }

    expect(swings, 'a held control should swing exactly once').toBe(1);
    expect(rejections, 'a held control should never be refused').toBe(0);
  });
});

describe('driving input re-arms from release', () => {
  /*
   * The pad's bottom face button confirms a menu *and* hops, so resuming from
   * the pause dialog with it handed the still-held button straight to the
   * simulation as a fresh hop. Nothing already down when input resumes counts
   * as a press.
   */
  it('ignores a key pressed while input was suspended', () => {
    const input = new InputManager(DEFAULT_KEY_BINDINGS);
    input.setEnabled(false);

    const key = fakeKeyboard(input);

    // Space activates the focused button and is also the hop.
    key('keydown', 'Space');
    input.setEnabled(true);
    expect(input.poll(FIXED_STEP).hop, 'the key that dismissed the menu became a hop').toBe(false);

    // Released and pressed again, it is an ordinary hop.
    key('keyup', 'Space');
    key('keydown', 'Space');
    expect(input.poll(FIXED_STEP).hop).toBe(true);
  });
});

describe('every crew has a legible tactical character', () => {
  /*
   * The live review could not identify a crew from its driving, because the AI
   * varied by grid index rather than by crew - the same crew raced differently
   * depending on where the player's own choice put it in the array.
   */
  it('gives each crew its own immutable style, averaging out across the field', () => {
    const lines = RACERS.map((racer) => racer.style.line);
    expect(new Set(lines).size, 'two crews share a line preference').toBe(RACERS.length);
    // The field's average behaviour is unchanged; only who does what moves.
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean(lines))).toBeLessThan(0.15);
    for (const key of ['shortcut', 'towPatience', 'strike', 'drift', 'room'] as const) {
      const values = RACERS.map((racer) => racer.style[key]);
      expect(Math.abs(mean(values) - 1), `${key} pulls the whole field`).toBeLessThan(0.1);
      expect(new Set(values).size, `${key} does not separate the crews`).toBeGreaterThan(3);
    }
  });

  it('carries a crew style onto its driver, not onto the grid slot', () => {
    const first = new Simulation(buildSetup({ trackId: 'saltflat-reliquary', entries: 6, playerIndex: 0 }));
    const second = new Simulation(buildSetup({ trackId: 'saltflat-reliquary', entries: 6, playerIndex: 3 }));
    for (const racer of first.racers) {
      if (!racer.ai) continue;
      const other = second.racers.find((r) => r.profileId === racer.profileId);
      if (!other?.ai) continue;
      expect(other.ai.style, `${racer.profileId} raced differently from a different grid slot`).toEqual(racer.ai.style);
      expect(other.ai.lineBias).toBe(racer.ai.lineBias);
    }
  });
});
