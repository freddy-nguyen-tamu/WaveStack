import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useQuery } from "@apollo/client";
import { SONG_PAGE_QUERY } from "../../api";
import type { ClientPlaylist, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { SongListRow } from "../../components/SongListRow";
import { formatSongDisplayName } from "../../song-format";

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

const ALL_PAGE_SIZE = 60;

type AllPageProps = {
  songs: Song[];
  localTracks?: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onOpenDetails?: OpenSongDetailsHandler;
};

type SortMode = "az" | "artist" | "newest" | "oldest";

const INITIAL_VISIBLE_COUNT = 60;
const LOAD_CHUNK_SIZE = 60;
const FAST_SCROLL_THUMB_HEIGHT = 86;

function getSongDateValue(song: Song): number {
  if (song.addedAt) {
    const addedAt = Date.parse(song.addedAt);
    if (Number.isFinite(addedAt)) return addedAt;
  }

  const modifiedTime = song.modifiedTime ? Date.parse(song.modifiedTime) : Number.NaN;

  if (Number.isFinite(modifiedTime)) {
    return modifiedTime;
  }

  return 0;
}

function getBackendSort(sortMode: SortMode): string {
  switch (sortMode) {
    case "newest": return "DATE_DESC";
    case "oldest": return "DATE_ASC";
    case "artist": return "ARTIST_ASC";
    default: return "TITLE_ASC";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function AllPage({
  songs,
  localTracks = [],
  playlists,
  favoriteIds,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  onOpenDetails
}: AllPageProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fastScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("az");
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [thumbTop, setThumbTop] = useState(0);
  const [isDraggingFastScroll, setIsDraggingFastScroll] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setVisibleCount(INITIAL_VISIBLE_COUNT);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [query]);

  const backendSort = useMemo(() => getBackendSort(sortMode), [sortMode]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [sortMode]);

  const { data, loading, fetchMore } = useQuery<SongPageQueryData, SongPageQueryVariables>(
    SONG_PAGE_QUERY,
    {
      variables: {
        first: ALL_PAGE_SIZE,
        after: null,
        query: debouncedQuery || null,
        sort: backendSort
      },
      fetchPolicy: "network-only",
      nextFetchPolicy: "cache-first",
      notifyOnNetworkStatusChange: true
    }
  );

  const backendSongs = data?.songPage?.nodes ?? [];
  const backendTotalCount = data?.songPage?.totalCount ?? backendSongs.length;
  const hasMoreBackendSongs = Boolean(data?.songPage?.pageInfo?.hasNextPage);
  const backendEndCursor = data?.songPage?.pageInfo?.endCursor ?? null;

  const allSongs = useMemo(() => {
    const seen = new Set<string>();
    const base = backendSongs.length > 0 || loading ? backendSongs : songs;
    return [...localTracks, ...base].filter((song) => {
      if (seen.has(song.id)) {
        return false;
      }
      seen.add(song.id);
      return true;
    });
  }, [localTracks, songs, backendSongs, loading]);

  const filteredSongs = useMemo(() => {
    if (sortMode === "artist") {
      return [...allSongs].sort((left, right) => {
        const artistCompare = String(left.artistName ?? "").localeCompare(
          String(right.artistName ?? ""),
          undefined,
          { numeric: true, sensitivity: "base" }
        );

        if (artistCompare !== 0) return artistCompare;

        return String(left.title ?? "").localeCompare(
          String(right.title ?? ""),
          undefined,
          { numeric: true, sensitivity: "base" }
        );
      });
    }

    return [...allSongs].sort((left, right) => {
      if (sortMode === "newest" || sortMode === "oldest") {
        const diff = getSongDateValue(right) - getSongDateValue(left);
        if (diff !== 0) return sortMode === "newest" ? diff : -diff;
        return formatSongDisplayName(left).localeCompare(
          formatSongDisplayName(right),
          undefined,
          { numeric: true, sensitivity: "base" }
        );
      }

      return formatSongDisplayName(left).localeCompare(
        formatSongDisplayName(right),
        undefined,
        {
          numeric: true,
          sensitivity: "base"
        }
      );
    });
  }, [allSongs, sortMode]);

  const visibleSongs = filteredSongs.slice(0, visibleCount);
  const hasMore = visibleSongs.length < filteredSongs.length;
  const playbackContext = useMemo<PlaybackContext>(() => ({
    id: `all:${backendSort}:${debouncedQuery || "all"}`,
    label: debouncedQuery ? `All Songs: ${debouncedQuery}` : `All Songs (${sortMode})`,
    source: "all",
    queryFilter: debouncedQuery || null,
    songs: filteredSongs
  }), [backendSort, debouncedQuery, filteredSongs, sortMode]);

  const loadMoreBackendSongs = useCallback(async () => {
    if (!hasMoreBackendSongs || !backendEndCursor) {
      return;
    }

    await fetchMore({
      variables: {
        first: ALL_PAGE_SIZE,
        after: backendEndCursor,
        query: debouncedQuery || null,
        sort: backendSort
      },
      updateQuery: (previous, { fetchMoreResult }) => {
        if (!fetchMoreResult?.songPage) {
          return previous;
        }

        return {
          songPage: {
            ...fetchMoreResult.songPage,
            nodes: [
              ...(previous.songPage?.nodes ?? []),
              ...(fetchMoreResult.songPage.nodes ?? [])
            ]
          }
        };
      }
    });
  }, [backendEndCursor, backendSort, debouncedQuery, fetchMore, hasMoreBackendSongs]);

  const updateThumbFromWindowScroll = useCallback(() => {
    const track = fastScrollTrackRef.current;
    const list = listRef.current;

    if (!track || !list) {
      setThumbTop(0);
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(0, trackRect.height - FAST_SCROLL_THUMB_HEIGHT);
    const listTop = list.getBoundingClientRect().top + window.scrollY;
    const listBottom = listTop + list.scrollHeight;
    const viewportTravel = Math.max(1, listBottom - window.innerHeight - listTop);
    const scrolledInsideList = clamp(window.scrollY - listTop, 0, viewportTravel);
    const ratio = viewportTravel <= 0 ? 0 : scrolledInsideList / viewportTravel;

    setThumbTop(ratio * maxThumbTop);
  }, []);

  const scrollToFastScrollRatio = useCallback((ratio: number) => {
    const list = listRef.current;
    const track = fastScrollTrackRef.current;

    if (!list || !track) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(0, trackRect.height - FAST_SCROLL_THUMB_HEIGHT);
    const nextThumbTop = clamp(ratio, 0, 1) * maxThumbTop;
    const listTop = list.getBoundingClientRect().top + window.scrollY;
    const listBottom = listTop + list.scrollHeight;
    const viewportTravel = Math.max(0, listBottom - window.innerHeight - listTop);

    setThumbTop(nextThumbTop);

    window.scrollTo({
      top: listTop + viewportTravel * clamp(ratio, 0, 1),
      behavior: "auto"
    });
  }, []);

  function getRatioFromPointer(clientY: number): number {
    const track = fastScrollTrackRef.current;

    if (!track) {
      return 0;
    }

    const trackRect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(1, trackRect.height - FAST_SCROLL_THUMB_HEIGHT);
    const nextTop = clamp(
      clientY - trackRect.top - FAST_SCROLL_THUMB_HEIGHT / 2,
      0,
      maxThumbTop
    );

    return nextTop / maxThumbTop;
  }

  function handleFastScrollPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDraggingFastScroll(true);
    scrollToFastScrollRatio(getRatioFromPointer(event.clientY));
  }

  function handleFastScrollPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!isDraggingFastScroll) {
      return;
    }

    event.preventDefault();
    scrollToFastScrollRatio(getRatioFromPointer(event.clientY));
  }

  function stopFastScrollDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsDraggingFastScroll(false);
    updateThumbFromWindowScroll();
  }

  function handleFastScrollTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }

    event.preventDefault();
    scrollToFastScrollRatio(getRatioFromPointer(event.clientY));
  }

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
    window.requestAnimationFrame(updateThumbFromWindowScroll);
  }, [query, sortMode, filteredSongs.length, updateThumbFromWindowScroll]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const canLoadMoreBackendSongs = hasMoreBackendSongs && !loading && Boolean(backendEndCursor);

    if (!sentinel || (!hasMore && !canLoadMoreBackendSongs)) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (hasMore) {
            setVisibleCount((count) => Math.min(count + LOAD_CHUNK_SIZE, filteredSongs.length));
            return;
          }

          if (canLoadMoreBackendSongs) {
            void loadMoreBackendSongs();
          }
        }
      },
      {
        root: null,
        rootMargin: "900px 0px 1100px 0px",
        threshold: 0.01
      }
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [backendEndCursor, filteredSongs.length, hasMore, hasMoreBackendSongs, loadMoreBackendSongs, loading]);

  useEffect(() => {
    updateThumbFromWindowScroll();

    window.addEventListener("scroll", updateThumbFromWindowScroll, { passive: true });
    window.addEventListener("resize", updateThumbFromWindowScroll);

    return () => {
      window.removeEventListener("scroll", updateThumbFromWindowScroll);
      window.removeEventListener("resize", updateThumbFromWindowScroll);
    };
  }, [updateThumbFromWindowScroll, visibleSongs.length]);

  if (!allSongs.length) {
    return (
      <article className="all-page">
        <p className="eyebrow">Library</p>
        <h2>All Songs</h2>
        <p>No songs found. Upload your first track or sign in to load your library.</p>
      </article>
    );
  }

  return (
    <article className="all-page">
      <div className="all-page__header-row">
        <div>
          <p className="eyebrow">Library</p>
          <h2>All Songs ({backendTotalCount})</h2>
        </div>
      </div>

      <section className="all-page__controls" aria-label="All songs controls">
        <label className="all-page__search">
          <Search aria-hidden="true" /> Search all songs
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Song, artist, album, or genre"
          />
        </label>

        <label className="all-page__sort">
          Sort
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="az">Title A-Z</option>
            <option value="artist">Author A-Z</option>
            <option value="newest">Newest added</option>
            <option value="oldest">Oldest added</option>
          </select>
        </label>
      </section>

      <p className="all-page__summary">
        Showing {visibleSongs.length} of {filteredSongs.length} song(s).
        {hasMore ? " Scroll down or drag the red bar to lazy-load more." : " End of list."}
      </p>

      {visibleSongs.length ? (
        <ul ref={listRef} className="song-list all-page__list">
          {visibleSongs.map((song, index) => (
            <SongListRow
              key={song.id}
              song={song}
              index={index}
              playlists={playlists}
              favoriteIds={favoriteIds}
              playbackContext={playbackContext}
              onPlay={onPlay}
              onQueue={onQueue}
              onToggleFavorite={onToggleFavorite}
              onAddToPlaylist={onAddToPlaylist}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </ul>
      ) : (
        <p>No matching songs.</p>
      )}

      <div ref={sentinelRef} className="all-page__lazy-sentinel" aria-hidden="true" />

      <div
        ref={fastScrollTrackRef}
        className="all-page__fast-scroll"
        onPointerDown={handleFastScrollTrackPointerDown}
        aria-hidden="true"
      >
        <button
          type="button"
          className="all-page__fast-scroll-thumb"
          data-dragging={isDraggingFastScroll ? "true" : "false"}
          onPointerDown={handleFastScrollPointerDown}
          onPointerMove={handleFastScrollPointerMove}
          onPointerUp={stopFastScrollDrag}
          onPointerCancel={stopFastScrollDrag}
          style={{ transform: `translateY(${thumbTop}px)` }}
          tabIndex={-1}
          aria-label="Fast scroll all songs"
        />
      </div>

      {hasMoreBackendSongs && loading ? (
        <p className="infinite-scroll-status">Loading more songs...</p>
      ) : null}

      <div className="bottom-player-spacer" aria-hidden="true" />
    </article>
  );
}
