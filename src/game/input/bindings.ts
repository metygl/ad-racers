/**
 * Control bindings.
 *
 * Actions are named, not keyed, so the keyboard map is data the player can
 * change and the gamepad map is a second implementation of the same contract.
 * Nothing in the game asks "is W held" — it asks whether `accelerate` is held.
 */

export type ActionId =
  | 'accelerate'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'drift'
  | 'hop'
  | 'boost'
  | 'strikeLeft'
  | 'strikeRight'
  | 'respawn'
  | 'pause'
  | 'camera';

export interface ActionInfo {
  id: ActionId;
  label: string;
  /** Short description shown on the controls screen. */
  hint: string;
  /** Rebindable actions appear in the settings list. */
  rebindable: boolean;
}

export const ACTIONS: readonly ActionInfo[] = [
  { id: 'accelerate', label: 'Accelerate', hint: 'Open the throttle.', rebindable: true },
  { id: 'brake', label: 'Brake / Reverse', hint: 'Slow down; at a standstill, reverse.', rebindable: true },
  { id: 'steerLeft', label: 'Steer left', hint: '', rebindable: true },
  { id: 'steerRight', label: 'Steer right', hint: '', rebindable: true },
  { id: 'drift', label: 'Drift', hint: 'Hold through a corner to build Surge.', rebindable: true },
  {
    id: 'hop',
    label: 'Hop',
    // Deliberately a separate key from Drift, and never folded into it. See the
    // note on `HOP` in `src/game/config.ts`.
    hint: 'Skip a kerb, take a crest level, or drop straight into a drift.',
    rebindable: true,
  },
  { id: 'boost', label: 'Surge', hint: 'Spend banked Surge for speed.', rebindable: true },
  { id: 'strikeLeft', label: 'Strike left', hint: 'Swing the pod arm at a rival on your left.', rebindable: true },
  { id: 'strikeRight', label: 'Strike right', hint: 'Swing the pod arm at a rival on your right.', rebindable: true },
  { id: 'respawn', label: 'Recover', hint: 'Return to the racing line if you are stuck.', rebindable: true },
  { id: 'camera', label: 'Camera', hint: 'Cycle the chase camera.', rebindable: true },
  { id: 'pause', label: 'Pause', hint: 'Escape always pauses as well.', rebindable: false },
];

export type KeyBindings = Record<ActionId, string[]>;

/**
 * Defaults cover both WASD and the arrow keys, because plenty of players reach
 * for one or the other without thinking and being told "that key does nothing"
 * is a bad first ten seconds.
 */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'KeyJ'],
  hop: ['Space', 'KeyK'],
  boost: ['KeyL', 'ControlLeft'],
  strikeLeft: ['KeyQ', 'Comma'],
  strikeRight: ['KeyE', 'Period'],
  respawn: ['KeyR'],
  camera: ['KeyC'],
  pause: ['Escape', 'KeyP'],
};

/**
 * Gamepad mapping, against the Standard Gamepad layout. Axes are handled
 * separately; these are the buttons.
 */
export const GAMEPAD_BUTTONS: Partial<Record<ActionId, number[]>> = {
  // The right trigger is the throttle and the bottom face button is the hop.
  // The bottom button used to double as a throttle, which is a common
  // convention, but the hop needs a button a thumb can reach without leaving
  // the stick — and a throttle that is also a hop is exactly the overloading
  // this game avoids elsewhere. The left trigger and the right face button
  // both brake, so nothing is left without a pair.
  accelerate: [7],
  brake: [6, 1],
  drift: [2],
  hop: [0],
  boost: [3],
  strikeLeft: [4],
  strikeRight: [5],
  respawn: [10],
  pause: [9],
  camera: [11],
};

/** Human-readable name for a `KeyboardEvent.code`. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  switch (code) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Space':
      return 'Space';
    case 'ShiftLeft':
      return 'L Shift';
    case 'ShiftRight':
      return 'R Shift';
    case 'ControlLeft':
      return 'L Ctrl';
    case 'ControlRight':
      return 'R Ctrl';
    case 'Comma':
      return ',';
    case 'Period':
      return '.';
    case 'Escape':
      return 'Esc';
    default:
      return code;
  }
}

/** Formats an action's bindings for display, e.g. "W or ↑". */
export function bindingLabel(bindings: KeyBindings, action: ActionId): string {
  const codes = bindings[action];
  if (!codes || codes.length === 0) return 'Unbound';
  return codes.map(keyLabel).join(' or ');
}
