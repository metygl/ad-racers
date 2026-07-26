import { clamp } from '../../core/math';
import type { ControlInput } from '../sim/state';
import { emptyInput } from '../sim/state';
import { DEFAULT_KEY_BINDINGS, GAMEPAD_BUTTONS } from './bindings';
import type { ActionId, KeyBindings } from './bindings';

/**
 * Keyboard, gamepad and touch, folded into one `ControlInput`.
 *
 * Three rules this enforces:
 *  - Nothing depends on hover or on a pointer being present.
 *  - Every device produces the same `ControlInput`, so the simulation cannot
 *    tell them apart and no device gets an advantage.
 *  - Keys held when the window loses focus are released, so alt-tabbing away
 *    mid-corner does not leave the throttle stuck open.
 */

export type InputSource = 'keyboard' | 'gamepad' | 'touch';

export interface TouchState {
  steer: number;
  accelerate: boolean;
  brake: boolean;
  drift: boolean;
  hop: boolean;
  boost: boolean;
  strike: -1 | 0 | 1;
}

const EMPTY_TOUCH: TouchState = {
  steer: 0,
  accelerate: false,
  brake: false,
  drift: false,
  hop: false,
  boost: false,
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

  /** Suspends driving input; menu navigation is unaffected. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.held.clear();
      this.steerAxis = 0;
      this.touch = { ...EMPTY_TOUCH };
    }
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
    this.held.add(event.code);
    this.pressedThisFrame.add(event.code);

    const action = this.actionFor(event.code);
    if (action) {
      // Space and the arrows scroll the page; the game owns them while bound.
      if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
      this.onAction?.(action);
    }
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
    let strike: -1 | 0 | 1 = 0;
    let respawn = false;
    let analogueSteer: number | null = null;

    // --- keyboard -----------------------------------------------------------
    if (this.isHeld('steerLeft')) steerTarget -= 1;
    if (this.isHeld('steerRight')) steerTarget += 1;
    if (this.isHeld('accelerate')) throttle = 1;
    if (this.isHeld('brake')) brake = true;
    if (this.isHeld('drift')) drift = true;
    if (this.isHeld('hop')) hop = true;
    if (this.isHeld('boost')) boost = true;
    if (this.isHeld('strikeLeft')) strike = -1;
    if (this.isHeld('strikeRight')) strike = 1;
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
      const pressed = (index: number): boolean => (buttons[index]?.pressed ?? false) || (buttons[index]?.value ?? 0) > 0.4;

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
            strike = -1;
            break;
          case 'strikeRight':
            strike = 1;
            break;
          case 'respawn':
            respawn = true;
            break;
          default:
            break;
        }
      }
      this.previousButtons = buttons.map((b) => b.pressed || b.value > 0.4);
      // The D-pad steers too, for players who prefer it.
      if (pressed(14)) steerTarget -= 1;
      if (pressed(15)) steerTarget += 1;
    }

    // --- touch --------------------------------------------------------------
    if (this.touch.accelerate) throttle = 1;
    if (this.touch.brake) brake = true;
    if (this.touch.drift) drift = true;
    if (this.touch.hop) hop = true;
    if (this.touch.boost) boost = true;
    if (this.touch.strike !== 0) strike = this.touch.strike;
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

    input.steer = clamp(this.steerAxis, -1, 1);
    input.throttle = throttle;
    input.brake = brake;
    input.drift = drift;
    input.hop = hop;
    input.boost = boost;
    input.strike = strike;
    input.respawn = respawn;

    this.pressedThisFrame.clear();
    return input;
  }

  /** True if any gamepad is currently connected. */
  hasGamepad(): boolean {
    return this.readGamepad() !== null;
  }
}
