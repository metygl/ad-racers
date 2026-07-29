/**
 * Small typed DOM helpers.
 *
 * The UI is hand-written DOM rather than a framework: the whole interface is a
 * handful of screens, and a framework would be a larger download than the game
 * logic. What matters is that these helpers make the *accessible* thing the
 * easy thing — real buttons, real labels, real focus order — so nothing in the
 * screens has to remember to do it.
 */

type Attributes = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; primary?: boolean; describedBy?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const node = el('button', {
    type: 'button',
    class: ['btn', options.primary ? 'btn--primary' : '', options.class ?? ''].filter(Boolean).join(' '),
    'aria-describedby': options.describedBy,
    disabled: options.disabled,
  });
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

/** A labelled range input with a live text readout. */
export function slider(
  label: string,
  value: number,
  onChange: (value: number) => void,
  options: { min?: number; max?: number; step?: number; format?: (value: number) => string } = {},
): HTMLElement {
  const id = `slider-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const format = options.format ?? ((v: number) => `${Math.round(v * 100)}%`);
  const output = el('output', { class: 'field__value', for: id, text: format(value) });
  const input = el('input', {
    type: 'range',
    id,
    min: options.min ?? 0,
    max: options.max ?? 1,
    step: options.step ?? 0.05,
    value,
    class: 'field__range',
  });
  input.addEventListener('input', () => {
    const next = Number(input.value);
    output.textContent = format(next);
    onChange(next);
  });
  return el('div', { class: 'field' }, el('label', { class: 'field__label', for: id, text: label }), input, output);
}

/** A labelled on/off switch, implemented as a real checkbox. */
export function toggle(label: string, value: boolean, onChange: (value: boolean) => void, hint?: string): HTMLElement {
  const id = `toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const input = el('input', { type: 'checkbox', id, class: 'field__checkbox', 'aria-describedby': hintId });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return el(
    'div',
    { class: 'field field--toggle' },
    el('label', { class: 'field__label', for: id, text: label }),
    input,
    hint ? el('p', { class: 'field__hint', id: hintId, text: hint }) : null,
  );
}

/**
 * A segmented choice. Implemented as a radiogroup so arrow keys move between
 * options the way a keyboard user expects, rather than as a row of buttons that
 * all take a tab stop.
 */
export function segmented<T extends string>(
  label: string,
  options: { value: T; label: string; hint?: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement {
  const name = `seg-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const group = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const option of options) {
    const id = `${name}-${option.value}`;
    const input = el('input', { type: 'radio', name, id, class: 'segmented__input', value: option.value });
    input.checked = option.value === current;
    input.addEventListener('change', () => onChange(option.value));
    const labelEl = el('label', { class: 'segmented__option', for: id }, option.label);
    if (option.hint) labelEl.title = option.hint;
    group.append(input, labelEl);
  }
  return el('div', { class: 'field field--segmented' }, el('span', { class: 'field__label', text: label }), group);
}

/** Removes every child of a node. */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Keeps Tab inside a container and restores focus when it closes.
 *
 * Used by the pause overlay and every dialog-like screen: a keyboard user
 * tabbing off the end of a pause menu and landing on the page behind it is a
 * dead end, because the page behind it is a canvas.
 */
export function trapFocus(container: HTMLElement, autoFocus = true): () => void {
  const previous = document.activeElement as HTMLElement | null;

  const focusable = (): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => node.offsetParent !== null || node === document.activeElement);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
    if (event.shiftKey && (document.activeElement === first || document.activeElement === preferred)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeyDown);
  // Focus the first control on open, so a keyboard user is not left hunting —
  // but only for a screen the player *asked* for. Doing it on first load drops
  // focus into the middle of the page, which puts the skip link behind a
  // Shift+Tab and breaks the reading order before anyone has pressed a key.
  /*
   * Focus without scrolling.
   *
   * On a phone the results screen is taller than the viewport and its first
   * control — Rematch — sits below the fold, so focusing it scrolled the page
   * 259 px and opened the screen with the *outcome* off the top. A review found
   * the result it had just earned was not visible until it scrolled back up.
   * The focus is still correct for a keyboard user; it just no longer decides
   * what the player sees first.
   */
  /*
   * And onto the *top* of a screen taller than the viewport.
   *
   * `preventScroll` stopped the page jumping, which left the other half of the
   * problem: on a 844x390 landscape phone the Controls screen is 810 px of
   * content and its only control - Continue - starts at y = 713, so first-run
   * focus landed on a button nothing on screen showed and there was no visible
   * focus ring anywhere. A screen that opts in with `data-autofocus` names what
   * should receive focus instead, which is its heading, and the sticky actions
   * footer keeps Continue reachable without hunting for it.
   */
  if (autoFocus) {
    queueMicrotask(() => {
      const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? focusable()[0])?.focus({ preventScroll: true });
    });
  }

  return () => {
    container.removeEventListener('keydown', onKeyDown);
    previous?.focus?.();
  };
}

/** Announces a message to screen readers without moving focus. */
export function announce(region: HTMLElement, message: string): void {
  // Clearing first guarantees the announcement even if the text is unchanged.
  region.textContent = '';
  queueMicrotask(() => {
    region.textContent = message;
  });
}
