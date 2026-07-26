import type { GameSettings } from '../../core/storage';
import { ACTIONS, bindingLabel, DEFAULT_KEY_BINDINGS, keyLabel } from '../../game/input/bindings';
import type { ActionId } from '../../game/input/bindings';
import { QUALITY_ORDER, QUALITY_TIERS } from '../../render/quality';
import type { QualityId } from '../../render/quality';
import { button, el, segmented, slider, toggle } from '../ui/dom';
import { CAMERA_MODES } from '../../render/camera/ChaseCamera';
import type { CameraMode } from '../../render/camera/ChaseCamera';

/**
 * Settings.
 *
 * Every change applies immediately rather than on an OK button — a volume
 * slider you cannot hear while dragging is useless, and the same argument
 * applies to quality and contrast. The screen is a list of native controls, so
 * it works with a keyboard, a screen reader and browser zoom without any
 * special handling.
 */

export interface SettingsActions {
  settings: GameSettings;
  onChange: (settings: GameSettings) => void;
  onBack: () => void;
  onClearData: () => void;
  /** Starts capturing a key for an action; resolves with the new binding. */
  onRebind: (action: ActionId, done: (code: string | null) => void) => void;
  gamepadConnected: boolean;
}

export function buildSettingsScreen(actions: SettingsActions): HTMLElement {
  const settings: GameSettings = JSON.parse(JSON.stringify(actions.settings)) as GameSettings;
  const emit = (): void => actions.onChange(JSON.parse(JSON.stringify(settings)) as GameSettings);

  const qualityField = segmented<QualityId | 'auto'>(
    'Graphics quality',
    [
      { value: 'auto', label: 'Auto', hint: 'Starts sensible and adapts to your frame rate.' },
      ...QUALITY_ORDER.map((id) => ({ value: id, label: QUALITY_TIERS[id].label, hint: QUALITY_TIERS[id].description })),
    ],
    settings.autoQuality ? 'auto' : settings.quality,
    (value) => {
      if (value === 'auto') {
        settings.autoQuality = true;
      } else {
        settings.autoQuality = false;
        settings.quality = value;
      }
      emit();
    },
  );

  const bindingRows = el('div', { class: 'bindings' });
  const renderBindings = (): void => {
    bindingRows.replaceChildren();
    for (const action of ACTIONS) {
      if (!action.rebindable) continue;
      const label = el('span', { class: 'bindings__label', text: action.label });
      const current = el('span', { class: 'bindings__keys', text: bindingLabel(settings.bindings, action.id) });
      const rebind = button('Change', () => {
        current.textContent = 'Press a key…';
        current.classList.add('bindings__keys--waiting');
        actions.onRebind(action.id, (code) => {
          current.classList.remove('bindings__keys--waiting');
          if (code) {
            settings.bindings[action.id] = [code];
            emit();
          }
          current.textContent = bindingLabel(settings.bindings, action.id);
        });
      }, { class: 'btn--small' });
      rebind.setAttribute('aria-label', `Change the key for ${action.label}`);
      bindingRows.append(el('div', { class: 'bindings__row' }, label, current, rebind));
    }
  };
  renderBindings();

  return el(
    'section',
    { class: 'screen screen--settings', 'data-screen': 'settings', 'aria-labelledby': 'settings-heading' },
    el('h1', { class: 'screen__heading', id: 'settings-heading', text: 'Settings' }),

    el(
      'div',
      { class: 'settings__group' },
      el('h2', { class: 'screen__subheading', text: 'Audio' }),
      slider('Master volume', settings.audio.master, (v) => {
        settings.audio.master = v;
        emit();
      }),
      slider('Music and ambience', settings.audio.music, (v) => {
        settings.audio.music = v;
        emit();
      }),
      slider('Effects', settings.audio.effects, (v) => {
        settings.audio.effects = v;
        emit();
      }),
      toggle('Mute everything', settings.audio.muted, (v) => {
        settings.audio.muted = v;
        emit();
      }),
    ),

    el(
      'div',
      { class: 'settings__group' },
      el('h2', { class: 'screen__subheading', text: 'Display' }),
      qualityField,
      toggle(
        'Reduced motion',
        settings.reducedMotion,
        (v) => {
          settings.reducedMotion = v;
          emit();
        },
        'Removes camera shake and speed streaks. Follows your system preference by default.',
      ),
      toggle(
        'High contrast interface',
        settings.highContrast,
        (v) => {
          settings.highContrast = v;
          emit();
        },
        'Heavier panels and stronger outlines on the menus and HUD.',
      ),
      toggle('Show performance overlay', settings.showPerformance, (v) => {
        settings.showPerformance = v;
        emit();
      }),
      segmented<CameraMode>(
        'Camera',
        CAMERA_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
        settings.cameraMode,
        (value) => {
          settings.cameraMode = value;
          emit();
        },
      ),
    ),

    el(
      'div',
      { class: 'settings__group' },
      el('h2', { class: 'screen__subheading', text: 'Racing' }),
      toggle(
        'Keep the pack close',
        settings.catchUp,
        (v) => {
          settings.catchUp = v;
          emit();
        },
        'A 3% engine assist for trailing opponents only. Never applies to you, and never enough to erase a mistake.',
      ),
    ),

    el(
      'div',
      { class: 'settings__group' },
      el('h2', { class: 'screen__subheading', text: 'Controls' }),
      el('p', {
        class: 'settings__note',
        text: actions.gamepadConnected
          ? 'Gamepad detected. Left stick or D-pad steers, right trigger accelerates.'
          : 'Connect a gamepad and press a button to use it. Left stick or D-pad steers.',
      }),
      bindingRows,
      button('Reset keys to defaults', () => {
        settings.bindings = JSON.parse(JSON.stringify(DEFAULT_KEY_BINDINGS)) as typeof settings.bindings;
        renderBindings();
        emit();
      }),
      el('p', { class: 'settings__note', text: `Pause is always available on ${keyLabel('Escape')}.` }),
    ),

    el(
      'div',
      { class: 'settings__group settings__group--danger' },
      el('h2', { class: 'screen__subheading', text: 'Stored data' }),
      el('p', {
        class: 'settings__note',
        text: 'AD Racers stores your settings and best times in this browser only. Nothing is sent anywhere.',
      }),
      button('Clear settings and best times', actions.onClearData, { class: 'btn--danger' }),
    ),

    el('div', { class: 'screen__actions' }, button('Back', actions.onBack, { primary: true })),
  );
}
