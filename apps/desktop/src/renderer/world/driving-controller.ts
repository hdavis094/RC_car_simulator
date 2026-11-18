export interface DriveCommandInput {
  readonly throttle: number;
  readonly steer: number;
}

/** 50 Hz manual driving interval (20 ms). */
export const DRIVE_COMMAND_HZ = 50;
export const DRIVE_INTERVAL_MS = 1000 / DRIVE_COMMAND_HZ;

const GAMEPAD_DEADZONE = 0.08;

const clampUnit = (v: number): number => Math.min(1, Math.max(-1, v));

const applyDeadzone = (v: number, deadzone = GAMEPAD_DEADZONE): number => {
  if (!Number.isFinite(v) || Math.abs(v) < deadzone) return 0;
  return clampUnit(v);
};

export function normalizeDriveKey(key: string): 'up' | 'down' | 'left' | 'right' | null {
  switch (key) {
    case 'w':
    case 'W':
    case 'ArrowUp':
      return 'up';
    case 's':
    case 'S':
    case 'ArrowDown':
      return 'down';
    case 'a':
    case 'A':
    case 'ArrowLeft':
      return 'left';
    case 'd':
    case 'D':
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

export function isModifierKey(key: string): boolean {
  return key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'OS' || key === 'Super';
}

export function isEstopKey(event: { readonly key: string; readonly code?: string }): boolean {
  return event.key === ' ' || event.code === 'Space';
}

const INTERACTIVE_TAGS = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'A',
  'SUMMARY',
  'DETAILS',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'combobox',
  'listbox',
  'menuitem',
  'option',
  'textbox',
  'link',
]);

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Returns true when `target` (or `document.activeElement` when `target` is `window`/`document`)
 * is an interactive UI control (such as a focused `<button>`, `<input>`, `<select>`, `<textarea>`,
 * or ARIA widget) where `Space` activates the control rather than triggering a global E-stop.
 * Returns false when the 3D canvas, ground overlay, or document body has focus.
 */
export function isInteractiveControlTarget(target: EventTarget | null): boolean {
  if (isEditableEventTarget(target)) return true;

  const checkElement = (node: EventTarget | null): boolean => {
    if (!node || typeof node !== 'object' || !('tagName' in node)) return false;
    const el = node as HTMLElement;
    const tag = el.tagName?.toUpperCase();
    if (!tag || tag === 'BODY' || tag === 'HTML' || tag === 'CANVAS') return false;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute?.('role')?.toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (typeof el.closest === 'function') {
      const ancestor = el.closest(
        'button, input, textarea, select, a[href], summary, [contenteditable="true"], [role="button"], [role="tab"], [role="slider"], [role="checkbox"], [role="switch"], [role="combobox"], [role="menuitem"]',
      );
      if (ancestor) return true;
    }
    return false;
  };

  if (checkElement(target)) return true;
  if (
    (target === null ||
      (typeof window !== 'undefined' && target === window) ||
      (typeof document !== 'undefined' &&
        (target === document ||
          target === document.body ||
          target === document.documentElement))) &&
    typeof document !== 'undefined' &&
    document.activeElement
  ) {
    return checkElement(document.activeElement);
  }
  return false;
}

/**
 * Computes `{ throttle, steer }` from the currently held keyboard driving keys.
 * Sign conventions per `@rcsim/control-protocol` SPEC.md:
 * - `throttle`: +1 full forward (`W`/`ArrowUp`), -1 full reverse (`S`/`ArrowDown`)
 * - `steer`: -1 full left (`A`/`ArrowLeft`), +1 full right (`D`/`ArrowRight`)
 */
export function computeDriveFromKeys(pressedKeys: ReadonlySet<string>): DriveCommandInput {
  let forward = 0;
  let backward = 0;
  let left = 0;
  let right = 0;

  for (const key of pressedKeys) {
    const dir = normalizeDriveKey(key);
    if (dir === 'up') forward = 1;
    else if (dir === 'down') backward = 1;
    else if (dir === 'left') left = 1;
    else if (dir === 'right') right = 1;
  }

  return {
    throttle: forward - backward,
    steer: right - left,
  };
}

/**
 * Reads connected gamepads via the browser Gamepad API (`navigator.getGamepads()`).
 * Returns `{ throttle, steer }` when an active gamepad provides non-zero input, or `null`.
 */
export function computeDriveFromGamepad(
  getGamepads: (() => readonly (Gamepad | null)[]) | undefined = typeof navigator !== 'undefined' &&
  typeof navigator.getGamepads === 'function'
    ? () => navigator.getGamepads()
    : undefined,
): DriveCommandInput | null {
  if (!getGamepads) return null;
  let pads: readonly (Gamepad | null)[];
  try {
    pads = getGamepads() ?? [];
  } catch {
    return null;
  }

  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    const rawSteer = applyDeadzone(pad.axes[0] ?? 0);
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const triggerThrottle = applyDeadzone(rt - lt);
    const stickThrottle = applyDeadzone(-(pad.axes[1] ?? 0));
    const throttle = triggerThrottle !== 0 ? triggerThrottle : stickThrottle;

    if (throttle !== 0 || rawSteer !== 0) {
      return {
        throttle: Math.round(throttle * 1000) / 1000,
        steer: Math.round(rawSteer * 1000) / 1000,
      };
    }
  }
  return null;
}

/** Combines keyboard and gamepad drive inputs (keyboard takes precedence when held). */
export function sampleManualDriveInput(
  pressedKeys: ReadonlySet<string>,
  getGamepads?: () => readonly (Gamepad | null)[],
): { readonly command: DriveCommandInput; readonly active: boolean } {
  const keyDrive = computeDriveFromKeys(pressedKeys);
  if (keyDrive.throttle !== 0 || keyDrive.steer !== 0) {
    return { command: keyDrive, active: true };
  }
  const padDrive = computeDriveFromGamepad(getGamepads);
  if (padDrive && (padDrive.throttle !== 0 || padDrive.steer !== 0)) {
    return { command: padDrive, active: true };
  }
  return { command: { throttle: 0, steer: 0 }, active: false };
}
