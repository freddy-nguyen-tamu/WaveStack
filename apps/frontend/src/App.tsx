



import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApolloQueryResult, useApolloClient, useMutation, useQuery } from "@apollo/client";
import { Activity, Clock, Heart, ListMusic, Music2, RefreshCw, TrendingUp, Upload } from "lucide-react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
    LISTENING_HABIT_SUMMARY_QUERY,
    ME_QUERY,
    MUSIC_HOME_QUERY,
    SONG_DETAILS_QUERY,
    SONG_PAGE_QUERY,
    RANDOM_SONG_QUERY,
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
import { createSongDetailsStore, SongDetailsLayer } from "./components/SongDetailsLayer";
import { AuthPanel } from "./features/auth/AuthPanel";
import { OAuthCallbackPage } from "./features/auth/OAuthCallbackPage";
import { ProfilePage } from "./features/profile/ProfilePage";
import { QueueDrawer } from "./features/queue/QueueDrawer";
import { StatsPage } from "./features/stats/StatsPage";
import { AddSongsPage } from "./features/add-songs/AddSongsPage";
import { uploadTrack } from "./api";
import { refreshWaveStackLibraryCache } from "./library-refresh";
import { formatSongDisplayName } from "./song-format";
import { NowPlayingProvider, createNowPlayingStore } from "./components/NowPlayingContext";
import { ToastNotice } from "./components/ToastNotice";
import { SongArtwork } from "./components/SongArtwork";
import { GlobalSearch } from "./components/GlobalSearch";
import { KeyboardShortcutsMenu } from "./components/KeyboardShortcutsMenu";
import { pickHabitArtworkSong } from "./habit-artwork";
import { assertStreamUrlBelongsToSong } from "./playback-source-identity";

export type Song = {
  id: string;
  fileName?: string;
  searchMetadata?: string;
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
  queryFilter?: string | null;
};

export type PlaySongHandler = (song: Song, context?: PlaybackContext) => void;
export type OpenSongDetailsHandler = (song: Song, context?: PlaybackContext) => void;

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

const PLACEHOLDER_SONG_ID = "demo-monkeys-spinning-monkeys";

const fallbackSongs: Song[] = [
  {
    id: PLACEHOLDER_SONG_ID,
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

// The catalog cache is only a startup fallback. Persisting the entire 10k-song
// in-memory library (including lyrics/search blobs) can occupy several MB,
// trigger localStorage quota errors, and synchronously block the main thread.
// Keep enough recent catalog objects for instant startup while the authoritative
// backend library loads in the background.
const PERSISTED_SONG_CACHE_LIMIT = 600;
const MAX_STARTUP_SONG_CACHE_CHARS = 1_750_000;

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
    const ids = value ? JSON.parse(value) as string[] : [];
    return ids.filter((id) => id !== PLACEHOLDER_SONG_ID);
  } catch {
    return [];
  }
}

function sanitizePlaylists(items: ClientPlaylist[]): ClientPlaylist[] {
  return items.map((playlist) => ({
    ...playlist,
    songIds: playlist.songIds.filter((id) => id !== PLACEHOLDER_SONG_ID),
    songs: playlist.songs?.filter((song) => song.id !== PLACEHOLDER_SONG_ID)
  }));
}

function readPlaylists(): ClientPlaylist[] {
  try {
    const value = window.localStorage.getItem("wavestack:playlists");
    return value ? sanitizePlaylists(JSON.parse(value) as ClientPlaylist[]) : [];
  } catch {
    return [];
  }
}

function uniqueSongsById(songs: Song[]): Song[] {
  return Array.from(
    new Map(
      songs
        .filter((song) => song.id !== PLACEHOLDER_SONG_ID)
        .map((song) => [song.id, song])
    ).values()
  );
}

function pickGuestRandomSongs(songs: Song[], seed: number, limit: number): Song[] {
  const pool = songs.filter((song) => song.id !== PLACEHOLDER_SONG_ID).slice();
  let state = (seed >>> 0) || 0x6d2b79f5;
  const count = Math.min(Math.max(0, limit), pool.length);

  function nextRandom() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  }

  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + Math.floor(nextRandom() * (pool.length - index));
    const current = pool[index];
    pool[index] = pool[swapIndex];
    pool[swapIndex] = current;
  }

  return pool.slice(0, count);
}

function authApiOrigin(): string {
  const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql";

  try {
    return new URL(graphqlUrl).origin;
  } catch {
    return "http://localhost:3000";
  }
}

// Avoid publishing a brand-new 10,000-item library when a newly played track
// contains the same catalog metadata as its cached copy.
function sameCachedSong(a: Song, b: Song): boolean {
  if (a === b) return true;
  const oldGenres = a.genreNames ?? [];
  const nextGenres = b.genreNames ?? [];
  return a.id === b.id && a.streamUrl === b.streamUrl &&
    a.title === b.title && a.artistName === b.artistName &&
    a.albumTitle === b.albumTitle && a.fileName === b.fileName &&
    a.durationSeconds === b.durationSeconds && a.thumbnailUrl === b.thumbnailUrl &&
    a.localThumbnailUrl === b.localThumbnailUrl &&
    a.driveThumbnailUrl === b.driveThumbnailUrl &&
    a.embeddedArtworkUrl === b.embeddedArtworkUrl && a.lyrics === b.lyrics &&
    a.searchMetadata === b.searchMetadata && a.score === b.score &&
    a.webViewLink === b.webViewLink && a.mimeType === b.mimeType &&
    a.modifiedTime === b.modifiedTime && a.addedAt === b.addedAt &&
    a.sizeBytes === b.sizeBytes && a.sourceRootFolderId === b.sourceRootFolderId &&
    oldGenres.length === nextGenres.length &&
    oldGenres.every((genre, index) => genre === nextGenres[index]);
}

function compactSongForStartupCache(song: Song): Song {
  return {
    id: song.id,
    fileName: song.fileName,
    title: song.title,
    artistName: song.artistName,
    albumTitle: song.albumTitle,
    durationSeconds: song.durationSeconds,
    streamUrl: song.streamUrl,
    genreNames: song.genreNames ?? [],
    thumbnailUrl: song.thumbnailUrl,
    localThumbnailUrl: song.localThumbnailUrl,
    driveThumbnailUrl: song.driveThumbnailUrl,
    embeddedArtworkUrl: song.embeddedArtworkUrl,
    mimeType: song.mimeType,
    modifiedTime: song.modifiedTime,
    addedAt: song.addedAt
  };
}

function compactSongCacheForPersistence(songs: Song[]): Song[] {
  return songs
    .slice(0, PERSISTED_SONG_CACHE_LIMIT)
    .map(compactSongForStartupCache);
}

function readSongCache(): Song[] {
  try {
    const value = window.localStorage.getItem("wavestack:song-cache");
    if (!value) return [];

    // Do not spend the first interactive seconds parsing a legacy multi-megabyte
    // catalog. The server immediately repopulates this fallback cache with the
    // bounded compact representation above.
    if (value.length > MAX_STARTUP_SONG_CACHE_CHARS) {
      return [];
    }

    const parsed = JSON.parse(value) as Song[];
    return Array.isArray(parsed)
      ? parsed.slice(0, PERSISTED_SONG_CACHE_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function readLastPlayedSong(): Song | null {
  try {
    const value = window.localStorage.getItem("wavestack:last-song");
    const song = value ? JSON.parse(value) as Song : null;
    return song?.id && song.id !== PLACEHOLDER_SONG_ID ? song : null;
  } catch {
    return null;
  }
}

function writeLocalJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not write ${key}`, error);
  }
}

const habitPeriodLabels: Record<string, string> = {
  DAY: "Today",
  WEEK: "This week",
  MONTH: "This month",
  YEAR: "This year"
};

const habitPeriodOrder = ["DAY", "WEEK", "MONTH", "YEAR"];

type GuestPersonalizationNoticeProps = {
  onLogin: () => void;
  loginBusy: boolean;
  className?: string;
  message?: string;
};

function GuestPersonalizationNotice({
  onLogin,
  loginBusy,
  className = "",
  message = "Random picks for now. Signing in will make this more meaningful."
}: GuestPersonalizationNoticeProps) {
  return (
    <div className={`guest-personalization-notice ${className}`.trim()}>
      <p>{message}</p>
      <button type="button" onClick={onLogin} disabled={loginBusy}>
        {loginBusy ? "Opening login..." : "Log in"}
      </button>
    </div>
  );
}

type GuestListeningHabitRailProps = {
  songs: Song[];
  onOpenDetails: OpenSongDetailsHandler;
  onLogin: () => void;
  loginBusy: boolean;
};

function GuestListeningHabitRail({
  songs,
  onOpenDetails,
  onLogin,
  loginBusy
}: GuestListeningHabitRailProps) {
  const [seed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  const randomSongs = useMemo(() => pickGuestRandomSongs(songs, seed, 4), [songs, seed]);

  return (
    <aside className="listening-rail listening-rail--guest" aria-label="Listening habit guest preview">
      <div className="listening-rail__header">
        <p className="eyebrow">Listening habits</p>
        <h2>Heavy rotation</h2>
      </div>

      <GuestPersonalizationNotice
        className="guest-personalization-notice--rail"
        onLogin={onLogin}
        loginBusy={loginBusy}
      />

      <section className="listening-rail__period" aria-label="Random guest picks">
        <h3>Random picks</h3>
        {randomSongs.length ? (
          <div className="listening-rail__items">
            {randomSongs.map((song) => (
              <button
                key={`guest-habit:${song.id}`}
                type="button"
                className="listening-rail__item"
                onClick={() => onOpenDetails(song)}
              >
                <SongArtwork
                  song={song}
                  wrapClassName="listening-rail__art"
                  fallbackClassName="listening-rail__art-fallback"
                  disableNowPlayingStyle
                />
                <span className="listening-rail__copy">
                  <strong>{song.artistName || song.title}</strong>
                  <span>Random pick</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="listening-rail__guest-empty">Random picks will appear when the music library is available.</p>
        )}
      </section>
    </aside>
  );
}

type ListeningHabitRailProps = {
  habitSummaries: Record<string, HabitSummaryEntry[]>;
  songs: Song[];
  onOpenDetails: OpenSongDetailsHandler;
};

function ListeningHabitRail({ habitSummaries, songs, onOpenDetails }: ListeningHabitRailProps) {
  // Resolving a representative artwork used to rescan the entire library for every
  // habit row on every App render. Cache the resolved rows until the library or the
  // habit summary actually changes so the persistent rail stays cheap to render.
  const periods = useMemo(() => habitPeriodOrder
    .map((period) => {
      const entries = (habitSummaries[period] ?? []).slice(0, 4).map((entry, index) => ({
        entry,
        artworkSong: pickHabitArtworkSong(entry, songs, index)
      }));

      return [period, entries] as const;
    })
    .filter(([, entries]) => entries.length > 0), [habitSummaries, songs]);

  if (!periods.length) {
    return null;
  }

  return (
    <aside className="listening-rail" aria-label="Listening habit highlights">
      <div className="listening-rail__header">
        <p className="eyebrow">Listening habits</p>
        <h2>Heavy rotation</h2>
      </div>

      {periods.map(([period, entries]) => (
        <section key={period} className="listening-rail__period" aria-label={habitPeriodLabels[period] ?? period}>
          <h3>{habitPeriodLabels[period] ?? period}</h3>
          <div className="listening-rail__items">
            {entries.map(({ entry, artworkSong }) => (
              <button
                key={`${period}:${entry.label}`}
                type="button"
                className="listening-rail__item"
                onClick={() => {
                  if (artworkSong) {
                    onOpenDetails(artworkSong);
                  }
                }}
                disabled={!artworkSong}
              >
                {artworkSong ? (
                  <SongArtwork
                    song={artworkSong}
                    wrapClassName="listening-rail__art"
                    fallbackClassName="listening-rail__art-fallback"
                    disableNowPlayingStyle
                  />
                ) : (
                  <span className="listening-rail__art listening-rail__art-fallback" aria-hidden="true" />
                )}
                <span className="listening-rail__copy">
                  <strong>{entry.label}</strong>
                  <span>{entry.count} play{entry.count === 1 ? "" : "s"}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </aside>
  );
}

function isUnauthenticatedGraphqlError(error: unknown): boolean {
  const graphQLErrors =
    (error as { graphQLErrors?: Array<{ message?: string; extensions?: { code?: string } }> })
      ?.graphQLErrors ?? [];

  return graphQLErrors.some((item) => {
    const message = item.message ?? "";
    return (
      item.extensions?.code === "UNAUTHENTICATED" ||
      /session expired|sign in again|unauthorized/i.test(message)
    );
  });
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const metadata = ROUTE_META[location.pathname] ?? ROUTE_META["/"];

    document.title = metadata.title;
    ensureMetaTag("description", metadata.description);
    ensureCanonicalLink(location.pathname);
  }, [location.pathname]);

  const [activeSong, setActiveSong] = useState<Song | null>(readLastPlayedSong);
  const [queue, setQueue] = useState<Song[]>([]);
  const [playSignal, setPlaySignal] = useState(0);
  const [nowPlayingStore] = useState(createNowPlayingStore);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStringArray("wavestack:favorites"));
  const [recentSongIds, setRecentSongIds] = useState<string[]>(() => readStringArray("wavestack:recent"));
  const [playlists, setPlaylists] = useState<ClientPlaylist[]>(readPlaylists);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [notice, setNotice] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState(() => window.sessionStorage.getItem("wavestack:active-search") ?? "");
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const explicitTheme = window.localStorage.getItem("wavestack:theme-user-set") === "true";
    const storedTheme = window.localStorage.getItem("wavestack:theme");

    // Dark is the new site-wide default, including existing visitors whose old
    // light value was written automatically before we could distinguish a real
    // user choice. Future explicit light-mode choices remain persistent.
    return explicitTheme ? storedTheme !== "light" : true;
  });
  const noticeTimerRef = useRef<number | null>(null);
  const favoriteIdsRef = useRef<string[]>(favoriteIds);
  const recentSongIdsRef = useRef<string[]>(recentSongIds);
  const playlistsRef = useRef<ClientPlaylist[]>(playlists);
  const emptyBackendLibraryStateWarningShownRef = useRef(false);

  useEffect(() => {
    favoriteIdsRef.current = favoriteIds;
  }, [favoriteIds]);

  useEffect(() => {
    recentSongIdsRef.current = recentSongIds;
  }, [recentSongIds]);

  useEffect(() => {
    playlistsRef.current = playlists;
  }, [playlists]);

  function applyFavoriteIds(nextIds: string[]) {
    const next = Array.from(new Set(nextIds.filter((id) => Boolean(id) && id !== PLACEHOLDER_SONG_ID)));
    favoriteIdsRef.current = next;
    setFavoriteIds(next);
    writeLocalJson("wavestack:favorites", next);
  }

  function applyRecentSongIds(nextIds: string[]) {
    const next = Array.from(new Set(nextIds.filter((id) => Boolean(id) && id !== PLACEHOLDER_SONG_ID))).slice(0, 100);
    recentSongIdsRef.current = next;
    setRecentSongIds(next);
    writeLocalJson("wavestack:recent", next);
  }

  function applyPlaylists(nextPlaylists: ClientPlaylist[]) {
    const next = sanitizePlaylists(nextPlaylists);
    playlistsRef.current = next;
    setPlaylists(next);
    writeLocalJson("wavestack:playlists", next);
  }

  function toggleDarkMode() {
    window.localStorage.setItem("wavestack:theme-user-set", "true");
    setIsDarkMode(current => !current);
  }

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
  const [songDetailsStore] = useState(createSongDetailsStore);
  const pendingNavScrollRef = useRef(false);

  const [playbackContext, setPlaybackContext] = useState<PlaybackContext>(() => ({
    id: "initial",
    label: "Initial library",
    songs: [],
    source: "manual"
  }));

  const currentSongRef = useRef<Song | null>(null);
  const playRequestIdRef = useRef(0);
  const shuffleEnabledRef = useRef(false);
  const repeatModeRef = useRef<RepeatMode>("none");
  const playHistoryRef = useRef<Song[]>([]);
  const playbackContextRef = useRef<PlaybackContext | null>(null);
  const queueRef = useRef<Song[]>([]);
  const allKnownSongsRef = useRef<Song[]>([]);
  const playedSinceManualPlayIdsRef = useRef<Set<string>>(new Set());
  const seededStartupAllContextRef = useRef(false);
  const startupAllContextFallbackTimerRef = useRef<number | null>(null);
  const lastPlayedSongIdRef = useRef(activeSong?.id ?? window.localStorage.getItem("wavestack:last-song-id"));

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
  const lastPersistedCacheRef = useRef(cachedSongs);

  // Catalog persistence must stay off the playback-critical path. A previous
  // version forced requestIdleCallback after four seconds and then serialized
  // the entire 10k-song cache synchronously; on a busy startup that timeout
  // landed directly on top of Space/click playback and could freeze the UI.
  useEffect(() => {
    if (lastPersistedCacheRef.current === cachedSongs) return;

    let pending = true;
    const persist = () => {
      if (!pending) return;
      pending = false;
      writeLocalJson(
        "wavestack:song-cache",
        compactSongCacheForPersistence(cachedSongs)
      );
      lastPersistedCacheRef.current = cachedSongs;
    };

    // No forced idle timeout: playback/input always wins. Browsers without
    // requestIdleCallback use a delayed, bounded write whose payload is small.
    const idleId = window.requestIdleCallback?.(persist);
    const timer = idleId === undefined ? window.setTimeout(persist, 2500) : null;
    window.addEventListener("pagehide", persist);

    return () => {
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
      pending = false;
    };
  }, [cachedSongs]);

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

  function submitGlobalSearch(query: string) {
    const nextQuery = query.trim();

    if (!nextQuery) {
      return;
    }

    setGlobalSearchQuery(nextQuery);
    window.sessionStorage.setItem("wavestack:active-search", nextQuery);
    navigate("/search");
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".search-panel--results-only")?.scrollIntoView({
        block: "start",
        behavior: "smooth"
      });
    });
  }

  useEffect(() => {
    if (location.pathname !== "/search") {
      return;
    }

    const storedQuery = window.sessionStorage.getItem("wavestack:active-search") ?? "";
    setGlobalSearchQuery((current) => current || storedQuery);
  }, [location.pathname]);

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
  const [guestDashboardSeed, setGuestDashboardSeed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  const [guestLoginStarting, setGuestLoginStarting] = useState(false);

  const [shuffleEnabled, setShuffleEnabled] = useState(() =>
    window.localStorage.getItem("wavestack:shuffle-enabled") === "true"
  );
  const [isResolvingNextSong, setIsResolvingNextSong] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(() => {
    const stored = window.localStorage.getItem("wavestack:repeat-mode");
    return stored === "all" || stored === "one" ? stored : "none";
  });
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
          after = pageData.pageInfo.hasNextPage ? pageData.pageInfo.endCursor ?? null : null;
        } while (after && !cancelled);

        if (!cancelled && collected.length) {
          // This is a background warm-up, not the route's own paginated query. The
          // old implementation published state after every 100-song page, forcing
          // the entire App, current route, player chrome and listening rail to
          // re-render repeatedly while the user was interacting. Publish the
          // completed library once instead; React batches this with the cache update.
          const unique = uniqueSongsById(collected);
          setLibrarySongs(unique);
          rememberSongObjects(unique);
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

  const {
    data: libraryStateData,
    error: libraryStateError,
    refetch: refetchLibraryState
  } = useQuery(LIBRARY_STATE_QUERY, {
    skip: !hasToken,
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true
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

  const {
    data: meData,
    error: meError,
    refetch: refetchMe
  } = useQuery(ME_QUERY, {
    skip: !hasToken,
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true
  });

  useEffect(() => {
    if (meData?.me) {
      setAuthUser(meData.me);
      window.localStorage.setItem("wavestack:auth-user", JSON.stringify(meData.me));
    }
  }, [meData]);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    void refetchMe();
    void refetchLibraryState();
  }, [authToken, refetchMe, refetchLibraryState]);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    if (!isUnauthenticatedGraphqlError(meError) && !isUnauthenticatedGraphqlError(libraryStateError)) {
      return;
    }

    window.localStorage.removeItem("wavestack:auth-token");
    window.localStorage.removeItem("wavestack:auth-user");

    setAuthToken(null);
    setAuthUser(null);

    showNotice("Your WaveStack session expired. Sign in again.");
  }, [authToken, meError, libraryStateError]);

  const { data, loading, error, refetch } = useQuery(MUSIC_HOME_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const songs = useMemo<Song[]>(
    () => uniqueSongsById(data?.dashboardSongs ?? []),
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
      ...(activeSong ? [activeSong] : [])
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
    activeSong
  ]);

  const guestDashboardRecommendations = useMemo<RecommendResult[]>(() => {
    if (hasToken) {
      return [];
    }

    return pickGuestRandomSongs(allKnownSongs, guestDashboardSeed, RECOMMENDATION_PAGE_SIZE)
      .map((song) => ({ song, reason: "" }));
  }, [allKnownSongs, guestDashboardSeed, hasToken]);

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

      const lastPlayedSong = lastPlayedSongIdRef.current
        ? startupAllSongs.find((song) => song.id === lastPlayedSongIdRef.current)
        : null;
      const randomIndex = Math.floor(Math.random() * startupAllSongs.length);
      const startupSong = lastPlayedSong ?? startupAllSongs[randomIndex] ?? startupAllSongs[0];

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
    const backendFavoriteIds = backendFavorites.map((song: Song) => song.id);
    const backendRecentIds = backendRecent.map((song: Song) => song.id);

    const backendHasAnyState =
      backendFavoriteIds.length > 0 ||
      backendRecentIds.length > 0 ||
      backendPlaylists.length > 0;

    const localHasAnyState =
      favoriteIdsRef.current.length > 0 ||
      recentSongIdsRef.current.length > 0 ||
      playlistsRef.current.length > 0;

    if (!backendHasAnyState && localHasAnyState) {
      console.warn(
        "libraryState returned empty while local user-state exists. Keeping local favorites/recent/playlists instead of wiping them."
      );

      if (!emptyBackendLibraryStateWarningShownRef.current) {
        emptyBackendLibraryStateWarningShownRef.current = true;
        showNotice("Could not load saved account library yet; keeping local favorites/recent/playlists.");
      }

      return;
    }

    emptyBackendLibraryStateWarningShownRef.current = false;
    applyFavoriteIds(backendFavoriteIds);
    applyRecentSongIds(backendRecentIds);
    applyPlaylists(backendPlaylists);

    rememberSongObjects([
      ...backendFavorites,
      ...backendRecent,
      ...backendPlaylists.flatMap((playlist: ClientPlaylist) => playlist.songs ?? [])
    ]);
  }, [authToken, libraryStateData]);

  const currentSong = activeSong ?? startupAllSongs[0] ?? songs[0] ?? fallbackSongs[0];
  useEffect(() => {
    nowPlayingStore.setActiveSongId(currentSong.id);
  }, [nowPlayingStore, currentSong.id]);

  function dismissNotice() {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }

    setNotice("");
  }

  function showNotice(message: string) {
    dismissNotice();

    setNotice(message);

    noticeTimerRef.current = window.setTimeout(() => {
      setNotice("");
      noticeTimerRef.current = null;
    }, 2800);
  }

  async function startGuestLogin() {
    if (hasToken || guestLoginStarting) {
      return;
    }

    setGuestLoginStarting(true);

    try {
      const response = await fetch(`${authApiOrigin()}/auth/google/url`);

      if (!response.ok) {
        throw new Error(`Google login URL request failed with ${response.status}`);
      }

      const data = await response.json() as { url?: string };

      if (!data.url) {
        throw new Error("The API did not return a Google login URL.");
      }

      window.location.href = data.url;
    } catch (error) {
      console.error("Could not start Google login", error);
      setGuestLoginStarting(false);
      showNotice("Could not start login. Please try again.");
    }
  }

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  function rememberRecent(song: Song) {
    if (song.id === PLACEHOLDER_SONG_ID) return;

    rememberSongObjects([song]);

    applyRecentSongIds([
      song.id,
      ...recentSongIdsRef.current.filter((id) => id !== song.id)
    ]);

    rememberPlayedSong(song);
  }

  function rememberPlayedSong(song: Song) {
    if (song.id === PLACEHOLDER_SONG_ID) return;

    setPlayHistory((items) => {
      const withoutDuplicate = items.filter((item) => item.id !== song.id);
      return [song, ...withoutDuplicate].slice(0, 100);
    });
  }

  function rememberSongObjects(songsToRemember: Song[]) {
    if (!songsToRemember.length) return;
    setCachedSongs(items => {
      const existing = new Map(items.map(song => [song.id, song]));
      const changed = uniqueSongsById(songsToRemember).filter(song => {
        const previous = existing.get(song.id);
        return !previous || !sameCachedSong(previous, song);
      });
      if (!changed.length) return items;
      const updatedIds = new Set(changed.map(song => song.id));
      return [...changed, ...items.filter(song => !updatedIds.has(song.id))]
        .slice(0, FULL_LIBRARY_REMEMBER_LIMIT);
    });
  }

  async function handleLocalUploads(files: File[]) {
    const audioFilePattern = /\.(aac|aif|aiff|alac|flac|m4a|m4b|mp3|mp4|oga|ogg|opus|wav|weba|webm|wma)$/i;
    const audioFiles = files.filter((file) => file.size > 0 && (file.type.startsWith("audio/") || audioFilePattern.test(file.name)));
    const skippedFiles = files.filter((file) => !audioFiles.includes(file));

    if (!audioFiles.length) {
      showNotice("Choose at least one readable audio file.");
      return;
    }

    if (skippedFiles.length) {
      showNotice(`Skipped ${skippedFiles.length} non-audio or empty file(s): ${skippedFiles.map((file) => file.name).slice(0, 3).join(", ")}${skippedFiles.length > 3 ? "..." : ""}`);
    }

    showNotice(`Uploading ${audioFiles.length} local audio file(s)...`);

    const uploaded: Song[] = [];

    for (const file of audioFiles) {
      try {
        const result = await uploadTrack(file, "", "", "");
        const track = result as unknown as Song;

        if (track?.id && track.streamUrl) {
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

  // Keep imperative playback policy aligned with the exact song rendered by Player.
  // During startup activeSong can still be null while currentSong already falls back
  // to the cached/library song shown in the UI.
  currentSongRef.current = currentSong;
  shuffleEnabledRef.current = shuffleEnabled;
  repeatModeRef.current = repeatMode;
  playHistoryRef.current = playHistory;
  playbackContextRef.current = playbackContext;
  queueRef.current = queue;
  allKnownSongsRef.current = allKnownSongs;

  useEffect(() => {
    window.localStorage.setItem("wavestack:shuffle-enabled", String(shuffleEnabled));
  }, [shuffleEnabled]);

  useEffect(() => {
    window.localStorage.setItem("wavestack:repeat-mode", repeatMode);
  }, [repeatMode]);

  type PlaybackAdvanceReason = "manual" | "ended";

  async function fetchFreshPlayableSong(song: Song): Promise<Song> {
    if (!/\/(?:drive\/stream|api\/uploads)\//.test(song.streamUrl)) {
      return song;
    }

    const result = await apolloClient.query<{ songDetails: Song | null }>({
      query: SONG_DETAILS_QUERY,
      variables: { id: song.id },
      fetchPolicy: "network-only"
    });
    const refreshed = result.data.songDetails;

    if (!refreshed?.streamUrl) {
      throw new Error("WaveStack could not refresh this song's playback link.");
    }

    if (refreshed.id && refreshed.id !== song.id) {
      throw new Error("WaveStack returned refreshed metadata for the wrong song.");
    }

    // A response can carry the requested GraphQL song id while still containing
    // a stale stream_url from another Drive row. The immutable Drive file id in
    // the URL path must agree with the immutable id encoded in song.id.
    assertStreamUrlBelongsToSong(song.id, refreshed.streamUrl);

    return {
      ...song,
      ...refreshed,
      id: song.id,
      streamUrl: refreshed.streamUrl
    };
  }

  async function refreshSongStreamUrl(song: Song): Promise<Song> {
    const refreshed = await fetchFreshPlayableSong(song);

    if (currentSongRef.current?.id === song.id) {
      currentSongRef.current = refreshed;
      lastPlayedSongIdRef.current = refreshed.id;
      window.localStorage.setItem("wavestack:last-song-id", refreshed.id);
      writeLocalJson("wavestack:last-song", refreshed);
      setActiveSong(refreshed);
    }

    return refreshed;
  }

  function startSong(song: Song, options: { preserveContext?: boolean } = {}) {
    const previousSong = currentSongRef.current;
    const shouldFollowPlaybackInDetails =
      Boolean(previousSong) &&
      songDetailsStore.getSnapshot()?.song.id === previousSong?.id &&
      nowPlayingStore.getState().isPlaying;

    // Commit the user's play request immediately. Do not wait for a network refresh here:
    // delaying the state change makes rapid song clicks race each other and can outlive
    // the browser's transient user-activation window. The Player refreshes an expired
    // signed URL on demand and retries failed signed streams without lengthening the URL TTL.
    playRequestIdRef.current += 1;
    currentSongRef.current = song;
    nowPlayingStore.setActiveSongId(song.id);
    lastPlayedSongIdRef.current = song.id;
    window.localStorage.setItem("wavestack:last-song-id", song.id);
    writeLocalJson("wavestack:last-song", song);
    setActiveSong(song);

    if (
      shouldFollowPlaybackInDetails &&
      previousSong &&
      song.id !== previousSong.id
    ) {
      songDetailsStore.followPlayback(previousSong.id, song, playbackContextRef.current);
    }

    setPlaySignal((value) => value + 1);
  }

  function popNextQueuedSong(): Song | null {
    const latestQueue = queueRef.current;

    if (!latestQueue.length) {
      return null;
    }

    const [nextSong, ...remainingQueue] = latestQueue;

    if (!nextSong) {
      return null;
    }

    queueRef.current = remainingQueue;
    setQueue(remainingQueue);

    return nextSong;
  }

  function usesBackendShufflePool(source: PlaybackContext["source"]): boolean {
    return source === "all" || source === "search";
  }

  function getPolicySongs(context: PlaybackContext): Song[] {
    if (context.source === "dashboard") {
      const fullLibrary = allKnownSongsRef.current.filter(Boolean);

      if (fullLibrary.length > context.songs.length) {
        return uniqueSongsById(fullLibrary);
      }
    }

    return uniqueSongsById(context.songs.filter(Boolean));
  }

  function pickRandomSong(candidates: Song[]): Song | null {
    if (!candidates.length) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * candidates.length);
    return candidates[randomIndex] ?? null;
  }

  function getUnplayedSongs(contextSongs: Song[], currentSongId: string): Song[] {
    const playedIds = playedSinceManualPlayIdsRef.current;
    return contextSongs.filter((song) => song.id !== currentSongId && !playedIds.has(song.id));
  }

  function resetPlayedSession(song: Song) {
    playedSinceManualPlayIdsRef.current = new Set([song.id]);
  }

  function markPlayed(song: Song) {
    playedSinceManualPlayIdsRef.current.add(song.id);
  }

  function resetExhaustedRepeatSession(currentSong: Song): Song[] {
    playedSinceManualPlayIdsRef.current = new Set([currentSong.id]);

    const latestContext = playbackContextRef.current;

    if (!latestContext) {
      return [];
    }

    return getPolicySongs(latestContext).filter((song) => song.id !== currentSong.id);
  }

  function findNextSequentialSong(contextSongs: Song[], currentSongId: string): Song | null {
    const currentIndex = contextSongs.findIndex((song) => song.id === currentSongId);

    if (currentIndex < 0) {
      return null;
    }

    return contextSongs[currentIndex + 1] ?? null;
  }

  function findNextRepeatAllSong(contextSongs: Song[], currentSong: Song, shuffle: boolean): Song | null {
    if (contextSongs.length <= 1) {
      return null;
    }

    if (shuffle) {
      const freshCandidates = resetExhaustedRepeatSession(currentSong);
      return pickRandomSong(freshCandidates);
    }

    const currentIndex = contextSongs.findIndex((song) => song.id === currentSong.id);

    if (currentIndex < 0) {
      return contextSongs[0] ?? null;
    }

    return contextSongs[(currentIndex + 1) % contextSongs.length] ?? null;
  }

  async function fetchBackendRandomSong(
    context: PlaybackContext,
    excludeIds: string[]
  ): Promise<Song | null> {
    try {
      const response = await apolloClient.query<{ randomSong: Song | null }>({
        query: RANDOM_SONG_QUERY,
        variables: {
          query: context.queryFilter ?? null,
          excludeIds
        },
        fetchPolicy: "network-only"
      });

      return response.data?.randomSong ?? null;
    } catch (error) {
      console.error("Failed to fetch a random song for shuffle", error);
      return null;
    }
  }

  async function resolveNextSongFromCurrentPolicy(reason: PlaybackAdvanceReason): Promise<Song | null> {
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

    if (latestRepeatMode === "one" && reason === "ended") {
      return latestCurrentSong;
    }

    if (latestShuffleEnabled && usesBackendShufflePool(latestContext.source)) {
      playedSinceManualPlayIdsRef.current.add(latestCurrentSong.id);

      const excludeIds = Array.from(playedSinceManualPlayIdsRef.current).slice(-500);
      const backendPick = await fetchBackendRandomSong(latestContext, excludeIds);

      if (backendPick) {
        return backendPick;
      }

      if (latestRepeatMode === "all") {
        resetPlayedSession(latestCurrentSong);
        return fetchBackendRandomSong(latestContext, [latestCurrentSong.id]);
      }

      if (latestRepeatMode === "one") {
        return latestCurrentSong;
      }

      return null;
    }

    const contextSongs = getPolicySongs(latestContext);

    if (!contextSongs.length) {
      return null;
    }

    if (latestShuffleEnabled) {
      playedSinceManualPlayIdsRef.current.add(latestCurrentSong.id);

      const shuffledPick = pickRandomSong(getUnplayedSongs(contextSongs, latestCurrentSong.id));

      if (shuffledPick) {
        return shuffledPick;
      }

      if (latestRepeatMode === "all") {
        return findNextRepeatAllSong(contextSongs, latestCurrentSong, true);
      }

      if (latestRepeatMode === "one") {
        return latestCurrentSong;
      }

      return null;
    }

    const nextSong = findNextSequentialSong(contextSongs, latestCurrentSong.id);

    if (nextSong) {
      return nextSong;
    }

    if (latestRepeatMode === "all") {
      return findNextRepeatAllSong(contextSongs, latestCurrentSong, false);
    }

    return null;
  }

  async function playNextFromPolicy(reason: PlaybackAdvanceReason = "manual") {
    const latestCurrentSong = currentSongRef.current;

    setIsResolvingNextSong(true);
    let nextSong: Song | null = null;

    try {
      nextSong = await resolveNextSongFromCurrentPolicy(reason);
    } finally {
      setIsResolvingNextSong(false);
    }

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
    markPlayed(nextSong);

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

    const latestContext = playbackContextRef.current;

    if (shuffleEnabledRef.current && latestContext && usesBackendShufflePool(latestContext.source)) {
      showNotice("No previous song available.");
      return;
    }

    const latestCurrentSong = currentSongRef.current;
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
    // The context remains in memory for Next/Previous; only the selected song
    // belongs in durable recent-song storage (handled by rememberRecent below).

    const seenContextSongIds = new Set<string>();
    const deduplicatedContext = {
      ...context,
      songs: context.songs.filter(item => {
        if (seenContextSongIds.has(item.id)) return false;
        seenContextSongIds.add(item.id);
        return true;
      })
    };

    playbackContextRef.current = deduplicatedContext;
    setPlaybackContext(deduplicatedContext);

    playHistoryRef.current = [];
    setPlayHistory([]);
    resetPlayedSession(song);

    startSong(song, { preserveContext: true });
    rememberRecent(song);
    showNotice(`Now playing: ${formatSongDisplayName(song)}`);
  }

  function playSong(song: Song) {
    playSongFromContext(song, {
      id: "manual:all",
      label: "All Songs",
      source: "manual",
      songs: allKnownSongsRef.current.length ? allKnownSongsRef.current : [song]
    });
  }

  function openDetails(song: Song, context?: PlaybackContext) {
    // Start the details request in the same input turn as the click instead of
    // waiting for the modal subtree to mount. Apollo deduplicates the modal's
    // matching query and reuses any already-cached lyrics immediately.
    void apolloClient.query<{ songDetails: Song | null }>({
      query: SONG_DETAILS_QUERY,
      variables: { id: song.id },
      fetchPolicy: "cache-first"
    }).catch(() => undefined);

    // A queue backdrop left underneath the song dialog intercepts scrolling
    // after closing the dialog; only one overlay should be active at a time.
    if (queueDrawerOpen) setQueueDrawerOpen(false);
    songDetailsStore.open(song, context ?? null);
  }

  function playDetailsSong(song: Song, detailsPlaybackContext: PlaybackContext | null) {
    if (detailsPlaybackContext?.songs.some((item) => item.id === song.id)) {
      playSongFromContext(song, detailsPlaybackContext);
      return;
    }

    playSong(song);
  }

  function queueSong(song: Song) {
    if (song.id === PLACEHOLDER_SONG_ID) return;

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
    if (song.id === PLACEHOLDER_SONG_ID) return;

    rememberSongObjects([song]);

    const currentFavoriteIds = favoriteIdsRef.current;
    const isFavorite = currentFavoriteIds.includes(song.id);
    const optimisticFavoriteIds = isFavorite
      ? currentFavoriteIds.filter((id) => id !== song.id)
      : [song.id, ...currentFavoriteIds];

    applyFavoriteIds(optimisticFavoriteIds);

    showNotice(
      isFavorite
        ? `Removed favorite: ${formatSongDisplayName(song)}`
        : `Added favorite: ${formatSongDisplayName(song)}`
    );

    if (!authToken) {
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
      const returnedFavoriteIds = favorites.map((item) => item.id);

      if (isFavorite) {
        applyFavoriteIds(returnedFavoriteIds);
        rememberSongObjects(favorites);
      } else if (returnedFavoriteIds.includes(song.id)) {
        applyFavoriteIds(returnedFavoriteIds);
        rememberSongObjects(favorites);
      } else {
        console.warn(
          "favoriteSong did not return the added song after adding. Keeping optimistic favorite state."
        );

        applyFavoriteIds([
          song.id,
          ...returnedFavoriteIds,
          ...optimisticFavoriteIds.filter((id) => id !== song.id)
        ]);

        rememberSongObjects(favorites);
      }

      await refetchLibraryState();
    } catch (error) {
      console.error("Failed to sync favorite", error);
      showNotice(
        isFavorite
          ? "Removed favorite locally, but account sync failed. Sign in again if it reappears."
          : "Added favorite locally, but account sync failed. Sign in again if it does not sync."
      );
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
      applyPlaylists(next);
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
      applyPlaylists(next);
      setSelectedPlaylistId(next[0]?.id ?? "");
      await refetchLibraryState();

      showNotice(playlist ? `Deleted playlist: ${playlist.name}` : "Deleted playlist.");
    } catch (error) {
      console.error("Failed to delete playlist", error);
      showNotice("Could not delete playlist from your account.");
    }
  }

  async function addToPlaylist(playlistId: string, song: Song) {
    if (song.id === PLACEHOLDER_SONG_ID) return;

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
        applyPlaylists(next);
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
      await removeFromPlaylist(playlistId, song.id, song);
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
      applyPlaylists(next);
      rememberSongObjects(next.flatMap((item) => item.songs ?? []));
      await refetchLibraryState();

      showNotice(`Added ${formatSongDisplayName(song)} to ${playlist.name}.`);
    } catch (error) {
      console.error("Failed to add song to playlist", error);
      showNotice("Could not add song to your account playlist.");
    }
  }

  async function removeFromPlaylist(playlistId: string, songId: string, knownSong?: Song) {
    const playlist = playlists.find((item) => item.id === playlistId);
    const song = knownSong ?? songById.get(songId);

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
      applyPlaylists(next);
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
    if (!authUser || !currentSong || currentSong.id === PLACEHOLDER_SONG_ID) return;

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
      // Recommendation pages are an ephemeral infinite-scroll feed. Caching
      // every page made Apollo retain the full wall and previously triggered a
      // full-cache localStorage serialization on each append. Keep this feed out
      // of the normalized cache; Dashboard already owns the returned items.
      fetchPolicy: "no-cache",
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
    if (!hasToken) {
      setGuestDashboardSeed((seed) => (seed + 0x9e3779b9) >>> 0);
      showNotice("Loaded new random picks. Log in to make them more meaningful.");
      return;
    }

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

  const showListeningRail = !["/dashboard", "/stats", "/profile", "/oauth-callback"].includes(location.pathname);

  function renderSongsPage(
    title: string,
    pageSongs: Song[],
    emptyMessage: string,
    contextPlay?: PlaySongHandler,
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
          onOpenDetails={openDetails}
          initialQuery={title === "Search" ? globalSearchQuery : ""}
          resultsOnly={title === "Search"}
        />
      </section>
    );
  }

  return (
    <>
      <NowPlayingProvider store={nowPlayingStore}>
      <KeyboardShortcutsMenu />
      <div className="app-shell">
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
          </div>

          <GlobalSearch
            initialValue={globalSearchQuery}
            onSubmit={submitGlobalSearch}
            onOpenSong={(song, query) => openDetails(song, {
              id: `global-search:${query || "results"}`,
              label: query ? `Search: ${query}` : "Search",
              source: "search",
              queryFilter: query || null,
              songs: allKnownSongs
            })}
          />

          <AuthPanel
            user={authUser}
            isDarkMode={isDarkMode}
            onToggleDarkMode={toggleDarkMode}
            onLogout={logout}
          />
        </header>

        <aside className="app-left-column" aria-label="Navigation and player">
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

        <section className="app-player-region" aria-label="Player">
          <Player
            activeSong={currentSong}
            queue={queue}
            playSignal={playSignal}
            isFavorite={favoriteIds.includes(currentSong.id)}
            shuffleEnabled={shuffleEnabled}
            repeatMode={repeatMode}
            canGoPrevious={
              playHistory.length > 0 ||
              (!(shuffleEnabled && usesBackendShufflePool(playbackContext.source)) && playbackContext.songs.length > 1)
            }
            onToggleFavorite={() => toggleFavorite(currentSong)}
            onToggleShuffle={toggleShuffle}
            onCycleRepeatMode={cycleRepeatMode}
            onQueueChange={(nextQueue) => {
              const sanitizedQueue = uniqueSongsById(nextQueue);
              queueRef.current = sanitizedQueue;
              setQueue(sanitizedQueue);
            }}
            onRefreshStreamUrl={refreshSongStreamUrl}
            onOpenDetails={openDetails}
            onPlaybackStateChange={nowPlayingStore.setPlaybackState}
            resolvingNext={isResolvingNextSong}
            onNext={() => { void playNextFromPolicy("manual"); }}
            onPrevious={playPreviousFromHistory}
            onEnded={() => { void playNextFromPolicy("ended"); }}
        />
        </section>
        </aside>

        <main
          id="main-content"
          className="app-main"
        >
        <h1 className="sr-only">WaveStack music library</h1>

      {notice ? (
        <ToastNotice onDismiss={dismissNotice}>
          {notice}
        </ToastNotice>
      ) : null}
      {error ? (
        <p className="app-banner app-banner--error" role="alert">
          Could not load music library: {error.message}
        </p>
      ) : null}


      <div
        className={showListeningRail ? "route-content route-content--with-rail" : "route-content"}
        data-route-content
      >
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
                onPlay={(song: Song, context?: PlaybackContext) =>
                  playSongFromContext(song, context ?? {
                    id: "all:fallback",
                    label: "All Songs",
                    source: "all",
                    songs: allKnownSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                onOpenDetails={openDetails}
              />
            </section>
          }
        />
        <Route
          path="/dashboard"
          element={
            <section aria-label="Dashboard">
              {!hasToken ? (
                <GuestPersonalizationNotice
                  className="guest-personalization-notice--dashboard"
                  onLogin={() => { void startGuestLogin(); }}
                  loginBusy={guestLoginStarting}
                />
              ) : null}
              <Dashboard
                loading={hasToken ? loading : loading && guestDashboardRecommendations.length === 0}
                recommendations={hasToken ? visibleRecommendations : guestDashboardRecommendations}
                playlists={playlists}
                favoriteIds={favoriteIds}
                onPlay={(song: Song) =>
                  playSongFromContext(song, {
                    id: "dashboard:recommendations",
                    label: "Dashboard recommendations",
                    source: "dashboard",
                    songs: allKnownSongs.length ? allKnownSongs : recommendationSongs.length ? recommendationSongs : songs
                  })
                }
                onOpenDetails={(song: Song) =>
                  openDetails(song, {
                    id: "dashboard:recommendations",
                    label: "Dashboard recommendations",
                    source: "dashboard",
                    songs: allKnownSongs.length ? allKnownSongs : recommendationSongs.length ? recommendationSongs : songs
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
            (song: Song, context?: PlaybackContext) =>
              playSongFromContext(song, context ?? {
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
          element={renderSongsPage("Favorites", favoriteSongs, "No favorite songs yet. Click Favorite on a song first.", (song: Song, context?: PlaybackContext) =>
            playSongFromContext(song, context ?? {
              id: "favorites",
              label: "Favorites",
              source: "favorites",
              songs: favoriteSongs
            })
          )}
        />
        <Route
          path="/recent"
          element={renderSongsPage("Recently Played", recentSongs, "No recently played songs yet. Click Play on a song first.", (song: Song, context?: PlaybackContext) =>
            playSongFromContext(song, context ?? {
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
                onPlay={(song: Song, context?: PlaybackContext) =>
                  playSongFromContext(song, context ?? {
                    id: `playlist:${selectedPlaylistId}`,
                    label: playlists.find((p) => p.id === selectedPlaylistId)?.name ?? "Playlist",
                    source: "playlist",
                    songs: allKnownSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onOpenDetails={openDetails}
              />
            </section>
          }
        />
        <Route
          path="/stats"
          element={
            <section aria-label="Stats">
              {!hasToken ? (
                <article className="stats-page stats-page--guest">
                  <div className="guest-stats-state">
                    <p className="eyebrow">Stats</p>
                    <h2>Log in to make it more meaningful</h2>
                    <p>
                      Your Top Artists, Top Genres, recent plays, and listening comparisons are built from your own history.
                    </p>
                    <button
                      type="button"
                      onClick={() => { void startGuestLogin(); }}
                      disabled={guestLoginStarting}
                    >
                      {guestLoginStarting ? "Opening login..." : "Log in"}
                    </button>
                  </div>
                </article>
              ) : (
                <StatsPage
                  songs={allKnownSongs}
                  playlists={playlists}
                  favoriteIds={favoriteIds}
                  onPlay={(song: Song, context?: PlaybackContext) =>
                    playSongFromContext(song, context ?? {
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
              )}
            </section>
          }
        />
        <Route
          path="/profile"
          element={
              <ProfilePage
                user={authUser}
                songs={allKnownSongs}
                favorites={favoriteSongs}
                recentlyPlayed={recentSongs}
                playlists={playlists}
                favoriteIds={favoriteIds}
                queueLength={queue.length}
                habitSummaries={habitSummaries}
                onLogout={logout}
                onPlay={(song: Song, context?: PlaybackContext) =>
                  playSongFromContext(song, context ?? {
                    id: "profile",
                    label: "Profile",
                    source: "profile",
                    songs: favoriteSongs
                  })
                }
                onQueue={queueSong}
                onToggleFavorite={toggleFavorite}
                onAddToPlaylist={addToPlaylist}
                onOpenDetails={openDetails}
              />
          }
        />
        <Route
          path="/oauth-callback"
          element={<OAuthCallbackPage />}
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      {showListeningRail ? (
        hasToken ? (
          <ListeningHabitRail
            habitSummaries={habitSummaries}
            songs={allKnownSongs}
            onOpenDetails={openDetails}
          />
        ) : (
          <GuestListeningHabitRail
            songs={allKnownSongs}
            onOpenDetails={openDetails}
            onLogin={() => { void startGuestLogin(); }}
            loginBusy={guestLoginStarting}
          />
        )
      ) : null}
      </div>

      <SongDetailsLayer
          store={songDetailsStore}
          onPlay={playDetailsSong}
          onQueue={queueSong}
          favoriteIds={favoriteIds}
          playlists={playlists}
          onToggleFavorite={toggleFavorite}
          onAddToPlaylist={addToPlaylist}
      />

      <QueueDrawer
        open={queueDrawerOpen}
        queue={queue}
        currentSongId={currentSong.id}
        playlists={playlists}
        favoriteIds={favoriteIds}
        onClose={() => setQueueDrawerOpen(false)}
        onPlay={(song, context) => {
          playSongFromContext(song, context ?? {
            id: "queue",
            label: "Queue",
            source: "manual",
            songs: queue.length ? queue : [song]
          });
        }}
        onQueue={queueSong}
        onToggleFavorite={toggleFavorite}
        onAddToPlaylist={addToPlaylist}
        onRemove={removeFromQueue}
        onOpenDetails={openDetails}
        onClear={() => {
          queueRef.current = [];
          setQueue([]);
          showNotice("Queue cleared.");
        }}
      />

        <div className="bottom-player-spacer" aria-hidden="true" />
        </main>
      </div>
      </NowPlayingProvider>
    </>
  );
}

