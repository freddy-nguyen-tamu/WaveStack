// A pointer click activates an action; it must not become a persistent focus
// selection. Native text editing and keyboard navigation remain untouched.
// In particular, Escape dismissing a pointer-opened dialog must NOT change
// its opening modality to keyboard and resurrect focus on the song row.
let lastInputWasPointer = false;
let pointerPressInProgress = false;
let lastPointerX = 0;
let lastPointerY = 0;
const activated = new Set<HTMLElement>();

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
    if (event.key === 'Escape' && lastInputWasPointer) return;
    lastInputWasPointer = false;
    pointerPressInProgress = false;
    // Tab/shortcuts inside a mouse-opened modal are keyboard actions, but
    // moving among modal controls must not resurrect the underlying row's
    // hover treatment after the overlay is removed under a stationary mouse.
    if (!modalIsOpen()) clearActivated();
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
    if (!lastInputWasPointer || pointerPressInProgress) return;
    const focused = event.target;
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
