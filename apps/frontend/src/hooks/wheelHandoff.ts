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

const OVERLAY_SURFACE_SELECTOR = ".song-modal-backdrop, .queue-backdrop";

function overlaySurfaceFor(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>(OVERLAY_SURFACE_SELECTOR) ?? null;
}

function isActiveOverlay(surface: HTMLElement | null): boolean {
  return Boolean(
    surface &&
    (surface.matches(".queue-backdrop") ||
      surface.matches(".song-modal-backdrop:not(.song-modal-backdrop--released)"))
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

  const eventTarget = eventElement(event.target);
  const targetIsland = scrollIslandFor(eventTarget);
  const overlaySurface = overlaySurfaceFor(eventTarget);

  // Fast path for the main document. This is the overwhelmingly common path on
  // Dashboard and other long routes, and it must remain compositor-native. Do
  // not hit-test the viewport or walk ancestors/getComputedStyle for every
  // wheel tick when the browser is already scrolling the page correctly.
  if (!targetIsland && !overlaySurface) {
    return;
  }

  const { x, y } = pointerCoordinates(event);
  const hovered = elementAtPoint(x, y);
  if (!hovered) return;

  if (overlaySurface && isActiveOverlay(overlaySurface) && !overlaySurface.contains(hovered)) {
    // An open modal/drawer owns scrolling exclusively. Never let a wheel tick
    // leak through its backdrop into the library underneath it.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    return;
  }

  const desiredOwner = scrollOwnerFor(hovered);
  const targetOwner = targetIsland ?? scrollOwnerFor(eventTarget);
  const desiredIsIsland = desiredOwner !== pageScroller();

  // Native wheel transactions can stay latched to the region where the gesture
  // started. Scroll islands are therefore handled manually every tick, while
  // the page keeps native scrolling whenever the browser is already targeting
  // the page correctly. A released modal is also routed here: its stale wheel
  // target remains in the old island while elementFromPoint resolves the page
  // now visible underneath it.
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
  const target = eventElement(event.target);
  const targetIsland = scrollIslandFor(target);
  const overlaySurface = overlaySurfaceFor(target);

  // A normal page touch gesture should stay completely native. Remember only
  // enough state to recognize that fast path on subsequent touchmove events.
  if (!targetIsland && !overlaySurface) {
    touchState = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      owner: pageScroller(),
      manual: false
    };
    return;
  }

  touchState = {
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
    owner: targetIsland ?? scrollOwnerFor(target),
    manual: false
  };
}

function routeTouchToFinger(event: TouchEvent) {
  if (!touchState || event.touches.length !== 1) return;

  const touch = Array.from(event.touches).find(item => item.identifier === touchState?.identifier);
  if (!touch) return;

  const eventTarget = eventElement(event.target);
  const targetIsland = scrollIslandFor(eventTarget);
  const overlaySurface = overlaySurfaceFor(eventTarget);

  // Keep ordinary document touch scrolling on the compositor. A gesture that
  // started on the page stays a page gesture until the next touchstart, just as
  // native scrolling normally latches to its initial scroller.
  if (
    !touchState.manual &&
    touchState.owner === pageScroller() &&
    !targetIsland &&
    !overlaySurface
  ) {
    touchState.x = touch.clientX;
    touchState.y = touch.clientY;
    return;
  }

  const hovered = elementAtPoint(touch.clientX, touch.clientY);
  if (!hovered) return;

  if (overlaySurface && isActiveOverlay(overlaySurface) && !overlaySurface.contains(hovered)) {
    if (event.cancelable) event.preventDefault();
    touchState.x = touch.clientX;
    touchState.y = touch.clientY;
    touchState.manual = true;
    return;
  }

  const desiredOwner = scrollOwnerFor(hovered);
  const targetOwner = targetIsland ?? scrollOwnerFor(eventTarget);
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
