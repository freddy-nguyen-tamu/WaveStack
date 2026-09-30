// A physical wheel gesture can remain targeted at a dialog's scroll container
// after that dialog is dismissed (Chromium/Firefox wheel-event transactions).
// Briefly hand any remaining deltas to the page instead of dropping them or
// allowing a sticky rail underneath the former close button to swallow them.
const WHEEL_HANDOFF_MS = 1900;
export const WHEEL_GHOST_MS = 2050;

let cancelActiveHandoff: (() => void) | null = null;

export function cancelWheelHandoff() {
  cancelActiveHandoff?.();
}

export function handOffWheelToDocument() {
  cancelWheelHandoff();

  const page = document.scrollingElement ?? document.documentElement;
  let timeout: number;
  let active = true;

  const extend = () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(stop, WHEEL_HANDOFF_MS);
  };

  const stop = () => {
    if (!active) return;
    active = false;
    window.clearTimeout(timeout);
    window.removeEventListener("wheel", passWheelToPage, true);
    if (cancelActiveHandoff === stop) cancelActiveHandoff = null;
  };

  const passWheelToPage = (event: WheelEvent) => {
    // Never interfere with browser pinch-zoom or a dialog opened again before
    // the previous gesture has finished.
    if (event.ctrlKey || event.metaKey) return;
    if (document.querySelector(
      '.song-modal-backdrop:not(.song-modal-backdrop--released), .queue-backdrop'
    )) {
      stop();
      return;
    }
    // Later ticks in one browser wheel transaction can be non-cancelable.
    // They still need explicit delivery to the page.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    const pixelsPerUnit = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2 ? window.innerHeight : 1;
    page.scrollTop += event.deltaY * pixelsPerUnit;
    page.scrollLeft += event.deltaX * pixelsPerUnit;
    // Keep the handoff alive for a continuous physical wheel gesture, not just
    // a fixed interval after the close click. It ends after wheel inactivity.
    extend();
  };

  cancelActiveHandoff = stop;
  window.addEventListener("wheel", passWheelToPage, { capture: true, passive: false });
  timeout = window.setTimeout(stop, WHEEL_HANDOFF_MS);
}
