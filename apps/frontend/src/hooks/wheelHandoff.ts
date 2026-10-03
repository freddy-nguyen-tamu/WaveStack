// Keep a dismissed song modal connected briefly because some browsers keep
// dispatching the tail of a physical wheel gesture to the original DOM node.
// The global ownership policy below still routes every stale delta to the
// scroll region currently underneath the pointer.
export const WHEEL_GHOST_MS = 2050;

const SCROLL_ISLAND_SELECTOR = [
  ".app-nav",
  ".app-player-region .player-card",
  ".listening-rail",
  ".profile-insights-rail",
  ".song-modal",
  ".queue-drawer"
].join(", ");

type ScrollOwner = HTMLElement;

type TouchScrollState = {
  identifier: number;
  x: number;
  y: number;
  owner: ScrollOwner;
  manual: boolean;
};

let scrollOwnershipInstalled = false;
let touchState: TouchScrollState | null = null;
let lastPointerX = 0;
let lastPointerY = 0;

function pageScroller(): ScrollOwner {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function scrollIslandFor(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>(SCROLL_ISLAND_SELECTOR) ?? null;
}

function scrollOwnerFor(element: Element | null): ScrollOwner {
  const island = scrollIslandFor(element);
  if (island) return island;

  // Also respect any independently scrollable control/popover added elsewhere
  // in the app. This keeps the policy spatial without having to maintain a
  // brittle list of every future overflow container.
  for (let node = element as HTMLElement | null; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    const style = getComputedStyle(node);
    const scrollableY =
      /^(?:auto|scroll|overlay)$/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight + 1;
    const scrollableX =
      /^(?:auto|scroll|overlay)$/.test(style.overflowX) &&
      node.scrollWidth > node.clientWidth + 1;

    if (scrollableY || scrollableX) return node;
  }

  return pageScroller();
}

function openOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".song-modal-backdrop:not(.song-modal-backdrop--released), .queue-backdrop"
  );
}

function elementAtPoint(x: number, y: number): Element | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
  return document.elementFromPoint(x, y);
}

function normalizeWheelDelta(event: WheelEvent, amount: number): number {
  if (!amount) return 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return amount * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return amount * window.innerHeight;
  return amount;
}

function scrollOwnerBy(owner: ScrollOwner, deltaX: number, deltaY: number) {
  if (!deltaX && !deltaY) return;

  if (owner === pageScroller()) {
    window.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
    return;
  }

  owner.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
}

function cancelMomentum(owner: ScrollOwner) {
  if (owner === pageScroller()) {
    window.scrollTo({ left: window.scrollX, top: window.scrollY, behavior: "auto" });
    return;
  }

  // Assigning the current position back to a native scroll container cancels
  // compositor momentum in Chromium/WebKit without visually moving it.
  owner.scrollLeft = owner.scrollLeft;
  owner.scrollTop = owner.scrollTop;
}

function pointerCoordinates(event: WheelEvent): { x: number; y: number } {
  const looksLikeSyntheticOrigin =
    event.clientX === 0 && event.clientY === 0 && (lastPointerX !== 0 || lastPointerY !== 0);
  const eventPointIsUsable =
    !looksLikeSyntheticOrigin &&
    Number.isFinite(event.clientX) && Number.isFinite(event.clientY) &&
    event.clientX >= 0 && event.clientY >= 0 &&
    event.clientX <= window.innerWidth && event.clientY <= window.innerHeight;

  return eventPointIsUsable
    ? { x: event.clientX, y: event.clientY }
    : { x: lastPointerX, y: lastPointerY };
}

function routeWheelToPointer(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return; // Keep native browser zoom.

  const { x, y } = pointerCoordinates(event);
  const hovered = elementAtPoint(x, y);
  if (!hovered) return;

  const overlay = openOverlay();
  if (overlay && !overlay.contains(hovered)) {
    // An open modal/drawer owns scrolling exclusively. Never let a wheel tick
    // leak through its backdrop into the library underneath it.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    return;
  }

  const desiredOwner = scrollOwnerFor(hovered);
  const targetOwner = scrollOwnerFor(eventElement(event.target));
  const desiredIsIsland = desiredOwner !== pageScroller();

  // Native wheel transactions can stay latched to the region where the gesture
  // started. Scroll islands are therefore handled manually every tick, while
  // the page keeps native scrolling whenever the browser is already targeting
  // the page correctly.
  if (!desiredIsIsland && targetOwner === desiredOwner) return;

  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  scrollOwnerBy(
    desiredOwner,
    normalizeWheelDelta(event, event.deltaX),
    normalizeWheelDelta(event, event.deltaY)
  );
}

function beginTouch(event: TouchEvent) {
  if (event.touches.length !== 1) {
    touchState = null;
    return;
  }

  const touch = event.touches[0];
  const hovered = elementAtPoint(touch.clientX, touch.clientY);
  if (!hovered) {
    touchState = null;
    return;
  }

  touchState = {
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
    owner: scrollOwnerFor(hovered),
    manual: false
  };
}

function routeTouchToFinger(event: TouchEvent) {
  if (!touchState || event.touches.length !== 1) return;

  const touch = Array.from(event.touches).find(item => item.identifier === touchState?.identifier);
  if (!touch) return;

  const hovered = elementAtPoint(touch.clientX, touch.clientY);
  if (!hovered) return;

  const overlay = openOverlay();
  if (overlay && !overlay.contains(hovered)) {
    if (event.cancelable) event.preventDefault();
    touchState.x = touch.clientX;
    touchState.y = touch.clientY;
    touchState.manual = true;
    return;
  }

  const desiredOwner = scrollOwnerFor(hovered);
  const targetOwner = scrollOwnerFor(eventElement(event.target));
  const ownerChanged = desiredOwner !== touchState.owner;

  if (ownerChanged) {
    cancelMomentum(touchState.owner);
  }

  const shouldRouteManually =
    touchState.manual ||
    desiredOwner !== pageScroller() ||
    targetOwner !== desiredOwner ||
    ownerChanged;

  if (shouldRouteManually) {
    if (event.cancelable) event.preventDefault();
    scrollOwnerBy(
      desiredOwner,
      touchState.x - touch.clientX,
      touchState.y - touch.clientY
    );
    touchState.manual = true;
  }

  touchState.x = touch.clientX;
  touchState.y = touch.clientY;
  touchState.owner = desiredOwner;
}

function endTouch() {
  touchState = null;
}

export function installScrollOwnershipPolicy() {
  if (scrollOwnershipInstalled) return;
  scrollOwnershipInstalled = true;

  window.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }, { capture: true, passive: true });

  window.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") return;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }, { capture: true, passive: true });

  window.addEventListener("wheel", routeWheelToPointer, { capture: true, passive: false });
  window.addEventListener("touchstart", beginTouch, { capture: true, passive: true });
  window.addEventListener("touchmove", routeTouchToFinger, { capture: true, passive: false });
  window.addEventListener("touchend", endTouch, { capture: true, passive: true });
  window.addEventListener("touchcancel", endTouch, { capture: true, passive: true });
}

// Compatibility exports for the modal code. Ownership is now global rather
// than a short-lived post-modal listener, so opening/closing a dialog only
// needs to ensure the policy is installed.
export function cancelWheelHandoff() {
  // Intentionally empty: there is no transient handoff listener anymore.
}

export function handOffWheelToDocument() {
  installScrollOwnershipPolicy();
}
