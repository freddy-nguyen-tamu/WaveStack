import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApolloQueryResult, useApolloClient, useMutation, useQuery } from "@apollo/client";
import { Activity, Clock, Heart, ListMusic, Music2, RefreshCw, Search, TrendingUp, Upload } from "lucide-react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
    LISTENING_HABIT_SUMMARY_QUERY,
    ME_QUERY,
    MUSIC_HOME_QUERY,
    SONG_PAGE_QUERY,
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
import { AllPage } from "./features/all/AllPage";
import { SongMetadataModal } from "./features/dashboard/SongMetadataModal";
import { AuthPanel } from "./features/auth/AuthPanel";
import { OAuthCallbackPage } from "./features/auth/OAuthCallbackPage";
import { ProfilePage } from "./features/profile/ProfilePage";
import { QueueDrawer } from "./features/queue/QueueDrawer";
import { StatsPage } from "./features/stats/StatsPage";
import { AddSongsPage } from "./features/add-songs/AddSongsPage";
import { uploadTrack } from "./api";
import { refreshWaveStackLibraryCache } from "./library-refresh";
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
  addedAt?: string;
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

export type PlaybackContext = {
  id: string;
  label: string;
  songs: Song[];
  source: "all" | "dashboard" | "search" | "favorites" | "recent" | "playlist" | "profile" | "manual";
};

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
  sort?: string | null;
};

const fallbackSongs: Song[] = [
  {
    id: "demo-monkeys-spinning-monkeys",
    title: "Monkeys Spinning Monkeys",
    artistName: "Kevin MacLeod",
    albumTitle: "Demo Library",
    durationSeconds: 125,
    streamUrl: "/demo/monkeys-spinning-monkeys.mp3",
    genreNames: ["instrumental", "background", "comedy"],
    thumbnailUrl: "https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80",
    driveThumbnailUrl: undefined,
    embeddedArtworkUrl: undefined,
    lyrics: "Instrumental demo track."
  }
];

const NAV_SCROLL_PATHS = new Set([
  "/all",
  "/dashboard",
  "/search",
  "/favorites",
  "/recent",
  "/stats",
  "/playlists",
  "/add-songs"
]);

const DEFAULT_META_DESCRIPTION =
  "WaveStack is a cloud-native music streaming platform for searching, playing, favoriting, queuing, and organizing your music library.";

const ROUTE_META: Record<string, { title: string; description: string }> = {
  "/": {
    title: "WaveStack | Cloud Music Streaming Platform",
    description: DEFAULT_META_DESCRIPTION
  },
  "/all": {
    title: "All Songs | WaveStack",
    description: "Browse and play every song available in your WaveStack music library."
  },
  "/dashboard": {
    title: "Dashboard | WaveStack",
    description: "View recommendations, favorites, recently played songs, and listening summaries in WaveStack."
  },
  "/search": {
    title: "Search Music | WaveStack",
    description: "Search your WaveStack cloud music library by song, artist, album, and genre."
  },
  "/add-songs": {
    title: "Add Songs | WaveStack",
    description: "Add local audio files or account songs to your WaveStack music library."
  },
  "/favorites": {
    title: "Favorites | WaveStack",
    description: "View and play your favorite songs in WaveStack."
  },
  "/recent": {
    title: "Recently Played | WaveStack",
    description: "Review the songs you recently played in WaveStack."
  },
  "/stats": {
    title: "Listening Stats | WaveStack",
    description: "Explore your WaveStack listening history, habits, rankings, and music taste statistics."
  },
  "/playlists": {
    title: "Playlists | WaveStack",
    description: "Create, manage, and play your WaveStack playlists."
  },
  "/profile": {
    title: "Profile | WaveStack",
    description: "Manage your WaveStack profile, listening archive, favorites, and account actions."
  },
  "/oauth-callback": {
    title: "Signing In | WaveStack",
    description: "Complete your WaveStack sign-in flow."
  }
};

const FULL_LIBRARY_REMEMBER_LIMIT = 10000;
const FULL_LIBRARY_PAGE_SIZE = 100;

function ensureMetaTag(name: string, content: string) {
  let tag = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);

  if (!tag) {
    tag = document.createElement("meta");
    tag.name = name;
    document.head.appendChild(tag);
  }

  tag.content = content;
}

function ensureCanonicalLink(pathname: string) {
  let tag = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');

  if (!tag) {
    tag = document.createElement("link");
    tag.rel = "canonical";
    document.head.appendChild(tag);
  }

  const path = pathname === "/" ? "/" : pathname;
  tag.href = `https://wavestack.duckdns.org${path}`;
}

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

  useEffect(() => {
    const metadata = ROUTE_META[location.pathname] ?? ROUTE_META["/"];

    document.title = metadata.title;
    ensureMetaTag("description", metadata.description);
    ensureCanonicalLink(location.pathname);
  }, [location.pathname]);

  const [activeSong, setActiveSong] = useState<Song | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [playSignal, setPlaySignal] = useState(0);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStringArray("wavestack:favorites"));
  const [recentSongIds, setRecentSongIds] = useState<string[]>(() => readStringArray("wavestack:recent"));
  const [playlists, setPlaylists] = useState<ClientPlaylist[]>(readPlaylists);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [notice, setNotice] = useState("");
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return window.localStorage.getItem("wavestack:theme") === "dark";
  });
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const theme = isDarkMode ? "dark" : "light";
    const themeColor = isDarkMode ? "#000000" : "#ffffff";

    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.body.dataset.theme = theme;
    document.body.style.colorScheme = theme;
    window.localStorage.setItem("wavestack:theme", theme);
    ensureMetaTag("theme-color", themeColor);
  }, [isDarkMode]);

  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [detailsSong, setDetailsSong] = useState<Song | null>(null);
  const pendingNavScrollRef = useRef(false);

  const [playbackContext, setPlaybackContext] = useState<PlaybackContext>(() => ({
    id: "initial",
    label: "Initial library",
    songs: [],
    source: "manual"
  }));

  const currentSongRef = useRef<Song | null>(null);
  const shuffleEnabledRef = useRef(false);
  const repeatModeRef = useRef<RepeatMode>("none");
  const playHistoryRef = useRef<Song[]>([]);
  const playbackContextRef = useRef<PlaybackContext | null>(null);
  const queueRef = useRef<Song[]>([]);
  const seededStartupAllContextRef = useRef(false);
  const startupAllContextFallbackTimerRef = useRef<number | null>(null);

  const [localTracks, setLocalTracks] = useState<Song[]>(() => {
    try {
      const stored = window.localStorage.getItem("wavestack:local-tracks");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [cachedSongs, setCachedSongs] = useState<Song[]>(readSongCache);
  const [librarySongs, setLibrarySongs] = useState<Song[]>([]);

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

  const RECOMMENDATION_PAGE_SIZE = 25;

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
  const [shufflingRecommendations, setShufflingRecommendations] = useState(false);
  const [isRefreshingLibrary, setIsRefreshingLibrary] = useState(false);
  const recommendationsLoadedForSessionRef = useRef(false);
  const recommendationsLoadingRef = useRef(false);
  const apolloClient = useApolloClient();

  useEffect(() => {
    let cancelled = false;

    async function loadFullBackendLibrary() {
      const collected: Song[] = [];
      let after: string | null = null;

      try {
        do {
          const queryResult = await apolloClient.query({
            query: SONG_PAGE_QUERY,
            variables: {
              first: FULL_LIBRARY_PAGE_SIZE,
              after,
              query: null,
              sort: "TITLE_ASC"
            },
            fetchPolicy: "no-cache"
          }) as ApolloQueryResult<SongPageQueryData>;

          const pageData: SongPageQueryData["songPage"] | undefined = queryResult.data?.songPage;

          if (!pageData) {
            break;
          }

          collected.push(...(pageData.nodes ?? []));

          const unique = uniqueSongsById(collected);

          if (!cancelled) {
            setLibrarySongs(unique);
          }

          after = pageData.pageInfo.hasNextPage ? pageData.pageInfo.endCursor ?? null : null;
        } while (after && !cancelled);

        if (!cancelled && collected.length) {
          rememberSongObjects(uniqueSongsById(collected));
        }
      } catch (error) {
        console.error("Failed to load full backend library", error);
      }
    }

    void loadFullBackendLibrary();

    return () => {
      cancelled = true;
    };
  }, [apolloClient]);

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
      ...localTracks,
      ...librarySongs,
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
    localTracks,
    librarySongs,
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

  const startupAllSongs = useMemo<Song[]>(() => {
    const backendAllSongs = librarySongs.length ? librarySongs : cachedSongs;

    return uniqueSongsById([
      ...localTracks,
      ...backendAllSongs
    ]);
  }, [localTracks, librarySongs, cachedSongs]);

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
    window.localStorage.setItem("wavestack:local-tracks", JSON.stringify(localTracks));
  }, [localTracks]);

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
    if (seededStartupAllContextRef.current) {
      return;
    }

    if (startupAllContextFallbackTimerRef.current) {
      window.clearTimeout(startupAllContextFallbackTimerRef.current);
      startupAllContextFallbackTimerRef.current = null;
    }

    const hasFreshBackendAllSongs = librarySongs.length > 0;
    const canUseFallbackCache = startupAllSongs.length > 0;

    if (!hasFreshBackendAllSongs && !canUseFallbackCache) {
      return;
    }

    function seedStartupAllContext() {
      if (seededStartupAllContextRef.current || !startupAllSongs.length) {
        return;
      }

      const randomIndex = Math.floor(Math.random() * startupAllSongs.length);
      const startupSong = startupAllSongs[randomIndex] ?? startupAllSongs[0];

      if (!startupSong) {
        return;
      }

      const startupContext: PlaybackContext = {
        id: "all:startup",
        label: "All Songs",
        source: "all",
        songs: startupAllSongs
      };

      seededStartupAllContextRef.current = true;
      playbackContextRef.current = startupContext;
      currentSongRef.current = startupSong;

      setPlaybackContext(startupContext);
      setPlayHistory([]);
      setActiveSong(startupSong);
    }

    if (hasFreshBackendAllSongs) {
      seedStartupAllContext();
      return;
    }

    startupAllContextFallbackTimerRef.current = window.setTimeout(() => {
      seedStartupAllContext();
    }, 1200);

    return () => {
      if (startupAllContextFallbackTimerRef.current) {
        window.clearTimeout(startupAllContextFallbackTimerRef.current);
        startupAllContextFallbackTimerRef.current = null;
      }
    };
  }, [librarySongs.length, startupAllSongs]);

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

  const currentSong = activeSong ?? startupAllSongs[0] ?? songs[0] ?? fallbackSongs[0];

  function showNotice(message: string) {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }

    setNotice(message);

    noticeTimerRef.current = window.setTimeout(() => {
      setNotice("");
      noticeTimerRef.current = null;
    }, 2800);
  }

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

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
      const next = uniqueSongsById([...songsToRemember, ...items]).slice(0, FULL_LIBRARY_REMEMBER_LIMIT);
      writeLocalJson("wavestack:song-cache", next);
      return next;
    });
  }

  async function handleLocalUploads(files: File[]) {
    const audioFiles = files.filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|wav|flac|aac|ogg|opus|webm|mp4)$/i.test(file.name));

    if (!audioFiles.length) {
      showNotice("Choose at least one audio file.");
      return;
    }

    showNotice(`Uploading ${audioFiles.length} local audio file(s)...`);

    const uploaded: Song[] = [];

    for (const file of audioFiles) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");

      try {
        const result = await uploadTrack(file, nameWithoutExt, "Local Upload", "Local Uploads");
        const track = result as unknown as Song;

        if (track?.id) {
          uploaded.push(track);
        }
      } catch (error) {
        console.error(`Upload failed for ${file.name}`, error);
        showNotice(error instanceof Error ? error.message : `Upload failed for ${file.name}.`);
      }
    }

    if (!uploaded.length) {
      showNotice("No files were uploaded.");
      return;
    }

    setLocalTracks((prev) => {
      const seen = new Set(prev.map((track) => track.id));
      const next = uploaded.filter((track) => !seen.has(track.id));
      return [...next, ...prev];
    });

    rememberSongObjects(uploaded);
    void refetch();
    void refetchLibraryState();
    showNotice(`Uploaded ${uploaded.length} local audio file(s).`);
  }

  function handleUserSongsAdded(songsToRemember: Song[]) {
    if (!songsToRemember.length) {
      return;
    }

    rememberSongObjects(songsToRemember);
    void refetch();
    void refetchLibraryState();
    void loadInitialRecommendations();
  }

  function dismissRecommendation(songId: string) {
    setDismissedRecommendationIds((ids) => (ids.includes(songId) ? ids : [...ids, songId]));
    setRecommendedData((items) => items ? items.filter((item) => item.song.id !== songId) : null);
  }

  currentSongRef.current = activeSong;
  shuffleEnabledRef.current = shuffleEnabled;
  repeatModeRef.current = repeatMode;
  playHistoryRef.current = playHistory;
  playbackContextRef.current = playbackContext;
  queueRef.current = queue;

  type PlaybackAdvanceReason = "manual" | "ended";

  function startSong(song: Song, options: { preserveContext?: boolean } = {}) {
    currentSongRef.current = song;
    setActiveSong(song);
    setPlaySignal((value) => value + 1);
  }

  function popNextQueuedSong(): Song | null {
    const latestQueue = queueRef.current;

    if (!latestQueue.length) {
      return null;
    }

    const nextSong = latestQueue[latestQueue.length - 1];
    const remainingQueue = latestQueue.slice(0, -1);

    queueRef.current = remainingQueue;
    setQueue(remainingQueue);

    return nextSong;
  }

  function pickRandomSongExcluding(songs: Song[], currentSongId: string): Song | null {
    const candidates = songs.filter((song) => song.id !== currentSongId);

    if (!candidates.length) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * candidates.length);
    return candidates[randomIndex] ?? null;
  }

  function resolveNextSongFromCurrentPolicy(reason: PlaybackAdvanceReason): Song | null {
    const queuedSong = popNextQueuedSong();

    if (queuedSong) {
      return queuedSong;
    }

    const latestCurrentSong = currentSongRef.current;
    const latestContext = playbackContextRef.current;
    const latestShuffleEnabled = shuffleEnabledRef.current;
    const latestRepeatMode = repeatModeRef.current;

    if (!latestCurrentSong || !latestContext?.songs?.length) {
      return null;
    }

    const contextSongs = latestContext.songs.filter(Boolean);

    if (!contextSongs.length) {
      return null;
    }

    if (latestRepeatMode === "one" && reason === "ended") {
      return latestCurrentSong;
    }

    if (latestShuffleEnabled) {
      const shuffledPick = pickRandomSongExcluding(contextSongs, latestCurrentSong.id);

      if (shuffledPick) {
        return shuffledPick;
      }

      if (latestRepeatMode === "all" || latestRepeatMode === "one") {
        return latestCurrentSong;
      }

      return null;
    }

    const currentIndex = contextSongs.findIndex((song) => song.id === latestCurrentSong.id);

    if (currentIndex < 0) {
      return contextSongs[0] ?? null;
    }

    const nextSong = contextSongs[currentIndex + 1];

    if (nextSong) {
      return nextSong;
    }

    if (latestRepeatMode === "all") {
      return contextSongs[0] ?? null;
    }

    return null;
  }

  function playNextFromPolicy(reason: PlaybackAdvanceReason = "manual") {
    const latestCurrentSong = currentSongRef.current;
    const nextSong = resolveNextSongFromCurrentPolicy(reason);

    if (!nextSong) {
      showNotice("No next song available.");
      return;
    }

    if (latestCurrentSong && nextSong.id !== latestCurrentSong.id) {
      const nextHistory = [...playHistoryRef.current, latestCurrentSong];
      playHistoryRef.current = nextHistory;
      setPlayHistory(nextHistory);
    }

    startSong(nextSong, { preserveContext: true });

    if (nextSong.id !== latestCurrentSong?.id) {
      rememberRecent(nextSong);
    }
  }

  function playPreviousFromHistory() {
    const latestHistory = playHistoryRef.current;

    if (latestHistory.length) {
      const previousSong = latestHistory[latestHistory.length - 1];
      const remainingHistory = latestHistory.slice(0, -1);

      playHistoryRef.current = remainingHistory;
      setPlayHistory(remainingHistory);

      startSong(previousSong, { preserveContext: true });
      rememberRecent(previousSong);
      return;
    }

    const latestCurrentSong = currentSongRef.current;
    const latestContext = playbackContextRef.current;
    const contextSongs = latestContext?.songs?.filter(Boolean) ?? [];

    if (!latestCurrentSong || !contextSongs.length) {
      showNotice("No previous song available.");
      return;
    }

    const currentIndex = contextSongs.findIndex((song) => song.id === latestCurrentSong.id);

    if (currentIndex < 0) {
      showNotice("No previous song available.");
      return;
    }

    const previousSong =
      currentIndex > 0
        ? contextSongs[currentIndex - 1]
        : repeatModeRef.current === "all"
          ? contextSongs[contextSongs.length - 1]
          : null;

    if (!previousSong) {
      showNotice("No previous song available.");
      return;
    }

    startSong(previousSong, { preserveContext: true });
    rememberRecent(previousSong);
  }

  function toggleShuffle() {
    setShuffleEnabled((enabled) => {
      const nextValue = !enabled;
      shuffleEnabledRef.current = nextValue;
      return nextValue;
    });
  }

  function cycleRepeatMode() {
    setRepeatMode((mode) => {
      const nextMode: RepeatMode =
        mode === "none" ? "all" : mode === "all" ? "one" : "none";

      repeatModeRef.current = nextMode;
      return nextMode;
    });
  }

  function playSongFromContext(song: Song, context: PlaybackContext) {
    rememberSongObjects([song, ...context.songs]);

    const deduplicatedContext = {
      ...context,
      songs: context.songs.filter(
        (item, index, list) => list.findIndex((other) => other.id === item.id) === index
      )
    };

    playbackContextRef.current = deduplicatedContext;
    setPlaybackContext(deduplicatedContext);

    playHistoryRef.current = [];
    setPlayHistory([]);

    startSong(song, { preserveContext: true });
    rememberRecent(song);
    showNotice(`Now playing: ${formatSongDisplayName(song)}`);
  }

  function playSong(song: Song) {
    startSong(song);
    rememberRecent(song);
    showNotice(`Now playing: ${formatSongDisplayName(song)}`);
  }

  function queueSong(song: Song) {
    setQueue((currentQueue) => {
      if (currentQueue.some((item) => item.id === song.id) || activeSong?.id === song.id) {
        showNotice(`${formatSongDisplayName(song)} is already in the queue.`);
        return currentQueue;
      }

      const nextQueue = [...currentQueue, song];
      queueRef.current = nextQueue;
      return nextQueue;
    });

    showNotice(`Queued: ${formatSongDisplayName(song)}`);
  }

  function removeFromQueue(songId: string) {
    const song = queue.find((item) => item.id === songId);

    setQueue((currentQueue) => {
      const nextQueue = currentQueue.filter((item) => item.id !== songId);
      queueRef.current = nextQueue;
      return nextQueue;
    });

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
    setRecommendationOffset(0);
    setHasMoreRecommendations(true);
    recommendationsLoadedForSessionRef.current = false;
    recommendationsLoadingRef.current = false;
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
      setRecommendationOffset(0);
      setHasMoreRecommendations(true);
      recommendationsLoadedForSessionRef.current = false;
      recommendationsLoadingRef.current = false;
      return;
    }

    if (recommendationsLoadedForSessionRef.current || recommendationsLoadingRef.current) {
      return;
    }

    let cancelled = false;
    recommendationsLoadingRef.current = true;

    async function run() {
      setRecommendationOffset(0);
      setHasMoreRecommendations(true);

      try {
        const page = await fetchRecommendedPage(0, []);

        if (cancelled) {
          return;
        }

        setRecommendedData(page.nodes);
        setRecommendationOffset(page.nextOffset);
        setHasMoreRecommendations(page.hasNextPage);
        recommendationsLoadedForSessionRef.current = true;
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("Failed to load initial recommendations", error);
        setRecommendedData([]);
        setRecommendationOffset(0);
        setHasMoreRecommendations(false);
      } finally {
        if (!cancelled) {
          recommendationsLoadingRef.current = false;
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
      recommendationsLoadingRef.current = false;
    };
    // Load recommendations once for this app session. Do not depend on favorites,
    // recent songs, dismissed IDs, route navigation, or playback state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

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

  async function fetchRecommendedPage(
    offset: number,
    excludedSongIds: string[] = []
  ): Promise<{
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
        favoriteSongIds: [],
        recentSongIds: [],
        excludedSongIds
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
      const currentRecommendationIds = (recommendedData ?? []).map((item) => item.song.id);
      const excludedSongIds = Array.from(new Set([
        ...dismissedRecommendationIds,
        ...currentRecommendationIds
      ]));

      const page = await fetchRecommendedPage(recommendationOffset, excludedSongIds);

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
      setHasMoreRecommendations(page.hasNextPage && page.nodes.length > 0);
    } catch (error) {
      console.error("Failed to load more recommendations", error);
      setHasMoreRecommendations(false);
    } finally {
      setLoadingMoreRecommendations(false);
    }
  }

  async function shuffleRecommendations() {
    if (shufflingRecommendations) {
      return;
    }

    setShufflingRecommendations(true);
    setLoadingMoreRecommendations(true);

    try {
      setDismissedRecommendationIds([]);

      const page = await fetchRecommendedPage(0, []);

      setRecommendedData(page.nodes);
      setRecommendationOffset(page.nextOffset);
      setHasMoreRecommendations(page.hasNextPage && page.nodes.length > 0);
      recommendationsLoadedForSessionRef.current = true;
      showNotice("Loaded random suggestions.");
    } catch (error) {
      console.error("Failed to shuffle recommendations", error);
      showNotice("Could not load random suggestions.");
    } finally {
      setShufflingRecommendations(false);
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

  async function handleRefreshLibraryCache() {
    if (isRefreshingLibrary) {
      return;
    }

    setIsRefreshingLibrary(true);
    showNotice("Syncing Drive library. This may take a moment...");

    try {
      await refreshWaveStackLibraryCache();
    } catch (error) {
      console.error("Failed to refresh library cache", error);
      showNotice("Could not refresh the music library.");
      setIsRefreshingLibrary(false);
    }
  }

  function renderSongsPage(
    title: string,
    pageSongs: Song[],
    emptyMessage: string,
    contextPlay?: (song: Song) => void,
    backendSearch = false
  ) {
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
          backendSearch={backendSearch}
          onAddToPlaylist={addToPlaylist}
          onPlay={contextPlay ?? playSong}
          onQueue={queueSong}
          onToggleFavorite={toggleFavorite}
          onOpenDetails={setDetailsSong}
        />
      </section>
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header__top">
          <NavLink
            className="app-header__brand"
            to="/all"
            aria-label="WaveStack home"
            onClick={() => requestNavScroll("/all")}
          >
            WaveStack
          </NavLink>
          <p id="app-description">Cloud-native music streaming platform</p>
        </div>

        <AuthPanel
          user={authUser}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((current) => !current)}
          onLogout={logout}
        />
      </header>

      <nav className="app-nav" aria-label="Primary navigation">
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <NavLink to="/all" onClick={() => requestNavScroll("/all")}>
          <Music2 aria-hidden="true" /> All
        </NavLink>
        <NavLink to="/dashboard" onClick={() => requestNavScroll("/dashboard")}>
          <Activity aria-hidden="true" /> Dashboard
        </NavLink>
        <NavLink to="/search" onClick={() => requestNavScroll("/search")}>
          <Search aria-hidden="true" /> Search
        </NavLink>
        <NavLink to="/add-songs" onClick={() => requestNavScroll("/add-songs")}>
          <Upload aria-hidden="true" /> Add Songs
        </NavLink>
        <NavLink to="/favorites" onClick={() => requestNavScroll("/favorites")}>
          <Heart aria-hidden="true" /> Favorites ({favoriteSongs.length})
        </NavLink>
        <NavLink to="/recent" onClick={() => requestNavScroll("/recent")}>
          <Clock aria-hidden="true" /> Recent ({recentSongs.length})
        </NavLink>
        <button type="button" onClick={() => setQueueDrawerOpen(true)}>
          <ListMusic aria-hidden="true" /> Queue ({queue.length})
        </button>
        <button
          type="button"
          onClick={() => void handleRefreshLibraryCache()}
          disabled={isRefreshingLibrary}
          title="Scan Drive, clear local music cache, and reload the latest library"
        >
          <RefreshCw aria-hidden="true" />
          {isRefreshingLibrary ? "Syncing..." : "Sync Library"}
        </button>
        <NavLink to="/stats" onClick={() => requestNavScroll("/stats")}>
          <TrendingUp aria-hidden="true" /> Stats
        </NavLink>
        <NavLink to="/playlists" onClick={() => requestNavScroll("/playlists")}>
          Playlists ({playlists.length})
        </NavLink>
      </nav>

      <main
        id="main-content"
        className="app-main"
        aria-describedby="app-description"
      >
        <h1 className="sr-only">WaveStack music library</h1>

      {notice ? (
        <p className="toast-notice toast-notice--status" role="status">
          {notice}
        </p>
      ) : null}
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
            canGoPrevious={playHistory.length > 0 || playbackContext.songs.length > 1}
            onToggleFavorite={() => toggleFavorite(currentSong)}
            onToggleShuffle={toggleShuffle}
            onCycleRepeatMode={cycleRepeatMode}
            onQueueChange={setQueue}
            onActiveSongChange={(song) => startSong(song)}
            onOpenDetails={setDetailsSong}
            onNext={() => playNextFromPolicy("manual")}
            onPrevious={playPreviousFromHistory}
            onEnded={() => playNextFromPolicy("ended")}
        />
      </section>

      <div className="route-content" data-route-content>
      <Routes>
        <Route path="/" element={<Navigate to="/all" replace />} />
        <Route
          path="/all"
          element={
            <section aria-label="All songs">
              <AllPage
                songs={allKnownSongs}
                localTracks={localTracks}
                playlists={playlists}
                favoriteIds={favoriteIds}
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: `all:az`,
                    label: "All Songs",
                    source: "all",
                    songs: allKnownSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                onOpenDetails={setDetailsSong}
              />
            </section>
          }
        />
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
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: "dashboard:recommendations",
                    label: "Dashboard recommendations",
                    source: "dashboard",
                    songs: recommendationSongs.length ? recommendationSongs : songs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                userName={authUser?.displayName}
                onLoadMoreRecommendations={hasToken ? loadMoreRecommendations : undefined}
                hasMoreRecommendations={hasToken && hasMoreRecommendations}
                loadingMoreRecommendations={loadingMoreRecommendations}
                onShuffleRecommendations={shuffleRecommendations}
                shufflingRecommendations={shufflingRecommendations}
              />
            </section>
          }
        />
        <Route
          path="/search"
          element={renderSongsPage(
            "Search",
            allKnownSongs,
            "No songs found.",
            (song: Song) =>
              playSongFromContext(song, {
                id: "search",
                label: "Search",
                source: "search",
                songs: allKnownSongs
              }),
            true
          )}
        />
        <Route
          path="/add-songs"
          element={
            <AddSongsPage
              isSignedIn={hasToken}
              onSongsAdded={handleUserSongsAdded}
              onNotice={showNotice}
              onUploadFiles={handleLocalUploads}
            />
          }
        />
        <Route
          path="/favorites"
          element={renderSongsPage("Favorites", favoriteSongs, "No favorite songs yet. Click Favorite on a song first.", (song: Song) =>
            playSongFromContext(song, {
              id: "favorites",
              label: "Favorites",
              source: "favorites",
              songs: favoriteSongs
            })
          )}
        />
        <Route
          path="/recent"
          element={renderSongsPage("Recently Played", recentSongs, "No recently played songs yet. Click Play on a song first.", (song: Song) =>
            playSongFromContext(song, {
              id: "recent",
              label: "Recent",
              source: "recent",
              songs: recentSongs
            })
          )}
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
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: `playlist:${selectedPlaylistId}`,
                    label: playlists.find((p) => p.id === selectedPlaylistId)?.name ?? "Playlist",
                    source: "playlist",
                    songs: allKnownSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onOpenDetails={setDetailsSong}
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
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: "stats",
                    label: "Stats",
                    source: "manual",
                    songs: allKnownSongs
                  })
                }
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
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: "profile",
                    label: "Profile",
                    source: "profile",
                    songs: favoriteSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                onOpenDetails={setDetailsSong}
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
        onOpenDetails={setDetailsSong}
        onClear={() => {
          queueRef.current = [];
          setQueue([]);
          showNotice("Queue cleared.");
        }}
      />

        <div className="bottom-player-spacer" aria-hidden="true" />
      </main>
    </>
  );
}
