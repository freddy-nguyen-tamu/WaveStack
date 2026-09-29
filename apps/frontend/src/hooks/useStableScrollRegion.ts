import { useLayoutEffect, useRef } from "react";

// Keep enough document height for the current viewport when a search becomes shorter.
export function useStableScrollRegion(changing: boolean) {
  const ref = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !changing) return;

    node.style.minHeight = `${Math.max(0, window.innerHeight - node.getBoundingClientRect().top)}px`;
  }, [changing]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    let lastScrollY = window.scrollY;
    let scrollFrame: number | null = null;

    const releaseOnScrollUp = () => {
      // Several list-heavy routes use this hook. Doing a layout read and style write
      // for every native scroll event made UI-only pages noticeably less smooth.
      // Coalesce the work to one layout pass per animation frame.
      if (scrollFrame !== null) {
        return;
      }

      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        const nextScrollY = window.scrollY;

        if (nextScrollY < lastScrollY) {
          const floor = Math.max(0, window.innerHeight - node.getBoundingClientRect().top);
          node.style.minHeight = `${Math.min(parseFloat(node.style.minHeight) || 0, floor)}px`;
        }

        lastScrollY = nextScrollY;
      });
    };

    window.addEventListener("scroll", releaseOnScrollUp, { passive: true });

    return () => {
      window.removeEventListener("scroll", releaseOnScrollUp);

      if (scrollFrame !== null) {
        window.cancelAnimationFrame(scrollFrame);
      }
    };
  }, []);

  return ref;
}
