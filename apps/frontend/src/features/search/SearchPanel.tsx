import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSongPages } from "../../hooks/useSongPages";
import { LoadingStatus } from "../../components/LoadingStatus";
import { useStableScrollRegion } from "../../hooks/useStableScrollRegion";
import type { ClientPlaylist, OpenSongDetailsHandler, PlaybackContext, PlaySongHandler, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { SongListRow } from "../../components/SongListRow";
import { PaginationBar } from "../../components/PaginationBar";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { ToastNotice } from "../../components/ToastNotice";

type SearchPanelProps = {
  pageKey: string;
  title: string;
  songs: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  emptyMessage?: string;
  backendSearch?: boolean;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onPlay: PlaySongHandler;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onOpenDetails: OpenSongDetailsHandler;
};

const PAGE_SIZE = 30;

export function SearchPanel({
  pageKey,
  title,
  songs,
  playlists,
  favoriteIds,
  emptyMessage = "No songs found.",
  backendSearch = false,
  onAddToPlaylist,
  onPlay,
  onQueue,
  onToggleFavorite,
  onOpenDetails
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { page: resultPage, loading, error, loadMore, retry } = useSongPages(debouncedQuery, "TITLE_ASC", PAGE_SIZE, backendSearch);
  const hasMore = Boolean(resultPage?.pageInfo.hasNextPage);
  const regionRef = useStableScrollRegion(loading || query.trim() !== debouncedQuery);

  const searchSentinelRef = useInfiniteScroll({
    enabled: backendSearch && !error && query.trim() === debouncedQuery,
    loading,
    hasMore,
    onLoadMore: () => {
      void loadMore();
    },
    rootMargin: "800px"
  });

  const fallbackResults = useMemo(() => {
    const needle = debouncedQuery.toLowerCase();

    if (!needle) {
      return songs;
    }

    return songs.filter((song) => {
      const haystack = [song.fileName, song.title, song.artistName, song.albumTitle, formatSongDisplayName(song), ...song.genreNames].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [debouncedQuery, songs]);

  const results = backendSearch ? resultPage?.nodes ?? [] : fallbackResults;

  const totalMatchingCount = backendSearch
    ? resultPage?.totalCount ?? results.length
    : results.length;

  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedResults = results.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const displayedResults = backendSearch ? results : pagedResults;
  const playbackSource: PlaybackContext["source"] =
    title === "Favorites" ? "favorites" : title === "Recently Played" ? "recent" : "search";
  const playbackContext = useMemo<PlaybackContext>(() => ({
    id: `${pageKey}:${backendSearch ? "backend" : "local"}:${debouncedQuery || query.trim() || "all"}`,
    label: debouncedQuery || query.trim() ? `${title}: ${debouncedQuery || query.trim()}` : title,
    source: playbackSource,
    queryFilter: backendSearch ? (debouncedQuery.trim() || null) : null,
    songs: results
  }), [backendSearch, debouncedQuery, pageKey, playbackSource, query, results, title]);

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setMessage("");
    setPage(1);
  }, [pageKey]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessage("");
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [message]);

  function play(song: Song) {
    onPlay(song, playbackContext);
    setMessage(`Playing: ${formatSongDisplayName(song)}`);
  }

  function queue(song: Song) {
    onQueue(song);
    setMessage(`Queue action sent for: ${formatSongDisplayName(song)}`);
  }

  function toggleFavorite(song: Song, isFavorite: boolean) {
    onToggleFavorite(song);
    setMessage(isFavorite ? `Removed favorite: ${formatSongDisplayName(song)}` : `Added favorite: ${formatSongDisplayName(song)}`);
  }

  function add(playlistId: string, song: Song) {
    return onAddToPlaylist(playlistId, song);
  }

  return (
    <article ref={regionRef}>
      <h2>{title}</h2>
      <label>
        <Search aria-hidden="true" /> Song, artist, album, or genre
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {message ? (
        <ToastNotice onDismiss={() => setMessage("")}>
          {message}
        </ToastNotice>
      ) : null}
      <p>
        {backendSearch ? (
          <>Showing {displayedResults.length} loaded of {totalMatchingCount} matching song(s).</>
        ) : (
          <>Showing {displayedResults.length} of {totalMatchingCount} matching song(s).</>
        )}
        {backendSearch && debouncedQuery ? ` (DB search: "${debouncedQuery}")` : ""}
        {backendSearch && loading ? " — searching..." : ""}
        {!backendSearch && pageCount > 1 ? ` Page ${currentPage} of ${pageCount}.` : ""}
      </p>
      {displayedResults.length ? (
        <>
          <ul className="song-list">
            {displayedResults.map((song, index) => (
              <SongListRow
                key={song.id}
                song={song}
                index={backendSearch ? index : (currentPage - 1) * PAGE_SIZE + index}
                playlists={playlists}
                favoriteIds={favoriteIds}
                playbackContext={playbackContext}
                onPlay={play}
                onQueue={queue}
                onToggleFavorite={(item) => toggleFavorite(item, favoriteIds.includes(item.id))}
                onAddToPlaylist={add}
                onOpenDetails={onOpenDetails}
              />
            ))}
          </ul>

          {!backendSearch && pageCount > 1 ? (
            <PaginationBar
              currentPage={currentPage}
              pageCount={pageCount}
              onPageChange={setPage}
              label={`${title} pagination`}
            />
          ) : null}
        </>
      ) : !loading && !error && query.trim() === debouncedQuery ? <p>{emptyMessage}</p> : null}
      {error ? <p role="alert">{error} <button type="button" onClick={retry}>Retry</button></p> : null}
      {backendSearch ? (
        <div ref={searchSentinelRef} className="infinite-scroll-sentinel" aria-hidden="true" />
      ) : null}
      {loading || query.trim() !== debouncedQuery ? (
        <LoadingStatus label="Loading search results..." />
      ) : null}
    </article>
  );
}
