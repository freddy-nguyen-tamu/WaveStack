// Keep a dismissed song modal connected briefly because some browsers keep
// dispatching the tail of a physical wheel gesture to the original DOM node.
export const WHEEL_GHOST_MS = 2050;

const SCROLL_ISLAND_SELECTOR = [
  ".app-nav",
  ".app-player-region .player-card",
  ".listening-rail",
  ".profile-insights-rail",
  ".song-modal",
  ".queue-drawer"
].join(", ");

const OVERLAY_SURFACE_SELECTOR = ".song-modal-backdrop, .queue-backdrop";
const WHEEL_SURFACE_SELECTOR = `${SCROLL_ISLAND_SELECTOR}, ${OVERLAY_SURFACE_SELECTOR}`;

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
const wiredSurfaces = new WeakSet<HTMLElement>();
let surfaceObserver: MutationObserver | null = null;

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

  // Respect nested independently scrollable controls/popovers inside a known
  // scroll surface. This walk now runs only for wheel/touch events that began
  // on those small surfaces, never for ordinary document scrolling.
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
  if (event.ctrlKey || event.metaKey) return;

  const eventTarget = eventElement(event.target);
  const targetIsland = scrollIslandFor(eventTarget);
  const overlaySurface = overlaySurfaceFor(eventTarget);
  const { x, y } = pointerCoordinates(event);
  const hovered = elementAtPoint(x, y);
  if (!hovered) return;

  if (overlaySurface && isActiveOverlay(overlaySurface) && !overlaySurface.contains(hovered)) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    return;
  }

  const desiredOwner = scrollOwnerFor(hovered);
  const targetOwner = targetIsland ?? scrollOwnerFor(eventTarget);
  const desiredIsIsland = desiredOwner !== pageScroller();

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
  touchState = {
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
    owner: scrollOwnerFor(target),
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

  if (ownerChanged) cancelMomentum(touchState.owner);

  if (touchState.manual || desiredOwner !== pageScroller() || targetOwner !== desiredOwner || ownerChanged) {
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

function wireSurface(surface: HTMLElement) {
  if (wiredSurfaces.has(surface)) return;
  wiredSurfaces.add(surface);

  // Critical performance rule: cancelable wheel/touch listeners live only on
  // the handful of independent scroll surfaces. A passive:false listener on
  // window/document makes Chromium treat *every* page wheel as main-thread
  // blocking even when the handler returns immediately.
  surface.addEventListener("wheel", routeWheelToPointer, { passive: false });
  surface.addEventListener("touchstart", beginTouch, { passive: true });
  surface.addEventListener("touchmove", routeTouchToFinger, { passive: false });
  surface.addEventListener("touchend", endTouch, { passive: true });
  surface.addEventListener("touchcancel", endTouch, { passive: true });
}

function wireTree(node: ParentNode | Element) {
  if (node instanceof HTMLElement && node.matches(WHEEL_SURFACE_SELECTOR)) {
    wireSurface(node);
  }

  node.querySelectorAll<HTMLElement>(WHEEL_SURFACE_SELECTOR).forEach(wireSurface);
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

  wireTree(document);

  surfaceObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) wireTree(node);
      }
    }
  });
  surfaceObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// Compatibility exports for the modal code. Released modal DOM is intentionally
// retained for WHEEL_GHOST_MS and keeps its own direct wheel listener, so no
// temporary window-level blocking listener is necessary.
export function cancelWheelHandoff() {
  // No global handoff listener exists.
}

export function handOffWheelToDocument() {
  // Direct listeners on the retained modal/backdrop already own the stale wheel
  // transaction until that released DOM is removed.
}
