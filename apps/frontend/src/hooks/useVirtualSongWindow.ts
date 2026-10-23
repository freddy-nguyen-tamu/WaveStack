import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Retain the fetched catalog but mount at most 100 nearby song controls/artworks.
 * Measured row heights replace estimates as users visit sections of the list,
 * so removing offscreen DOM does not collapse the scroll range or move the loader.
 * Window scroll is read once per animation frame; it never intercepts wheel input.
 */
function onNextFrame(callback: FrameRequestCallback): number {
  return typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(() => callback(performance.now()), 16);
}

function cancelNextFrame(id: number) {
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(id);
  else window.clearTimeout(id);
}

export function useVirtualSongWindow<T extends HTMLElement>({
  count,
  resetKey,
  grid = false,
  estimatedRowHeight = 135
}: {
  count: number;
  resetKey: string;
  grid?: boolean;
  estimatedRowHeight?: number;
}) {
  const ref = useRef<T | null>(null);
  const rowHeights = useRef(new Map<number, number>());
  const [startRow, setStartRow] = useState(0);
  const [, setMeasurementRevision] = useState(0);
  const [layout, setLayout] = useState({ columns: 1, gap: 0, estimate: estimatedRowHeight });
  const [currentKey, setCurrentKey] = useState(resetKey);
  const frame = useRef<number | null>(null);

  // Reset the measurement model synchronously with the next dataset's render.
  // Pages that happen to contain the same number of items are still distinct.
  if (currentKey !== resetKey) {
    rowHeights.current.clear();
    setCurrentKey(resetKey);
    setStartRow(0);
  }

  const columns = grid ? layout.columns : 1;
  const totalRows = Math.ceil(count / columns);
  const capacity = Math.max(1, Math.floor(100 / columns));
  const firstRow = Math.min(startRow, Math.max(0, totalRows - capacity));
  const lastRow = Math.min(totalRows, firstRow + capacity);

  const offsetForRow = (row: number) => {
    let offset = row * (layout.estimate + layout.gap);
    for (const [index, height] of rowHeights.current) {
      if (index < row) offset += height - layout.estimate;
    }
    return offset;
  };
  const totalHeight = Math.max(0, offsetForRow(totalRows) - (totalRows ? layout.gap : 0));
  const topHeight = firstRow ? Math.max(0, offsetForRow(firstRow) - layout.gap) : 0;
  const bottomHeight = lastRow < totalRows
    ? Math.max(0, totalHeight - offsetForRow(lastRow))
    : 0;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const readLayout = () => {
      const style = window.getComputedStyle(node);
      const gap = parseFloat(style.rowGap) || 0;
      const columns = grid ? Math.max(1, style.gridTemplateColumns.split(/\s+/).filter(Boolean).length) : 1;
      const estimate = grid
        ? Math.max(estimatedRowHeight, node.clientWidth / columns + 125)
        : estimatedRowHeight;
      setLayout(old => {
        if (old.columns === columns && old.gap === gap && old.estimate === estimate) return old;
        rowHeights.current.clear();
        return { columns, gap, estimate };
      });
    };
    readLayout();
    // CSS media queries change the grid columns without changing item count.
    window.addEventListener("resize", readLayout);
    return () => window.removeEventListener("resize", readLayout);
  }, [count, grid, estimatedRowHeight, resetKey]);

  useEffect(() => {
    function schedule() {
      if (frame.current !== null) return;
      frame.current = onNextFrame(() => {
        frame.current = null;
        const node = ref.current;
        if (!node || !count) return;
        const rect = node.getBoundingClientRect();
        const top = Math.max(0, -rect.top);
        const bottom = Math.max(0, window.innerHeight - rect.top);
        // Binary search works with measured rows and unvisited estimated rows.
        const findRow = (position: number) => {
          let low = 0;
          let high = totalRows;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (offsetForRow(middle + 1) < position) low = middle + 1;
            else high = middle;
          }
          return Math.min(low, Math.max(0, totalRows - 1));
        };
        const visibleStart = findRow(top);
        const visibleEnd = findRow(bottom);
        const margin = Math.min(12, Math.max(2, Math.floor(capacity * 0.16)));
        if ((firstRow > 0 && visibleStart < firstRow + margin) ||
            (lastRow < totalRows && visibleEnd >= lastRow - margin)) {
          const visibleRows = Math.max(1, visibleEnd - visibleStart + 1);
          const nextStart = Math.max(0, Math.min(totalRows - capacity,
            visibleStart - Math.floor((capacity - visibleRows) / 2)));
          setStartRow(old => old === nextStart ? old : nextStart);
        }
      });
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame.current !== null) cancelNextFrame(frame.current);
      frame.current = null;
    };
  }, [count, capacity, firstRow, lastRow, totalRows, layout]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !count || typeof ResizeObserver === "undefined") return;
    const children = root.querySelectorAll<HTMLElement>("[data-virtual-index]");
    if (!children.length) return;
    let queued: number | null = null;
    const measure = () => {
      queued = null;
      const measuredRows = new Map<number, number>();
      children.forEach(node => {
        const itemIndex = Number(node.dataset.virtualIndex);
        if (!Number.isFinite(itemIndex)) return;
        const row = Math.floor(itemIndex / columns);
        const height = node.getBoundingClientRect().height;
        measuredRows.set(row, Math.max(height, measuredRows.get(row) ?? 0));
      });
      let changed = false;
      measuredRows.forEach((height, row) => {
        if (height > 0 && Math.abs((rowHeights.current.get(row) ?? layout.estimate) - height) > 1) {
          rowHeights.current.set(row, height);
          changed = true;
        }
      });
      if (changed) setMeasurementRevision(value => value + 1);
    };
    const observer = new ResizeObserver(() => {
      if (queued === null) queued = onNextFrame(measure);
    });
    children.forEach(child => observer.observe(child));
    measure();
    return () => {
      observer.disconnect();
      if (queued !== null) cancelNextFrame(queued);
    };
  }, [count, firstRow, lastRow, columns, layout.estimate, resetKey]);

  return {
    ref,
    start: firstRow * columns,
    end: Math.min(count, lastRow * columns),
    topHeight,
    bottomHeight
  };
}
