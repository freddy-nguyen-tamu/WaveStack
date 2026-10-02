import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "../../App";
import { Player } from "./Player";

function makeSong(id: string, streamUrl: string): Song {
  return {
    id,
    title: `Song ${id}`,
    artistName: `Artist ${id}`,
    albumTitle: "Race Test",
    durationSeconds: id === "a" ? 111 : 222,
    streamUrl,
    genreNames: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noop = () => {};

function playerProps(activeSong: Song, playSignal: number, onRefreshStreamUrl: (song: Song) => Promise<Song>) {
  return {
    activeSong,
    queue: [] as Song[],
    playSignal,
    isFavorite: false,
    shuffleEnabled: false,
    repeatMode: "none" as const,
    canGoPrevious: false,
    resolvingNext: false,
    onToggleFavorite: noop,
    onToggleShuffle: noop,
    onCycleRepeatMode: noop,
    onQueueChange: noop,
    onRefreshStreamUrl,
    onOpenDetails: noop,
    onPlaybackStateChange: noop,
    onNext: noop,
    onPrevious: noop,
    onEnded: noop
  };
}

describe("Player media-source ownership", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let a stale signed-URL refresh replace the newer song source", async () => {
    const now = Math.floor(Date.now() / 1000);
    const songA = makeSong("drive-a", `/drive/stream/a?expires=${now - 60}`);
    const songB = makeSong("drive-b", `/drive/stream/b?expires=${now + 3600}`);
    const refreshedA = makeSong("drive-a", `/drive/stream/a-refreshed?expires=${now + 3600}`);
    const refreshA = deferred<Song>();

    const onRefreshStreamUrl = vi.fn((song: Song) => {
      if (song.id === "drive-a") {
        return refreshA.promise;
      }
      return Promise.resolve(song);
    });

    const view = render(<Player {...playerProps(songA, 1, onRefreshStreamUrl)} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(onRefreshStreamUrl).toHaveBeenCalledWith(expect.objectContaining({ id: "drive-a" }));

    view.rerender(<Player {...playerProps(songB, 2, onRefreshStreamUrl)} />);

    const audio = view.container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio!.src).toBe(new URL(songB.streamUrl, window.location.href).href);

    await act(async () => {
      refreshA.resolve(refreshedA);
      await refreshA.promise;
      await Promise.resolve();
    });

    expect(audio!.src).toBe(new URL(songB.streamUrl, window.location.href).href);
    expect(audio!.src).not.toContain("a-refreshed");
  });
  it("rejects a refresh that claims the current song id but carries the previous Drive file URL", async () => {
    const now = Math.floor(Date.now() / 1000);
    const currentSong = makeSong("drive-b", `/drive/stream/b?expires=${now - 60}`);
    const crossedRefresh = makeSong("drive-b", `/drive/stream/a?expires=${now + 3600}`);

    const onRefreshStreamUrl = vi.fn(async () => crossedRefresh);
    const view = render(<Player {...playerProps(currentSong, 1, onRefreshStreamUrl)} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const audio = view.container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(onRefreshStreamUrl).toHaveBeenCalled();
    expect(audio!.src).not.toContain("/drive/stream/a?");
    expect(audio!.src).toContain("/drive/stream/b?");
  });

});
