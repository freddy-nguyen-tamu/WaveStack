import { type ReactNode, useLayoutEffect, useRef } from "react";

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
