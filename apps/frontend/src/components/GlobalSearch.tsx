import { Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Song } from "../App";
import { useSongPages } from "../hooks/useSongPages";
import { formatSeconds, formatSongDisplayName } from "../song-format";
import { readSearchHistory, rememberSearch } from "../search-history";

type GlobalSearchProps = {
  initialValue?: string;
  onSubmit: (query: string) => void;
  onOpenSong: (song: Song, query: string) => void;
};

const LIVE_RESULT_LIMIT = 12;
const RECENT_SEARCH_LIMIT = 10;
const LIVE_SEARCH_DEBOUNCE_MS = 260;

function SearchResultArtwork({ song }: { song: Song }) {
  const sources = [
    song.localThumbnailUrl,
    song.thumbnailUrl,
    song.driveThumbnailUrl,
    song.embeddedArtworkUrl
  ]
    .map((source) => source?.trim())
    .filter((source): source is string => Boolean(source))
    .filter((source, index, items) => items.indexOf(source) === index);
  const sourceKey = sources.join("|");
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [song.id, sourceKey]);

  const source = sources[sourceIndex];

  return (
    <span className="global-search__art" aria-hidden="true">
      <img
        className="global-search__art-placeholder"
        src="/icon-512.png"
        alt=""
        draggable={false}
        decoding="async"
      />
      {source ? (
        <img
          key={`${song.id}:${source}`}
          className="global-search__art-image"
          src={source}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          fetchPriority="low"
          onError={() => setSourceIndex((index) => index + 1)}
        />
      ) : null}
    </span>
  );
}

export function GlobalSearch({ initialValue = "", onSubmit, onOpenSong }: GlobalSearchProps) {
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(readSearchHistory);
  const [debouncedQuery, setDebouncedQuery] = useState(initialValue.trim());

  // The input intentionally owns its text locally. Keeping every keystroke out of
  // App.tsx prevents the whole player, route, navigation and listening rail from
  // re-rendering just because the user typed one character.
  useEffect(() => {
    if (document.activeElement === inputRef.current) {
      return;
    }

    setQuery(initialValue);
    setDebouncedQuery(initialValue.trim());
  }, [initialValue]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, LIVE_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      const target = event.target;

      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, []);

  const trimmedQuery = query.trim();
  const liveSearchEnabled = open && Boolean(debouncedQuery);
  const { page, loading, error } = useSongPages(
    debouncedQuery,
    "TITLE_ASC",
    LIVE_RESULT_LIMIT,
    liveSearchEnabled
  );
  const liveResults = page?.nodes ?? [];
  const queryIsSettled = trimmedQuery === debouncedQuery;
  const isUpdating = Boolean(trimmedQuery) && (!queryIsSettled || loading);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = query.trim();

    if (!nextQuery) {
      setOpen(true);
      return;
    }

    setHistory(rememberSearch(nextQuery));
    setOpen(false);
    onSubmit(nextQuery);
  }

  function chooseRecent(nextQuery: string) {
    setQuery(nextQuery);
    setHistory(rememberSearch(nextQuery));
    setOpen(true);
  }

  function chooseSong(song: Song) {
    setOpen(false);
    onOpenSong(song, trimmedQuery || debouncedQuery);
  }

  return (
    <form
      ref={rootRef}
      className="app-header__search global-search"
      role="search"
      onSubmit={submit}
      aria-label="Search WaveStack"
    >
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="What do you want to play?"
        aria-label="What do you want to play?"
        autoComplete="off"
        aria-expanded={open}
        aria-controls="global-search-popover"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setHistory(readSearchHistory());
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
      />
      <button className="global-search__submit" type="submit" aria-label="Show all search results">
        <Search aria-hidden="true" />
      </button>

      {open ? (
        <div
          id="global-search-popover"
          className="global-search__popover"
          role="region"
          aria-label={trimmedQuery ? "Live search results" : "Recent searches"}
          onPointerDown={(event) => {
            // Keep the input focused while a dropdown choice handles the pointer event.
            if ((event.target as HTMLElement).closest("button")) {
              event.preventDefault();
            }
          }}
        >
          {!trimmedQuery ? (
            <>
              <div className="global-search__heading">Recent searches</div>
              {history.length ? (
                <div className="global-search__recent" role="listbox" aria-label="Recent searches">
                  {history.slice(0, RECENT_SEARCH_LIMIT).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="global-search__recent-item"
                      role="option"
                      aria-selected="false"
                      onClick={() => chooseRecent(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="global-search__empty">No recent searches yet.</p>
              )}
            </>
          ) : (
            <>
              <div className="global-search__heading">
                <span>Search results</span>
                <span>
                  {isUpdating ? "Updating…" : page ? `${page.totalCount.toLocaleString()} matches` : ""}
                </span>
              </div>

              {liveResults.length ? (
                <div className="global-search__results" role="listbox" aria-label="Matching songs">
                  {liveResults.map((song) => (
                    <button
                      key={song.id}
                      type="button"
                      className="global-search__result"
                      role="option"
                      aria-selected="false"
                      title={`Open ${formatSongDisplayName(song)}`}
                      onClick={() => chooseSong(song)}
                    >
                      <SearchResultArtwork song={song} />
                      <span className="global-search__copy">
                        <strong>{song.title?.trim() || song.fileName?.trim() || "Untitled Track"}</strong>
                        <span>{song.artistName?.trim() || "Unknown Artist"}</span>
                      </span>
                      <span className="global-search__duration">{formatSeconds(song.durationSeconds)}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {isUpdating && !liveResults.length ? (
                <p className="global-search__empty">Searching…</p>
              ) : null}

              {queryIsSettled && error ? (
                <p className="global-search__empty" role="alert">Could not load search results.</p>
              ) : null}

              {queryIsSettled && !loading && !error && !liveResults.length ? (
                <p className="global-search__empty">No matching songs.</p>
              ) : null}

              <div className="global-search__footer">Press Enter to show all results</div>
            </>
          )}
        </div>
      ) : null}
    </form>
  );
}
