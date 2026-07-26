import { button, el } from '../ui/dom';

/**
 * The title screen.
 *
 * It has one job beyond looking like something: get the player into a race in
 * one click. Everything else on it is secondary and placed accordingly.
 */

export interface TitleActions {
  onRace: () => void;
  onSettings: () => void;
  onControls: () => void;
  /** Present only once a best time exists somewhere. */
  bestSummary: string | null;
}

export function buildTitleScreen(actions: TitleActions): HTMLElement {
  const play = button('Race', actions.onRace, { primary: true, class: 'btn--large' });

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
    el('div', { class: 'title__actions' }, play, button('Settings', actions.onSettings), button('Controls', actions.onControls)),
    actions.bestSummary ? el('p', { class: 'title__best', text: actions.bestSummary }) : null,
    el(
      'footer',
      { class: 'title__footer' },
      el('p', {
        text: 'Original game. Not affiliated with, and containing no assets from, any existing racing title.',
      }),
    ),
  );
}
