import { clamp } from '../../core/math';
import type { ControlInput } from '../sim/state';
import { emptyInput } from '../sim/state';
import { DEFAULT_KEY_BINDINGS, GAMEPAD_BUTTONS } from './bindings';
import type { ActionId, KeyBindings } from './bindings';

/**
 * Keyboard, gamepad and touch, folded into one `ControlInput`.
 *
 * Four rules this enforces:
 *  - Nothing depends on hover or on a pointer being present.
 *  - Every device produces the same `ControlInput`, so the simulation cannot
 *    tell them apart and no device gets an advantage.
 *  - Keys held when the window loses focus are released, so alt-tabbing away
 *    mid-corner does not leave the throttle stuck open.
 *  - A control that is already down when driving input is re-enabled is not a
 *    press. See `setEnabled`.
 */

export type InputSource = 'keyboard' | 'gamepad' | 'touch';

export interface TouchState {
  steer: number;
  accelerate: boolean;
  brake: boolean;
  drift: boolean;
  hop: boolean;
  boost: boolean;
  respawn: boolean;
  strike: -1 | 0 | 1;
}

const EMPTY_TOUCH: TouchState = {
  steer: 0,
  accelerate: false,
  brake: false,
  drift: false,
  hop: false,
  boost: false,
  respawn: false,
  strike: 0,
};

export class InputManager {
  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private bindings: KeyBindings;
  private gamepadIndex: number | null = null;
  private previousButtons: boolean[] = [];
  private touch: TouchState = { ...EMPTY_TOUCH };
  /** Smoothed analogue steering, so keyboard input is not a square wave. */
  private steerAxis = 0;
  private lastSource: InputSource = 'keyboard';
  private captureCallback: ((code: string) => void) | null = null;
  private enabled = true;
  /**
   * Which strike sides were already down at the previous poll.
   *
   * The strike is the one driving action that is a *request* rather than a
   * state: the simulation answers a held control with a fresh refusal on every
   * fixed step, so a 100 ms tap on a phone produced twelve identical
   * `Already swinging` notices and twelve refusal sounds. Edge-triggering it
   * here rather than debouncing it in the HUD is what makes one press one
   * request everywhere downstream - the event stream, the audio and the
   * simulation all see the same single thing.
   */
  private strikeDown = { left: false, right: false };
  /**
   * A strike side pressed and released between two polls.
   *
   * Only touch can do this - a pointer down/up pair inside one frame - and
   * dropping it would make a quick tap silently do nothing.
   */
  private touchStrikePulse: -1 | 0 | 1 = 0;
  /**
   * Gamepad buttons that were already held when driving input was re-enabled.
   *
   * The pad's bottom face button both confirms a menu and hops, so resuming
   * from the pause dialog with it used to hand the still-held button straight
   * to the simulation as a fresh hop. Suppressed until physically released.
   */
  private readonly suppressedButtons = new Set<number>();

  /** Fired for edge-triggered actions the UI cares about. */
  onAction: ((action: ActionId) => void) | null = null;
  /** Fired the first time a gamepad is seen, so the UI can say so. */
  onGamepadConnected: (() => void) | null = null;
  onSourceChanged: ((source: InputSource) => void) | null = null;

  constructor(bindings: KeyBindings = DEFAULT_KEY_BINDINGS) {
    this.bindings = { ...bindings };
  }

  attach(target: Window = window): () => void {
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('keyup', this.handleKeyUp);
    target.addEventListener('blur', this.handleBlur);
    target.addEventListener('gamepadconnected', this.handleGamepad);
    return () => {
      target.removeEventListener('keydown', this.handleKeyDown);
      target.removeEventListener('keyup', this.handleKeyUp);
      target.removeEventListener('blur', this.handleBlur);
      target.removeEventListener('gamepadconnected', this.handleGamepad);
    };
  }

  setBindings(bindings: KeyBindings): void {
    this.bindings = { ...bindings };
  }

  getBindings(): KeyBindings {
    return { ...this.bindings };
  }

  /**
   * Suspends driving input; menu navigation is unaffected.
   *
   * Re-enabling is the interesting half. The action that dismissed the menu was
   * made with a physical control that is very often *still down* - the pad's
   * bottom face button confirms and hops, Space activates a button and hops -
   * and handing that to the simulation turns "resume" into "resume and hop".
   * Every source is therefore re-armed from release rather than from state:
   * keys pressed while suspended are never recorded at all, and pad buttons
   * already down are suppressed until they come up.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.held.clear();
    this.pressedThisFrame.clear();
    this.steerAxis = 0;
    this.strikeDown = { left: false, right: false };
    this.touchStrikePulse = 0;
    this.suppressedButtons.clear();

    if (!enabled) {
      this.touch = { ...EMPTY_TOUCH };
      this.previousButtons = [];
      return;
    }

    const pad = this.readGamepad();
    if (!pad) return;
    pad.buttons.forEach((button, index) => {
      if (button.pressed || button.value > 0.4) this.suppressedButtons.add(index);
    });
    this.previousButtons = pad.buttons.map((b) => b.pressed || b.value > 0.4);
  }

  get source(): InputSource {
    return this.lastSource;
  }

  /**
   * Grabs the next key press instead of treating it as gameplay input, for the
   * rebinding UI. Escape cancels.
   */
  captureNextKey(callback: (code: string) => void): void {
    this.captureCallback = callback;
  }

  cancelCapture(): void {
    this.captureCallback = null;
  }

  get isCapturing(): boolean {
    return this.captureCallback !== null;
  }

  setTouchState(state: Partial<TouchState>): void {
    this.touch = { ...this.touch, ...state };
    // A tap shorter than a frame still has to count as a press, so a strike is
    // latched here and consumed by the next poll rather than sampled from a
    // state that may already have gone back to zero.
    if (state.strike !== undefined && state.strike !== 0) this.touchStrikePulse = state.strike;
    this.setSource('touch');
  }

  private setSource(source: InputSource): void {
    if (this.lastSource === source) return;
    this.lastSource = source;
    this.onSourceChanged?.(source);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.captureCallback) {
      event.preventDefault();
      const callback = this.captureCallback;
      this.captureCallback = null;
      callback(event.code);
      return;
    }

    // Never swallow the keys assistive technology and browsers rely on.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.repeat) return;

    this.setSource('keyboard');

    const action = this.actionFor(event.code);

    /*
     * Outside a race the game owns nothing except Pause.
     *
     * This listener is on `window`, so it saw every key press on every menu —
     * and because Space and the arrows are bound to driving actions it called
     * `preventDefault` on them there too. That cancelled the *native* arrow-key
     * behaviour of a radio group, so a keyboard player could move through the
     * course, crew and difficulty cards, watch the selection appear to change,
     * and then start a race with none of their choices applied. Silently
     * starting a different race than the one someone selected is the sort of
     * defect that makes every accessibility claim nominal.
     *
     * A key pressed here is also not recorded as *held*. Space activates the
     * focused button and is the hop, so the press that dismissed the pause
     * dialog used to still be sitting in `held` when driving resumed, and the
     * skiff hopped on the spot. Nothing pressed while the game was not
     * listening may become a driving input later; the player has to press it
     * again, which is exactly what suspending input means.
     */
    if (!this.enabled) {
      if (action === 'pause') this.onAction?.(action);
      return;
    }

    this.held.add(event.code);
    this.pressedThisFrame.add(event.code);
    if (!action) return;

    // Space and the arrows scroll the page; the game owns them while driving.
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    this.onAction?.(action);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private handleBlur = (): void => {
    this.held.clear();
    this.steerAxis = 0;
  };

  private handleGamepad = (event: Event): void => {
    const gamepad = (event as GamepadEvent).gamepad;
    this.gamepadIndex = gamepad.index;
    this.onGamepadConnected?.();
  };

  private actionFor(code: string): ActionId | null {
    for (const [action, codes] of Object.entries(this.bindings) as [ActionId, string[]][]) {
      if (codes.includes(code)) return action;
    }
    return null;
  }

  private isHeld(action: ActionId): boolean {
    return (this.bindings[action] ?? []).some((code) => this.held.has(code));
  }

  /** Reads the active gamepad, if any. Also picks one up on first poll. */
  private readGamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null) {
      const pad = pads[this.gamepadIndex];
      if (pad?.connected) return pad;
      this.gamepadIndex = null;
    }
    for (const pad of pads) {
      if (pad?.connected) {
        this.gamepadIndex = pad.index;
        return pad;
      }
    }
    return null;
  }

  /**
   * Produces this frame's control input.
   * `elapsed` shapes the keyboard steering ramp so it is frame-rate independent.
   */
  poll(elapsed: number): ControlInput {
    const input = emptyInput();
    if (!this.enabled) {
      this.steerAxis = 0;
      return input;
    }

    let steerTarget = 0;
    let throttle = 0;
    let brake = false;
    let drift = false;
    let hop = false;
    let boost = false;
    let respawn = false;
    let analogueSteer: number | null = null;
    // Gathered across every source, then edge-detected once at the end.
    let strikeLeftDown = false;
    let strikeRightDown = false;

    // --- keyboard -----------------------------------------------------------
    if (this.isHeld('steerLeft')) steerTarget -= 1;
    if (this.isHeld('steerRight')) steerTarget += 1;
    if (this.isHeld('accelerate')) throttle = 1;
    if (this.isHeld('brake')) brake = true;
    if (this.isHeld('drift')) drift = true;
    if (this.isHeld('hop')) hop = true;
    if (this.isHeld('boost')) boost = true;
    // `pressedThisFrame` as well as `held`, so a tap that starts and ends
    // between two polls is still one press rather than none.
    if (this.isHeld('strikeLeft') || this.wasPressed('strikeLeft')) strikeLeftDown = true;
    if (this.isHeld('strikeRight') || this.wasPressed('strikeRight')) strikeRightDown = true;
    if (this.isHeld('respawn')) respawn = true;

    // --- gamepad ------------------------------------------------------------
    const pad = this.readGamepad();
    if (pad) {
      const axis = pad.axes[0] ?? 0;
      // Deadzone, then rescale so the usable range still reaches full lock.
      const deadzone = 0.16;
      if (Math.abs(axis) > deadzone) {
        analogueSteer = Math.sign(axis) * ((Math.abs(axis) - deadzone) / (1 - deadzone));
        this.setSource('gamepad');
      }

      const buttons = pad.buttons;
      const rawDown = buttons.map((b) => b.pressed || b.value > 0.4);
      // A button suppressed at re-enable stays suppressed until it comes up.
      for (const index of [...this.suppressedButtons]) {
        if (!rawDown[index]) this.suppressedButtons.delete(index);
      }
      const downNow = rawDown.map((value, index) => value && !this.suppressedButtons.has(index));
      const pressed = (index: number): boolean => downNow[index] ?? false;

      for (const [action, indices] of Object.entries(GAMEPAD_BUTTONS) as [ActionId, number[]][]) {
        const down = indices.some(pressed);
        const wasDown = indices.some((i) => this.previousButtons[i] ?? false);
        if (down && !wasDown) {
          this.setSource('gamepad');
          this.onAction?.(action);
        }
        if (!down) continue;
        switch (action) {
          case 'accelerate':
            // Analogue triggers give proportional throttle.
            throttle = Math.max(throttle, buttons[7]?.value || 1);
            break;
          case 'brake':
            brake = true;
            break;
          case 'drift':
            drift = true;
            break;
          case 'hop':
            hop = true;
            break;
          case 'boost':
            boost = true;
            break;
          case 'strikeLeft':
            strikeLeftDown = true;
            break;
          case 'strikeRight':
            strikeRightDown = true;
            break;
          case 'respawn':
            respawn = true;
            break;
          default:
            break;
        }
      }
      this.previousButtons = downNow;
      // The D-pad steers too, for players who prefer it.
      if (pressed(14)) steerTarget -= 1;
      if (pressed(15)) steerTarget += 1;
    }

    // --- touch --------------------------------------------------------------
    let automaticThrottle = false;
    if (this.touch.accelerate) {
      throttle = 1;
      automaticThrottle = true;
    }
    if (this.touch.brake) brake = true;
    if (this.touch.drift) drift = true;
    if (this.touch.hop) hop = true;
    if (this.touch.boost) boost = true;
    if (this.touch.respawn) respawn = true;
    const touchStrike = this.touch.strike !== 0 ? this.touch.strike : this.touchStrikePulse;
    if (touchStrike === -1) strikeLeftDown = true;
    if (touchStrike === 1) strikeRightDown = true;
    if (this.touch.steer !== 0) analogueSteer = this.touch.steer;

    // Analogue sources bypass the ramp entirely; digital ones get a smooth
    // ramp so keyboard steering is controllable rather than binary.
    if (analogueSteer !== null) {
      this.steerAxis = clamp(analogueSteer, -1, 1);
    } else {
      const rate = steerTarget === 0 ? 7.5 : 4.6;
      this.steerAxis += (steerTarget - this.steerAxis) * (1 - Math.exp(-rate * elapsed));
      if (Math.abs(this.steerAxis) < 0.005) this.steerAxis = 0;
    }

    /*
     * One press, one request.
     *
     * The rising edge is taken here rather than in the simulation because the
     * simulation is right to answer every step it is asked: what was wrong was
     * asking it three hundred times for one tap. Both sides are latched
     * independently, so crossing from one shoulder to the other without
     * releasing still reads as a second, deliberate swing.
     */
    const strike: -1 | 0 | 1 =
      strikeRightDown && !this.strikeDown.right ? 1 : strikeLeftDown && !this.strikeDown.left ? -1 : 0;
    this.strikeDown = { left: strikeLeftDown, right: strikeRightDown };
    this.touchStrikePulse = 0;

    input.steer = clamp(this.steerAxis, -1, 1);
    input.throttle = throttle;
    input.brake = brake;
    input.drift = drift;
    input.hop = hop;
    input.boost = boost;
    input.strike = strike;
    input.respawn = respawn;
    input.automaticThrottle = automaticThrottle;

    this.pressedThisFrame.clear();
    return input;
  }

  /** True if the key bound to `action` went down since the last poll. */
  private wasPressed(action: ActionId): boolean {
    return (this.bindings[action] ?? []).some((code) => this.pressedThisFrame.has(code));
  }

  /** True if any gamepad is currently connected. */
  hasGamepad(): boolean {
    return this.readGamepad() !== null;
  }

  /**
   * The active pad, for the menu navigation layer.
   *
   * Exposed rather than duplicated: the navigator must read the same device the
   * driving path reads, or "the pad works in a race but not in a menu" becomes
   * two separate bugs instead of one behaviour.
   */
  activeGamepad(): Gamepad | null {
    return this.readGamepad();
  }
}
