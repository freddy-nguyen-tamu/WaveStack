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
    const releaseOnScrollUp = () => {
      if (window.scrollY < lastScrollY) {
        const floor = Math.max(0, window.innerHeight - node.getBoundingClientRect().top);
        node.style.minHeight = `${Math.min(parseFloat(node.style.minHeight) || 0, floor)}px`;
      }
      lastScrollY = window.scrollY;
    };
    window.addEventListener("scroll", releaseOnScrollUp, { passive: true });
    return () => window.removeEventListener("scroll", releaseOnScrollUp);
  }, []);
  return ref;
}
