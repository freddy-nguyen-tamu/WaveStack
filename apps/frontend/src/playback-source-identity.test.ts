import { describe, expect, it } from "vitest";
import {
  assertStreamUrlBelongsToSong,
  driveFileIdFromSongId,
  driveFileIdFromStreamUrl,
  streamUrlBelongsToSong
} from "./playback-source-identity";

describe("playback source identity", () => {
  it("extracts the immutable Drive file id from song ids and signed stream URLs", () => {
    expect(driveFileIdFromSongId("drive-1OTq-current")).toBe("1OTq-current");
    expect(driveFileIdFromStreamUrl(
      "https://api.wavestack.test/drive/stream/1OTq-current?expires=1&signature=x"
    )).toBe("1OTq-current");
  });

  it("accepts refreshed signatures for the same Drive file", () => {
    expect(streamUrlBelongsToSong(
      "drive-1OTq-current",
      "https://api.wavestack.test/drive/stream/1OTq-current?expires=999&signature=new"
    )).toBe(true);
  });

  it("rejects the exact crossed-source failure captured by the playback probe", () => {
    expect(streamUrlBelongsToSong(
      "drive-1OTq-current",
      "https://api.wavestack.test/drive/stream/1kie-previous?expires=999&signature=stale"
    )).toBe(false);

    expect(() => assertStreamUrlBelongsToSong(
      "drive-1OTq-current",
      "https://api.wavestack.test/drive/stream/1kie-previous?expires=999&signature=stale"
    )).toThrow(/wrong Drive file/i);
  });

  it("does not impose Drive path rules on non-Drive songs", () => {
    expect(streamUrlBelongsToSong("user-123", "/api/uploads/audio.mp3?expires=999")).toBe(true);
  });
});
