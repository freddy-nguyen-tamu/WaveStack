// A pointer click activates an action; it must not become a persistent focus
// selection. Native text editing and keyboard navigation remain untouched.
// In particular, Escape dismissing a pointer-opened dialog must NOT change
// its opening modality to keyboard and resurrect focus on the song row.
let lastInputWasPointer = false;
let pointerPressInProgress = false;
let lastPointerX = 0;
let lastPointerY = 0;
const activated = new Set<HTMLElement>();
let lastPointerActivatedControl: HTMLElement | null = null;
let suppressedPointerRestore: HTMLElement | null = null;
let suppressPointerRestoreUntil = 0;
let suppressAnyPostModalActionFocusUntil = 0;

export function isPointerInput(): boolean {
  return lastInputWasPointer;
}

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

function textEditor(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return ['text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function modalIsOpen(): boolean {
  return Boolean(document.querySelector(
    '.song-modal-backdrop:not(.song-modal-backdrop--released), .queue-backdrop'
  ));
}

function clearActivated() {
  activated.forEach((element) => element.removeAttribute('data-ws-pointer-activated'));
  activated.clear();
}

function markActivated(element: HTMLElement) {
  element.setAttribute('data-ws-pointer-activated', '');
  activated.add(element);
  lastPointerActivatedControl = element;
}

function isSuppressedPointerRestore(element: HTMLElement): boolean {
  if (!suppressedPointerRestore || performance.now() > suppressPointerRestoreUntil) {
    suppressedPointerRestore = null;
    return false;
  }

  return element === suppressedPointerRestore || suppressedPointerRestore.contains(element);
}

function blurSuppressedPointerRestore() {
  if (modalIsOpen()) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || textEditor(active)) return;
  if (isSuppressedPointerRestore(active)) active.blur();
}

function guardPointerModalCloseFocus() {
  if (!lastPointerActivatedControl) return;
  suppressedPointerRestore = lastPointerActivatedControl;
  suppressPointerRestoreUntil = performance.now() + 900;
  suppressAnyPostModalActionFocusUntil = suppressPointerRestoreUntil;

  // Chromium may restore the pointer opener synchronously, in a microtask, on
  // the next animation frame, or after the portal has fully detached. Cover all
  // of those phases without stealing deliberate keyboard focus later.
  queueMicrotask(blurSuppressedPointerRestore);
  window.requestAnimationFrame(() => {
    blurSuppressedPointerRestore();
    window.setTimeout(blurSuppressedPointerRestore, 0);
    window.setTimeout(blurSuppressedPointerRestore, 80);
  });
}

function releasePointerFocusedAction() {
  if (!lastInputWasPointer) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || textEditor(active)) return;
  // The modal's tabindex=-1 focus anchor is not a control and has no visual
  // focus treatment. Leave it alone so Escape/Tab containment stays reliable.
  if (active.matches(actionControlSelector) || active.matches('input, select')) {
    // The popup of a native select needs focus while it is open. Its change
    // handler below releases focus only after the selection has completed.
    if (!(active instanceof HTMLSelectElement)) active.blur();
  }
}

export function installPointerFocusPolicy(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    lastInputWasPointer = true;
    pointerPressInProgress = true;
    const target = event.target;
    if (target instanceof Element && suppressedPointerRestore &&
        (target === suppressedPointerRestore || suppressedPointerRestore.contains(target))) {
      // A deliberate new pointer press on the old opener is allowed to own focus
      // again; only automatic post-modal restoration is suppressed.
      suppressedPointerRestore = null;
      suppressPointerRestoreUntil = 0;
    }
    // Clicking a backdrop at the same pointer position can dismiss it without
    // generating pointermove. Keep the underlying song's hover suppression.
    if (!(target instanceof Element && target.closest(
      '.song-modal-backdrop:not(.song-modal-backdrop--released), .queue-backdrop'
    ))) clearActivated();
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    if (!(target instanceof Element) || textEditor(target)) return;
    const control = target.closest(actionControlSelector);
    if (!(control instanceof HTMLElement) || textEditor(control)) return;
    markActivated(control);
    const surface = control.closest(songSurfaceSelector);
    if (surface instanceof HTMLElement) markActivated(surface);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !lastInputWasPointer) return;
    const target = event.target;
    if (!(target instanceof Element) || textEditor(target)) return;
    // Prevent native mouse-down focus rather than trying to undo it after a
    // React render has removed the opener. The click and action still fire.
    // Do not cancel inputs/selects: that can break range drags, native pickers
    // and text caret placement.
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const control = target.closest(actionControlSelector);
    if (control instanceof HTMLElement && !textEditor(control)) event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    // Browser hover can re-highlight the clicked song *without any real mouse
    // movement* when a full-screen modal is removed. Keep the click marker
    // until the person actually moves the pointer, not until pointerleave:
    // pointerleave is also fired by modal insertion/removal.
    if (!event.isPrimary || event.pointerType !== 'mouse' || !activated.size) return;
    if (Math.abs(event.clientX - lastPointerX) + Math.abs(event.clientY - lastPointerY) > 1) {
      clearActivated();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    // Escape commonly closes a dialog that was opened by clicking a song.
    // It must not turn the ensuing focus restoration into a keyboard opener.
    if (event.key === 'Escape' && lastInputWasPointer) {
      guardPointerModalCloseFocus();
      return;
    }

    lastInputWasPointer = false;
    pointerPressInProgress = false;

    // A real Tab move deliberately transfers keyboard focus, so pointer-open
    // suppression no longer applies. Playback shortcuts (Z/X/arrows/Space),
    // however, must NOT clear the clicked opener marker: Chromium can restore
    // focus to that opener a task or frame after the modal has disappeared.
    // Keeping the marker until Tab or actual pointer movement lets focusin
    // reject that late restoration instead of letting it steal shortcuts.
    if (event.key === 'Tab') {
      clearActivated();
      suppressedPointerRestore = null;
      suppressPointerRestoreUntil = 0;
      suppressAnyPostModalActionFocusUntil = 0;
    }
  };

  const onPointerUp = () => {
    pointerPressInProgress = false;
    // In unusual drag/cancel paths there is no click, so do not leave the
    // focus guard suspended forever. The timer runs after the click if present.
    window.setTimeout(releasePointerFocusedAction, 0);
  };
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0 || !lastInputWasPointer) return;
    pointerPressInProgress = false;
    // After React's click handler; may run after the opener unmounts.
    queueMicrotask(releasePointerFocusedAction);
  };
  const onFocusIn = (event: FocusEvent) => {
    const focused = event.target;
    if (!(focused instanceof HTMLElement)) return;

    const postModalAutomaticActionFocus =
      performance.now() <= suppressAnyPostModalActionFocusUntil &&
      !modalIsOpen() &&
      !textEditor(focused) &&
      (focused.matches(actionControlSelector) || Boolean(focused.closest(actionControlSelector)));

    const stalePointerRestoration =
      postModalAutomaticActionFocus ||
      isSuppressedPointerRestore(focused) ||
      focused.hasAttribute('data-ws-pointer-activated') ||
      Boolean(focused.closest('[data-ws-pointer-activated]'));

    // A pointer-opened modal/drawer can be removed by Escape and Chromium may
    // restore its opener later, even after a playback shortcut has already
    // changed the global input modality to keyboard. Reject both the explicit
    // post-close suppression target and any still-marked pointer opener.
    if (stalePointerRestoration && !modalIsOpen() && !textEditor(focused)) {
      queueMicrotask(() => {
        if (document.activeElement === focused) focused.blur();
      });
      return;
    }

    if (!lastInputWasPointer || pointerPressInProgress) return;
    // Also catches useEffect/rAF/timeouts that refocus an opener after click.
    queueMicrotask(() => {
      if (document.activeElement === focused) releasePointerFocusedAction();
    });
  };
  const onChange = (event: Event) => {
    if (!lastInputWasPointer || !(event.target instanceof HTMLSelectElement)) return;
    queueMicrotask(() => event.target instanceof HTMLElement && event.target.blur());
  };
  const onPointerCancel = () => {
    pointerPressInProgress = false;
    queueMicrotask(releasePointerFocusedAction);
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  return () => {
    clearActivated();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('pointercancel', onPointerCancel, true);
  };
}
