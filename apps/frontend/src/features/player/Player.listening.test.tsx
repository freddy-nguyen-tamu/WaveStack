import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "../../App";
import { Player } from "./Player";

const noop = () => {};

function makeSong(id: string): Song {
  return {
    id,
    title: `Track ${id}`,
    artistName: "Loop artist",
    albumTitle: "Loop album",
    durationSeconds: 60,
    streamUrl: `/drive/stream/${id.replace(/^drive-/, "")}?expires=${Math.floor(Date.now() / 1000) + 3600}`,
    genreNames: []
  };
}

function props(song: Song, playSignal: number, onListenStart: (song: Song) => void) {
  return {
    activeSong: song,
    queue: [] as Song[],
    playSignal,
    isFavorite: false,
    shuffleEnabled: false,
    repeatMode: "one" as const,
    canGoPrevious: false,
    onToggleFavorite: noop,
    onToggleShuffle: noop,
    onCycleRepeatMode: noop,
    onQueueChange: noop,
    onRefreshStreamUrl: async (track: Song) => track,
    onOpenDetails: noop,
    onPlaybackStateChange: noop,
    onListenStart,
    onNext: noop,
    onPrevious: noop,
    onEnded: noop
  };
}

async function settlePlayback() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Player listening event accounting", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("records each repeat of the same song while ignoring duplicate playing/buffering notifications", async () => {
    const song = makeSong("drive-a");
    const onListenStart = vi.fn();
    const view = render(<Player {...props(song, 1, onListenStart)} />);
    await settlePlayback();
    const audio = view.container.querySelector("audio")!;

    fireEvent.playing(audio);
    fireEvent.playing(audio);
    fireEvent.waiting(audio);
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(1);
    expect(onListenStart).toHaveBeenCalledWith(song);

    fireEvent.ended(audio);
    view.rerender(<Player {...props(song, 2, onListenStart)} />);
    await settlePlayback();
    fireEvent.playing(audio);
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(2);

    // Clicking the same song explicitly creates another playback cycle.
    view.rerender(<Player {...props(song, 3, onListenStart)} />);
    await settlePlayback();
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(3);
  });

  it("counts the first Space-activated play of a restored cached last song", async () => {
    const song = makeSong("drive-cached");
    const onListenStart = vi.fn();
    const view = render(<Player {...props(song, 0, onListenStart)} />);
    const audio = view.container.querySelector("audio")!;
    await settlePlayback();

    expect(onListenStart).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { code: "Space", key: " ", repeat: false });
    fireEvent.keyUp(document, { code: "Space", key: " " });
    await settlePlayback();
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(1);
    expect(onListenStart).toHaveBeenCalledWith(song);

    // Buffering and resuming the same cycle must not count as another play.
    fireEvent.pause(audio);
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(1);
  });

  it("counts a replay after a natural end even when repeat is disabled", async () => {
    const song = makeSong("drive-a");
    const onListenStart = vi.fn();
    const view = render(<Player {...props(song, 1, onListenStart)} repeatMode="none" />);
    await settlePlayback();
    const audio = view.container.querySelector("audio")!;
    fireEvent.playing(audio);
    fireEvent.ended(audio);

    fireEvent.keyDown(document, { code: "Space", key: " ", repeat: false });
    fireEvent.keyUp(document, { code: "Space", key: " " });
    await settlePlayback();
    fireEvent.playing(audio);
    expect(onListenStart).toHaveBeenCalledTimes(2);
  });

  it("attributes each song change to the correct media source", async () => {
    const a = makeSong("drive-a");
    const b = makeSong("drive-b");
    const onListenStart = vi.fn();
    const view = render(<Player {...props(a, 1, onListenStart)} />);
    await settlePlayback();
    const audio = view.container.querySelector("audio")!;
    fireEvent.playing(audio);

    view.rerender(<Player {...props(b, 2, onListenStart)} />);
    await settlePlayback();
    fireEvent.playing(audio);
    expect(onListenStart.mock.calls.map(([song]) => song.id)).toEqual(["drive-a", "drive-b"]);
  });
});
