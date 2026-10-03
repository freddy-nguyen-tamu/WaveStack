import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";


type RouteStickerProps = {
  children: ReactNode;
};

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Sticky folded ribbon whose visual corner is derived from the containing
 * route card's real border box. Responsive padding is measured instead of
 * copied into ribbon positioning, so the ribbon remains tied to the card edge.
 *
 * Kept in this already-tracked component module so deployments cannot fail
 * merely because a newly-created helper file was omitted from a Git commit.
 */
export function RouteSticker({ children }: RouteStickerProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const card = anchor?.parentElement;

    if (!anchor || !card) {
      return;
    }

    let frame = 0;

    const updateEdgeInsets = () => {
      frame = 0;
      const style = window.getComputedStyle(card);
      const topInset = cssPixels(style.paddingTop) + cssPixels(style.borderTopWidth);
      const rightInset = cssPixels(style.paddingRight) + cssPixels(style.borderRightWidth);

      anchor.style.setProperty("--route-card-top-inset", `${topInset}px`);
      anchor.style.setProperty("--route-card-right-inset", `${rightInset}px`);
    };

    const scheduleUpdate = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(updateEdgeInsets);
    };

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleUpdate)
      : null;

    resizeObserver?.observe(card);
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    updateEdgeInsets();

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  return (
    <span ref={anchorRef} className="route-sticker-anchor" aria-hidden="true">
      <span className="route-sticker">{children}</span>
    </span>
  );
}

export function KeyboardShortcutsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [open]);

  return (
    <div ref={rootRef} className={open ? "keyboard-shortcuts keyboard-shortcuts--open" : "keyboard-shortcuts"}>
      <button
        type="button"
        className="keyboard-shortcuts__toggle"
        aria-label={open ? "Hide keyboard shortcuts" : "Show keyboard shortcuts"}
        aria-expanded={open}
        aria-controls="wavestack-keyboard-shortcuts"
        title="Keyboard shortcuts"
        onClick={() => setOpen(current => !current)}
      >
        <ChevronDown aria-hidden="true" />
      </button>

      {open ? (
        <div
          id="wavestack-keyboard-shortcuts"
          className="keyboard-shortcuts__bar"
          role="region"
          aria-label="Keyboard shortcuts"
        >
          <span><kbd>Space</kbd> Play/Pause</span>
          <span><kbd>X</kbd> + <kbd>→</kbd> Next</span>
          <span><kbd>Z</kbd> + <kbd>←</kbd> Back/restart</span>
          <span><kbd>Ctrl/⌘</kbd> + <kbd>F</kbd> Find lyrics</span>
          <span><kbd>↑/↓</kbd> Lyric matches</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      ) : null}
    </div>
  );
}
