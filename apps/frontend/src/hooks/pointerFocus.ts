// WaveStack treats the page itself as the keyboard-shortcut surface. Interactive
// controls may be activated with the pointer, but non-editor controls must never
// remain document.activeElement and steal Space/Z/X/arrow playback shortcuts.
// Real text-entry controls are the only persistent focus owners; native selects
// keep focus only while their picker is being used.
let lastInputWasPointer = false;
let lastPointerX = 0;
let lastPointerY = 0;
const activated = new Set<HTMLElement>();

const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "number"
]);

const actionControlSelector = [
  'button', 'a[href]', 'summary',
  '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="option"]', '[role="switch"]', '[role="menuitem"]',
  '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const songSurfaceSelector = [
  '.song-list-row', '.song-tile', '.profile-song-list__item',
  '.recent-list__item', '.ranking-list__item', '.queue-drawer__item'
].join(', ');

export function isPointerInput(): boolean {
  return lastInputWasPointer;
}

function textEditor(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(element.type || "text");
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function persistentFocusAllowed(element: Element): boolean {
  return textEditor(element) || element instanceof HTMLSelectElement;
}

export function releaseNonEditorFocus(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (active === document.body || active === document.documentElement) return;
  if (persistentFocusAllowed(active)) return;
  active.blur();
}

export function releasePageFocus(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (active === document.body || active === document.documentElement) return;
  active.blur();
}

function clearActivated() {
  activated.forEach((element) => element.removeAttribute('data-ws-pointer-activated'));
  activated.clear();
}

function markActivated(element: HTMLElement) {
  element.setAttribute('data-ws-pointer-activated', '');
  activated.add(element);
}

function releaseAcrossBrowserPhases() {
  releaseNonEditorFocus();
  queueMicrotask(releaseNonEditorFocus);
  window.requestAnimationFrame(() => {
    releaseNonEditorFocus();
    window.setTimeout(releaseNonEditorFocus, 0);
  });
}

export function installPointerFocusPolicy(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    lastInputWasPointer = true;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    const target = event.target;
    if (!(target instanceof Element)) return;

    // If an editor/select was active, any pointer press outside that control
    // ends the editing session first. Preventing focus on the clicked nav/button
    // must never leave an old search field silently owning Space/arrows.
    const active = document.activeElement;
    if (active instanceof HTMLElement && persistentFocusAllowed(active) &&
        active !== target && !active.contains(target)) {
      active.blur();
    }

    // Preserve normal text selection/editing and native select behavior.
    if (persistentFocusAllowed(target)) return;

    // A new pointer action replaces the old clicked/hover-suppression marker.
    clearActivated();
    const control = target.closest(actionControlSelector);
    if (!(control instanceof HTMLElement) || persistentFocusAllowed(control)) return;

    markActivated(control);
    const surface = control.closest(songSurfaceSelector);
    if (surface instanceof HTMLElement) markActivated(surface);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !lastInputWasPointer) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Text fields, selects, ranges, checkboxes, and other native inputs keep
    // their pointer interaction. The focus guard releases non-text inputs after
    // activation, while text editors remain usable for typing.
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;

    const control = target.closest(actionControlSelector);
    if (control instanceof HTMLElement && !persistentFocusAllowed(control)) {
      // Prevent native mouse-down focus before React/browser navigation has a
      // chance to park focus on a button or link. The click itself still fires.
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType !== 'mouse' || !activated.size) return;
    if (Math.abs(event.clientX - lastPointerX) + Math.abs(event.clientY - lastPointerY) > 1) {
      clearActivated();
    }
  };

  const onPointerUp = () => {
    releaseAcrossBrowserPhases();
  };

  const onPointerCancel = () => {
    releaseAcrossBrowserPhases();
  };

  const onClick = () => {
    releaseAcrossBrowserPhases();
  };

  const onFocus = (event: FocusEvent) => {
    const focused = event.target;
    if (!(focused instanceof HTMLElement)) return;
    if (persistentFocusAllowed(focused)) return;

    // This runs in capture phase and blurs synchronously. It catches direct
    // .focus(), React/browser focus restoration, Tab focus, route-link focus,
    // modal opener restoration, and delayed rAF/setTimeout focus attempts.
    focused.blur();
  };

  const onFocusIn = (event: FocusEvent) => {
    const focused = event.target;
    if (!(focused instanceof HTMLElement) || persistentFocusAllowed(focused)) return;
    focused.blur();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      lastInputWasPointer = false;
      }

    // With no editor active, Tab must not create a persistent focus owner that
    // can subsequently consume Space/arrows. Text editors may still Tab away;
    // any non-editor destination is immediately released by onFocus above.
    if (event.key === 'Tab' && !(document.activeElement instanceof Element && persistentFocusAllowed(document.activeElement))) {
      event.preventDefault();
      releaseNonEditorFocus();
    }
  };

  const onChange = (event: Event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement) {
      queueMicrotask(() => select.blur());
    }
  };

  const onWindowFocus = () => {
    releasePageFocus();
    releaseAcrossBrowserPhases();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      releasePageFocus();
      releaseAcrossBrowserPhases();
    }
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('focus', onFocus, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pageshow', onWindowFocus);

  releaseAcrossBrowserPhases();

  return () => {
    clearActivated();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerCancel, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('focus', onFocus, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pageshow', onWindowFocus);
  };
}
