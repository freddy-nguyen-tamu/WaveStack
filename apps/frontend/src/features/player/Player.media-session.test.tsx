import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "../../App";
import { Player } from "./Player";

const noop = () => {};

function song(id: string): Song {
  return {
    id: `drive-${id}`,
    title: `Title ${id}`,
    artistName: `Artist ${id}`,
    albumTitle: "Transition album",
    durationSeconds: 100,
    streamUrl: `/drive/stream/${id}?expires=${Math.floor(Date.now() / 1000) + 3600}`,
    thumbnailUrl: `/drive/assets/thumbnails/${id}.jpg`,
    genreNames: []
  };
}

function props(activeSong: Song, playSignal: number, onNext = noop) {
  return {
    activeSong,
    queue: [] as Song[],
    playSignal,
    isFavorite: false,
    shuffleEnabled: false,
    repeatMode: "none" as const,
    canGoPrevious: true,
    resolvingNext: false,
    onToggleFavorite: noop,
    onToggleShuffle: noop,
    onCycleRepeatMode: noop,
    onQueueChange: noop,
    onRefreshStreamUrl: async (item: Song) => item,
    onOpenDetails: noop,
    onPlaybackStateChange: noop,
    onListenStart: noop,
    onNext,
    onPrevious: noop,
    onEnded: noop
  };
}

type PlaybackState = "none" | "paused" | "playing";

function fakeMediaSession() {
  const actions = new Map<string, (() => void) | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as PlaybackState,
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      actions.set(action, handler);
    })
  };

  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session
  });
  vi.stubGlobal("MediaMetadata", class {
    title: string;
    artist: string;
    album: string;
    artwork: MediaImage[];
    constructor(init: MediaMetadataInit) {
      this.title = init.title ?? "";
      this.artist = init.artist ?? "";
      this.album = init.album ?? "";
      this.artwork = init.artwork ?? [];
    }
  });

  return { session, actions };
}

function setMediaReadyState(audio: HTMLAudioElement, readyState: number) {
  Object.defineProperty(audio, "readyState", { configurable: true, get: () => readyState });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe("WaveStack Windows/Chromium media-session continuity", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaSession");
  });

  it("does not claim the system media flyout before the first playback", async () => {
    const { session } = fakeMediaSession();
    const view = render(<Player {...props(song("cached"), 0)} />);
    const audio = view.container.querySelector("audio")!;

    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.canPlay(audio);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");

    fireEvent.click(view.getByRole("button", { name: "Play" }));
    await flush();
    fireEvent.playing(audio);
    expect(session.metadata?.title).toBe("Title cached");
  });

  it("keeps outgoing artwork and metadata while the replacement source buffers", async () => {
    const { session, actions } = fakeMediaSession();
    const first = song("a");
    const second = song("b");
    const view = render(<Player {...props(first, 1)} />);
    const audio = view.container.querySelector("audio")!;

    await flush();
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artist).toBe("Artist a");
    expect(session.metadata?.artwork?.[0]?.src).toContain("a.jpg");

    setMediaReadyState(audio, HTMLMediaElement.HAVE_NOTHING);
    view.rerender(<Player {...props(second, 2)} />);
    await flush();

    expect(audio.src).toContain("/drive/stream/b?");
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artwork?.[0]?.src).toContain("a.jpg");
    expect(session.playbackState).toBe("playing");
    expect(actions.get("nexttrack")).toEqual(expect.any(Function));
    // A transient 'loadedmetadata' event is not enough to display the next song.
    fireEvent.loadedMetadata(audio);
    fireEvent.canPlay(audio);
    expect(session.metadata?.title).toBe("Title a");

    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.canPlay(audio);
    expect(session.metadata?.title).toBe("Title b");
    expect(session.metadata?.artwork?.[0]?.src).toContain("b.jpg");
  });

  it("keeps the outgoing REAL audio stream alive until the replacement starts", async () => {
    const { session } = fakeMediaSession();
    const first = song("a");
    const second = song("b");
    const view = render(<Player {...props(first, 1)} />);
    await flush();

    const [oldDeck, newDeck] = Array.from(view.container.querySelectorAll("audio"));
    // In jsdom play() is mocked and paused never becomes false automatically.
    // Explicitly model a genuinely playing HTMLAudioElement, as in Chromium.
    let oldPaused = false;
    Object.defineProperty(oldDeck, "paused", { configurable: true, get: () => oldPaused });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      if (this === oldDeck) oldPaused = true;
    });
    setMediaReadyState(oldDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(oldDeck);
    expect(session.metadata?.title).toBe("Title a");
    const outgoingPauseCount = pause.mock.contexts.filter(context => context === oldDeck).length;

    view.rerender(<Player {...props(second, 2)} />);
    await flush();

    expect(oldDeck.src).toContain("/drive/stream/a?");
    expect(newDeck.src).toContain("/drive/stream/b?");
    expect(pause.mock.contexts.filter(context => context === oldDeck)).toHaveLength(outgoingPauseCount);
    expect(oldPaused).toBe(false);
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artist).toBe("Artist a");
    expect(session.playbackState).toBe("playing");

    // Even a successfully buffered replacement cannot claim the flyout before
    // the new audio actually starts. Otherwise Windows can temporarily show
    // one song's text with another song's thumbnail.
    setMediaReadyState(newDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.canPlay(newDeck);
    expect(session.metadata?.title).toBe("Title a");
    fireEvent.playing(newDeck);
    expect(session.metadata?.title).toBe("Title b");
    expect(session.metadata?.artist).toBe("Artist b");
    expect(session.metadata?.artwork?.[0]?.src).toContain("b.jpg");
    expect(oldPaused).toBe(true);
    expect(pause.mock.contexts.filter(context => context === oldDeck)).toHaveLength(outgoingPauseCount + 1);
  });

  it("preserves the first playing deck through rapid skips and ignores old-deck ended events", async () => {
    const { session } = fakeMediaSession();
    const onEnded = vi.fn();
    const view = render(<Player {...props(song("a"), 1)} onEnded={onEnded} />);
    await flush();
    const [oldDeck, stagingDeck] = Array.from(view.container.querySelectorAll("audio"));
    let oldPaused = false;
    Object.defineProperty(oldDeck, "paused", { configurable: true, get: () => oldPaused });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      if (this === oldDeck) oldPaused = true;
    });
    setMediaReadyState(oldDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(oldDeck);
    const outgoingPauseCount = pause.mock.contexts.filter(context => context === oldDeck).length;

    view.rerender(<Player {...props(song("b"), 2)} onEnded={onEnded} />);
    await flush();
    expect(stagingDeck.src).toContain("/drive/stream/b?");
    view.rerender(<Player {...props(song("c"), 3)} onEnded={onEnded} />);
    await flush();
    expect(stagingDeck.src).toContain("/drive/stream/c?");
    expect(oldDeck.src).toContain("/drive/stream/a?");
    expect(oldPaused).toBe(false);
    fireEvent.ended(oldDeck);
    expect(onEnded).not.toHaveBeenCalled();
    expect(session.metadata?.title).toBe("Title a");
    setMediaReadyState(stagingDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(stagingDeck);
    expect(session.metadata?.title).toBe("Title c");
    expect(pause.mock.contexts.filter(context => context === oldDeck)).toHaveLength(outgoingPauseCount + 1);
  });

  it("pauses both audio decks if the user presses Pause during a track handoff", async () => {
    const { session } = fakeMediaSession();
    const view = render(<Player {...props(song("a"), 1)} />);
    await flush();
    const [oldDeck, stagingDeck] = Array.from(view.container.querySelectorAll("audio"));
    let oldPaused = false;
    Object.defineProperty(oldDeck, "paused", { configurable: true, get: () => oldPaused });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      if (this === oldDeck) oldPaused = true;
    });
    setMediaReadyState(oldDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(oldDeck);
    view.rerender(<Player {...props(song("b"), 2)} />);
    await flush();
    expect(oldPaused).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await flush();
    expect(oldPaused).toBe(true);
    expect(pause.mock.contexts).toContain(stagingDeck);
    expect(session.playbackState).toBe("paused");
    setMediaReadyState(stagingDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(stagingDeck);
    expect(session.metadata?.title).toBe("Title a");
  });

  it("never removes the OS media handlers between songs and targets the latest callbacks", async () => {
    const { session, actions } = fakeMediaSession();
    const onNextA = vi.fn();
    const onNextB = vi.fn();
    const view = render(<Player {...props(song("a"), 1, onNextA)} />);
    const audio = view.container.querySelector("audio")!;
    await flush();
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);

    const originalNextHandler = actions.get("nexttrack")!;
    const initialHandlerRegistrationCount = session.setActionHandler.mock.calls.length;
    setMediaReadyState(audio, HTMLMediaElement.HAVE_NOTHING);
    view.rerender(<Player {...props(song("b"), 2, onNextB)} />);
    await flush();

    expect(session.setActionHandler.mock.calls.length).toBe(initialHandlerRegistrationCount);
    expect(actions.get("nexttrack")).toBe(originalNextHandler);
    originalNextHandler();
    expect(onNextA).not.toHaveBeenCalled();
    expect(onNextB).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(actions.get("nexttrack")).toBeNull();
  });

  it("skips an unready intermediate track during rapid next/previous or song selection", async () => {
    const { session } = fakeMediaSession();
    const view = render(<Player {...props(song("a"), 1)} />);
    const audio = view.container.querySelector("audio")!;
    await flush();
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);

    setMediaReadyState(audio, HTMLMediaElement.HAVE_NOTHING);
    view.rerender(<Player {...props(song("b"), 2)} />);
    view.rerender(<Player {...props(song("c"), 3)} />);
    await flush();

    expect(session.metadata?.title).toBe("Title a");
    expect(session.playbackState).toBe("playing");
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.canPlay(audio);
    expect(session.metadata?.title).toBe("Title c");
    expect(audio.src).toContain("/drive/stream/c?");
  });
});
