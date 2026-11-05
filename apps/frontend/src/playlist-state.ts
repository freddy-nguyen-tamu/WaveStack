import type { ClientPlaylist, Song } from "./App";

export type PlaylistMembershipEdits = Map<string, Map<string, { present: boolean; song?: Song }>>;

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
  playlistEdits.set(songId, { present, song });
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
    return {
      ...playlist,
      songIds,
      songs: songIds.map(id => songById.get(id)).filter((song): song is Song => Boolean(song)),
      songCount: songIds.length
    };
  });
}

/** New playlists first, without changing relative order for unknown legacy dates. */
export function sortPlaylistsNewestFirst(playlists: ClientPlaylist[]): ClientPlaylist[] {
  const createdAt = (playlist: ClientPlaylist): number => {
    const parsed = Date.parse(playlist.createdAt ?? "");
    if (Number.isFinite(parsed)) return parsed;
    const localId = /^playlist-(\d+)$/.exec(playlist.id);
    return localId ? Number(localId[1]) : 0;
  };
  return [...playlists].sort((a, b) => createdAt(b) - createdAt(a));
}
