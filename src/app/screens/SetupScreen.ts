import { formatLapTime } from '../../core/math';
import type { BestTime } from '../../core/storage';
import { DIFFICULTIES } from '../../game/ai/driver';
import { SPEED_CLASSES } from '../../game/config';
import { RACERS } from '../../game/racers';
import type { RacerProfile } from '../../game/racers';
import { TRACK_DEFINITIONS } from '../../game/track/tracks';
import type { TrackDefinition } from '../../game/track/types';
import { button, el } from '../ui/dom';

/**
 * Race setup: course, skiff, difficulty.
 *
 * Built as three radio groups rather than three carousels, because a radiogroup
 * is navigable with the arrow keys for free, works with a screen reader, and
 * shows every option at once — which is what a player picking a car actually
 * wants. The stat bars are `meter` elements for the same reason.
 */

export interface SetupSelection {
  trackId: string;
  racerId: string;
  difficultyId: string;
  speedClassId: string;
}

export interface SetupActions {
  /** A championship races every course in order, so it hides the course list. */
  mode: 'single' | 'circuit';
  selection: SetupSelection;
  bests: Record<string, BestTime>;
  /** Speed class ids the player has earned; the rest are shown locked. */
  unlockedSpeedClasses: ReadonlySet<string>;
  onChange: (selection: SetupSelection) => void;
  onStart: () => void;
  onBack: () => void;
}

function trackCard(track: TrackDefinition, best: BestTime | undefined, selected: boolean, onSelect: () => void): HTMLElement {
  const id = `track-${track.id}`;
  const input = el('input', { type: 'radio', name: 'track', id, class: 'card__input' });
  input.checked = selected;
  input.addEventListener('change', onSelect);

  const pips = el('span', { class: 'card__pips', 'aria-label': `Technicality ${track.technicality} of 3` });
  for (let i = 0; i < 3; i++) {
    pips.append(el('span', { class: `card__pip ${i < track.technicality ? 'card__pip--on' : ''}` }));
  }

  const shortcut = track.branches[0];

  return el(
    'div',
    { class: 'card-wrap' },
    input,
    el(
      'label',
      { class: `card card--track card--${track.id}`, for: id },
      el('span', { class: 'card__kicker', text: `Course ${TRACK_DEFINITIONS.indexOf(track) + 1}` }),
      el('span', { class: 'card__title', text: track.name }),
      el('span', { class: 'card__tagline', text: track.tagline }),
      el(
        'span',
        { class: 'card__meta' },
        el('span', { text: `${track.laps} laps` }),
        pips,
      ),
      shortcut
        ? el('span', { class: 'card__shortcut', text: `Shortcut — ${shortcut.name}: ${shortcut.risk}` })
        : null,
      best && Number.isFinite(best.race)
        ? el('span', { class: 'card__best', text: `Best ${formatLapTime(best.race)} · lap ${formatLapTime(best.lap)}` })
        : el('span', { class: 'card__best card__best--none', text: 'No time set' }),
    ),
  );
}

function statBar(label: string, value: number): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat__label', text: label }),
    el(
      'span',
      {
        class: 'stat__meter',
        role: 'meter',
        'aria-label': label,
        'aria-valuenow': Math.round(value * 100),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      el('span', { class: 'stat__fill', style: `transform: scaleX(${value.toFixed(3)})` }),
    ),
  );
}

function racerCard(racer: RacerProfile, selected: boolean, onSelect: () => void): HTMLElement {
  const id = `racer-${racer.id}`;
  const input = el('input', { type: 'radio', name: 'racer', id, class: 'card__input' });
  input.checked = selected;
  input.addEventListener('change', onSelect);

  const swatch = el('span', { class: 'card__swatch', 'aria-hidden': 'true' });
  swatch.style.setProperty('--body', `#${racer.colors.body.toString(16).padStart(6, '0')}`);
  swatch.style.setProperty('--trim', `#${racer.colors.trim.toString(16).padStart(6, '0')}`);
  swatch.style.setProperty('--glow', `#${racer.colors.glow.toString(16).padStart(6, '0')}`);

  return el(
    'div',
    { class: 'card-wrap' },
    input,
    el(
      'label',
      { class: 'card card--racer', for: id },
      swatch,
      el('span', { class: 'card__title', text: racer.crew }),
      el('span', { class: 'card__crew', text: `${racer.pilot} & ${racer.wrench} · ${racer.skiff}` }),
      el('span', { class: 'card__blurb', text: racer.blurb }),
      el(
        'span',
        { class: 'card__stats' },
        statBar('Speed', racer.stats.topSpeed),
        statBar('Accel', racer.stats.acceleration),
        statBar('Grip', racer.stats.grip),
        statBar('Mass', racer.stats.weight),
        statBar('Reach', racer.stats.reach),
      ),
    ),
  );
}

export function buildSetupScreen(actions: SetupActions): HTMLElement {
  const selection = { ...actions.selection };
  const emit = (): void => actions.onChange({ ...selection });

  const trackList = el('div', { class: 'card-grid card-grid--tracks', role: 'radiogroup', 'aria-label': 'Course' });
  for (const track of TRACK_DEFINITIONS) {
    trackList.append(
      trackCard(track, actions.bests[track.id], track.id === selection.trackId, () => {
        selection.trackId = track.id;
        emit();
      }),
    );
  }

  const racerList = el('div', { class: 'card-grid card-grid--racers', role: 'radiogroup', 'aria-label': 'Crew' });
  for (const racer of RACERS) {
    racerList.append(
      racerCard(racer, racer.id === selection.racerId, () => {
        selection.racerId = racer.id;
        emit();
      }),
    );
  }

  const difficultyList = el('div', { class: 'card-grid card-grid--difficulty', role: 'radiogroup', 'aria-label': 'Difficulty' });
  for (const difficulty of DIFFICULTIES) {
    const id = `difficulty-${difficulty.id}`;
    const input = el('input', { type: 'radio', name: 'difficulty', id, class: 'card__input' });
    input.checked = difficulty.id === selection.difficultyId;
    input.addEventListener('change', () => {
      selection.difficultyId = difficulty.id;
      emit();
    });
    difficultyList.append(
      el(
        'div',
        { class: 'card-wrap' },
        input,
        el(
          'label',
          { class: 'card card--difficulty', for: id },
          el('span', { class: 'card__title', text: difficulty.label }),
          el('span', { class: 'card__blurb', text: difficulty.description }),
        ),
      ),
    );
  }

  const classList = el('div', {
    class: 'card-grid card-grid--difficulty',
    role: 'radiogroup',
    'aria-label': 'Speed class',
  });
  for (const speedClass of SPEED_CLASSES) {
    const unlocked = actions.unlockedSpeedClasses.has(speedClass.id);
    const id = `speed-${speedClass.id}`;
    const input = el('input', { type: 'radio', name: 'speed', id, class: 'card__input' });
    input.checked = speedClass.id === selection.speedClassId && unlocked;
    input.disabled = !unlocked;
    input.addEventListener('change', () => {
      selection.speedClassId = speedClass.id;
      emit();
    });
    classList.append(
      el(
        'div',
        { class: 'card-wrap' },
        input,
        el(
          'label',
          { class: `card card--difficulty ${unlocked ? '' : 'card--locked'}`, for: id },
          el('span', { class: 'card__title', text: speedClass.label }),
          el('span', { class: 'card__blurb', text: speedClass.description }),
          // A locked class is shown, with what opens it. Hiding it would leave
          // a player with no idea there is anything further to reach for.
          unlocked
            ? null
            : el('span', { class: 'card__lock', text: 'Finish a Circuit on the podium in the class below.' }),
        ),
      ),
    );
  }

  const circuit = actions.mode === 'circuit';

  return el(
    'section',
    { class: 'screen screen--setup', 'data-screen': 'setup', 'aria-labelledby': 'setup-heading' },
    el('h1', { class: 'screen__heading', id: 'setup-heading', text: circuit ? 'Circuit setup' : 'Race setup' }),
    circuit
      ? el('p', {
          class: 'screen__lead',
          text: `A championship over all ${TRACK_DEFINITIONS.length} courses. Points every round; everyone scores.`,
        })
      : null,
    circuit
      ? null
      : el('div', { class: 'setup__section' }, el('h2', { class: 'screen__subheading', text: 'Course' }), trackList),
    el('div', { class: 'setup__section' }, el('h2', { class: 'screen__subheading', text: 'Crew' }), racerList),
    el('div', { class: 'setup__section' }, el('h2', { class: 'screen__subheading', text: 'Difficulty' }), difficultyList),
    el('div', { class: 'setup__section' }, el('h2', { class: 'screen__subheading', text: 'Speed class' }), classList),
    el(
      'div',
      { class: 'screen__actions' },
      button('Back', actions.onBack),
      button(circuit ? 'Start circuit' : 'Start race', actions.onStart, { primary: true, class: 'btn--large' }),
    ),
  );
}
