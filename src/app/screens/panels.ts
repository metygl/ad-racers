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
export function buildStandingsTable(
  standings: readonly CircuitStanding[],
  playerProfileId: string,
  rounds: number,
): HTMLElement {
  const rows = el('ol', { class: 'standings-table__list' });
  standings.forEach((standing, index) => {
    const profile = getRacer(standing.profileId);
    const row = el(
      'li',
      {
        class: `standings-table__row ${standing.profileId === playerProfileId ? 'standings-table__row--player' : ''}`,
      },
      el('span', { class: 'standings-table__place', text: String(index + 1) }),
      el('span', { class: 'standings-table__crew', text: profile.crew }),
      el(
        'span',
        { class: 'standings-table__finishes' },
        ...Array.from({ length: rounds }, (_, round) =>
          el('span', {
            class: `standings-table__pip ${standing.finishes[round] === 1 ? 'standings-table__pip--win' : ''}`,
            text: standing.finishes[round] === undefined ? '–' : String(standing.finishes[round]),
          }),
        ),
      ),
      el('span', { class: 'standings-table__points', text: String(standing.points) }),
    );
    row.style.setProperty('--crew', `#${profile.colors.body.toString(16).padStart(6, '0')}`);
    rows.append(row);
  });

  return el(
    'div',
    { class: 'standings-table' },
    el(
      'div',
      { class: 'standings-table__head', 'aria-hidden': 'true' },
      el('span', { text: '#' }),
      el('span', { text: 'Crew' }),
      el('span', { text: 'Rounds' }),
      el('span', { text: 'Pts' }),
    ),
    rows,
  );
}

export function buildResultsScreen(actions: ResultsActions): HTMLElement {
  const player = actions.results.find((r) => r.index === actions.playerIndex);
  const rows = el('ol', { class: 'results__list' });

  const leader = actions.results[0];
  for (const racer of actions.results) {
    const profile = getRacer(racer.profileId);
    const gap =
      leader?.completed && racer.completed && racer !== leader
        ? `+${(racer.finishTime - leader.finishTime).toFixed(2)}s`
        : '—';
    const row = el(
      'li',
      { class: `results__row ${racer.index === actions.playerIndex ? 'results__row--player' : ''}` },
      el('span', { class: 'results__place', text: String(racer.finishPosition) }),
      el('span', { class: 'results__crew' },
        el('span', { class: 'results__name', text: profile.crew }),
        el('span', { class: 'results__pilots', text: `${profile.pilot} & ${profile.wrench}` }),
      ),
      el('span', { class: 'results__time', text: racer.completed ? formatLapTime(racer.finishTime) : 'DNF' }),
      el('span', { class: 'results__gap', text: gap }),
      el('span', {
        class: 'results__best',
        text: Number.isFinite(racer.bestLap) ? formatLapTime(racer.bestLap) : '—',
      }),
      el('span', { class: 'results__strikes', text: `${racer.strikesLanded}/${racer.strikesTaken}` }),
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
      'div',
      { class: 'results__table' },
      el(
        'div',
        { class: 'results__head', 'aria-hidden': 'true' },
        el('span', { text: '#' }),
        el('span', { text: 'Crew' }),
        el('span', { text: 'Time' }),
        el('span', { text: 'Gap' }),
        el('span', { text: 'Best lap' }),
        el('span', { text: 'Hits' }),
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
