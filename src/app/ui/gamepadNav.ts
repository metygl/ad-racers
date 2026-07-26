/**
 * Gamepad navigation for the menus.
 *
 * A game that invites a player to plug in a controller has to be operable with
 * one from first launch to final standings. Before this, the pad could steer
 * and open the pause menu and nothing else: on the title screen the D-pad and
 * the bottom face button did nothing at all, and in the pause dialog they could
 * not move focus off Resume or activate it. On a controller-only device the
 * product was unusable.
 *
 * The layer is deliberately thin. It does not build a parallel focus model —
 * it moves the browser's own focus between the elements the DOM already
 * exposes, so keyboard, pointer, assistive technology and gamepad all end up in
 * exactly the same state. Anything a keyboard user can reach, a pad reaches the
 * same way and with the same visible focus ring.
 */

/** Standard Gamepad button indices this layer reads. */
const BUTTON = {
  confirm: 0,
  back: 1,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/** Seconds before a held direction starts repeating, and the repeat period. */
const REPEAT_DELAY = 0.42;
const REPEAT_INTERVAL = 0.13;
/** Stick deflection that counts as a direction. */
const STICK_THRESHOLD = 0.55;

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export interface GamepadNavOptions {
  /** The container whose focusable elements are navigable. */
  root: HTMLElement;
  /** Called for the back/cancel button. */
  onBack: () => void;
}

function focusable(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]):not([type="radio"]), select:not([disabled]), ' +
    'textarea:not([disabled]), input[type="radio"]:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
  );
}

/** Radios in the same named group, in DOM order. */
function radioGroup(input: HTMLInputElement): HTMLInputElement[] {
  const root = input.form ?? input.ownerDocument;
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(input.name)}"]`)];
}

export class GamepadNavigator {
  private held = new Map<NavDirection | 'confirm' | 'back', number>();
  private previous = new Set<number>();

  constructor(private readonly options: GamepadNavOptions) {}

  /**
   * Polls the pad and applies one frame of navigation.
   * Returns true if it consumed anything, so the caller can suppress duplicates.
   */
  update(pad: Gamepad | null, elapsed: number): boolean {
    if (!pad) {
      this.held.clear();
      this.previous.clear();
      return false;
    }

    const pressed = (index: number): boolean =>
      (pad.buttons[index]?.pressed ?? false) || (pad.buttons[index]?.value ?? 0) > 0.4;

    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;

    const directions: Record<NavDirection, boolean> = {
      up: pressed(BUTTON.dpadUp) || axisY < -STICK_THRESHOLD,
      down: pressed(BUTTON.dpadDown) || axisY > STICK_THRESHOLD,
      left: pressed(BUTTON.dpadLeft) || axisX < -STICK_THRESHOLD,
      right: pressed(BUTTON.dpadRight) || axisX > STICK_THRESHOLD,
    };

    let acted = false;
    for (const [direction, active] of Object.entries(directions) as [NavDirection, boolean][]) {
      if (!active) {
        this.held.delete(direction);
        continue;
      }
      const elapsedHeld = this.held.get(direction);
      if (elapsedHeld === undefined) {
        // Edge: act immediately, then wait out the repeat delay.
        this.held.set(direction, 0);
        this.move(direction);
        acted = true;
      } else {
        const next = elapsedHeld + elapsed;
        this.held.set(direction, next);
        if (next >= REPEAT_DELAY) {
          this.held.set(direction, REPEAT_DELAY - REPEAT_INTERVAL);
          this.move(direction);
          acted = true;
        }
      }
    }

    // Confirm and back are edge-triggered only; holding them must not repeat.
    if (pressed(BUTTON.confirm) && !this.previous.has(BUTTON.confirm)) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.click();
      acted = true;
    }
    if (pressed(BUTTON.back) && !this.previous.has(BUTTON.back)) {
      this.options.onBack();
      acted = true;
    }

    this.previous = new Set([BUTTON.confirm, BUTTON.back].filter(pressed));
    return acted;
  }

  private move(direction: NavDirection): void {
    const items = focusable(this.options.root);
    if (items.length === 0) return;

    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;

    /*
     * Inside a radio group, left/right change the *selection*, which is what a
     * radio group does for arrow keys — and it dispatches a real `change`
     * event, so the value commits through the same path a pointer uses. Up and
     * down leave the group entirely, so a pad can always get out of one.
     */
    if (active instanceof HTMLInputElement && active.type === 'radio' && (direction === 'left' || direction === 'right')) {
      const group = radioGroup(active).filter((radio) => !radio.disabled);
      const at = group.indexOf(active);
      if (at >= 0 && group.length > 1) {
        const step = direction === 'right' ? 1 : -1;
        const next = group[(at + step + group.length) % group.length];
        if (next) {
          next.checked = true;
          next.focus();
          next.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }

    const step = direction === 'down' || direction === 'right' ? 1 : -1;
    const start = index < 0 ? (step > 0 ? -1 : items.length) : index;
    let target = items[(start + step + items.length) % items.length];

    /*
     * Skip past the rest of a radio group when moving vertically, so up and
     * down step between *sections* rather than crawling through six crew cards
     * one at a time. Selecting within a group is left/right's job.
     */
    if (active instanceof HTMLInputElement && active.type === 'radio' && (direction === 'up' || direction === 'down')) {
      const names = new Set(radioGroup(active).map((radio) => radio));
      let cursor = (start + step + items.length) % items.length;
      for (let guard = 0; guard < items.length; guard++) {
        const candidate = items[cursor];
        if (!candidate || !(candidate instanceof HTMLInputElement) || !names.has(candidate)) break;
        cursor = (cursor + step + items.length) % items.length;
      }
      target = items[cursor];
    }

    target?.focus();
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
