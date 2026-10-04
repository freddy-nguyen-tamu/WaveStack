import { useEffect, useRef } from "react";

type UseInfiniteScrollOptions = {
  enabled: boolean;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
};

export function useInfiniteScroll({
  enabled,
  loading,
  hasMore,
  onLoadMore,
  rootMargin = "800px"
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onLoadMore);
  const armedRef = useRef(true);

  callbackRef.current = onLoadMore;

  useEffect(() => {
    const node = sentinelRef.current;

    if (!node || !enabled || !hasMore || loading) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];

        if (!entry.isIntersecting) {
          // Re-arm only after the sentinel has genuinely left the preload
          // boundary. Loading toggles recreate this observer; without a
          // persistent arm bit, a still-visible sentinel can immediately fire
          // again and drain page after page while the user simply stays put.
          armedRef.current = true;
          return;
        }

        if (armedRef.current) {
          armedRef.current = false;
          callbackRef.current();
        }
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01
      }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [enabled, hasMore, loading, rootMargin]);

  return sentinelRef;
}
