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

  callbackRef.current = onLoadMore;

  useEffect(() => {
    const node = sentinelRef.current;

    if (!node || !enabled || !hasMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];

        if (entry.isIntersecting && !loading && hasMore) {
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
