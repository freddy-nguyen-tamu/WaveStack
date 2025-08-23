import { Heart, ListPlus, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ClientPlaylist, Song } from "../../App";

type SearchPanelProps = {
  pageKey: string;
  title: string;
  songs: Song[];
  playlists: ClientPlaylist[];
  selectedPlaylistId: string;
  favoriteIds: string[];
  emptyMessage?: string;
  onSelectedPlaylistChange: (playlistId: string) => void;
  onCreatePlaylist: (name: string) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
};

const PAGE_SIZE = 30;

export function SearchPanel({
  pageKey,
  title,
  songs,
  playlists,
  selectedPlaylistId,
  favoriteIds,
  emptyMessage = "No songs found.",
  onSelectedPlaylistChange,
  onCreatePlaylist,
  onAddToPlaylist,
  onPlay,
  onQueue,
  onToggleFavorite
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState("");

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return songs;
    }

    return songs.filter((song) => {
      const haystack = [
        song.title,
        song.artistName,
        song.albumTitle,
        ...song.genreNames
      ].join(" ").toLowerCase();

      return haystack.includes(needle);
    });
  }, [query, songs]);

  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSongs = results.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    setQuery("");
    setPage(1);
    setMessage("");
  }, [pageKey]);

  useEffect(() => {
    setPage(1);
  }, [query, songs.length]);

  function createPlaylistFromPrompt() {
    const name = window.prompt("Playlist name", "My Playlist");

    if (name) {
      onCreatePlaylist(name);
      setMessage(`Created playlist: ${name.trim()}`);
      return;
    }

    setMessage("Playlist creation cancelled.");
  }

  function play(song: Song) {
    onPlay(song);
    setMessage(`Playing: ${song.title}`);
  }

  function queue(song: Song) {
    onQueue(song);
    setMessage(`Queue action sent for: ${song.title}`);
  }

  function toggleFavorite(song: Song, isFavorite: boolean) {
    onToggleFavorite(song);
    setMessage(isFavorite ? `Removed favorite: ${song.title}` : `Added favorite: ${song.title}`);
  }

  function add(song: Song) {
    onAddToPlaylist(selectedPlaylistId, song);
    setMessage(`Playlist action sent for: ${song.title}`);
  }

  return (
    <article>
      <h2>{title}</h2>

      <label>
        <Search aria-hidden="true" /> Song, artist, album, or genre
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      <div>
        <label>
          Playlist
          <select
            value={selectedPlaylistId}
            onChange={(event) => onSelectedPlaylistChange(event.target.value)}
          >
            <option value="">Create/select playlist</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name} ({playlist.songIds.length})
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={createPlaylistFromPrompt}>
          <ListPlus aria-hidden="true" /> New playlist
        </button>
      </div>

      {message ? <p role="status">{message}</p> : null}

      <p>
        Showing {pagedSongs.length} of {results.length} song(s). Page {currentPage} of {pageCount}.
      </p>

      {pageCount > 1 ? (
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
      ) : (
        <p>Pagination appears after more than {PAGE_SIZE} matching songs.</p>
      )}

      {pagedSongs.length ? (
        <ul>
          {pagedSongs.map((song) => {
            const isFavorite = favoriteIds.includes(song.id);

            return (
              <li key={song.id}>
                <button type="button" onClick={() => play(song)}>
                  <Play aria-hidden="true" /> Play
                </button>

                <button type="button" onClick={() => queue(song)}>
                  Queue
                </button>

                <button type="button" onClick={() => toggleFavorite(song, isFavorite)} aria-pressed={isFavorite}>
                  <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
                </button>

                <button type="button" onClick={() => add(song)}>
                  <ListPlus aria-hidden="true" /> Add to playlist
                </button>

                <strong>{song.title}</strong> - {song.artistName} - {song.albumTitle}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{emptyMessage}</p>
      )}
    </article>
  );
}
