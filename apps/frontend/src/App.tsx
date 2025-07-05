import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { Library, Search, Heart, Clock, ListMusic } from "lucide-react";
import { MUSIC_HOME_QUERY } from "./api";
import { Player } from "./features/player/Player";
import { PlaylistPanel } from "./features/playlists/PlaylistPanel";
import { SearchPanel } from "./features/search/SearchPanel";
import { Dashboard } from "./features/dashboard/Dashboard";

export type Song = {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  durationSeconds: number;
  streamUrl: string;
  genreNames: string[];
  score?: number;
};

export type ClientPlaylist = {
  id: string;
  name: string;
  songIds: string[];
};

type View = "library" | "search" | "favorites" | "recent" | "queue" | "playlists";

const fallbackSongs: Song[] = [
  {
    id: "demo-1",
    title: "Cloudline",
    artistName: "The Latency",
    albumTitle: "Regions",
    durationSeconds: 213,
    streamUrl: "/demo/cloudline.mp3",
    genreNames: ["electronic", "ambient"]
  },
  {
    id: "demo-2",
    title: "Packet Chorus",
    artistName: "Blue Queue",
    albumTitle: "Async Hearts",
    durationSeconds: 188,
    streamUrl: "/demo/packet-chorus.mp3",
    genreNames: ["indie", "pop"]
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
  const [activeView, setActiveView] = useState<View>("library");
  const [activeSong, setActiveSong] = useState<Song | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [playSignal, setPlaySignal] = useState(0);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStringArray("wavestack:favorites"));
  const [recentSongIds, setRecentSongIds] = useState<string[]>(() => readStringArray("wavestack:recent"));
  const [playlists, setPlaylists] = useState<ClientPlaylist[]>(readPlaylists);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");

  const { data, loading, error, refetch } = useQuery(MUSIC_HOME_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const songs = useMemo<Song[]>(
    () => uniqueSongsById(data?.songs?.length ? data.songs : fallbackSongs),
    [data]
  );

  const songById = useMemo(() => {
    return new Map(songs.map((song) => [song.id, song]));
  }, [songs]);

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
  }

  function queueSong(song: Song) {
    setQueue((items) => {
      if (items.some((item) => item.id === song.id)) {
        return items;
      }

      return [...items, song];
    });
  }

  function removeFromQueue(songId: string) {
    setQueue((items) => items.filter((song) => song.id !== songId));
  }

  function toggleFavorite(song: Song) {
    setFavoriteIds((items) => {
      if (items.includes(song.id)) {
        return items.filter((id) => id !== song.id);
      }

      return [song.id, ...items];
    });
  }

  function createPlaylist(name: string) {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    const playlist: ClientPlaylist = {
      id: `playlist-${Date.now()}`,
      name: trimmed,
      songIds: []
    };

    setPlaylists((items) => [...items, playlist]);
    setSelectedPlaylistId(playlist.id);
    setActiveView("playlists");
  }

  function deletePlaylist(playlistId: string) {
    setPlaylists((items) => items.filter((playlist) => playlist.id !== playlistId));
  }

  function addToPlaylist(playlistId: string, song: Song) {
    if (!playlistId) {
      const name = window.prompt("Name your new playlist", "My Playlist");

      if (!name) {
        return;
      }

      const playlist: ClientPlaylist = {
        id: `playlist-${Date.now()}`,
        name,
        songIds: [song.id]
      };

      setPlaylists((items) => [...items, playlist]);
      setSelectedPlaylistId(playlist.id);
      setActiveView("playlists");
      return;
    }

    setPlaylists((items) =>
      items.map((playlist) => {
        if (playlist.id !== playlistId || playlist.songIds.includes(song.id)) {
          return playlist;
        }

        return {
          ...playlist,
          songIds: [...playlist.songIds, song.id]
        };
      })
    );
  }

  function removeFromPlaylist(playlistId: string, songId: string) {
    setPlaylists((items) =>
      items.map((playlist) => {
        if (playlist.id !== playlistId) {
          return playlist;
        }

        return {
          ...playlist,
          songIds: playlist.songIds.filter((id) => id !== songId)
        };
      })
    );
  }

  const viewTitle: Record<View, string> = {
    library: "Library",
    search: "Search",
    favorites: "Favorites",
    recent: "Recently Played",
    queue: "Queue",
    playlists: "Playlists"
  };

  const visibleSongs = activeView === "favorites"
    ? favoriteSongs
    : activeView === "recent"
      ? recentSongs
      : activeView === "queue"
        ? queue
        : songs;

  return (
    <main>
      <header>
        <h1>WaveStack</h1>
        <p>Cloud-native music streaming platform</p>

        <nav aria-label="Primary">
          <button type="button" onClick={() => setActiveView("library")} aria-pressed={activeView === "library"}>
            <Library aria-hidden="true" /> Library
          </button>
          <button type="button" onClick={() => setActiveView("search")} aria-pressed={activeView === "search"}>
            <Search aria-hidden="true" /> Search
          </button>
          <button type="button" onClick={() => setActiveView("favorites")} aria-pressed={activeView === "favorites"}>
            <Heart aria-hidden="true" /> Favorites ({favoriteSongs.length})
          </button>
          <button type="button" onClick={() => setActiveView("recent")} aria-pressed={activeView === "recent"}>
            <Clock aria-hidden="true" /> Recent ({recentSongs.length})
          </button>
          <button type="button" onClick={() => setActiveView("queue")} aria-pressed={activeView === "queue"}>
            <ListMusic aria-hidden="true" /> Queue ({queue.length})
          </button>
          <button type="button" onClick={() => setActiveView("playlists")} aria-pressed={activeView === "playlists"}>
            Playlists ({playlists.length})
          </button>
          <button type="button" onClick={() => void refetch()}>
            Refresh Drive
          </button>
        </nav>
      </header>

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
          }}
          onQueueRemove={removeFromQueue}
          onQueueClear={() => setQueue([])}
        />
      </section>

      <section aria-label="Dashboard">
        <Dashboard
          loading={loading}
          songs={songs}
          favorites={favoriteSongs}
          recentlyPlayed={recentSongs}
          onPlay={playSong}
        />
      </section>

      {activeView === "playlists" ? (
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
      ) : (
        <section aria-label={viewTitle[activeView]}>
          <SearchPanel
            title={viewTitle[activeView]}
            songs={visibleSongs}
            playlists={playlists}
            selectedPlaylistId={selectedPlaylistId}
            favoriteIds={favoriteIds}
            emptyMessage={
              activeView === "favorites"
                ? "No favorite songs yet."
                : activeView === "recent"
                  ? "No recently played songs yet."
                  : activeView === "queue"
                    ? "Your queue is empty."
                    : "No songs found."
            }
            onSelectedPlaylistChange={setSelectedPlaylistId}
            onCreatePlaylist={createPlaylist}
            onAddToPlaylist={addToPlaylist}
            onPlay={playSong}
            onQueue={queueSong}
            onToggleFavorite={toggleFavorite}
          />
        </section>
      )}
    </main>
  );
}
