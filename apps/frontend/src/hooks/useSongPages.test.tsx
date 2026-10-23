import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSongPages } from "./useSongPages";
import { AllPage } from "../features/all/AllPage";
import { SearchPanel } from "../features/search/SearchPanel";
import type { Song } from "../App";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@apollo/client", async importOriginal => ({
  ...await importOriginal<typeof import("@apollo/client")>(),
  useApolloClient: () => client
}));
const client = { query: request };
const pending: Array<(value: unknown) => void> = [];
const song = (id: number): Song => ({ id: String(id), title: `Song ${id}`, artistName: "Artist", albumTitle: "Album", durationSeconds: 60, streamUrl: "/test.mp3", genreNames: [] });
const page = (start: number, count = 60, more = true) => ({ data: { songPage: {
  nodes: Array.from({ length: count }, (_, i) => song(start + i)),
  totalCount: 240,
  pageInfo: { hasNextPage: more, endCursor: more ? String(start + count) : null }
} } });
const props = { songs: [], playlists: [], favoriteIds: [], onPlay: vi.fn(), onQueue: vi.fn(), onToggleFavorite: vi.fn(), onAddToPlaylist: vi.fn(), onOpenDetails: vi.fn() };
let intersect: IntersectionObserverCallback;

beforeEach(() => {
  pending.length = 0;
  request.mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      if (options.rootMargin === "800px") intersect = callback;
    }
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("song pagination", () => {
  it("retains rows and rejects stale searches, including a zero-result response", async () => {
    const { result, rerender } = renderHook(({ query }) => useSongPages(query, "TITLE_ASC", 60), { initialProps: { query: "" } });
    await act(async () => pending.shift()!(page(0)));
    act(() => { void result.current.loadMore(); void result.current.loadMore(); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.page?.nodes).toHaveLength(60);
    await act(async () => pending.shift()!(page(60)));
    expect(result.current.page?.nodes).toHaveLength(120);
    rerender({ query: "old" });
    const oldResponse = pending.shift()!;
    rerender({ query: "missing" });
    expect(result.current.page?.nodes).toHaveLength(120);
    await act(async () => pending.shift()!(page(0, 0, false)));
    await act(async () => oldResponse(page(100)));
    expect(result.current.page?.nodes).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  it("retains all fetched rows while mounting at most 100 nearest songs", async () => {
    const view = render(<AllPage {...props} />);
    await act(async () => pending.shift()!(page(0)));
    const firstRow = view.container.querySelector(".song-list-row");
    for (const start of [60, 120, 180]) {
      act(() => {
        intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
        intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      await act(async () => pending.shift()!(page(start, 60, start < 180)));
      expect(view.container.querySelectorAll(".song-list-row").length)
        .toBe(Math.min(start + 60, 100));
      expect(view.container.querySelector(".song-list-row")).toBe(firstRow);
    }
    expect(view.container.querySelector(".virtual-song-spacer")).toBeTruthy();
    expect(view.container.querySelectorAll(".song-list-row")).toHaveLength(100);
  }, 20000);

  it("keeps the search input mounted through loading, zero results, and recovery", async () => {
    vi.useFakeTimers();
    render(<SearchPanel {...props} pageKey="search" title="Search" backendSearch />);
    await act(async () => pending.shift()!(page(0, 3, false)));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "missing" } });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText(/Song 0/)).toBeInTheDocument();
    await act(async () => pending.shift()!(page(0, 0, false)));
    expect(screen.getByText("No songs found.")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBe(input);
    fireEvent.change(input, { target: { value: "Artist" } });
    act(() => vi.advanceTimersByTime(300));
    await act(async () => pending.shift()!(page(0, 3, false)));
    expect(screen.getByText(/Song 0/)).toBeInTheDocument();
  });
});
