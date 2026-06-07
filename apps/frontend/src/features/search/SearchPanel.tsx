import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { SONG_PAGE_QUERY } from "../../api";
import type { ClientPlaylist, Song } from "../../App";
import { formatSongDisplayName } from "../../song-format";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import { SongActions } from "../../components/SongActions";
import { SongArtwork } from "../../components/SongArtwork";

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
};

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
  onToggleFavorite
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [message, setMessage] = useState("");
  const [allResults, setAllResults] = useState<Song[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

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

  const sentinelRef = useInfiniteScroll({
    enabled: debouncedQuery.length > 0,
    loading,
    hasMore,
    onLoadMore: () => { void loadMore(); }
  });

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

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setAllResults([]);
    setMessage("");
    setCursor(null);
    setHasMore(false);
  }, [pageKey]);

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
      {message ? <p role="status">{message}</p> : null}
      <p>Showing {results.length} song(s){debouncedQuery ? ` (DB search: "${debouncedQuery}")` : ""}{loading ? " — searching..." : ""}</p>
      {results.length ? (
        <ul>
          {results.map((song, index) => {
            const isFavorite = favoriteIds.includes(song.id);
            return (
              <li key={song.id} className="song-list-row">
                <SongArtwork
                  song={song}
                  wrapClassName="song-list-row__art"
                  fallbackClassName="song-list-row__art-fallback"
                  imageClassName="song-list-row__art-image"
                />
                <div className="song-list-row__body">
                  <strong>
                    <span className="song-list-row__index">{index + 1}.</span>{" "}
                    {formatSongDisplayName(song)}
                  </strong>
                  {song.albumTitle ? <small>{song.albumTitle}</small> : null}
                  <SongActions
                    song={song}
                    playlists={playlists}
                    isFavorite={isFavorite}
                    onPlay={play}
                    onQueue={queue}
                    onToggleFavorite={(item) => toggleFavorite(item, isFavorite)}
                    onAddToPlaylist={add}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p>{emptyMessage}</p>}
      {hasMore ? <div ref={sentinelRef} className="infinite-scroll-sentinel" aria-hidden="true" /> : null}
      {loading && allResults.length ? <p className="infinite-scroll-status">Loading more results...</p> : null}
      {!hasMore && allResults.length ? <p className="infinite-scroll-status">End of search results.</p> : null}
    </article>
  );
}
