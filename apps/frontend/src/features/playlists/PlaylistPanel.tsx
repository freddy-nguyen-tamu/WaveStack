import { Heart, ListPlus, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ClientPlaylist, Song } from "../../App";

type PlaylistPanelProps = {
  songs: Song[];
  playlists: ClientPlaylist[];
  selectedPlaylistId: string;
  favoriteIds: string[];
  onSelectedPlaylistChange: (playlistId: string) => void;
  onCreatePlaylist: (name: string) => void;
  onDeletePlaylist: (playlistId: string) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onRemoveFromPlaylist: (playlistId: string, songId: string) => void;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
};

const PAGE_SIZE = 30;

export function PlaylistPanel({
  songs,
  playlists,
  selectedPlaylistId,
  favoriteIds,
  onSelectedPlaylistChange,
  onCreatePlaylist,
  onDeletePlaylist,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onPlay,
  onQueue,
  onToggleFavorite
}: PlaylistPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const songById = useMemo(() => new Map(songs.map((song) => [song.id, song])), [songs]);

  const selectedPlaylistSongs = useMemo(() => {
    if (!selectedPlaylist) {
      return [];
    }

    return selectedPlaylist.songIds
      .map((songId) => songById.get(songId))
      .filter((song): song is Song => Boolean(song));
  }, [selectedPlaylist, songById]);

  const libraryResults = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return songs;
    }

    return songs.filter((song) =>
      [song.title, song.artistName, song.albumTitle, ...song.genreNames]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, songs]);

  const pageCount = Math.max(1, Math.ceil(libraryResults.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSongs = libraryResults.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [query, songs.length]);

  function createPlaylistFromPrompt() {
    const name = window.prompt("Playlist name", "My Playlist");

    if (name) {
      onCreatePlaylist(name);
    }
  }

  return (
    <article>
      <h2>Playlists</h2>

      <button type="button" onClick={createPlaylistFromPrompt}>
        <ListPlus aria-hidden="true" /> New playlist
      </button>

      {playlists.length ? (
        <ul>
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <button type="button" onClick={() => onSelectedPlaylistChange(playlist.id)}>
                {playlist.id === selectedPlaylistId ? "Selected: " : "Open: "}
                {playlist.name} ({playlist.songIds.length})
              </button>
              <button type="button" onClick={() => onDeletePlaylist(playlist.id)}>
                <Trash2 aria-hidden="true" /> Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No playlists yet. Create one with the New playlist button.</p>
      )}

      {selectedPlaylist ? (
        <section>
          <h3>{selectedPlaylist.name}</h3>

          {selectedPlaylistSongs.length ? (
            <ol>
              {selectedPlaylistSongs.map((song) => {
                const isFavorite = favoriteIds.includes(song.id);

                return (
                  <li key={song.id}>
                    <button type="button" onClick={() => onPlay(song)}>
                      <Play aria-hidden="true" /> Play
                    </button>
                    <button type="button" onClick={() => onQueue(song)}>
                      Queue
                    </button>
                    <button type="button" onClick={() => onToggleFavorite(song)} aria-pressed={isFavorite}>
                      <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
                    </button>
                    <button type="button" onClick={() => onRemoveFromPlaylist(selectedPlaylist.id, song.id)}>
                      <Trash2 aria-hidden="true" /> Remove
                    </button>
                    <strong>{song.title}</strong> - {song.artistName}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p>This playlist is empty. Add songs below.</p>
          )}
        </section>
      ) : null}

      <section>
        <h3>Add songs to playlist</h3>

        <label>
          Search library
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>

        <p>
          Showing {pagedSongs.length} of {libraryResults.length} song(s). Page {currentPage} of {pageCount}.
        </p>

        <div aria-label="Pagination">
          <button type="button" onClick={() => setPage(1)} disabled={currentPage === 1}>
            First
          </button>
          <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1}>
            Previous
          </button>
          <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount}>
            Next
          </button>
          <button type="button" onClick={() => setPage(pageCount)} disabled={currentPage === pageCount}>
            Last
          </button>
        </div>

        <ul>
          {pagedSongs.map((song) => (
            <li key={song.id}>
              <button type="button" onClick={() => onAddToPlaylist(selectedPlaylistId, song)}>
                <ListPlus aria-hidden="true" /> Add to playlist
              </button>
              <button type="button" onClick={() => onPlay(song)}>
                <Play aria-hidden="true" /> Play
              </button>
              {song.title} - {song.artistName}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
