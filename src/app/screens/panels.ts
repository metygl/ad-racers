import { formatLapTime, ordinal } from '../../core/math';
import type { GameSettings } from '../../core/storage';
import { getDifficulty } from '../../game/ai/driver';
import { getSpeedClass } from '../../game/config';
import type { CircuitStanding } from '../../game/circuit';
import { getRacer } from '../../game/racers';
import { ACTIONS, bindingLabel } from '../../game/input/bindings';
import type { RacerState } from '../../game/sim/state';
import type { Track } from '../../game/track/buildTrack';
import { button, el } from '../ui/dom';

/**
 * The smaller screens: controls card, pause, results, and the message panels
 * used for loading and for the states where the game cannot run.
 */

/** First-run controls card. Short on purpose — six lines, then race. */
export function buildControlsCard(settings: GameSettings, onDismiss: () => void, dismissLabel = 'Got it'): HTMLElement {
  const rows = el('dl', { class: 'controls__list' });
  for (const action of ACTIONS) {
    if (!action.rebindable && action.id !== 'pause') continue;
    rows.append(
      el('div', { class: 'controls__row' },
        el('dt', { class: 'controls__key', text: bindingLabel(settings.bindings, action.id) }),
        el('dd', { class: 'controls__action' },
          el('span', { class: 'controls__name', text: action.label }),
          action.hint ? el('span', { class: 'controls__hint', text: action.hint }) : null,
        ),
      ),
    );
  }

  return el(
    'section',
    { class: 'screen screen--controls', 'data-screen': 'controls', 'aria-labelledby': 'controls-heading' },
    el('h1', { class: 'screen__heading', id: 'controls-heading', text: 'Controls' }),
    el('p', {
      class: 'screen__lead',
      text:
        'Hold the drift through a corner to bank Surge, then spend it on the exit. Sit in a rival\'s wake to ' +
        'charge a tow snap, and pull out to spend it. Hop to take a crest level — landing straight and flat ' +
        'pays. Your wrench can swing at anyone running alongside, but you have to earn the position first.',
    }),
    rows,
    el('p', {
      class: 'settings__note',
      text:
        'A gamepad works too: left stick steers, right trigger accelerates, the bottom face button hops, ' +
        'the left and top buttons drift and Surge, and the shoulders swing the pod arm left and right.',
    }),
    el('div', { class: 'screen__actions' }, button(dismissLabel, onDismiss, { primary: true, class: 'btn--large' })),
  );
}

export interface PauseActions {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
}

export function buildPauseOverlay(actions: PauseActions): HTMLElement {
  return el(
    'div',
    {
      class: 'overlay',
      'data-screen': 'pause',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'pause-heading',
    },
    el(
      'div',
      { class: 'overlay__panel' },
      el('h2', { class: 'overlay__heading', id: 'pause-heading', text: 'Paused' }),
      el('div', { class: 'overlay__actions' },
        button('Resume', actions.onResume, { primary: true }),
        button('Restart race', actions.onRestart),
        button('Settings', actions.onSettings),
        button('Quit to title', actions.onQuit, { class: 'btn--danger' }),
      ),
    ),
  );
}

export interface ResultsActions {
  results: RacerState[];
  playerIndex: number;
  track: Track;
  difficultyId: string;
  speedClassId: string;
  records: { race: boolean; lap: boolean };
  /** Present when this race was a championship round. */
  circuit?: {
    round: number;
    rounds: number;
    standings: CircuitStanding[];
    playerProfileId: string;
    complete: boolean;
    /** Set when finishing the championship opened a new speed class. */
    unlocked?: string;
  } | null;
  primaryLabel: string;
  onPrimary: () => void;
  onSetup: () => void;
  onTitle: () => void;
}

/** The championship table, shared by the results screen and the standings view. */
/*
 * A real `table`, not a grid of `div`s.
 *
 * The visual layout is identical — the columns are laid out with CSS grid
 * either way — but the accessibility tree is not. As a div grid, a screen
 * reader emitted every row as an unassociated run of static text: a listener
 * heard a crew name, a time, a gap and "0/3" with no idea which column any of
 * them belonged to. Race results are tabular data and there is a element for
 * tabular data.
 */
export function buildStandingsTable(
  standings: readonly CircuitStanding[],
  playerProfileId: string,
  rounds: number,
): HTMLElement {
  const body = el('tbody', { class: 'standings-table__list' });
  standings.forEach((standing, index) => {
    const profile = getRacer(standing.profileId);
    const isPlayer = standing.profileId === playerProfileId;
    const row = el(
      'tr',
      { class: `standings-table__row ${isPlayer ? 'standings-table__row--player' : ''}` },
      el('td', { class: 'standings-table__place', text: String(index + 1) }),
      el(
        'th',
        { class: 'standings-table__crew', scope: 'row' },
        el('span', { text: profile.crew }),
        // Announced, not merely coloured: the player's own row has to be
        // findable without seeing the highlight.
        isPlayer ? el('span', { class: 'sr-only', text: ' (your crew)' }) : null,
      ),
      el(
        'td',
        { class: 'standings-table__finishes' },
        ...Array.from({ length: rounds }, (_, round) => {
          const place = standing.finishes[round];
          return el('span', {
            class: `standings-table__pip ${place === 1 ? 'standings-table__pip--win' : ''}`,
            title: place === undefined ? `Round ${round + 1}: not yet raced` : `Round ${round + 1}: ${ordinal(place)}`,
            text: place === undefined ? '–' : String(place),
          });
        }),
      ),
      el('td', { class: 'standings-table__points', text: String(standing.points) }),
    );
    row.style.setProperty('--crew', `#${profile.colors.body.toString(16).padStart(6, '0')}`);
    body.append(row);
  });

  return el(
    'table',
    { class: 'standings-table' },
    el('caption', { class: 'sr-only', text: 'Circuit standings' }),
    el(
      'thead',
      { class: 'standings-table__head' },
      el(
        'tr',
        {},
        el('th', { scope: 'col', text: '#' }),
        el('th', { scope: 'col', text: 'Crew' }),
        el('th', { scope: 'col', text: 'Rounds' }),
        el('th', { scope: 'col', text: 'Points' }),
      ),
    ),
    body,
  );
}

export function buildResultsScreen(actions: ResultsActions): HTMLElement {
  const player = actions.results.find((r) => r.index === actions.playerIndex);
  const rows = el('tbody', { class: 'results__list' });

  const leader = actions.results[0];
  for (const racer of actions.results) {
    const profile = getRacer(racer.profileId);
    const gap =
      leader?.completed && racer.completed && racer !== leader
        ? `+${(racer.finishTime - leader.finishTime).toFixed(2)}s`
        : '—';
    const isPlayer = racer.index === actions.playerIndex;
    const row = el(
      'tr',
      { class: `results__row ${isPlayer ? 'results__row--player' : ''}` },
      el('td', { class: 'results__place', text: String(racer.finishPosition) }),
      el('th', { class: 'results__crew', scope: 'row' },
        el('span', { class: 'results__name', text: profile.crew }),
        el('span', { class: 'results__pilots', text: `${profile.pilot} & ${profile.wrench}` }),
        isPlayer ? el('span', { class: 'sr-only', text: ' (your crew)' }) : null,
      ),
      el('td', { class: 'results__time', text: racer.completed ? formatLapTime(racer.finishTime) : 'DNF' }),
      el('td', { class: 'results__gap', text: gap }),
      el('td', {
        class: 'results__best',
        text: Number.isFinite(racer.bestLap) ? formatLapTime(racer.bestLap) : '—',
      }),
      // The two-number form was unexplained: it is strikes landed and taken.
      el('td', {
        class: 'results__strikes',
        'aria-label': `${racer.strikesLanded} landed, ${racer.strikesTaken} taken`,
        text: `${racer.strikesLanded}/${racer.strikesTaken}`,
      }),
    );
    row.style.setProperty('--crew', `#${profile.colors.body.toString(16).padStart(6, '0')}`);
    rows.append(row);
  }

  const circuit = actions.circuit ?? null;
  const playerPlace = circuit
    ? circuit.standings.findIndex((standing) => standing.profileId === circuit.playerProfileId) + 1
    : 0;

  const headline = circuit?.complete
    ? playerPlace === 1
      ? 'Circuit won'
      : `Circuit finished ${ordinal(playerPlace)}`
    : player
    ? !player.completed
      ? 'Did not finish'
      : player.finishPosition === 1
      ? 'Race won'
      : `Finished ${ordinal(player.finishPosition)}`
    : 'Race complete';

  const subtitle = circuit
    ? `${actions.track.definition.name} · Round ${circuit.round} of ${circuit.rounds} · ` +
      `${getDifficulty(actions.difficultyId).label} · ${getSpeedClass(actions.speedClassId).label}`
    : `${actions.track.definition.name} · ${actions.track.laps} laps · ` +
      `${getDifficulty(actions.difficultyId).label} · ${getSpeedClass(actions.speedClassId).label}`;

  return el(
    'section',
    { class: 'screen screen--results', 'data-screen': 'results', 'aria-labelledby': 'results-heading' },
    el('h1', { class: 'screen__heading', id: 'results-heading', text: headline }),
    el('p', { class: 'screen__lead', text: subtitle }),
    circuit?.unlocked
      ? el('p', { class: 'results__record results__record--unlock', text: `Unlocked: ${circuit.unlocked} class` })
      : null,
    actions.records.race || actions.records.lap
      ? el('p', {
          class: 'results__record',
          text: [actions.records.race ? 'New best race time' : null, actions.records.lap ? 'New best lap' : null]
            .filter(Boolean)
            .join(' · '),
        })
      : null,
    el(
      'table',
      { class: 'results__table' },
      el('caption', { class: 'sr-only', text: 'Race classification' }),
      el(
        'thead',
        { class: 'results__head' },
        el(
          'tr',
          {},
          el('th', { scope: 'col', text: '#' }),
          el('th', { scope: 'col', text: 'Crew' }),
          el('th', { scope: 'col', text: 'Time' }),
          el('th', { scope: 'col', text: 'Gap' }),
          el('th', { scope: 'col', text: 'Best lap' }),
          el('th', { scope: 'col', title: 'Strikes landed / taken', text: 'Hits' }),
        ),
      ),
      rows,
    ),
    circuit
      ? el(
          'div',
          { class: 'results__standings' },
          el('h2', { class: 'screen__subheading', text: 'Circuit standings' }),
          buildStandingsTable(circuit.standings, circuit.playerProfileId, circuit.rounds),
        )
      : null,
    el(
      'div',
      { class: 'screen__actions' },
      button(actions.primaryLabel, actions.onPrimary, { primary: true, class: 'btn--large' }),
      button('Change setup', actions.onSetup),
      button('Title', actions.onTitle),
    ),
  );
}

/** Loading, fatal errors, and the honest "this device cannot run it" panel. */
export function buildMessagePanel(options: {
  kind: 'loading' | 'error' | 'unsupported';
  heading: string;
  body: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}): HTMLElement {
  return el(
    'section',
    {
      class: `screen screen--message screen--${options.kind}`,
      'data-screen': options.kind,
      role: options.kind === 'loading' ? 'status' : 'alert',
      'aria-live': options.kind === 'loading' ? 'polite' : 'assertive',
    },
    options.kind === 'loading' ? el('div', { class: 'spinner', 'aria-hidden': 'true' }) : null,
    el('h1', { class: 'screen__heading', text: options.heading }),
    el('p', { class: 'screen__lead', text: options.body }),
    options.detail ? el('pre', { class: 'message__detail', text: options.detail }) : null,
    options.action ? el('div', { class: 'screen__actions' }, button(options.action.label, options.action.onClick, { primary: true })) : null,
  );
}
