import { act, fireEvent, render } from "@testing-library/react";
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
    onListenStart: noop,
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
    vi.useRealTimers();
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

  it("recovers an old stream on the first Space press even while play() is unresolved", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldSong = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}&signature=old`);
    const newSong = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}&signature=new`);
    const failedPlay = deferred<void>();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementationOnce(() => failedPlay.promise)
      .mockResolvedValue(undefined);
    const refresh = vi.fn(async () => newSong);
    const view = render(<Player {...playerProps(oldSong, 0, refresh)} />);
    const audio = view.container.querySelector("audio")!;

    fireEvent.keyDown(document, { code: "Space", key: " ", repeat: false });
    fireEvent.keyUp(document, { code: "Space", key: " " });
    expect(play).toHaveBeenCalledTimes(1);

    // A media error often arrives while the original play() is still pending.
    // Its recovery must take over rather than wait for that promise to settle.
    await act(async () => {
      fireEvent.error(audio);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
    expect(audio.src).toContain("signature=new");

    // Late failure from the replaced request must not turn playback off.
    await act(async () => {
      failedPlay.reject(new DOMException("Failed to load prior stream", "NotSupportedError"));
      await failedPlay.promise.catch(() => undefined);
    });

    expect(view.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(view.queryByText(/Playback error:/)).toBeNull();
  });

  it("does not let an older refresh for the same song overwrite a newer recovery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldSong = makeSong("drive-a", `/drive/stream/a?expires=${now - 60}`);
    const stale = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}&signature=stale`);
    const fresh = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}&signature=fresh`);
    const firstRefresh = deferred<Song>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(fresh);
    const view = render(<Player {...playerProps(oldSong, 1, refresh)} />);
    const audio = view.container.querySelector("audio")!;
    await act(async () => { await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.error(audio);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(audio.src).toContain("signature=fresh");

    await act(async () => {
      firstRefresh.resolve(stale);
      await firstRefresh.promise;
      await Promise.resolve();
    });
    expect(audio.src).toContain("signature=fresh");
    expect(audio.src).not.toContain("signature=stale");
  });

  it("restarts a failed media element even if refreshed signing returns the same URL", async () => {
    const now = Math.floor(Date.now() / 1000);
    const song = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}`);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new Error("Failed to load stream"))
      .mockResolvedValue(undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, "load");
    const refresh = vi.fn(async () => song);
    const view = render(<Player {...playerProps(song, 0, refresh)} />);
    const loadsBeforePlay = load.mock.calls.length;

    fireEvent.keyDown(document, { code: "Space", key: " ", repeat: false });
    fireEvent.keyUp(document, { code: "Space", key: " " });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.length).toBeGreaterThan(loadsBeforePlay);
    expect(play).toHaveBeenCalledTimes(2);
    expect(view.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("recovers a startup stall without nudging the playhead or skipping the intro", async () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const song = makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}`);
    const refresh = vi.fn(async () => makeSong("drive-a", `/drive/stream/a?expires=${now + 3600}&retry=1`));
    const view = render(<Player {...playerProps(song, 1, refresh)} />);
    const audio = view.container.querySelector("audio")!;
    await act(async () => { await Promise.resolve(); });

    const currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    const seekPositions: number[] = [];
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      get: () => currentTimeDescriptor.get!.call(audio) as number,
      set: (value: number) => {
        seekPositions.push(value);
        currentTimeDescriptor.set!.call(audio, value);
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(760);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seekPositions).not.toContain(0.02);
    expect(seekPositions.every((position) => position === 0)).toBe(true);
    expect(audio.currentTime).toBe(0);
  });

});
