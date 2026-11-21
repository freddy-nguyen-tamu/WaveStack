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

    const [oldDeck, newDeck] = Array.from(view.container.querySelectorAll("audio") as NodeListOf<HTMLAudioElement>);
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
    const [oldDeck, stagingDeck] = Array.from(view.container.querySelectorAll("audio") as NodeListOf<HTMLAudioElement>);
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
    const [oldDeck, stagingDeck] = Array.from(view.container.querySelectorAll("audio") as NodeListOf<HTMLAudioElement>);
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

  it("keeps the old OS title, artist and cover through automatic end and async next resolution", async () => {
    const { session } = fakeMediaSession();
    let finishAdvance!: (advanced: boolean) => void;
    const onEnded = vi.fn(() => new Promise<boolean>(resolve => { finishAdvance = resolve; }));
    const view = render(<Player {...props(song("a"), 1)} onEnded={onEnded} />);
    await flush();
    const oldDeck = view.container.querySelector("audio")!;
    setMediaReadyState(oldDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(oldDeck);
    expect(session.metadata?.title).toBe("Title a");

    Object.defineProperty(oldDeck, "ended", { configurable: true, get: () => true });
    fireEvent.pause(oldDeck); // Chrome may emit pause before ended.
    expect(session.playbackState).toBe("playing");
    fireEvent.ended(oldDeck);
    await flush();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(session.playbackState).toBe("playing");
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artist).toBe("Artist a");
    expect(session.metadata?.artwork?.[0]?.src).toContain("a.jpg");

    view.rerender(<Player {...props(song("b"), 2)} onEnded={onEnded} />);
    await flush();
    expect(session.playbackState).toBe("playing");
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artwork?.[0]?.src).toContain("a.jpg");
    // Even a stale async completion from A must not affect B's pending session.
    await act(async () => { finishAdvance(false); });
    expect(session.playbackState).toBe("playing");
    setMediaReadyState(oldDeck, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(oldDeck);
    expect(session.metadata?.title).toBe("Title b");
    expect(session.metadata?.artist).toBe("Artist b");
    expect(session.metadata?.artwork?.[0]?.src).toContain("b.jpg");
  });

  it("returns to paused when natural playback ends and no next track exists", async () => {
    const { session } = fakeMediaSession();
    const onEnded = vi.fn(async () => false);
    const view = render(<Player {...props(song("last"), 1)} onEnded={onEnded} />);
    await flush();
    const audio = view.container.querySelector("audio")!;
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    Object.defineProperty(audio, "ended", { configurable: true, get: () => true });
    fireEvent.ended(audio);
    await flush();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(session.playbackState).toBe("paused");
    expect(session.metadata?.title).toBe("Title last");
  });

  it("keeps the paused song identity during signed-link renewal without a competing audio element", async () => {
    const { session } = fakeMediaSession();
    const old = song("a");
    let finishRefresh!: (song: Song) => void;
    const refresh = vi.fn(() => new Promise<Song>(resolve => { finishRefresh = resolve; }));
    const view = render(<Player {...props(old, 1)} onRefreshStreamUrl={refresh} />);
    await flush();
    const [audio] = Array.from(view.container.querySelectorAll("audio") as NodeListOf<HTMLAudioElement>);
    expect(view.container.querySelectorAll("audio")).toHaveLength(2);
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    audio.currentTime = 36;
    fireEvent.timeUpdate(audio);
    fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await flush();

    const pausedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(pausedAt + 2 * 60 * 60 * 1000);
    // Simulate the browser discarding an idle resource over a long pause.
    setMediaReadyState(audio, HTMLMediaElement.HAVE_NOTHING);
    session.playbackState = "none";
    session.metadata = new MediaMetadata({ title: "Other app" });

    fireEvent.click(view.getByRole("button", { name: "Play" }));
    expect(session.playbackState).toBe("playing");
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artist).toBe("Artist a");
    expect(session.metadata?.artwork?.[0]?.src).toContain("a.jpg");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh({ ...old, streamUrl: `/drive/stream/a?expires=${Math.floor(Date.now() / 1000) + 3600}` });
    });
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    expect(session.metadata?.title).toBe("Title a");
    expect(session.metadata?.artist).toBe("Artist a");
  });

  it("resumes buffered audio immediately after URL expiry without depending on the API", async () => {
    const { session } = fakeMediaSession();
    const old = song("buffered");
    const refresh = vi.fn(async (item: Song) => item);
    const view = render(<Player {...props(old, 1)} onRefreshStreamUrl={refresh} />);
    await flush();
    const audio = view.container.querySelector("audio")!;
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await flush();

    const pausedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(pausedAt + 2 * 60 * 60 * 1000);
    session.playbackState = "none";
    session.metadata = new MediaMetadata({ title: "Other app" });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    fireEvent.click(view.getByRole("button", { name: "Play" }));
    await flush();
    expect(play.mock.contexts).toContain(audio);
    expect(refresh).not.toHaveBeenCalled();
    expect(session.metadata?.title).toBe("Title buffered");
    expect(session.metadata?.artist).toBe("Artist buffered");
    expect(session.playbackState).toBe("playing");
  });

  it("keeps metadata while a real audio play() remains pending and honors hardware Pause", async () => {
    const { session, actions } = fakeMediaSession();
    const view = render(<Player {...props(song("a"), 1)} />);
    await flush();
    const audio = view.container.querySelector("audio")!;
    setMediaReadyState(audio, HTMLMediaElement.HAVE_FUTURE_DATA);
    fireEvent.playing(audio);
    fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await flush();

    let finishPlay!: () => void;
    const delayedPlay = new Promise<void>(resolve => { finishPlay = resolve; });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => delayedPlay);
    session.playbackState = "none";
    session.metadata = new MediaMetadata({ title: "Other app" });
    act(() => { actions.get("play")?.(); });
    await flush();
    expect(session.playbackState).toBe("playing");
    expect(session.metadata?.title).toBe("Title a");
    expect(view.container.querySelectorAll("audio")).toHaveLength(2);
    fireEvent.waiting(audio);
    act(() => { actions.get("pause")?.(); });
    expect(session.playbackState).toBe("paused");
    await act(async () => { finishPlay(); });
    expect(session.playbackState).toBe("paused");
    expect(session.metadata?.title).toBe("Title a");
  });

  it("retains Play intent and retries a transient API outage without an immediate false Pause", async () => {
    fakeMediaSession();
    const expired = { ...song("offline"), streamUrl: "/drive/stream/offline?expires=1" };
    const refresh = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ...expired, streamUrl: `/drive/stream/offline?expires=${Math.floor(Date.now() / 1000) + 3600}` });
    const view = render(<Player {...props(expired, 0)} onRefreshStreamUrl={refresh} />);
    const audio = view.container.querySelector("audio")!;
    setMediaReadyState(audio, HTMLMediaElement.HAVE_NOTHING);
    vi.useFakeTimers();
    try {
      fireEvent.click(view.getByRole("button", { name: "Play" }));
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(view.getByRole("button", { name: "Pause" })).toBeTruthy();
      expect(view.getByRole("alert").textContent).toContain("Retrying playback");
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await flush();
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(view.getByRole("button", { name: "Pause" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels network recovery when Pause is pressed; no stale retry can restart music", async () => {
    const { session } = fakeMediaSession();
    const expired = { ...song("offline"), streamUrl: "/drive/stream/offline?expires=1" };
    const refresh = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const view = render(<Player {...props(expired, 0)} onRefreshStreamUrl={refresh} />);
    vi.useFakeTimers();
    try {
      fireEvent.click(view.getByRole("button", { name: "Play" }));
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      fireEvent.click(view.getByRole("button", { name: "Pause" }));
      expect(session.playbackState).toBe("paused");
      await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(view.getByRole("button", { name: "Play" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
