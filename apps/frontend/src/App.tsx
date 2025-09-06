import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { Activity, Clock, Heart, Library, ListMusic, Search } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { MUSIC_HOME_QUERY } from "./api";
import { Player } from "./features/player/Player";
import { PlaylistPanel } from "./features/playlists/PlaylistPanel";
import { SearchPanel } from "./features/search/SearchPanel";
import { Dashboard } from "./features/dashboard/Dashboard";
import { formatSongDisplayName } from "./song-format";

export type Song = {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  durationSeconds: number;
  streamUrl: string;
  genreNames: string[];
  score?: number;
  thumbnailUrl?: string;
  lyrics?: string;
  webViewLink?: string;
  mimeType?: string;
  modifiedTime?: string;
  sizeBytes?: number;
  sourceRootFolderId?: string;
};

export type ClientPlaylist = {
  id: string;
  name: string;
  songIds: string[];
};

const fallbackSongs: Song[] = [
  {
    id: "demo-1",
    title: "Cloudline",
    artistName: "The Latency",
    albumTitle: "Regions",
    durationSeconds: 213,
    streamUrl: "/demo/cloudline.mp3",
    genreNames: ["electronic", "ambient"],
    thumbnailUrl: "https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=900&q=80",
    lyrics: "Instrumental demo track."
  },
  {
    id: "demo-2",
    title: "Packet Chorus",
    artistName: "Blue Queue",
    albumTitle: "Async Hearts",
    durationSeconds: 188,
    streamUrl: "/demo/packet-chorus.mp3",
    genreNames: ["indie", "pop"],
    thumbnailUrl: "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80",
    lyrics: "Demo lyrics placeholder."
  }
];

function readStringArray(key: string): string[] {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function readPlaylists(): ClientPlaylist[] {
  try {
    const value = window.localStorage.getItem("wavestack:playlists");
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function uniqueSongsById(songs: Song[]): Song[] {
  return Array.from(new Map(songs.map((song) => [song.id, song])).values());
}

export function App() {
  const [activeSong, setActiveSong] = useState<Song | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [playSignal, setPlaySignal] = useState(0);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStringArray("wavestack:favorites"));
  const [recentSongIds, setRecentSongIds] = useState<string[]>(() => readStringArray("wavestack:recent"));
  const [playlists, setPlaylists] = useState<ClientPlaylist[]>(readPlaylists);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");

  const { data, loading, error, refetch } = useQuery(MUSIC_HOME_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const songs = useMemo<Song[]>(
    () => uniqueSongsById(data?.songs?.length ? data.songs : fallbackSongs),
    [data]
  );

  const songById = useMemo(() => new Map(songs.map((song) => [song.id, song])), [songs]);

  const favoriteSongs = useMemo(() => {
    return favoriteIds
      .map((id) => songById.get(id))
      .filter((song): song is Song => Boolean(song));
  }, [favoriteIds, songById]);

  const recentSongs = useMemo(() => {
    return recentSongIds
      .map((id) => songById.get(id))
      .filter((song): song is Song => Boolean(song));
  }, [recentSongIds, songById]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:favorites", JSON.stringify(favoriteIds));
  }, [favoriteIds]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:recent", JSON.stringify(recentSongIds));
  }, [recentSongIds]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:playlists", JSON.stringify(playlists));
  }, [playlists]);

  useEffect(() => {
    if (!selectedPlaylistId && playlists.length) {
      setSelectedPlaylistId(playlists[0].id);
    }

    if (selectedPlaylistId && !playlists.some((playlist) => playlist.id === selectedPlaylistId)) {
      setSelectedPlaylistId(playlists[0]?.id ?? "");
    }
  }, [playlists, selectedPlaylistId]);

  useEffect(() => {
    if (!songs.length) {
      return;
    }

    setQueue((items) => {
      if (items.length && items.every((item) => songById.has(item.id))) {
        return items;
      }

      return songs.slice(0, 30);
    });

    setActiveSong((currentSong) => {
      if (currentSong && songById.has(currentSong.id)) {
        return currentSong;
      }

      return songs[0];
    });
  }, [songs, songById]);

  const currentSong = activeSong ?? songs[0] ?? fallbackSongs[0];

  function showNotice(message: string) {
    setNotice(message);
  }

  function rememberRecent(song: Song) {
    setRecentSongIds((items) => [song.id, ...items.filter((id) => id !== song.id)].slice(0, 50));
  }

  function playSong(song: Song) {
    setActiveSong(song);
    rememberRecent(song);

    setQueue((items) => {
      if (items.some((item) => item.id === song.id)) {
        return items;
      }

      return [song, ...items];
    });

    setPlaySignal((value) => value + 1);
    showNotice(`Now playing: ${formatSongDisplayName(song)}`);
  }

  function queueSong(song: Song) {
    if (queue.some((item) => item.id === song.id)) {
      showNotice(`${formatSongDisplayName(song)} is already in the queue.`);
      return;
    }

    setQueue((items) => [...items, song]);
    showNotice(`Queued: ${formatSongDisplayName(song)}`);
  }

  function removeFromQueue(songId: string) {
    const song = queue.find((item) => item.id === songId);
    setQueue((items) => items.filter((item) => item.id !== songId));
    showNotice(song ? `Removed from queue: ${formatSongDisplayName(song)}` : "Removed song from queue.");
  }

  function toggleFavorite(song: Song) {
    const isFavorite = favoriteIds.includes(song.id);

    setFavoriteIds((items) => {
      if (items.includes(song.id)) {
        return items.filter((id) => id !== song.id);
      }

      return [song.id, ...items];
    });

    showNotice(
      isFavorite
        ? `Removed favorite: ${formatSongDisplayName(song)}`
        : `Added favorite: ${formatSongDisplayName(song)}`
    );
  }

  function createPlaylist(name: string) {
    const trimmed = name.trim();

    if (!trimmed) {
      showNotice("Playlist name cannot be empty.");
      return;
    }

    const playlist: ClientPlaylist = {
      id: `playlist-${Date.now()}`,
      name: trimmed,
      songIds: []
    };

    setPlaylists((items) => [...items, playlist]);
    setSelectedPlaylistId(playlist.id);
    showNotice(`Created playlist: ${playlist.name}`);
  }

  function deletePlaylist(playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    setPlaylists((items) => items.filter((item) => item.id !== playlistId));
    showNotice(playlist ? `Deleted playlist: ${playlist.name}` : "Deleted playlist.");
  }

  function addToPlaylist(playlistId: string, song: Song) {
    if (!playlistId) {
      const name = window.prompt("Name your new playlist", "My Playlist");

      if (!name) {
        showNotice("Add to playlist cancelled.");
        return;
      }

      const trimmed = name.trim();

      if (!trimmed) {
        showNotice("Playlist name cannot be empty.");
        return;
      }

      const playlist: ClientPlaylist = {
        id: `playlist-${Date.now()}`,
        name: trimmed,
        songIds: [song.id]
      };

      setPlaylists((items) => [...items, playlist]);
      setSelectedPlaylistId(playlist.id);
      showNotice(`Created ${playlist.name} and added ${formatSongDisplayName(song)}.`);
      return;
    }

    const playlist = playlists.find((item) => item.id === playlistId);

    if (!playlist) {
      showNotice("Select or create a playlist first.");
      return;
    }

    if (playlist.songIds.includes(song.id)) {
      showNotice(`${formatSongDisplayName(song)} is already in ${playlist.name}.`);
      return;
    }

    setPlaylists((items) =>
      items.map((item) => {
        if (item.id !== playlistId) {
          return item;
        }

        return {
          ...item,
          songIds: [...item.songIds, song.id]
        };
      })
    );

    showNotice(`Added ${formatSongDisplayName(song)} to ${playlist.name}.`);
  }

  function removeFromPlaylist(playlistId: string, songId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    const song = songById.get(songId);

    setPlaylists((items) =>
      items.map((item) => {
        if (item.id !== playlistId) {
          return item;
        }

        return {
          ...item,
          songIds: item.songIds.filter((id) => id !== songId)
        };
      })
    );

    showNotice(
      playlist && song
        ? `Removed ${formatSongDisplayName(song)} from ${playlist.name}.`
        : "Removed song from playlist."
    );
  }

  async function refreshDrive() {
    setRefreshNotice("Refreshing Drive library...");

    try {
      await refetch();
      setRefreshNotice("Drive library refreshed.");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "Unknown refresh error.";
      setRefreshNotice(`Refresh failed: ${message}`);
    }
  }

  function renderSongsPage(title: string, pageSongs: Song[], emptyMessage: string) {
    return (
      <section aria-label={title}>
        <SearchPanel
          key={title}
          pageKey={title}
          title={title}
          songs={pageSongs}
          playlists={playlists}
          selectedPlaylistId={selectedPlaylistId}
          favoriteIds={favoriteIds}
          emptyMessage={emptyMessage}
          onSelectedPlaylistChange={setSelectedPlaylistId}
          onCreatePlaylist={createPlaylist}
          onAddToPlaylist={addToPlaylist}
          onPlay={playSong}
          onQueue={queueSong}
          onToggleFavorite={toggleFavorite}
        />
      </section>
    );
  }

  return (
    <main>
      <header>
        <h1>WaveStack</h1>
        <p>Cloud-native music streaming platform</p>

        <nav aria-label="Primary">
          <NavLink to="/dashboard">
            <Activity aria-hidden="true" /> Dashboard
          </NavLink>
          <NavLink to="/library">
            <Library aria-hidden="true" /> Library
          </NavLink>
          <NavLink to="/search">
            <Search aria-hidden="true" /> Search
          </NavLink>
          <NavLink to="/favorites">
            <Heart aria-hidden="true" /> Favorites ({favoriteSongs.length})
          </NavLink>
          <NavLink to="/recent">
            <Clock aria-hidden="true" /> Recent ({recentSongs.length})
          </NavLink>
          <NavLink to="/queue">
            <ListMusic aria-hidden="true" /> Queue ({queue.length})
          </NavLink>
          <NavLink to="/playlists">
            Playlists ({playlists.length})
          </NavLink>
          <button type="button" onClick={() => void refreshDrive()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Drive"}
          </button>
        </nav>
      </header>

      {notice ? <p role="status">{notice}</p> : null}
      {refreshNotice ? <p role="status">{refreshNotice}</p> : null}

      {error ? (
        <section role="alert">
          <h2>Could not load music library</h2>
          <p>{error.message}</p>
        </section>
      ) : null}

      <section aria-label="Player">
        <Player
          activeSong={currentSong}
          queue={queue.length ? queue : songs.slice(0, 30)}
          playSignal={playSignal}
          isFavorite={favoriteIds.includes(currentSong.id)}
          onToggleFavorite={() => toggleFavorite(currentSong)}
          onQueueChange={setQueue}
          onActiveSongChange={(song) => {
            setActiveSong(song);
            rememberRecent(song);
            showNotice(`Selected: ${formatSongDisplayName(song)}`);
          }}
          onQueueRemove={removeFromQueue}
          onQueueClear={() => {
            setQueue([]);
            showNotice("Queue cleared.");
          }}
        />
      </section>

      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/dashboard"
          element={
            <section aria-label="Dashboard">
              <Dashboard
                loading={loading}
                songs={songs}
                favorites={favoriteSongs}
                recentlyPlayed={recentSongs}
                onPlay={playSong}
              />
            </section>
          }
        />
        <Route
          path="/library"
          element={renderSongsPage("Library", songs, "No songs found.")}
        />
        <Route
          path="/search"
          element={renderSongsPage("Search", songs, "No songs found.")}
        />
        <Route
          path="/favorites"
          element={renderSongsPage("Favorites", favoriteSongs, "No favorite songs yet. Click Favorite on a song first.")}
        />
        <Route
          path="/recent"
          element={renderSongsPage("Recently Played", recentSongs, "No recently played songs yet. Click Play on a song first.")}
        />
        <Route
          path="/queue"
          element={renderSongsPage("Queue", queue, "Your queue is empty. Click Queue on songs first.")}
        />
        <Route
          path="/playlists"
          element={
            <section aria-label="Playlists">
              <PlaylistPanel
                songs={songs}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
                favoriteIds={favoriteIds}
                onSelectedPlaylistChange={setSelectedPlaylistId}
                onCreatePlaylist={createPlaylist}
                onDeletePlaylist={deletePlaylist}
                onAddToPlaylist={addToPlaylist}
                onRemoveFromPlaylist={removeFromPlaylist}
                onPlay={playSong}
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
              />
            </section>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>

      <div className="bottom-player-spacer" aria-hidden="true" />
    </main>
  );
}
