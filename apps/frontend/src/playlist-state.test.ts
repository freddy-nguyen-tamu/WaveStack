import { describe, expect, it } from "vitest";
import type { ClientPlaylist, Song } from "./App";
import { mergeEditedPlaylistMembership, recordPlaylistMembershipEdit, sortPlaylistsNewestFirst, type PlaylistMembershipEdits } from "./playlist-state";

function song(id: string): Song {
  return {
    id, title: id, artistName: "Test Artist", albumTitle: "Test Album",
    durationSeconds: 120, streamUrl: `/audio/${id}.mp3`, genreNames: []
  };
}

function playlist(ids: string[]): ClientPlaylist {
  return {
    id: "playlist-one", name: "Example", songIds: ids,
    songs: ids.map(song), songCount: ids.length,
    createdAt: "2026-11-01T01:00:00Z"
  };
}

describe("playlist membership against stale playback-related refreshes", () => {
  it("does not re-add a removed song when an older library response arrives", () => {
    const edits: PlaylistMembershipEdits = new Map();
    recordPlaylistMembershipEdit(edits, "playlist-one", "removed", false);
    const actual = mergeEditedPlaylistMembership([playlist(["removed", "remaining"])], edits)[0];
    expect(actual.songIds).toEqual(["remaining"]);
    expect(actual.songs?.map(item => item.id)).toEqual(["remaining"]);
    expect(actual.songCount).toBe(1);
  });

  it("keeps newly added tracks first and accepts unrelated remote changes", () => {
    const edits: PlaylistMembershipEdits = new Map();
    recordPlaylistMembershipEdit(edits, "playlist-one", "old", false);
    recordPlaylistMembershipEdit(edits, "playlist-one", "new", true, song("new"));
    const stale = playlist(["old", "remote"]);
    const result = mergeEditedPlaylistMembership([stale], edits)[0];
    expect(result.songIds).toEqual(["new", "remote"]);
    expect(result.songs?.map(item => item.id)).toEqual(["new", "remote"]);
    expect(stale.songIds).toEqual(["old", "remote"]); // Do not mutate server payloads.
  });

  it("follows the final user action when a song is toggled repeatedly", () => {
    const edits: PlaylistMembershipEdits = new Map();
    recordPlaylistMembershipEdit(edits, "playlist-one", "a", false);
    recordPlaylistMembershipEdit(edits, "playlist-one", "a", true, song("a"));
    recordPlaylistMembershipEdit(edits, "playlist-one", "a", false);
    expect(mergeEditedPlaylistMembership([playlist(["a", "b"])], edits)[0].songIds)
      .toEqual(["b"]);
  });
});

describe("newest-first playlists", () => {
  it("orders server timestamps newest-first, independently of update time", () => {
    const older = { ...playlist([]), id: "older", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" };
    const newer = { ...playlist([]), id: "newer", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
    expect(sortPlaylistsNewestFirst([older, newer]).map(item => item.id)).toEqual(["newer", "older"]);
  });

  it("sorts legacy local playlist IDs by timestamp", () => {
    const older = { ...playlist([]), createdAt: undefined, id: "playlist-1000" };
    const newer = { ...playlist([]), createdAt: undefined, id: "playlist-2000" };
    expect(sortPlaylistsNewestFirst([older, newer]).map(item => item.id))
      .toEqual(["playlist-2000", "playlist-1000"]);
  });
});
