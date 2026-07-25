import { formatLapTime, ordinal } from '../../core/math';
import type { GameSettings } from '../../core/storage';
import { getDifficulty } from '../../game/ai/driver';
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
      text: 'Hold the drift through a corner to bank Surge, then spend it on the straight. Your wrench can swing at anyone running alongside — but you have to earn the position first.',
    }),
    rows,
    el('p', {
      class: 'settings__note',
      text: 'A gamepad works too: left stick steers, right trigger accelerates, face buttons drift and Surge, shoulders swing left and right.',
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
  records: { race: boolean; lap: boolean };
  onRematch: () => void;
  onSetup: () => void;
  onTitle: () => void;
}

export function buildResultsScreen(actions: ResultsActions): HTMLElement {
  const player = actions.results.find((r) => r.index === actions.playerIndex);
  const rows = el('ol', { class: 'results__list' });

  const leader = actions.results[0];
  for (const racer of actions.results) {
    const profile = getRacer(racer.profileId);
    const gap =
      leader && racer !== leader && Number.isFinite(racer.finishTime)
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
      el('span', { class: 'results__time', text: formatLapTime(racer.finishTime) }),
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

  const headline = player
    ? player.finishPosition === 1
      ? 'Race won'
      : `Finished ${ordinal(player.finishPosition)}`
    : 'Race complete';

  return el(
    'section',
    { class: 'screen screen--results', 'data-screen': 'results', 'aria-labelledby': 'results-heading' },
    el('h1', { class: 'screen__heading', id: 'results-heading', text: headline }),
    el('p', {
      class: 'screen__lead',
      text: `${actions.track.definition.name} · ${actions.track.laps} laps · ${getDifficulty(actions.difficultyId).label}`,
    }),
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
    el(
      'div',
      { class: 'screen__actions' },
      button('Rematch', actions.onRematch, { primary: true, class: 'btn--large' }),
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
