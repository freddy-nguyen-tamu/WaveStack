// Mouse/touch activation must never leave an action control focused, including
// when a component focuses it later (for example in an animation frame/effect).
// Keep text editing and keyboard navigation native. This deliberately does not
// listen to wheel, mousemove, or scroll, which must stay independent of focus.
let lastInputWasPointer = false;
let pointerPressInProgress = false;

export function isPointerInput(): boolean {
  return lastInputWasPointer;
}

const actionControlSelector = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

function releasePointerFocusedAction() {
  if (!lastInputWasPointer) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  // Native inputs (including editable fields, selects, and draggable ranges),
  // contenteditable, and the dialog's non-interactive focus anchor are not
  // action buttons. Blurring them during a pointer gesture breaks their input.
  if (active.matches("input, textarea, select") || active.isContentEditable) return;
  if (active.matches(actionControlSelector)) active.blur();
}

export function installPointerFocusPolicy(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    lastInputWasPointer = true;
    // Native controls focus on pointerdown, before their click/change fires.
    // Do not blur in that interval: it can swallow actions or close popovers.
    pointerPressInProgress = true;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    lastInputWasPointer = false;
    pointerPressInProgress = false;
  };
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0 || !lastInputWasPointer) return;
    pointerPressInProgress = false;
    // Run after React's click handler, so actions execute normally first.
    queueMicrotask(releasePointerFocusedAction);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (!lastInputWasPointer || pointerPressInProgress) return;
    const focused = event.target;
    // Catches rAF, timeouts, mount effects, and asynchronous focus restoration
    // after a mouse click; a one-off click listener alone misses these paths.
    queueMicrotask(() => {
      if (document.activeElement === focused) releasePointerFocusedAction();
    });
  };
  const onPointerCancel = () => {
    pointerPressInProgress = false;
    queueMicrotask(releasePointerFocusedAction);
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
  };
}
