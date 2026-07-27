import { formatLapTime, ordinal } from '../../core/math';
import { shouldUseTouch } from '../ui/TouchControls';
import { crewSilhouette } from '../ui/garage';
import type { GameSettings } from '../../core/storage';
import { getDifficulty } from '../../game/ai/driver';
import { getSpeedClass } from '../../game/config';
import type { CircuitStanding } from '../../game/circuit';
import { getRacer } from '../../game/racers';
import { ACTIONS, bindingLabel } from '../../game/input/bindings';
import { classify } from '../../game/sim/race';
import type { RacerState } from '../../game/sim/state';
import type { Track } from '../../game/track/buildTrack';
import { button, el } from '../ui/dom';

/**
 * The smaller screens: controls card, pause, results, and the message panels
 * used for loading and for the states where the game cannot run.
 */

/**
 * What the touch layout actually does, in the order a thumb needs it.
 *
 * A review on a phone continued past this screen and immediately started an
 * auto-accelerating vehicle it had not been told about, because the first thing
 * a touch player was shown was a wall of key names for a keyboard they do not
 * have. The single most important fact — *you do not press accelerate* — was
 * nowhere on it.
 */
const TOUCH_ROWS: readonly { control: string; name: string; hint: string }[] = [
  { control: 'Automatic', name: 'Throttle', hint: 'You are already accelerating. There is no go button.' },
  { control: 'Bottom strip', name: 'Steer', hint: 'Slide a thumb along it. Centre is straight.' },
  { control: 'Brake', name: 'Slow, then reverse', hint: 'Hold it past a stop to back out of trouble.' },
  { control: 'Drift', name: 'Bank Surge', hint: 'Hold it through a corner, release on the exit.' },
  { control: 'Surge', name: 'Spend it', hint: 'Once the meter has a segment.' },
  { control: 'Hop', name: 'Take a crest level', hint: 'Landing straight and flat pays.' },
  { control: 'Recover', name: 'Get unstuck', hint: 'Puts you back on the road if you end up off it.' },
  { control: 'CAM / II', name: 'Camera and pause', hint: 'Top left, out of the way of your thumbs.' },
];

/** First-run controls card. Short on purpose — six lines, then race. */
export function buildControlsCard(settings: GameSettings, onDismiss: () => void, dismissLabel = 'Got it'): HTMLElement {
  const rows = el('dl', { class: 'controls__list' });

  /*
   * Serve the controls the device actually has.
   *
   * Showing a touch player the keyboard bindings is not merely unhelpful, it is
   * misleading: it implies there is a key to press to move.
   */
  if (shouldUseTouch()) {
    for (const row of TOUCH_ROWS) {
      rows.append(
        el('div', { class: 'controls__row' },
          el('dt', { class: 'controls__key', text: row.control }),
          el('dd', { class: 'controls__action' },
            el('span', { class: 'controls__name', text: row.name }),
            el('span', { class: 'controls__hint', text: row.hint }),
          ),
        ),
      );
    }
  } else {
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
  }

  return el(
    'section',
    { class: 'screen screen--controls', 'data-screen': 'controls', 'aria-labelledby': 'controls-heading' },
    // Focus opens at the top of the page rather than on a Continue button that
    // can be 700 px below the fold on a landscape phone. See `trapFocus`.
    el('h1', { class: 'screen__heading', id: 'controls-heading', tabindex: '-1', 'data-autofocus': true, text: 'Controls' }),
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
      text: shouldUseTouch()
        ? 'A keyboard or gamepad works too if you plug one in — the on-screen controls stay available either way.'
        : 'A gamepad works too: left stick steers, right trigger accelerates, the bottom face button hops, ' +
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

/**
 * The mark a projected classification carries, everywhere it appears.
 *
 * One glyph rather than a word, because it has to sit inside a time column at
 * 320 px; the legend under the table is what says what it means, and every
 * projected cell also carries the words for a screen reader.
 */
const PROJECTED_MARK = '≈';

export function buildResultsScreen(actions: ResultsActions): HTMLElement {
  const player = actions.results.find((r) => r.index === actions.playerIndex);
  const rows = el('tbody', { class: 'results__list' });
  let anyProjected = false;

  const leader = actions.results[0];
  for (const racer of actions.results) {
    const profile = getRacer(racer.profileId);
    const outcome = classify(racer);
    if (outcome === 'projected') anyProjected = true;
    /*
     * A gap needs two comparable times, not two *completed* ones.
     *
     * Requiring `completed` on both meant a field where the leader finished and
     * everyone else was classified on pace showed a column of dashes, which
     * throws away the one number that says how close the race was.
     */
    const comparable = leader !== undefined && Number.isFinite(leader.finishTime) && Number.isFinite(racer.finishTime);
    const approximate = outcome === 'projected' || (leader !== undefined && classify(leader) === 'projected');
    const gap =
      comparable && leader !== undefined && racer !== leader
        ? `${approximate ? PROJECTED_MARK : '+'}${(racer.finishTime - leader.finishTime).toFixed(2)}s`
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
      el(
        'td',
        {
          class: `results__time${outcome === 'projected' ? ' results__time--projected' : ''}`,
          ...(outcome === 'projected' ? { title: 'Projected on the pace they were running' } : {}),
        },
        el('span', {
          text:
            outcome === 'dnf'
              ? 'DNF'
              : `${outcome === 'projected' ? PROJECTED_MARK : ''}${formatLapTime(racer.finishTime)}`,
        }),
        outcome === 'projected' ? el('span', { class: 'sr-only', text: ' projected finish' }) : null,
      ),
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
    // Drives the staggered reveal; see `.results__row` in the stylesheet.
    row.style.setProperty('--row', String(rows.children.length));
    rows.append(row);
  }

  const circuit = actions.circuit ?? null;
  const playerPlace = circuit
    ? circuit.standings.findIndex((standing) => standing.profileId === circuit.playerProfileId) + 1
    : 0;

  const playerOutcome = player ? classify(player) : null;
  const headline = circuit?.complete
    ? playerPlace === 1
      ? 'Circuit won'
      : `Circuit finished ${ordinal(playerPlace)}`
    : player && playerOutcome
    ? playerOutcome === 'dnf'
      ? 'Did not finish'
      : playerOutcome === 'projected'
      ? // Classified, not failed. The race was called while this crew was still
        // running, and their own pace is what places them.
        `Classified ${ordinal(player.finishPosition)}`
      : player.finishPosition === 1
      ? 'Race won'
      : `Finished ${ordinal(player.finishPosition)}`
    : 'Race complete';

  const subtitle = circuit
    ? `${actions.track.definition.name} · Round ${circuit.round} of ${circuit.rounds} · ` +
      `${getDifficulty(actions.difficultyId).label} · ${getSpeedClass(actions.speedClassId).label}`
    : `${actions.track.definition.name} · ${actions.track.laps} laps · ` +
      `${getDifficulty(actions.difficultyId).label} · ${getSpeedClass(actions.speedClassId).label}`;

  /*
   * A hero card, then the table.
   *
   * A review's verdict on this screen was "winning feels like entering a
   * spreadsheet": a heading, a line of text, a classification table and three
   * buttons, with no podium, no crew, no reward and nothing that belonged to
   * the race that had just happened. The information was all there; the
   * *occasion* was missing entirely.
   *
   * So the outcome leads with the crew who earned it — their machine, their
   * names, their place and their time at a size that means something — and the
   * table stays underneath for the detail. It is built from the same silhouette
   * the garage and the 3D scene use, so the card cannot show a machine the
   * player did not just drive, and it reads at 320 px because it is a stack
   * rather than a row.
   */
  const heroCard = player && playerOutcome
    ? (() => {
        const profile = getRacer(player.profileId);
        const won = player.finishPosition === 1 && playerOutcome === 'finished';
        const podium = player.finishPosition <= 3 && playerOutcome !== 'dnf';
        const card = el(
          'div',
          {
            class:
              `results__hero${won ? ' results__hero--won' : ''}` +
              `${podium && !won ? ' results__hero--podium' : ''}`,
          },
          el('div', { class: 'results__hero-art' }, crewSilhouette(profile) as unknown as HTMLElement),
          el('div', { class: 'results__hero-body' },
            el(
              'p',
              { class: 'results__hero-place' },
              el('span', { text: playerOutcome === 'dnf' ? 'DNF' : ordinal(player.finishPosition) }),
              playerOutcome === 'projected'
                ? el('span', { class: 'results__hero-tag', text: 'classified on pace' })
                : null,
              won ? el('span', { class: 'results__hero-tag results__hero-tag--won', text: 'race won' }) : null,
            ),
            el('p', { class: 'results__hero-crew', text: profile.crew }),
            el('p', { class: 'results__hero-pilots', text: `${profile.pilot} & ${profile.wrench} · ${profile.skiff}` }),
            el('p', {
              class: 'results__hero-time',
              text:
                playerOutcome === 'dnf'
                  ? 'Did not finish'
                  : `${playerOutcome === 'projected' ? PROJECTED_MARK : ''}${formatLapTime(player.finishTime)}`,
            }),
          ),
        );
        card.style.setProperty('--crew', `#${profile.colors.body.toString(16).padStart(6, '0')}`);
        card.style.setProperty('--crew-trim', `#${profile.colors.trim.toString(16).padStart(6, '0')}`);
        card.style.setProperty('--crew-glow', `#${profile.colors.glow.toString(16).padStart(6, '0')}`);
        return card;
      })()
    : null;

  return el(
    'section',
    { class: 'screen screen--results', 'data-screen': 'results', 'aria-labelledby': 'results-heading' },
    el('h1', { class: 'screen__heading', id: 'results-heading', text: headline }),
    el('p', { class: 'screen__lead', text: subtitle }),
    heroCard,
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
    // Said once, under the table, rather than repeated in every cell.
    anyProjected
      ? el('p', {
          class: 'results__legend',
          text: `${PROJECTED_MARK} Projected finish - classified on the pace that crew was running when the race was called.`,
        })
      : null,
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
