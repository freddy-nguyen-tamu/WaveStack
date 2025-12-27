import { Heart, ListPlus, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { SONG_PAGE_QUERY } from "../../api";
import type { ClientPlaylist, Song } from "../../App";
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
};

type SearchPanelProps = {
  pageKey: string;
  title: string;
  songs: Song[];
  playlists: ClientPlaylist[];
  selectedPlaylistId: string;
  favoriteIds: string[];
  emptyMessage?: string;
  onSelectedPlaylistChange: (playlistId: string) => void;
  onCreatePlaylist: (name: string) => void;
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
  selectedPlaylistId,
  favoriteIds,
  emptyMessage = "No songs found.",
  onSelectedPlaylistChange,
  onCreatePlaylist,
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
      variables: {
        first: 30,
        after: null,
        query: debouncedQuery || null
      },
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
      variables: {
        first: 30,
        after: cursor,
        query: debouncedQuery || null
      }
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
      const haystack = [
        song.title,
        song.artistName,
        song.albumTitle,
        formatSongDisplayName(song),
        ...song.genreNames
      ].join(" ").toLowerCase();
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

  function createPlaylistFromPrompt() {
    const name = window.prompt("Playlist name", "My Playlist");

    if (name) {
      onCreatePlaylist(name);
      setMessage(`Created playlist: ${name.trim()}`);
      return;
    }

    setMessage("Playlist creation cancelled.");
  }

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
    setMessage(
      isFavorite
        ? `Removed favorite: ${formatSongDisplayName(song)}`
        : `Added favorite: ${formatSongDisplayName(song)}`
    );
  }

  function add(song: Song) {
    onAddToPlaylist(selectedPlaylistId, song);
    setMessage(`Playlist action sent for: ${formatSongDisplayName(song)}`);
  }

  return (
    <article>
      <h2>{title}</h2>

      <label>
        <Search aria-hidden="true" /> Song, artist, album, or genre
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      <div>
        <label>
          Playlist
          <select
            value={selectedPlaylistId}
            onChange={(event) => onSelectedPlaylistChange(event.target.value)}
          >
            <option value="">Create/select playlist</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name} ({playlist.songIds.length})
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={createPlaylistFromPrompt}>
          <ListPlus aria-hidden="true" /> New playlist
        </button>
      </div>

      {message ? <p role="status">{message}</p> : null}

      <p>
        Showing {results.length} song(s)
        {debouncedQuery ? ` (DB search: "${debouncedQuery}")` : ""}
        {loading ? " — searching..." : ""}
      </p>

      {results.length ? (
        <ul>
          {results.map((song) => {
            const isFavorite = favoriteIds.includes(song.id);

            return (
              <li key={song.id}>
                <button type="button" onClick={() => play(song)}>
                  <Play aria-hidden="true" /> Play
                </button>

                <button type="button" onClick={() => queue(song)}>
                  Queue
                </button>

                <button type="button" onClick={() => toggleFavorite(song, isFavorite)} aria-pressed={isFavorite}>
                  <Heart aria-hidden="true" /> {isFavorite ? "Unfavorite" : "Favorite"}
                </button>

                <button type="button" onClick={() => add(song)}>
                  <ListPlus aria-hidden="true" /> Add to playlist
                </button>

                <strong>{formatSongDisplayName(song)}</strong> - {song.albumTitle}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{emptyMessage}</p>
      )}

      {hasMore ? (
        <div className="load-more-row">
          <button type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading..." : "Load more results"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
