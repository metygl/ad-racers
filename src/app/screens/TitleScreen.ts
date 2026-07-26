import { button, el } from '../ui/dom';

/**
 * The title screen.
 *
 * It has one job beyond looking like something: get the player into a race in
 * one click. Everything else on it is secondary and placed accordingly.
 */

export interface TitleActions {
  onRace: () => void;
  onCircuit: () => void;
  onSettings: () => void;
  onControls: () => void;
  /** Present only once a best time exists somewhere. */
  bestSummary: string | null;
  /** Present only once a championship has been finished. */
  circuitSummary: string | null;
}

export function buildTitleScreen(actions: TitleActions): HTMLElement {
  /*
   * Single Race is the primary action and Circuit sits beside it, not above.
   * A championship is three races long, and a player arriving for the first
   * time should not have to opt out of a commitment to find out whether they
   * like the driving.
   */
  const play = button('Race', actions.onRace, { primary: true, class: 'btn--large' });
  const circuit = button('Circuit', actions.onCircuit, { class: 'btn--large' });

  return el(
    'section',
    { class: 'screen screen--title', 'data-screen': 'title', 'aria-labelledby': 'title-heading' },
    el(
      'div',
      { class: 'title__mark', 'aria-hidden': 'true' },
      el('span', { class: 'title__kicker', text: 'The Reclaim Circuit' }),
      el('span', { class: 'title__rule' }),
    ),
    el('h1', { class: 'title__wordmark', id: 'title-heading' }, 'AD ', el('em', { text: 'Racers' })),
    el('p', {
      class: 'title__tagline',
      text: 'Three hundred years after the Long Quiet, the motorways are green again — and the salvage crews race on them.',
    }),
    el(
      'div',
      { class: 'title__actions' },
      play,
      circuit,
      button('Settings', actions.onSettings),
      button('Controls', actions.onControls),
    ),
    el(
      'div',
      { class: 'title__records' },
      actions.bestSummary ? el('p', { class: 'title__best', text: actions.bestSummary }) : null,
      actions.circuitSummary ? el('p', { class: 'title__best', text: actions.circuitSummary }) : null,
    ),
    el(
      'footer',
      { class: 'title__footer' },
      el('p', {
        text: 'Original game. Not affiliated with, and containing no assets from, any existing racing title.',
      }),
    ),
  );
}
