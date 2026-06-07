import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@apollo/client";
import { SONG_PAGE_QUERY } from "../../api";
import type { ClientPlaylist, Song } from "../../App";
import { SongActions } from "../../components/SongActions";
import { SongIdentityButton } from "../../components/SongIdentityButton";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";

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

type SortMode = "DATE_DESC" | "DATE_ASC" | "TITLE_ASC";

type AllPageProps = {
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onOpenDetails: (song: Song) => void;
};

const PAGE_SIZE = 50;

export function AllPage({
  playlists,
  favoriteIds,
  onPlay,
  onQueue,
  onToggleFavorite,
  onAddToPlaylist,
  onOpenDetails
}: AllPageProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("DATE_DESC");
  const [songs, setSongs] = useState<Song[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);

    return () => window.clearTimeout(timer);
  }, [query]);

  const { data, loading, fetchMore, refetch } = useQuery<SongPageQueryData, SongPageQueryVariables>(
    SONG_PAGE_QUERY,
    {
      variables: {
        first: PAGE_SIZE,
        after: null,
        query: debouncedQuery || null,
        sort
      },
      fetchPolicy: "network-only",
      notifyOnNetworkStatusChange: true
    }
  );

  useEffect(() => {
    const page = data?.songPage;
    setSongs(page?.nodes ?? []);
    setCursor(page?.pageInfo.endCursor ?? null);
    setHasMore(Boolean(page?.pageInfo.hasNextPage));
  }, [data]);

  useEffect(() => {
    setSongs([]);
    setCursor(null);
    setHasMore(false);
    void refetch({ first: PAGE_SIZE, after: null, query: debouncedQuery || null, sort });
  }, [debouncedQuery, sort, refetch]);

  async function loadMore() {
    if (!cursor || !hasMore || isFetchingMore) {
      return;
    }

    setIsFetchingMore(true);

    try {
      const result = await fetchMore({
        variables: {
          first: PAGE_SIZE,
          after: cursor,
          query: debouncedQuery || null,
          sort
        }
      });

      const page = result.data?.songPage;

      if (!page) {
        return;
      }

      setSongs((current) => {
        const seen = new Set(current.map((song) => song.id));
        const next = page.nodes.filter((song) => !seen.has(song.id));
        return [...current, ...next];
      });
      setCursor(page.pageInfo.endCursor ?? null);
      setHasMore(page.pageInfo.hasNextPage);
    } finally {
      setIsFetchingMore(false);
    }
  }

  const sentinelRef = useInfiniteScroll({
    enabled: true,
    loading: loading || isFetchingMore,
    hasMore,
    onLoadMore: () => void loadMore(),
    rootMargin: "1200px"
  });

  const totalCount = data?.songPage.totalCount ?? songs.length;

  const progressPercent = useMemo(() => {
    if (!totalCount) {
      return 0;
    }

    return Math.min(100, Math.max(0, (songs.length / totalCount) * 100));
  }, [songs.length, totalCount]);

  function jumpByFastScroll(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const documentHeight = document.documentElement.scrollHeight - window.innerHeight;

    window.scrollTo({
      top: documentHeight * ratio,
      behavior: "auto"
    });

    if (ratio > 0.72 && hasMore && !isFetchingMore) {
      void loadMore();
    }
  }

  return (
    <article className="all-page" ref={scrollerRef}>
      <p className="eyebrow">Library</p>
      <h2>All Songs</h2>

      <div className="all-page__toolbar" aria-label="All songs controls">
        <label className="all-page__search">
          <Search aria-hidden="true" /> Search all songs
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, artist, album, or genre"
          />
        </label>

        <label className="all-page__sort">
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
            <option value="DATE_DESC">Date descending</option>
            <option value="DATE_ASC">Date ascending</option>
            <option value="TITLE_ASC">A-Z</option>
          </select>
        </label>
      </div>

      <p className="all-page__count">
        Showing {songs.length} of {totalCount} song(s). Lazy loading is on; no pagination.
      </p>

      {songs.length ? (
        <ul className="all-page__list" aria-label="All loaded songs">
          {songs.map((song, index) => {
            const isFavorite = favoriteIds.includes(song.id);

            return (
              <li key={song.id} className="song-list-row all-page__row">
                <SongIdentityButton
                  song={song}
                  index={index + 1}
                  subtitle={song.artistName}
                  onOpenDetails={onOpenDetails}
                />
                <SongActions
                  song={song}
                  playlists={playlists}
                  isFavorite={isFavorite}
                  onPlay={onPlay}
                  onQueue={onQueue}
                  onToggleFavorite={onToggleFavorite}
                  onAddToPlaylist={onAddToPlaylist}
                />
              </li>
            );
          })}
        </ul>
      ) : loading ? (
        <p className="infinite-scroll-status">Loading all songs...</p>
      ) : (
        <p>No songs found.</p>
      )}

      <div ref={sentinelRef} className="infinite-scroll-sentinel" aria-hidden="true" />

      {isFetchingMore ? <p className="infinite-scroll-status">Loading more songs...</p> : null}
      {!loading && !isFetchingMore && songs.length > 0 && !hasMore ? (
        <p className="infinite-scroll-status">You reached the end of all songs.</p>
      ) : null}

      <div
        className="all-page__fast-scroll"
        role="scrollbar"
        aria-label="Fast scroll all songs"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressPercent)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          jumpByFastScroll(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            jumpByFastScroll(event);
          }
        }}
      >
        <span style={{ height: `${Math.max(8, progressPercent)}%` }} />
      </div>
    </article>
  );
}
