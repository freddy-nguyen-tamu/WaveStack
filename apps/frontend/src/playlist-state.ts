
import type { ClientPlaylist, Song } from "./App";

export type PlaylistMembershipEdits = Map<string, Map<string, { present: boolean; song?: Song; addedAt?: string }>>;

/** The latest explicit user action wins over a slower, older libraryState response. */
export function recordPlaylistMembershipEdit(
  edits: PlaylistMembershipEdits,
  playlistId: string,
  songId: string,
  present: boolean,
  song?: Song
): void {
  let playlistEdits = edits.get(playlistId);
  if (!playlistEdits) {
    playlistEdits = new Map();
    edits.set(playlistId, playlistEdits);
  }
  // Reinsertion gives re-added songs the newest position, even after toggles.
  playlistEdits.delete(songId);
  playlistEdits.set(songId, { present, song, addedAt: present ? new Date().toISOString() : undefined });
}

/** Preserve fresh server data except for memberships explicitly changed in this tab. */
export function mergeEditedPlaylistMembership(
  playlists: ClientPlaylist[],
  edits: PlaylistMembershipEdits
): ClientPlaylist[] {
  if (!edits.size) return playlists;
  return playlists.map(playlist => {
    const playlistEdits = edits.get(playlist.id);
    if (!playlistEdits?.size) return playlist;
    const editedAdditions = [...playlistEdits.entries()]
      .filter(([, change]) => change.present)
      .map(([id]) => id)
      .reverse();
    const editedIds = new Set(playlistEdits.keys());
    const songIds = [
      ...editedAdditions,
      ...playlist.songIds.filter(id => !editedIds.has(id))
    ];
    const songById = new Map((playlist.songs ?? []).map(song => [song.id, song]));
    for (const [id, change] of playlistEdits) {
      if (change.song) songById.set(id, change.song);
    }
    const localAdds = [...playlistEdits.values()]
      .filter(change => change.present && change.addedAt)
      .map(change => change.addedAt!)
      .sort();
    const mostRecentLocalAdd = localAdds[localAdds.length - 1];
    const lastSongAddedAt = mostRecentLocalAdd &&
      mostRecentLocalAdd > (playlist.lastSongAddedAt ?? "")
      ? mostRecentLocalAdd : playlist.lastSongAddedAt;
    return {
      ...playlist,
      lastSongAddedAt,
      songIds,
      songs: songIds.map(id => songById.get(id)).filter((song): song is Song => Boolean(song)),
      songCount: songIds.length
    };
  });
}

/** Order by the latest song added, falling back to creation for empty/legacy lists.
 * Never elevate a playlist just because a song was removed or state refreshed. */
export function sortPlaylistsNewestFirst(playlists: ClientPlaylist[]): ClientPlaylist[] {
  const activityAt = (playlist: ClientPlaylist): number => {
    const activity = Date.parse(playlist.lastSongAddedAt ?? "");
    if (Number.isFinite(activity)) return activity;
    const created = Date.parse(playlist.createdAt ?? "");
    if (Number.isFinite(created)) return created;
    const localId = /^playlist-(\d+)$/.exec(playlist.id);
    return localId ? Number(localId[1]) : 0;
  };
  return [...playlists].sort((a, b) => activityAt(b) - activityAt(a));
}
