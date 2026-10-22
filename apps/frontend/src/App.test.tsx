import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type Song } from "./App";
import { SONG_PAGE_QUERY } from "./api";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the WaveStack music dashboard", () => {
    render(
      <MemoryRouter>
        <MockedProvider>
          <App />
        </MockedProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /wavestack home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Player" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "All songs" })).toBeInTheDocument();
  });
});

function makeSong(id: string, title: string): Song {
  return {
    id,
    title,
    artistName: "Playback Test Artist",
    albumTitle: "Playback Tests",
    durationSeconds: 180,
    streamUrl: `/test/${id}.mp3`,
    genreNames: []
  };
}

function saveLastPlayedSong(song: Song) {
  window.localStorage.setItem("wavestack:last-song", JSON.stringify(song));
  window.localStorage.setItem("wavestack:last-song-id", song.id);
}

function expectPlayerSong(title: string) {
  expect(within(screen.getByRole("region", { name: "Player" }))
    .getByRole("heading", { name: title })).toBeInTheDocument();
}

describe("last played song startup restoration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  it("keeps a saved song missing from the startup cache after the fallback timer", async () => {
    const savedSong = makeSong("saved-outside-cache", "Restored song outside cache");
    saveLastPlayedSong(savedSong);
    window.localStorage.setItem("wavestack:song-cache", JSON.stringify([
      makeSong("cached-other", "Cached unrelated song")
    ]));

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <MockedProvider><App /></MockedProvider>
      </MemoryRouter>
    );

    expectPlayerSong(savedSong.title);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    expectPlayerSong(savedSong.title);
  });

  it("persists the first cached song when Space starts playback before initialization", async () => {
    const firstSong = makeSong("first-played", "First played song");
    window.localStorage.setItem("wavestack:song-cache", JSON.stringify([firstSong]));

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <MockedProvider><App /></MockedProvider>
      </MemoryRouter>
    );

    expectPlayerSong(firstSong.title);
    expect(window.localStorage.getItem("wavestack:last-song")).toBeNull();
    fireEvent.keyDown(document, { code: "Space", key: " ", repeat: false });
    fireEvent.keyUp(document, { code: "Space", key: " " });
    const audio = screen.getByRole("region", { name: "Player" }).querySelector("audio");
    expect(audio).not.toBeNull();
    await act(async () => {
      fireEvent.playing(audio!);
      await Promise.resolve();
    });

    expect(JSON.parse(window.localStorage.getItem("wavestack:last-song") ?? "null")?.id)
      .toBe(firstSong.id);
  });

  it("does not switch songs when the full backend catalog finishes loading", async () => {
    const savedSong = makeSong("saved-outside-catalog", "Restored song outside catalog");
    const catalogSong = makeSong("new-library-entry", "New catalog track for restoration test");
    saveLastPlayedSong(savedSong);

    const fullLibraryReply = vi.fn(() => ({
      data: {
        songPage: {
          nodes: [catalogSong],
          pageInfo: { endCursor: null, hasNextPage: false },
          totalCount: 1
        }
      }
    }));

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <MockedProvider mocks={[{
          request: {
            query: SONG_PAGE_QUERY,
            variables: { first: 100, after: null, query: null, sort: "TITLE_ASC" }
          },
          result: fullLibraryReply
        }]}>
          <App />
        </MockedProvider>
      </MemoryRouter>
    );

    expectPlayerSong(savedSong.title);
    await waitFor(() => expect(fullLibraryReply).toHaveBeenCalledTimes(1));
    // Dashboard recommendations include the newly hydrated library track only
    // once App has published the completed catalog and rerendered.
    await screen.findByText(catalogSong.title);
    expectPlayerSong(savedSong.title);
  });
});
