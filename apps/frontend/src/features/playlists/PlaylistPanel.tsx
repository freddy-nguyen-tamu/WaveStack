import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ClientPlaylist, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { SongListRow } from "../../components/SongListRow";
import { PaginationBar } from "../../components/PaginationBar";

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
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
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
  onToggleFavorite,
  onOpenDetails
}: PlaylistPanelProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState("");

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
      [song.title, song.artistName, song.albumTitle, formatSongDisplayName(song), ...song.genreNames]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, songs]);

  const pageCount = Math.max(1, Math.ceil(libraryResults.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSongs = libraryResults.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedPlaylistContext = useMemo<PlaybackContext>(() => ({
    id: selectedPlaylist ? `playlist:${selectedPlaylist.id}` : "playlist:none",
    label: selectedPlaylist?.name ?? "Playlist",
    source: "playlist",
    songs: selectedPlaylistSongs
  }), [selectedPlaylist, selectedPlaylistSongs]);
  const libraryPlaybackContext = useMemo<PlaybackContext>(() => ({
    id: `playlist-library:${query.trim() || "all"}`,
    label: query.trim() ? `Playlist library: ${query.trim()}` : "Playlist library",
    source: "all",
    songs: libraryResults
  }), [libraryResults, query]);

  useEffect(() => {
    setPage(1);
  }, [query, songs.length]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage("");
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [message]);

  function createPlaylistFromPrompt() {
    const name = window.prompt("Playlist name", "My Playlist");

    if (name) {
      onCreatePlaylist(name);
      setMessage(`Created playlist: ${name.trim()}`);
      return;
    }

    setMessage("Playlist creation cancelled.");
  }

  function selectPlaylist(playlist: ClientPlaylist) {
    onSelectedPlaylistChange(playlist.id);
    setMessage(`Opened playlist: ${playlist.name}`);
  }

  function deletePlaylist(playlist: ClientPlaylist) {
    const shouldDelete = window.confirm(`Delete playlist "${playlist.name}"?`);

    if (!shouldDelete) {
      setMessage("Playlist delete cancelled.");
      return;
    }

    onDeletePlaylist(playlist.id);
    setMessage(`Deleted playlist: ${playlist.name}`);
  }

  function add(playlistId: string, song: Song) {
    onAddToPlaylist(playlistId, song);
    setMessage(`Playlist action sent for: ${formatSongDisplayName(song)}`);
  }

  function remove(song: Song) {
    if (!selectedPlaylist) {
      setMessage("No playlist selected.");
      return;
    }

    onRemoveFromPlaylist(selectedPlaylist.id, song.id);
    setMessage(`Removed ${formatSongDisplayName(song)} from ${selectedPlaylist.name}.`);
  }

  function play(song: Song, context?: PlaybackContext) {
    onPlay(song, context);
    setMessage(`Playing: ${formatSongDisplayName(song)}`);
  }

  function queue(song: Song) {
    onQueue(song);
    setMessage(`Queue action sent for: ${formatSongDisplayName(song)}`);
  }

  function toggleFavorite(song: Song, isFavorite: boolean) {
    onToggleFavorite(song);
    setMessage(
      isFavorite
        ? `Removed favorite: ${formatSongDisplayName(song)}`
        : `Added favorite: ${formatSongDisplayName(song)}`
    );
  }

  return (
    <article>
      <h2>Playlists</h2>

      <button type="button" onClick={createPlaylistFromPrompt}>
        <ListPlus aria-hidden="true" /> New playlist
      </button>

      {message ? (
        <p className="toast-notice toast-notice--status" role="status">
          {message}
        </p>
      ) : null}

      {playlists.length ? (
        <ul>
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <button type="button" onClick={() => selectPlaylist(playlist)} aria-pressed={playlist.id === selectedPlaylistId}>
                {playlist.id === selectedPlaylistId ? "Selected: " : "Open: "}
                {playlist.name} ({playlist.songIds.length})
              </button>
              <button type="button" onClick={() => deletePlaylist(playlist)}>
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
            <ul className="song-list">
              {selectedPlaylistSongs.map((song, index) => (
                <SongListRow
                  key={song.id}
                  song={song}
                  index={index}
                  playlists={playlists}
                  favoriteIds={favoriteIds}
                  playbackContext={selectedPlaylistContext}
                  onPlay={play}
                  onQueue={queue}
                  onToggleFavorite={(item) => toggleFavorite(item, favoriteIds.includes(item.id))}
                  onAddToPlaylist={add}
                  onOpenDetails={onOpenDetails}
                  extraActions={
                    <button type="button" onClick={() => remove(song)}>
                      <Trash2 aria-hidden="true" /> Remove
                    </button>
                  }
                />
              ))}
            </ul>
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

        <ul className="song-list">
          {pagedSongs.map((song, index) => (
            <SongListRow
              key={song.id}
              song={song}
              index={(currentPage - 1) * PAGE_SIZE + index}
              playlists={playlists}
              favoriteIds={favoriteIds}
              playbackContext={libraryPlaybackContext}
              onPlay={play}
              onQueue={queue}
              onToggleFavorite={(item) => toggleFavorite(item, favoriteIds.includes(item.id))}
              onAddToPlaylist={add}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </ul>

        <PaginationBar
          currentPage={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
          label="Playlist library pagination"
        />
      </section>
    </article>
  );
}
