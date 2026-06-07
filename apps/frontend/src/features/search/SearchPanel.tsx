import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { SONG_PAGE_QUERY } from "../../api";
import type { ClientPlaylist, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { SongListRow } from "../../components/SongListRow";
import { PaginationBar } from "../../components/PaginationBar";

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

type SearchPanelProps = {
  pageKey: string;
  title: string;
  songs: Song[];
  playlists: ClientPlaylist[];
  favoriteIds: string[];
  emptyMessage?: string;
  onAddToPlaylist: (playlistId: string, song: Song) => void;
  onPlay: (song: Song) => void;
  onQueue: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onOpenDetails: (song: Song) => void;
};

const PAGE_SIZE = 30;

export function SearchPanel({
  pageKey,
  title,
  songs,
  playlists,
  favoriteIds,
  emptyMessage = "No songs found.",
  onAddToPlaylist,
  onPlay,
  onQueue,
  onToggleFavorite,
  onOpenDetails
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [message, setMessage] = useState("");
  const [allResults, setAllResults] = useState<Song[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setAllResults([]);
      setCursor(null);
      setHasMore(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, fetchMore, loading } = useQuery<SongPageQueryData, SongPageQueryVariables>(
    SONG_PAGE_QUERY,
    {
      variables: { first: 30, after: null, query: debouncedQuery || null },
      fetchPolicy: "cache-and-network",
      skip: !debouncedQuery
    }
  );

  useEffect(() => {
    if (data?.songPage) {
      setAllResults(data.songPage.nodes ?? []);
      setCursor(data.songPage.pageInfo.endCursor ?? null);
      setHasMore(data.songPage.pageInfo.hasNextPage);
    }
  }, [data]);

  async function loadMore() {
    if (!cursor || !hasMore) return;
    const result = await fetchMore({
      variables: { first: 30, after: cursor, query: debouncedQuery || null }
    });
    const page = result.data?.songPage;
    if (page?.nodes) {
      setAllResults((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const deduped = page.nodes.filter((n) => !seen.has(n.id));
        return [...prev, ...deduped];
      });
      setCursor(page.pageInfo.endCursor ?? null);
      setHasMore(page.pageInfo.hasNextPage);
    }
  }

  const fallbackResults = useMemo(() => {
    if (debouncedQuery) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return songs;
    return songs.filter((song) => {
      const haystack = [song.title, song.artistName, song.albumTitle, formatSongDisplayName(song), ...song.genreNames].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [query, debouncedQuery, songs]);

  const results = debouncedQuery ? allResults : fallbackResults;
  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedResults = results.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setAllResults([]);
    setMessage("");
    setCursor(null);
    setHasMore(false);
    setPage(1);
  }, [pageKey]);

  useEffect(() => {
    setPage(1);
  }, [query, results.length]);

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
    onPlay(song);
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
    onAddToPlaylist(playlistId, song);
    setMessage(`Playlist action sent for: ${formatSongDisplayName(song)}`);
  }

  return (
    <article>
      <h2>{title}</h2>
      <label>
        <Search aria-hidden="true" /> Song, artist, album, or genre
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {message ? (
        <p className="toast-notice toast-notice--status" role="status">
          {message}
        </p>
      ) : null}
      <p>
        Showing {pagedResults.length} of {results.length} song(s).
        {debouncedQuery ? ` (DB search: "${debouncedQuery}")` : ""}
        {loading ? " — searching..." : ""}
        {pageCount > 1 ? ` Page ${currentPage} of ${pageCount}.` : ""}
      </p>
      {pagedResults.length ? (
        <>
          <ul className="song-list">
            {pagedResults.map((song, index) => (
              <SongListRow
                key={song.id}
                song={song}
                index={(currentPage - 1) * PAGE_SIZE + index}
                playlists={playlists}
                favoriteIds={favoriteIds}
                onPlay={play}
                onQueue={queue}
                onToggleFavorite={(item) => toggleFavorite(item, favoriteIds.includes(item.id))}
                onAddToPlaylist={add}
                onOpenDetails={onOpenDetails}
              />
            ))}
          </ul>

          <PaginationBar
            currentPage={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
            label={`${title} pagination`}
          />
        </>
      ) : <p>{emptyMessage}</p>}
      {hasMore ? (
        <button type="button" onClick={() => void loadMore()} disabled={loading}>
          {loading ? "Loading more..." : "Load more search results"}
        </button>
      ) : null}
    </article>
  );
}
