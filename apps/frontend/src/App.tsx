import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApolloClient, useMutation, useQuery } from "@apollo/client";
import { Activity, Clock, Heart, ListMusic, Search, TrendingUp } from "lucide-react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
    LISTENING_HABIT_SUMMARY_QUERY,
    ME_QUERY,
    MUSIC_HOME_QUERY,
    RECOMMENDED_SONGS_QUERY,
    RECORD_LISTEN_MUTATION,
    LIBRARY_STATE_QUERY,
    FAVORITE_SONG_MUTATION,
    UNFAVORITE_SONG_MUTATION,
    CREATE_USER_PLAYLIST_MUTATION,
    DELETE_USER_PLAYLIST_MUTATION,
    ADD_SONG_TO_USER_PLAYLIST_MUTATION,
    REMOVE_SONG_FROM_USER_PLAYLIST_MUTATION
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
import { StatsPage } from "./features/stats/StatsPage";
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

export type RepeatMode = "none" | "all" | "one";

export type RecommendResult = {
  song: Song;
  reason: string;
};

type RecommendedSongsPageData = {
  recommendedSongs: {
    nodes: RecommendResult[];
    totalCount: number;
    hasNextPage: boolean;
    nextOffset: number;
  };
};

type RecommendedSongsPageVariables = {
  limit?: number;
  offset?: number;
  favoriteSongIds?: string[];
  recentSongIds?: string[];
  excludedSongIds?: string[];
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
  songs?: Song[];
  songCount?: number;
  createdAt?: string;
  updatedAt?: string;
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
  }
];

const NAV_SCROLL_PATHS = new Set([
  "/dashboard",
  "/search",
  "/favorites",
  "/recent",
  "/stats",
  "/playlists"
]);

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

function readSongCache(): Song[] {
  try {
    const value = window.localStorage.getItem("wavestack:song-cache");
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function writeLocalJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not write ${key}`, error);
  }
}

export function App() {
  const location = useLocation();
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
  const pendingNavScrollRef = useRef(false);

  const [cachedSongs, setCachedSongs] = useState<Song[]>(readSongCache);

  const scrollRouteContentIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const nav = document.querySelector<HTMLElement>(".app-nav");
        const target = document.querySelector<HTMLElement>(
          "[data-route-content] h2, [data-route-content] h3"
        );

        if (!nav || !target) {
          return;
        }

        const navHeight = nav.getBoundingClientRect().height;
        const targetTop = target.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({
          top: Math.max(0, targetTop - navHeight - 8),
          behavior: "smooth"
        });
      });
    });
  }, []);

  function requestNavScroll(path: string) {
    pendingNavScrollRef.current = true;

    if (location.pathname === path) {
      pendingNavScrollRef.current = false;
      scrollRouteContentIntoView();
    }
  }

  useEffect(() => {
    if (!pendingNavScrollRef.current) {
      return;
    }

    pendingNavScrollRef.current = false;

    if (NAV_SCROLL_PATHS.has(location.pathname)) {
      scrollRouteContentIntoView();
    }
  }, [location.pathname, scrollRouteContentIntoView]);

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

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token") ?? url.searchParams.get("authToken");
    const userParam = url.searchParams.get("user");
    const authError = url.searchParams.get("authError");

    if (!token && !authError) {
      return;
    }

    if (authError) {
      showNotice(`Google login failed: ${authError}`);
      url.searchParams.delete("authError");
      window.history.replaceState({}, document.title, url.pathname);
      return;
    }

    try {
      let parsedUser: AuthUser | null = null;

      if (userParam) {
        const normalized = userParam.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
        const json = atob(padded);
        parsedUser = JSON.parse(json);
      }

      window.localStorage.setItem("wavestack:auth-token", token!);

      if (parsedUser) {
        window.localStorage.setItem("wavestack:auth-user", JSON.stringify(parsedUser));
        setAuthUser(parsedUser);
      }

      setAuthToken(token!);
      showNotice("Signed in with Google.");
    } catch (error) {
      console.error("Could not parse Google login callback", error);
      showNotice("Google login returned invalid user data.");
    } finally {
      url.searchParams.delete("token");
      url.searchParams.delete("user");
      window.history.replaceState({}, document.title, url.pathname);
    }
  }, []);

  const RECOMMENDATION_PAGE_SIZE = 24;

  const [recommendedData, setRecommendedData] = useState<RecommendResult[] | null>(null);
  const [habitSummaries, setHabitSummaries] = useState<Record<string, HabitSummaryEntry[]>>({});
  const [recordListen] = useMutation(RECORD_LISTEN_MUTATION);
  const lastListenRef = useRef("");
  const hasToken = Boolean(authToken);

  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("none");
  const [playHistory, setPlayHistory] = useState<Song[]>([]);
  const [dismissedRecommendationIds, setDismissedRecommendationIds] = useState<string[]>([]);
  const [recommendationOffset, setRecommendationOffset] = useState(0);
  const [hasMoreRecommendations, setHasMoreRecommendations] = useState(true);
  const [loadingMoreRecommendations, setLoadingMoreRecommendations] = useState(false);
  const apolloClient = useApolloClient();

  const { data: libraryStateData, refetch: refetchLibraryState } = useQuery(LIBRARY_STATE_QUERY, {
    skip: !hasToken,
    fetchPolicy: "network-only"
  });

  const dismissedRecommendationSet = useMemo(
    () => new Set(dismissedRecommendationIds),
    [dismissedRecommendationIds]
  );

  const visibleRecommendations = useMemo(
    () => recommendedData ? recommendedData.filter((item) => !dismissedRecommendationSet.has(item.song.id)) : [],
    [dismissedRecommendationSet, recommendedData]
  );

  const recommendationSongs = useMemo(
    () => visibleRecommendations.map((item) => item.song),
    [visibleRecommendations]
  );

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

  const homeRecentSongs = useMemo<Song[]>(
    () => uniqueSongsById(data?.recentlyPlayed ?? []),
    [data]
  );

  const homeRecommendationSongs = useMemo<Song[]>(
    () => uniqueSongsById(
      data?.recommendations?.map((item: RecommendResult | Song) =>
        "song" in item ? item.song : item
      ) ?? []
    ),
    [data]
  );

  const allKnownSongs = useMemo<Song[]>(() => {
    return uniqueSongsById([
      ...cachedSongs,
      ...songs,
      ...homeRecentSongs,
      ...homeRecommendationSongs,
      ...visibleRecommendations.map((item) => item.song),
      ...queue,
      ...playHistory,
      ...playlists.flatMap((playlist) => playlist.songs ?? []),
      ...(activeSong ? [activeSong] : []),
      ...(detailsSong ? [detailsSong] : [])
    ]);
  }, [
    cachedSongs,
    songs,
    homeRecentSongs,
    homeRecommendationSongs,
    visibleRecommendations,
    queue,
    playHistory,
    playlists,
    activeSong,
    detailsSong
  ]);

  const songById = useMemo(
    () => new Map(allKnownSongs.map((song) => [song.id, song])),
    [allKnownSongs]
  );

  const favoriteSongs = useMemo(() => {
    return favoriteIds
      .map((id) => songById.get(id))
      .filter((song): song is Song => Boolean(song));
  }, [favoriteIds, songById]);

  const recentSongs = useMemo(() => {
    const localRecentSongs = recentSongIds
      .map((id) => songById.get(id))
      .filter((song): song is Song => Boolean(song));

    return uniqueSongsById([...homeRecentSongs, ...localRecentSongs]);
  }, [recentSongIds, songById, homeRecentSongs]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:favorites", JSON.stringify(favoriteIds));
  }, [favoriteIds]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:recent", JSON.stringify(recentSongIds));
  }, [recentSongIds]);

  useEffect(() => {
    rememberSongObjects(songs);
  }, [songs]);

  useEffect(() => {
    rememberSongObjects(visibleRecommendations.map((item) => item.song));
  }, [visibleRecommendations]);

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
    writeLocalJson("wavestack:playlists", playlists);
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

  useEffect(() => {
    if (!authToken || !libraryStateData?.libraryState) {
      return;
    }

    const backendFavorites = libraryStateData.libraryState.favorites ?? [];
    const backendRecent = libraryStateData.libraryState.recentlyPlayed ?? [];
    const backendPlaylists = libraryStateData.libraryState.playlists ?? [];

    setFavoriteIds(backendFavorites.map((song: Song) => song.id));
    setRecentSongIds(backendRecent.map((song: Song) => song.id));
    setPlaylists(backendPlaylists);

    writeLocalJson("wavestack:favorites", backendFavorites.map((song: Song) => song.id));
    writeLocalJson("wavestack:recent", backendRecent.map((song: Song) => song.id));
    writeLocalJson("wavestack:playlists", backendPlaylists);

    rememberSongObjects([
      ...backendFavorites,
      ...backendRecent,
      ...backendPlaylists.flatMap((playlist: ClientPlaylist) => playlist.songs ?? [])
    ]);
  }, [authToken, libraryStateData]);

  const currentSong = activeSong ?? songs[0] ?? fallbackSongs[0];
  const queueRef = useRef(queue);
  queueRef.current = queue;

  function showNotice(message: string) {
    setNotice(message);
  }

  function rememberRecent(song: Song) {
    rememberSongObjects([song]);

    setRecentSongIds((items) => {
      const next = [song.id, ...items.filter((id) => id !== song.id)].slice(0, 100);
      writeLocalJson("wavestack:recent", next);
      return next;
    });

    rememberPlayedSong(song);
  }

  function rememberPlayedSong(song: Song) {
    setPlayHistory((items) => {
      const withoutDuplicate = items.filter((item) => item.id !== song.id);
      return [song, ...withoutDuplicate].slice(0, 100);
    });
  }

  function rememberSongObjects(songsToRemember: Song[]) {
    setCachedSongs((items) => {
      const next = uniqueSongsById([...songsToRemember, ...items]).slice(0, 1500);
      writeLocalJson("wavestack:song-cache", next);
      return next;
    });
  }

  function dismissRecommendation(songId: string) {
    setDismissedRecommendationIds((ids) => (ids.includes(songId) ? ids : [...ids, songId]));
    setRecommendedData((items) => items ? items.filter((item) => item.song.id !== songId) : null);
  }

  function pickFromSongs(songsToPickFrom: Song[]): Song | null {
    if (!songsToPickFrom.length) {
      return null;
    }

    if (!shuffleEnabled) {
      return songsToPickFrom[0];
    }

    return songsToPickFrom[Math.floor(Math.random() * songsToPickFrom.length)];
  }

  function consumeQueueNext(): Song | null {
    if (!queue.length) {
      return null;
    }

    const nextSong = pickFromSongs(queue);

    if (!nextSong) {
      return null;
    }

    setQueue((items) => items.filter((item) => item.id !== nextSong.id));
    return nextSong;
  }

  function consumeRecommendationNext(): Song | null {
    const nextSong = pickFromSongs(recommendationSongs);

    if (!nextSong) {
      return null;
    }

    dismissRecommendation(nextSong.id);
    return nextSong;
  }

  function fallbackLibraryNext(): Song | null {
    const candidates = songs.filter((song) => song.id !== activeSong?.id);

    if (!candidates.length) {
      return null;
    }

    return pickFromSongs(candidates);
  }

  function startSong(song: Song, options: { rememberCurrent?: boolean } = {}) {
    if (activeSong && options.rememberCurrent !== false) {
      rememberPlayedSong(activeSong);
    }

    setActiveSong(song);
    setPlaySignal((value) => value + 1);
  }

  async function ensureMoreRecommendationsIfNeeded() {
    if (loadingMoreRecommendations || !hasMoreRecommendations) {
      return;
    }

    await loadMoreRecommendations();
  }

  async function playNextFromPolicy(reason: "ended" | "manual") {
    if (!activeSong) {
      const firstRecommendation = consumeRecommendationNext();
      const firstFallback = firstRecommendation ?? fallbackLibraryNext();

      if (firstFallback) {
        startSong(firstFallback, { rememberCurrent: false });
      }

      return;
    }

    if (reason === "ended") {
      dismissRecommendation(activeSong.id);
    }

    if (repeatMode === "one" && reason === "ended") {
      setPlaySignal((value) => value + 1);
      return;
    }

    const queuedNext = consumeQueueNext();

    if (queuedNext) {
      startSong(queuedNext);
      return;
    }

    let recommendationNext = consumeRecommendationNext();

    if (!recommendationNext && hasMoreRecommendations) {
      await ensureMoreRecommendationsIfNeeded();
      recommendationNext = consumeRecommendationNext();
    }

    if (recommendationNext) {
      startSong(recommendationNext);
      return;
    }

    if (repeatMode === "all") {
      const fromHistory = playHistory.length ? pickFromSongs([...playHistory].reverse()) : null;
      const fromLibrary = fromHistory ?? fallbackLibraryNext();

      if (fromLibrary) {
        startSong(fromLibrary);
        return;
      }
    }

    const fallbackNext = fallbackLibraryNext();

    if (fallbackNext) {
      startSong(fallbackNext);
    }
  }

  function playPreviousFromHistory() {
    const previous = playHistory[0];

    if (!previous) {
      return;
    }

    setPlayHistory((items) => items.slice(1));

    if (activeSong) {
      setQueue((items) => [activeSong, ...items.filter((item) => item.id !== activeSong.id)]);
    }

    setActiveSong(previous);
    setPlaySignal((value) => value + 1);
  }

  function toggleShuffle() {
    setShuffleEnabled((value) => !value);
  }

  function cycleRepeatMode() {
    setRepeatMode((value) => {
      if (value === "none") return "all";
      if (value === "all") return "one";
      return "none";
    });
  }

  function playSong(song: Song) {
    setActiveSong(song);
    rememberRecent(song);
    setPlaySignal((value) => value + 1);
    showNotice(`Now playing: ${formatSongDisplayName(song)}`);
  }

  function queueSong(song: Song) {
    rememberSongObjects([song]);
    setQueue((items) => {
      if (items.some((item) => item.id === song.id) || activeSong?.id === song.id) {
        showNotice(`${formatSongDisplayName(song)} is already in the queue.`);
        return items;
      }

      return [...items, song];
    });

    showNotice(`Queued: ${formatSongDisplayName(song)}`);
  }

  function removeFromQueue(songId: string) {
    const song = queue.find((item) => item.id === songId);
    setQueue((items) => items.filter((item) => item.id !== songId));
    showNotice(song ? `Removed from queue: ${formatSongDisplayName(song)}` : "Removed song from queue.");
  }

  async function toggleFavorite(song: Song) {
    rememberSongObjects([song]);
    const isFavorite = favoriteIds.includes(song.id);

    if (!authToken) {
      setFavoriteIds((items) => {
        const next = items.includes(song.id)
          ? items.filter((id) => id !== song.id)
          : [song.id, ...items];

        writeLocalJson("wavestack:favorites", next);
        return next;
      });

      showNotice(
        isFavorite
          ? `Removed favorite locally: ${formatSongDisplayName(song)}`
          : `Added favorite locally: ${formatSongDisplayName(song)}`
      );
      return;
    }

    try {
      const result = await apolloClient.mutate<{
        favoriteSong?: Song[];
        unfavoriteSong?: Song[];
      }>({
        mutation: isFavorite ? UNFAVORITE_SONG_MUTATION : FAVORITE_SONG_MUTATION,
        variables: { songId: song.id },
        fetchPolicy: "no-cache"
      });

      const favorites = result.data?.favoriteSong ?? result.data?.unfavoriteSong ?? [];

      setFavoriteIds(favorites.map((item) => item.id));
      rememberSongObjects(favorites);

      await refetchLibraryState();

      showNotice(
        isFavorite
          ? `Removed favorite: ${formatSongDisplayName(song)}`
          : `Added favorite: ${formatSongDisplayName(song)}`
      );
    } catch (error) {
      console.error("Failed to update favorite", error);
      showNotice("Could not save favorite to your account.");
    }
  }

  async function createPlaylist(name: string) {
    const trimmed = name.trim();

    if (!trimmed) {
      showNotice("Playlist name cannot be empty.");
      return;
    }

    if (!authToken) {
      const playlist: ClientPlaylist = {
        id: `playlist-${Date.now()}`,
        name: trimmed,
        songIds: [],
        songs: [],
        songCount: 0
      };

      setPlaylists((items) => {
        const next = [...items, playlist];
        writeLocalJson("wavestack:playlists", next);
        return next;
      });

      setSelectedPlaylistId(playlist.id);
      showNotice(`Created local playlist: ${playlist.name}`);
      return;
    }

    try {
      const result = await apolloClient.mutate<{ createUserPlaylist: ClientPlaylist[] }>({
        mutation: CREATE_USER_PLAYLIST_MUTATION,
        variables: { name: trimmed },
        fetchPolicy: "no-cache"
      });

      const next = result.data?.createUserPlaylist ?? [];
      setPlaylists(next);
      setSelectedPlaylistId(next[0]?.id ?? "");
      rememberSongObjects(next.flatMap((playlist) => playlist.songs ?? []));
      await refetchLibraryState();

      showNotice(`Created playlist: ${trimmed}`);
    } catch (error) {
      console.error("Failed to create playlist", error);
      showNotice("Could not create playlist in your account.");
    }
  }

  async function deletePlaylist(playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);

    if (!authToken) {
      setPlaylists((items) => {
        const next = items.filter((item) => item.id !== playlistId);
        writeLocalJson("wavestack:playlists", next);
        return next;
      });

      showNotice(playlist ? `Deleted local playlist: ${playlist.name}` : "Deleted local playlist.");
      return;
    }

    try {
      const result = await apolloClient.mutate<{ deleteUserPlaylist: ClientPlaylist[] }>({
        mutation: DELETE_USER_PLAYLIST_MUTATION,
        variables: { playlistId },
        fetchPolicy: "no-cache"
      });

      const next = result.data?.deleteUserPlaylist ?? [];
      setPlaylists(next);
      setSelectedPlaylistId(next[0]?.id ?? "");
      await refetchLibraryState();

      showNotice(playlist ? `Deleted playlist: ${playlist.name}` : "Deleted playlist.");
    } catch (error) {
      console.error("Failed to delete playlist", error);
      showNotice("Could not delete playlist from your account.");
    }
  }

  async function addToPlaylist(playlistId: string, song: Song) {
    rememberSongObjects([song]);

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

      if (!authToken) {
        const playlist: ClientPlaylist = {
          id: `playlist-${Date.now()}`,
          name: trimmed,
          songIds: [song.id],
          songs: [song],
          songCount: 1
        };

        setPlaylists((items) => {
          const next = [...items, playlist];
          writeLocalJson("wavestack:playlists", next);
          return next;
        });

        setSelectedPlaylistId(playlist.id);
        showNotice(`Created local playlist ${playlist.name} and added ${formatSongDisplayName(song)}.`);
        return;
      }

      try {
        const createResult = await apolloClient.mutate<{ createUserPlaylist: ClientPlaylist[] }>({
          mutation: CREATE_USER_PLAYLIST_MUTATION,
          variables: { name: trimmed },
          fetchPolicy: "no-cache"
        });

        const created = createResult.data?.createUserPlaylist?.[0];

        if (!created) {
          showNotice("Could not create playlist.");
          return;
        }

        const addResult = await apolloClient.mutate<{ addSongToUserPlaylist: ClientPlaylist[] }>({
          mutation: ADD_SONG_TO_USER_PLAYLIST_MUTATION,
          variables: {
            playlistId: created.id,
            songId: song.id
          },
          fetchPolicy: "no-cache"
        });

        const next = addResult.data?.addSongToUserPlaylist ?? [];
        setPlaylists(next);
        setSelectedPlaylistId(created.id);
        rememberSongObjects(next.flatMap((playlist) => playlist.songs ?? []));
        await refetchLibraryState();

        showNotice(`Created ${trimmed} and added ${formatSongDisplayName(song)}.`);
        return;
      } catch (error) {
        console.error("Failed to create playlist and add song", error);
        showNotice("Could not save playlist to your account.");
        return;
      }
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

    if (!authToken) {
      setPlaylists((items) => {
        const next = items.map((item) => {
          if (item.id !== playlistId) {
            return item;
          }

          return {
            ...item,
            songIds: [...item.songIds, song.id],
            songs: [...(item.songs ?? []), song],
            songCount: (item.songCount ?? item.songIds.length) + 1
          };
        });

        writeLocalJson("wavestack:playlists", next);
        return next;
      });

      showNotice(`Added ${formatSongDisplayName(song)} to local playlist ${playlist.name}.`);
      return;
    }

    try {
      const result = await apolloClient.mutate<{ addSongToUserPlaylist: ClientPlaylist[] }>({
        mutation: ADD_SONG_TO_USER_PLAYLIST_MUTATION,
        variables: {
          playlistId,
          songId: song.id
        },
        fetchPolicy: "no-cache"
      });

      const next = result.data?.addSongToUserPlaylist ?? [];
      setPlaylists(next);
      rememberSongObjects(next.flatMap((item) => item.songs ?? []));
      await refetchLibraryState();

      showNotice(`Added ${formatSongDisplayName(song)} to ${playlist.name}.`);
    } catch (error) {
      console.error("Failed to add song to playlist", error);
      showNotice("Could not add song to your account playlist.");
    }
  }

  async function removeFromPlaylist(playlistId: string, songId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    const song = songById.get(songId);

    if (!authToken) {
      setPlaylists((items) => {
        const next = items.map((item) => {
          if (item.id !== playlistId) {
            return item;
          }

          return {
            ...item,
            songIds: item.songIds.filter((id) => id !== songId),
            songs: (item.songs ?? []).filter((playlistSong) => playlistSong.id !== songId),
            songCount: Math.max(0, (item.songCount ?? item.songIds.length) - 1)
          };
        });

        writeLocalJson("wavestack:playlists", next);
        return next;
      });

      showNotice(
        playlist && song
          ? `Removed ${formatSongDisplayName(song)} from local playlist ${playlist.name}.`
          : "Removed song from local playlist."
      );
      return;
    }

    try {
      const result = await apolloClient.mutate<{ removeSongFromUserPlaylist: ClientPlaylist[] }>({
        mutation: REMOVE_SONG_FROM_USER_PLAYLIST_MUTATION,
        variables: {
          playlistId,
          songId
        },
        fetchPolicy: "no-cache"
      });

      const next = result.data?.removeSongFromUserPlaylist ?? [];
      setPlaylists(next);
      rememberSongObjects(next.flatMap((item) => item.songs ?? []));
      await refetchLibraryState();

      showNotice(
        playlist && song
          ? `Removed ${formatSongDisplayName(song)} from ${playlist.name}.`
          : "Removed song from playlist."
      );
    } catch (error) {
      console.error("Failed to remove song from playlist", error);
      showNotice("Could not remove song from your account playlist.");
    }
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

    let cancelled = false;

    async function run() {
      setRecommendationOffset(0);
      setHasMoreRecommendations(true);
      setRecommendedData([]);

      try {
        const page = await fetchRecommendedPage(0);

        if (cancelled) {
          return;
        }

        setRecommendedData(page.nodes);
        setRecommendationOffset(page.nextOffset);
        setHasMoreRecommendations(page.hasNextPage);
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("Failed to load initial recommendations", error);
        setRecommendedData([]);
        setRecommendationOffset(0);
        setHasMoreRecommendations(false);
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
    // Do not include dismissedRecommendationIds here, or the wall resets every time a song ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, favoriteIds.join("|"), recentSongIds.join("|")]);

  useEffect(() => {
    if (!getAuthToken()) {
      return;
    }

    const timer = setTimeout(async () => {
      const periods = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

      for (const period of periods) {
        try {
          const token = getAuthToken();
          if (!token) return;

          const response = await fetch(import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              query: LISTENING_HABIT_SUMMARY_QUERY.loc?.source?.body ?? "",
              variables: { period }
            })
          });

          const summaryJson = await response.json() as { data?: { listeningHabitSummary?: HabitSummaryEntry[] } };

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
        } catch {
          // silently fail — non-critical data
        }
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [authToken, favoriteIds.join("|"), recentSongIds.join("|")]);

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

  async function fetchRecommendedPage(offset: number): Promise<{
    nodes: RecommendResult[];
    totalCount: number;
    hasNextPage: boolean;
    nextOffset: number;
  }> {
    const result = await apolloClient.query<RecommendedSongsPageData, RecommendedSongsPageVariables>({
      query: RECOMMENDED_SONGS_QUERY,
      fetchPolicy: "network-only",
      variables: {
        limit: RECOMMENDATION_PAGE_SIZE,
        offset,
        favoriteSongIds: favoriteIds,
        recentSongIds,
        excludedSongIds: dismissedRecommendationIds
      }
    });

    const page = result.data.recommendedSongs;

    if (import.meta.env.DEV) {
      console.log("recommendedSongs page", {
        offset,
        received: page.nodes?.length ?? 0,
        totalCount: page.totalCount,
        hasNextPage: page.hasNextPage,
        nextOffset: page.nextOffset
      });
    }

    return {
      nodes: page.nodes ?? [],
      totalCount: page.totalCount,
      hasNextPage: page.hasNextPage,
      nextOffset: page.nextOffset
    };
  }

  async function loadInitialRecommendations() {
    try {
      const page = await fetchRecommendedPage(0);
      setRecommendedData(page.nodes);
      setRecommendationOffset(page.nextOffset);
      setHasMoreRecommendations(page.hasNextPage);
    } catch (error) {
      console.error("Failed to load initial recommendations", error);
      setRecommendedData([]);
      setRecommendationOffset(0);
      setHasMoreRecommendations(false);
    }
  }

  async function loadMoreRecommendations() {
    if (loadingMoreRecommendations || !hasMoreRecommendations) {
      return;
    }

    setLoadingMoreRecommendations(true);

    try {
      const page = await fetchRecommendedPage(recommendationOffset);

      setRecommendedData((current) => {
        const map = new Map<string, RecommendResult>();

        for (const item of current ?? []) {
          if (!dismissedRecommendationSet.has(item.song.id)) {
            map.set(item.song.id, item);
          }
        }

        for (const item of page.nodes) {
          if (!dismissedRecommendationSet.has(item.song.id)) {
            map.set(item.song.id, item);
          }
        }

        return Array.from(map.values());
      });

      setRecommendationOffset(page.nextOffset);
      setHasMoreRecommendations(page.hasNextPage);
    } catch (error) {
      console.error("Failed to load more recommendations", error);
      setHasMoreRecommendations(false);
    } finally {
      setLoadingMoreRecommendations(false);
    }
  }

  async function createPlaylistFromSongIds(songIds: string[]) {
    const name = `Chart ${new Date().toLocaleDateString()}`;

    if (!authToken) {
      const playlist: ClientPlaylist = {
        id: `playlist-${Date.now()}`,
        name,
        songIds
      };

      setPlaylists((items) => {
        const next = [...items, playlist];
        writeLocalJson("wavestack:playlists", next);
        return next;
      });
      setSelectedPlaylistId(playlist.id);
      showNotice(`Created local playlist: ${playlist.name}`);
      return;
    }

    try {
      const createResult = await apolloClient.mutate<{ createUserPlaylist: ClientPlaylist[] }>({
        mutation: CREATE_USER_PLAYLIST_MUTATION,
        variables: { name },
        fetchPolicy: "no-cache"
      });

      const created = createResult.data?.createUserPlaylist?.[0];

      if (!created) {
        showNotice("Could not create playlist.");
        return;
      }

      for (const songId of songIds) {
        await apolloClient.mutate({
          mutation: ADD_SONG_TO_USER_PLAYLIST_MUTATION,
          variables: {
            playlistId: created.id,
            songId
          },
          fetchPolicy: "no-cache"
        });
      }

      await refetchLibraryState();

      setSelectedPlaylistId(created.id);
      showNotice(`Created playlist: ${created.name}`);
    } catch (error) {
      console.error("Failed to create playlist from song IDs", error);
      showNotice("Could not create playlist in your account.");
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
          favoriteIds={favoriteIds}
          emptyMessage={emptyMessage}
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
        </div>

        <AuthPanel
          user={authUser}
          onLogout={logout}
        />
      </header>

      <nav className="app-nav" aria-label="Primary">
        <NavLink to="/dashboard" onClick={() => requestNavScroll("/dashboard")}>
          <Activity aria-hidden="true" /> Dashboard
        </NavLink>
        <NavLink to="/search" onClick={() => requestNavScroll("/search")}>
          <Search aria-hidden="true" /> Search
        </NavLink>
        <NavLink to="/favorites" onClick={() => requestNavScroll("/favorites")}>
          <Heart aria-hidden="true" /> Favorites ({favoriteSongs.length})
        </NavLink>
        <NavLink to="/recent" onClick={() => requestNavScroll("/recent")}>
          <Clock aria-hidden="true" /> Recent ({recentSongs.length})
        </NavLink>
        <button type="button" onClick={() => setQueueDrawerOpen(true)} aria-label="Open queue">
          <ListMusic aria-hidden="true" /> Queue ({queue.length})
        </button>
        <NavLink to="/stats" onClick={() => requestNavScroll("/stats")}>
          <TrendingUp aria-hidden="true" /> Stats
        </NavLink>
        <NavLink to="/playlists" onClick={() => requestNavScroll("/playlists")}>
          Playlists ({playlists.length})
        </NavLink>
      </nav>

      {notice ? <p className="app-banner app-banner--status" role="status">{notice}</p> : null}
      {error ? (
        <p className="app-banner app-banner--error" role="alert">
          Could not load music library: {error.message}
        </p>
      ) : null}

      <section aria-label="Player">
          <Player
            activeSong={currentSong}
            queue={queue}
            playSignal={playSignal}
            isFavorite={favoriteIds.includes(currentSong.id)}
            shuffleEnabled={shuffleEnabled}
            repeatMode={repeatMode}
            canGoPrevious={playHistory.length > 0}
            onToggleFavorite={() => toggleFavorite(currentSong)}
            onToggleShuffle={toggleShuffle}
            onCycleRepeatMode={cycleRepeatMode}
            onQueueChange={setQueue}
            onActiveSongChange={(song) => startSong(song)}
            onOpenDetails={setDetailsSong}
            onNext={() => void playNextFromPolicy("manual")}
            onPrevious={playPreviousFromHistory}
            onEnded={() => void playNextFromPolicy("ended")}
        />
      </section>

      <div className="route-content" data-route-content>
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
                recommendations={visibleRecommendations}
                habitSummaries={habitSummaries}
                playlists={playlists}
                favoriteIds={favoriteIds}
                onPlay={playSong}
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                userName={authUser?.displayName}
                onLoadMoreRecommendations={hasToken ? loadMoreRecommendations : undefined}
                hasMoreRecommendations={hasToken && hasMoreRecommendations}
                loadingMoreRecommendations={loadingMoreRecommendations}
              />
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
                songs={allKnownSongs}
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
          path="/stats"
          element={
            <section aria-label="Stats">
              <StatsPage
                songs={allKnownSongs}
                playlists={playlists}
                favoriteIds={favoriteIds}
                onPlay={playSong}
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
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
              playlists={playlists}
              favoriteIds={favoriteIds}
              queueLength={queue.length}
              habitSummaries={habitSummaries}
              onLogout={logout}
              onPlay={playSong}
              onQueue={queueSong}
              onToggleFavorite={toggleFavorite}
              onAddToPlaylist={addToPlaylist}
            />
          }
        />
        <Route
          path="/oauth-callback"
          element={<OAuthCallbackPage />}
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </div>

      {detailsSong ? (
        <SongMetadataModal
          song={detailsSong}
          onPlay={() => playSong(detailsSong)}
          onQueue={() => queueSong(detailsSong)}
          isFavorite={favoriteIds.includes(detailsSong.id)}
          playlists={playlists}
          onToggleFavorite={() => toggleFavorite(detailsSong)}
          onAddToPlaylist={(playlistId) => addToPlaylist(playlistId, detailsSong)}
          onClose={() => setDetailsSong(null)}
        />
      ) : null}

      <QueueDrawer
        open={queueDrawerOpen}
        queue={queue}
        currentSongId={currentSong.id}
        playlists={playlists}
        favoriteIds={favoriteIds}
        onClose={() => setQueueDrawerOpen(false)}
        onPlay={(song) => {
          playSong(song);
        }}
        onQueue={queueSong}
        onToggleFavorite={toggleFavorite}
        onAddToPlaylist={addToPlaylist}
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
