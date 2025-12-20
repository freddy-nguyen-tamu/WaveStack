import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { Activity, Clock, Heart, Library, ListMusic, Search, UserCircle } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import {
    LISTENING_HABIT_SUMMARY_QUERY,
    ME_QUERY,
    MUSIC_HOME_QUERY,
    RECOMMENDED_SONGS_QUERY,
    RECORD_LISTEN_MUTATION,
    SONG_PAGE_QUERY
  } from "./api";
import { Player } from "./features/player/Player";
import { PlaylistPanel } from "./features/playlists/PlaylistPanel";
import { SearchPanel } from "./features/search/SearchPanel";
import { Dashboard } from "./features/dashboard/Dashboard";
import { SongMetadataModal } from "./features/dashboard/SongMetadataModal";
import { AuthPanel } from "./features/auth/AuthPanel";
import { OAuthCallbackPage } from "./features/auth/OAuthCallbackPage";
import { ProfilePage } from "./features/profile/ProfilePage";
import { QueueDrawer } from "./features/queue/QueueDrawer";
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
  localThumbnailUrl?: string;
  driveThumbnailUrl?: string;
  embeddedArtworkUrl?: string;
  lyrics?: string;
  webViewLink?: string;
  mimeType?: string;
  modifiedTime?: string;
  sizeBytes?: number;
  sourceRootFolderId?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type RecommendResult = {
  song: Song;
  reason: string;
};

export type HabitSummaryEntry = {
  label: string;
  count: number;
  totalDurationSeconds: number;
};

export type ClientPlaylist = {
  id: string;
  name: string;
  songIds: string[];
};

type SongPageQueryData = {
  songPage: {
    nodes: Song[];
    pageInfo: {
      endCursor?: string | null;
      hasNextPage: boolean;
    };
    totalCount: number;
  };
};

type SongPageQueryVariables = {
  first: number;
  after?: string | null;
  query?: string | null;
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
    driveThumbnailUrl: undefined,
    embeddedArtworkUrl: undefined,
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
    driveThumbnailUrl: undefined,
    embeddedArtworkUrl: undefined,
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
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [detailsSong, setDetailsSong] = useState<Song | null>(null);

  const [authUser, setAuthUser] = useState<AuthUser | null>(() => {
    try {
      const stored = window.localStorage.getItem("wavestack:auth-user");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [authToken, setAuthToken] = useState<string | null>(() => {
    return window.localStorage.getItem("wavestack:auth-token");
  });

  const [recommendedData, setRecommendedData] = useState<RecommendResult[] | null>(null);
  const [habitSummaries, setHabitSummaries] = useState<Record<string, HabitSummaryEntry[]>>({});
  const [recordListen] = useMutation(RECORD_LISTEN_MUTATION);
  const lastListenRef = useRef("");
  const hasToken = Boolean(authToken);

  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const [librarySongs, setLibrarySongs] = useState<Song[]>([]);

  const { data: meData, refetch: refetchMe } = useQuery(ME_QUERY, {
    skip: !hasToken,
    fetchPolicy: "network-only"
  });

  useEffect(() => {
    if (meData?.me) {
      setAuthUser(meData.me);
      window.localStorage.setItem("wavestack:auth-user", JSON.stringify(meData.me));
    }
  }, [meData]);

  useEffect(() => {
    if (authToken) {
      void refetchMe();
    }
  }, [authToken, refetchMe]);

  const { data, loading, error, refetch } = useQuery(MUSIC_HOME_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const songs = useMemo<Song[]>(
    () => uniqueSongsById(data?.dashboardSongs?.length ? data.dashboardSongs : fallbackSongs),
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

  const {
    data: libraryData,
    fetchMore: fetchMoreLibrary
  } = useQuery<SongPageQueryData, SongPageQueryVariables>(SONG_PAGE_QUERY, {
    variables: { first: 50, after: null, query: null },
    fetchPolicy: "cache-and-network"
  });

  useEffect(() => {
    if (libraryData?.songPage?.nodes) {
      setLibrarySongs(libraryData.songPage.nodes);
      setLibraryCursor(libraryData.songPage.pageInfo.endCursor ?? null);
    }
  }, [libraryData]);

  async function loadMoreLibrary() {
    if (!libraryCursor) return;

    const result = await fetchMoreLibrary({
      variables: {
        first: 50,
        after: libraryCursor,
        query: null
      }
    });

    const page = result.data?.songPage;

    if (page?.nodes) {
      setLibrarySongs((items) => uniqueSongsById([...items, ...page.nodes]));
      setLibraryCursor(page.pageInfo.endCursor ?? null);
    }
  }

  useEffect(() => {
    window.localStorage.setItem("wavestack:favorites", JSON.stringify(favoriteIds));
  }, [favoriteIds]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:recent", JSON.stringify(recentSongIds));
  }, [recentSongIds]);

  useEffect(() => {
    if (!detailsSong) {
      document.body.classList.remove("modal-open");
      return;
    }

    document.body.classList.add("modal-open");

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDetailsSong(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [detailsSong]);

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

    setActiveSong((currentSong) => {
      if (currentSong && songById.has(currentSong.id)) {
        return currentSong;
      }

      return songs[0];
    });
  }, [songs, songById]);

  const currentSong = activeSong ?? songs[0] ?? fallbackSongs[0];
  const queueRef = useRef(queue);
  queueRef.current = queue;

  function showNotice(message: string) {
    setNotice(message);
  }

  function rememberRecent(song: Song) {
    setRecentSongIds((items) => [song.id, ...items.filter((id) => id !== song.id)].slice(0, 50));
  }

  function playSong(song: Song) {
    setActiveSong(song);
    rememberRecent(song);
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

  function logout() {
    window.localStorage.removeItem("wavestack:auth-token");
    window.localStorage.removeItem("wavestack:auth-user");
    setAuthToken(null);
    setAuthUser(null);
    setRecommendedData(null);
    setHabitSummaries({});
    showNotice("Signed out.");
  }

  const meLoading = !authUser && hasToken;

  function getAuthToken(): string | null {
    return window.localStorage.getItem("wavestack:auth-token");
  }

  useEffect(() => {
    if (!getAuthToken()) {
      setRecommendedData(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getAuthToken()}`
          },
          body: JSON.stringify({
            query: RECOMMENDED_SONGS_QUERY.loc?.source?.body ?? "",
            variables: {
              limit: 24,
              favoriteSongIds: favoriteIds,
              recentSongIds
            }
          })
        });

        const json = await response.json() as { data?: { recommendedSongs?: RecommendResult[] } };

        if (json.data?.recommendedSongs) {
          setRecommendedData(json.data.recommendedSongs);
        }

        const periods = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

        for (const period of periods) {
          const summaryResponse = await fetch(import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({
              query: LISTENING_HABIT_SUMMARY_QUERY.loc?.source?.body ?? "",
              variables: { period }
            })
          });

          const summaryJson = await summaryResponse.json() as { data?: { listeningHabitSummary?: HabitSummaryEntry[] } };

          const summaryPeriodData = summaryJson.data?.listeningHabitSummary;
          if (summaryPeriodData) {
            setHabitSummaries((prev) => {
              const next: Record<string, HabitSummaryEntry[]> = {};
              for (const key of Object.keys(prev)) {
                next[key] = prev[key];
              }
              next[period] = summaryPeriodData;
              return next;
            });
          }
        }
      } catch {
        // silently fail — non-critical data
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [authToken, favoriteIds, recentSongIds]);

  useEffect(() => {
    if (!authUser || !currentSong) return;

    const key = `${authUser.id}:${currentSong.id}`;

    if (key === lastListenRef.current) return;
    lastListenRef.current = key;

    const timer = setTimeout(() => {
      void recordListen({
        variables: {
          songId: currentSong.id,
          artistName: currentSong.artistName,
          title: currentSong.title,
          durationSeconds: currentSong.durationSeconds || 0,
          completedPlayRatio: 0
        }
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, [authUser, currentSong, recordListen]);

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
        <div className="app-header__top">
          <div>
            <h1>WaveStack</h1>
            <p>Cloud-native music streaming platform</p>
          </div>

          <NavLink
            to="/profile"
            className="profile-shortcut"
            aria-label={authUser ? `Open profile for ${authUser.displayName}` : "Open profile"}
          >
            {authUser?.avatarUrl ? (
              <img src={authUser.avatarUrl} alt="" />
            ) : (
              <UserCircle aria-hidden="true" />
            )}
            <span>{authUser ? authUser.displayName : "Profile"}</span>
          </NavLink>
        </div>

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
          <button type="button" onClick={() => setQueueDrawerOpen(true)} aria-label="Open queue">
            <ListMusic aria-hidden="true" /> Queue ({queue.length})
          </button>
          <NavLink to="/playlists">
            Playlists ({playlists.length})
          </NavLink>
        </nav>

        <AuthPanel
          user={authUser}
          onLogout={logout}
        />
      </header>

      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <section role="alert">
          <h2>Could not load music library</h2>
          <p>{error.message}</p>
        </section>
      ) : null}

      <section aria-label="Player">
        <Player
          activeSong={currentSong}
          queue={queue}
          playSignal={playSignal}
          isFavorite={favoriteIds.includes(currentSong.id)}
          onToggleFavorite={() => toggleFavorite(currentSong)}
          onQueueChange={setQueue}
          onActiveSongChange={(song) => {
            setActiveSong(song);
            rememberRecent(song);
            showNotice(`Selected: ${formatSongDisplayName(song)}`);
          }}
          onOpenDetails={setDetailsSong}
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
                recommendedData={recommendedData}
                habitSummaries={habitSummaries}
                onPlay={playSong}
                userName={authUser?.displayName}
              />
            </section>
          }
        />
        <Route
          path="/library"
          element={
            <section aria-label="Library">
              <SearchPanel
                pageKey="Library"
                title="Library"
                songs={librarySongs.length ? librarySongs : songs}
                playlists={playlists}
                selectedPlaylistId={selectedPlaylistId}
                favoriteIds={favoriteIds}
                emptyMessage="No songs found."
                onSelectedPlaylistChange={setSelectedPlaylistId}
                onCreatePlaylist={createPlaylist}
                onAddToPlaylist={addToPlaylist}
                onPlay={playSong}
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
              />

              {libraryCursor ? (
                <div className="load-more-row">
                  <button type="button" onClick={() => void loadMoreLibrary()}>
                    Load more songs
                  </button>
                </div>
              ) : null}
            </section>
          }
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
        <Route
          path="/profile"
          element={
            <ProfilePage
              user={authUser}
              favorites={favoriteSongs}
              recentlyPlayed={recentSongs}
              queueLength={queue.length}
              habitSummaries={habitSummaries}
              onLogout={logout}
              onPlay={playSong}
            />
          }
        />
        <Route
          path="/oauth-callback"
          element={
            <OAuthCallbackPage
              onToken={(token) => {
                setAuthToken(token);
                showNotice("Signed in with Google.");
              }}
              onError={showNotice}
            />
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>

      {detailsSong ? (
        <SongMetadataModal
          song={detailsSong}
          onPlay={() => playSong(detailsSong)}
          onClose={() => setDetailsSong(null)}
        />
      ) : null}

      <QueueDrawer
        open={queueDrawerOpen}
        queue={queue}
        currentSongId={currentSong.id}
        onClose={() => setQueueDrawerOpen(false)}
        onPlay={(song) => {
          playSong(song);
        }}
        onRemove={removeFromQueue}
        onClear={() => {
          setQueue([]);
          showNotice("Queue cleared.");
        }}
      />

      <div className="bottom-player-spacer" aria-hidden="true" />
    </main>
  );
}
