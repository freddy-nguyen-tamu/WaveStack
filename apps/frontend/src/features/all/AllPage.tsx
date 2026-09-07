import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useSongPages } from "../../hooks/useSongPages";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { LoadingStatus } from "../../components/LoadingStatus";
import { useStableScrollRegion } from "../../hooks/useStableScrollRegion";
import type { ClientPlaylist, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { SongListRow } from "../../components/SongListRow";

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

const FAST_SCROLL_THUMB_HEIGHT = 86;

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
  const fastScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const fastScrollThumbRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("az");
  const [isDraggingFastScroll, setIsDraggingFastScroll] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);

    return () => window.clearTimeout(timer);
  }, [query]);

  const backendSort = useMemo(() => getBackendSort(sortMode), [sortMode]);


  const { page: resultPage, loading, error, loadMore: loadMoreBackendSongs, retry } = useSongPages(debouncedQuery, backendSort, ALL_PAGE_SIZE);
  const backendSongs = resultPage?.nodes ?? [];
  const backendTotalCount = resultPage?.totalCount ?? backendSongs.length;
  const hasMoreBackendSongs = Boolean(resultPage?.pageInfo.hasNextPage);
  const regionRef = useStableScrollRegion(loading || query.trim() !== debouncedQuery);

  const allSongs = useMemo(() => {
    const seen = new Set<string>();
    const needle = debouncedQuery.toLowerCase();
    const matchingLocalTracks = localTracks.filter(song => !needle || [song.fileName, song.title, song.artistName, song.albumTitle, ...song.genreNames].join(" ").toLowerCase().includes(needle));
    return [...matchingLocalTracks, ...backendSongs].filter((song) => {
      if (seen.has(song.id)) {
        return false;
      }
      seen.add(song.id);
      return true;
    });
  }, [localTracks, backendSongs, debouncedQuery]);

  // The server owns ordering. Re-sorting every appended page moves existing rows.
  const visibleSongs = allSongs;
  const hasMore = hasMoreBackendSongs;
  const playbackContext = useMemo<PlaybackContext>(() => ({
    id: `all:${backendSort}:${debouncedQuery || "all"}`,
    label: debouncedQuery ? `All Songs: ${debouncedQuery}` : `All Songs (${sortMode})`,
    source: "all",
    queryFilter: debouncedQuery || null,
    songs: allSongs
  }), [backendSort, debouncedQuery, allSongs, sortMode]);

  const sentinelRef = useInfiniteScroll({
    enabled: !error && query.trim() === debouncedQuery,
    loading,
    hasMore,
    onLoadMore: () => { void loadMoreBackendSongs(); }
  });

  const updateThumbFromWindowScroll = useCallback(() => {
    const track = fastScrollTrackRef.current;
    const list = listRef.current;

    if (!track || !list) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(0, trackRect.height - FAST_SCROLL_THUMB_HEIGHT);
    const listTop = list.getBoundingClientRect().top + window.scrollY;
    const listBottom = listTop + list.scrollHeight;
    const viewportTravel = Math.max(1, listBottom - window.innerHeight - listTop);
    const scrolledInsideList = clamp(window.scrollY - listTop, 0, viewportTravel);
    const ratio = viewportTravel <= 0 ? 0 : scrolledInsideList / viewportTravel;

    if (fastScrollThumbRef.current) fastScrollThumbRef.current.style.transform = `translateY(${ratio * maxThumbTop}px)`;
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

    if (fastScrollThumbRef.current) fastScrollThumbRef.current.style.transform = `translateY(${nextThumbTop}px)`;

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
    updateThumbFromWindowScroll();

    window.addEventListener("scroll", updateThumbFromWindowScroll, { passive: true });
    window.addEventListener("resize", updateThumbFromWindowScroll);

    return () => {
      window.removeEventListener("scroll", updateThumbFromWindowScroll);
      window.removeEventListener("resize", updateThumbFromWindowScroll);
    };
  }, [updateThumbFromWindowScroll, visibleSongs.length]);

  return (
    <article ref={regionRef} className="all-page">
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
        Showing {visibleSongs.length} of {backendTotalCount} song(s).
        {!hasMore && !loading && !error ? " End of list." : ""}
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
      ) : !loading && !error ? (
        <p>No matching songs.</p>
      ) : null}

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
          ref={fastScrollThumbRef}
          data-dragging={isDraggingFastScroll ? "true" : "false"}
          onPointerDown={handleFastScrollPointerDown}
          onPointerMove={handleFastScrollPointerMove}
          onPointerUp={stopFastScrollDrag}
          onPointerCancel={stopFastScrollDrag}
          tabIndex={-1}
          aria-label="Fast scroll all songs"
        />
      </div>

      {error ? <p role="alert">{error} <button type="button" onClick={retry}>Retry</button></p> : null}
      {loading || query.trim() !== debouncedQuery ? (
        <LoadingStatus label="Loading songs..." />
      ) : null}

      <div className="bottom-player-spacer" aria-hidden="true" />
    </article>
  );
}
