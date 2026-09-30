// Chromium/Firefox can continue targeting the old modal node for the remainder
// of a physical wheel transaction. Keep that node connected briefly and hand
// off *only those stale events*. Fresh wheel input belongs to the element
// under the pointer (e.g. the independently scrollable Listening Habit rail).
const WHEEL_HANDOFF_MS = 1900;
export const WHEEL_GHOST_MS = 2050;

let cancelActiveHandoff: (() => void) | null = null;

function releasedBackdropFor(target: EventTarget | null): Element | null {
  const element = target instanceof Element
    ? target
    : target instanceof Node ? target.parentElement : null;
  return element?.closest(".song-modal-backdrop--released") ?? null;
}

function scrollAtPointer(event: WheelEvent) {
  const pixelsPerUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
  const hovered = document.elementFromPoint(event.clientX, event.clientY);
  const page = document.scrollingElement ?? document.documentElement;

  // Match native wheel routing: independently scrollable panels get the first
  // chance to consume each axis, and scrolling chains to the page at an edge.
  // A stale event's target is the invisible modal, NOT the hovered panel.
  const routeAxis = (axis: "x" | "y", amount: number) => {
    if (!amount) return;
    const vertical = axis === "y";
    const position = vertical ? "scrollTop" : "scrollLeft";
    const extent = vertical ? "scrollHeight" : "scrollWidth";
    const viewport = vertical ? "clientHeight" : "clientWidth";
    const overflow = vertical ? "overflowY" : "overflowX";

    for (let node = hovered; node && node !== page; node = node.parentElement) {
      const behavior = getComputedStyle(node)[overflow];
      if (behavior !== "auto" && behavior !== "scroll" && behavior !== "overlay") continue;
      const limit = node[extent] - node[viewport];
      if (limit < 1) continue;
      const from = node[position];
      const to = Math.max(0, Math.min(limit, from + amount));
      if (Math.abs(to - from) < 0.5) continue;
      node[position] = to;
      return;
    }
    page[position] += amount;
  };

  routeAxis("y", event.deltaY * pixelsPerUnit);
  routeAxis("x", event.deltaX * pixelsPerUnit);
}

export function cancelWheelHandoff() {
  cancelActiveHandoff?.();
}

export function handOffWheelToDocument() {
  cancelWheelHandoff();

  let timeout: number;
  let active = true;

  const stop = () => {
    if (!active) return;
    active = false;
    window.clearTimeout(timeout);
    window.removeEventListener("wheel", passStaleWheel, true);
    if (cancelActiveHandoff === stop) cancelActiveHandoff = null;
  };

  const extend = () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(stop, WHEEL_HANDOFF_MS);
  };

  const passStaleWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return; // native browser zoom
    if (document.querySelector(
      '.song-modal-backdrop:not(.song-modal-backdrop--released), .queue-backdrop'
    )) {
      stop();
      return;
    }

    // The former implementation redirected EVERY wheel tick to the page, and
    // extended itself indefinitely. This prevented the listening rail from
    // scrolling even after the pointer moved over it. Let all fresh wheel
    // targets use the browser's native scroll behavior unchanged.
    if (!releasedBackdropFor(event.target)) return;

    // Later ticks in a wheel transaction may be non-cancelable. The obsolete
    // modal is invisible; send its stale deltas to the real hovered scroller.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    scrollAtPointer(event);
    extend();
  };

  cancelActiveHandoff = stop;
  window.addEventListener("wheel", passStaleWheel, { capture: true, passive: false });
  timeout = window.setTimeout(stop, WHEEL_HANDOFF_MS);
}
