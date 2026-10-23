import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVirtualSongWindow } from "./useVirtualSongWindow";

function VirtualFixture({ count, columns = 1, resetKey = "songs" }: {
  count: number;
  columns?: number;
  resetKey?: string;
}) {
  const virtual = useVirtualSongWindow<HTMLDivElement>({
    count,
    grid: columns > 1,
    resetKey,
    estimatedRowHeight: 135
  });
  return (
    <div
      data-testid="virtual-root"
      ref={virtual.ref}
      style={{ display: "grid", gridTemplateColumns: Array(columns).fill("100px").join(" ") }}
    >
      {virtual.topHeight > 0 ? <div data-testid="top" style={{ height: virtual.topHeight }} /> : null}
      {Array.from({ length: virtual.end - virtual.start }, (_, offset) => (
        <div key={virtual.start + offset} data-virtual-index={virtual.start + offset}>
          {virtual.start + offset}
        </div>
      ))}
      {virtual.bottomHeight > 0 ? <div data-testid="bottom" style={{ height: virtual.bottomHeight }} /> : null}
    </div>
  );
}

async function scrollVirtualRoot(top: number) {
  const node = screen.getByTestId("virtual-root");
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => ({ top: -top } as DOMRect));
  await act(async () => {
    fireEvent.scroll(window);
    await new Promise<void>(resolve => window.setTimeout(resolve, 30));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("virtual song window", () => {
  it("forgets distant rows but restores them on scrolling back", async () => {
    render(<VirtualFixture count={2000} />);
    expect(screen.getByTestId("virtual-root").querySelectorAll("[data-virtual-index]")).toHaveLength(100);
    expect(screen.getByTestId("bottom")).toBeInTheDocument();
    await scrollVirtualRoot(125000);
    const nodes = screen.getByTestId("virtual-root").querySelectorAll<HTMLElement>("[data-virtual-index]");
    expect(nodes.length).toBeLessThanOrEqual(100);
    expect(Number(nodes[0].dataset.virtualIndex)).toBeGreaterThan(500);
    expect(screen.getByTestId("top")).toBeInTheDocument();
    await scrollVirtualRoot(0);
    expect(screen.getByTestId("virtual-root").querySelector("[data-virtual-index]")?.getAttribute("data-virtual-index")).toBe("0");
  });

  it("never mounts more than 100 tiles and aligns the window to grid rows", async () => {
    // The computed CSS in browsers resolves repeat() into track widths.
    const view = render(<VirtualFixture count={2000} columns={5} />);
    await scrollVirtualRoot(20000);
    let tiles = screen.getByTestId("virtual-root").querySelectorAll<HTMLElement>("[data-virtual-index]");
    expect(tiles.length).toBeLessThanOrEqual(100);
    expect(Number(tiles[0].dataset.virtualIndex) % 5).toBe(0);
    view.rerender(<VirtualFixture count={2000} columns={4} />);
    await act(async () => { fireEvent.resize(window); });
    tiles = screen.getByTestId("virtual-root").querySelectorAll<HTMLElement>("[data-virtual-index]");
    expect(tiles.length).toBeLessThanOrEqual(100);
    expect(Number(tiles[0].dataset.virtualIndex) % 4).toBe(0);
  });
});
