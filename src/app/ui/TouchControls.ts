import { clamp } from '../../core/math';
import type { InputManager } from '../../game/input/InputManager';
import { el } from './dom';

/**
 * Touch controls.
 *
 * The scheme is a steering strip on the left and a stack of action pads on the
 * right, with a permanent auto-throttle so a phone player only ever has to
 * think about steering, braking and the two skills. Holding an accelerator pad
 * with the same thumb you steer with is the usual reason touch racing games are
 * unplayable, so the game simply does not ask.
 *
 * Every pad is a real `button`, sized to the 44 px minimum target, positioned
 * inside the safe area, and nothing here depends on hover.
 */

export interface TouchControlsOptions {
  input: InputManager;
  onPause: () => void;
}

export class TouchControls {
  readonly root: HTMLElement;
  private steerTrack: HTMLElement;
  private steerKnob: HTMLElement;
  private pointerId: number | null = null;
  private trackRect: DOMRect | null = null;
  private readonly input: InputManager;
  private visible = false;

  constructor(options: TouchControlsOptions) {
    this.input = options.input;

    this.steerKnob = el('div', { class: 'touch__knob', 'aria-hidden': 'true' });
    this.steerTrack = el(
      'div',
      {
        class: 'touch__steer',
        role: 'slider',
        tabindex: '0',
        'aria-label': 'Steering',
        'aria-valuemin': '-100',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
      },
      this.steerKnob,
      el('span', { class: 'touch__steer-label', text: 'Steer' }),
    );

    this.steerTrack.addEventListener('pointerdown', this.onPointerDown);
    this.steerTrack.addEventListener('pointermove', this.onPointerMove);
    this.steerTrack.addEventListener('pointerup', this.onPointerUp);
    this.steerTrack.addEventListener('pointercancel', this.onPointerUp);
    this.steerTrack.addEventListener('keydown', this.onSteerKey);
    this.steerTrack.addEventListener('keyup', this.onSteerKeyUp);

    const pad = (label: string, className: string, apply: (down: boolean) => void): HTMLElement => {
      const node = el('button', { type: 'button', class: `touch__pad ${className}`, 'aria-label': label }, label);
      const down = (event: PointerEvent): void => {
        event.preventDefault();
        // Capture keeps the pad held when a thumb slides slightly off it, but
        // it is an optimisation, not a requirement: `setPointerCapture` throws
        // for a pointer the browser no longer considers active, and an
        // exception here would leave the control dead for the rest of the race.
        try {
          node.setPointerCapture(event.pointerId);
        } catch {
          /* Capture unavailable; the pad still works, it is just less forgiving. */
        }
        node.classList.add('touch__pad--down');
        apply(true);
      };
      const up = (): void => {
        node.classList.remove('touch__pad--down');
        apply(false);
      };
      node.addEventListener('pointerdown', down);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
      node.addEventListener('pointerleave', up);
      // Keyboard activation still has to do something sensible, since these are
      // real buttons and can be reached with Tab on a hybrid device.
      node.addEventListener('keydown', (event) => {
        if (event.key === ' ' || event.key === 'Enter') apply(true);
      });
      node.addEventListener('keyup', () => apply(false));
      return node;
    };

    this.root = el(
      'div',
      { class: 'touch', 'data-testid': 'touch-controls', hidden: true },
      el('div', { class: 'touch__left' }, this.steerTrack),
      el(
        'div',
        { class: 'touch__right' },
        el(
          'div',
          { class: 'touch__row' },
          pad('Left', 'touch__pad--strike', (down) => this.input.setTouchState({ strike: down ? -1 : 0 })),
          pad('Right', 'touch__pad--strike', (down) => this.input.setTouchState({ strike: down ? 1 : 0 })),
        ),
        el(
          'div',
          { class: 'touch__row' },
          pad('Brake', 'touch__pad--brake', (down) => this.input.setTouchState({ brake: down })),
          pad('Drift', 'touch__pad--drift', (down) => this.input.setTouchState({ drift: down })),
          pad('Surge', 'touch__pad--boost', (down) => this.input.setTouchState({ boost: down })),
        ),
      ),
      el('button', { type: 'button', class: 'touch__pause', 'aria-label': 'Pause' }, 'II'),
    );

    const pause = this.root.querySelector('.touch__pause');
    pause?.addEventListener('click', options.onPause);
  }

  private onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.pointerId = event.pointerId;
    try {
      this.steerTrack.setPointerCapture(event.pointerId);
    } catch {
      /* See the note on the action pads: capture is a nicety, not a
         precondition, and losing it must not disable steering. */
    }
    this.trackRect = this.steerTrack.getBoundingClientRect();
    this.applySteer(event.clientX);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.applySteer(event.clientX);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.setSteer(0);
  };

  private onSteerKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') this.setSteer(-1);
    else if (event.key === 'ArrowRight') this.setSteer(1);
    else return;
    event.preventDefault();
  };

  private onSteerKeyUp = (): void => this.setSteer(0);

  private applySteer(clientX: number): void {
    const rect = this.trackRect ?? this.steerTrack.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    // Full lock at roughly 40% of the strip width from centre, so the usable
    // travel fits inside a thumb's natural arc.
    this.setSteer(clamp((clientX - centre) / (rect.width * 0.4), -1, 1));
  }

  private setSteer(value: number): void {
    this.input.setTouchState({ steer: value });
    this.steerKnob.style.transform = `translateX(${(value * 42).toFixed(1)}%)`;
    this.steerTrack.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }

  /** Shows the pads and turns on the auto-throttle they depend on. */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.input.setTouchState({ accelerate: true });
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.input.setTouchState({
      accelerate: false,
      brake: false,
      drift: false,
      boost: false,
      strike: 0,
      steer: 0,
    });
    this.setSteer(0);
  }
}

/**
 * Whether touch controls should be offered.
 *
 * Requires an actual coarse pointer *and* touch points, rather than a narrow
 * window: a small desktop window is not a phone, and showing thumb pads over a
 * keyboard player's HUD would be worse than showing nothing.
 */
export function shouldUseTouch(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints ?? 0) > 0;
}
