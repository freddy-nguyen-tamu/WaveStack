import { describe, expect, it } from "vitest";
import { createPlaybackTimeline } from "./playback-timeline";

describe("playback timeline", () => {
  it("revisits the exact same 99-song shuffle path without choosing again", () => {
    const timeline = createPlaybackTimeline<string>();
    const played = Array.from({ length: 99 }, (_, index) => `random-song-${index + 1}`);
    timeline.reset(played[0]);

    for (const song of played.slice(1)) timeline.append(song);
    expect(timeline.current()).toBe(played[98]);

    for (let index = 97; index >= 0; index--) {
      expect(timeline.previous()).toBe(played[index]);
    }
    expect(timeline.previous()).toBeNull();
    expect(timeline.hasPrevious()).toBe(false);

    for (let index = 1; index < played.length; index++) {
      expect(timeline.peekNext()).toBe(played[index]);
      expect(timeline.next()).toBe(played[index]);
    }
    expect(timeline.next()).toBeNull();
    expect(timeline.past()).toEqual(played.slice(0, -1));
  });

  it("replays future before extending and discards future only on an explicit branch", () => {
    const timeline = createPlaybackTimeline<string>();
    timeline.reset("a");
    timeline.append("b");
    timeline.append("c");
    expect(timeline.previous()).toBe("b");
    expect(timeline.next()).toBe("c");
    expect(timeline.previous()).toBe("b");
    timeline.append("new queue song");
    expect(timeline.peekNext()).toBeNull();
    expect(timeline.past()).toEqual(["a", "b"]);
  });

  it("retains the next song when stepping backwards sequentially before any history", () => {
    const timeline = createPlaybackTimeline<string>();
    timeline.reset("song 5");
    timeline.prepend("song 4");
    expect(timeline.current()).toBe("song 4");
    expect(timeline.next()).toBe("song 5");
  });

  it("stores refreshed metadata for the current history entry", () => {
    const timeline = createPlaybackTimeline<{ id: string; url: string }>();
    timeline.reset({ id: "a", url: "old" });
    timeline.replaceCurrent({ id: "a", url: "new" });
    timeline.append({ id: "b", url: "b" });
    expect(timeline.previous()).toEqual({ id: "a", url: "new" });
  });

  it("bounds memory while retaining the most recent navigation path", () => {
    const timeline = createPlaybackTimeline<number>(100);
    timeline.reset(0);
    for (let i = 1; i <= 120; i++) timeline.append(i);
    for (let i = 119; i >= 21; i--) expect(timeline.previous()).toBe(i);
    expect(timeline.previous()).toBeNull();
    for (let i = 22; i <= 120; i++) expect(timeline.next()).toBe(i);
  });
});
