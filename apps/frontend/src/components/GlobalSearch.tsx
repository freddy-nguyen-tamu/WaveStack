import { Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Song } from "../App";
import { useSongPages } from "../hooks/useSongPages";
import { formatSeconds, formatSongDisplayName } from "../song-format";
import { readSearchHistory, rememberSearch } from "../search-history";
import { SongArtwork } from "./SongArtwork";

type GlobalSearchProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  onOpenSong: (song: Song) => void;
};

const LIVE_RESULT_LIMIT = 12;
const RECENT_SEARCH_LIMIT = 10;

export function GlobalSearch({ value, onChange, onSubmit, onOpenSong }: GlobalSearchProps) {
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(readSearchHistory);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(value.trim());
    }, 170);

    return () => window.clearTimeout(timer);
  }, [value]);

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

  const trimmedQuery = value.trim();
  const liveSearchEnabled = open && Boolean(debouncedQuery);
  const { page, loading, error } = useSongPages(
    debouncedQuery,
    "TITLE_ASC",
    LIVE_RESULT_LIMIT,
    liveSearchEnabled
  );
  const liveResults = page?.nodes ?? [];
  const queryIsSettled = trimmedQuery === debouncedQuery;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = value.trim();

    if (!query) {
      setOpen(true);
      inputRef.current?.focus();
      return;
    }

    setHistory(rememberSearch(query));
    setOpen(false);
    onSubmit(query);
  }

  function chooseRecent(query: string) {
    onChange(query);
    setHistory(rememberSearch(query));
    setOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function chooseSong(song: Song) {
    setOpen(false);
    onOpenSong(song);
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
        value={value}
        placeholder="What do you want to play?"
        aria-label="What do you want to play?"
        autoComplete="off"
        aria-expanded={open}
        aria-controls="global-search-popover"
        onChange={(event) => {
          onChange(event.target.value);
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
      <button type="submit" aria-label="Show all search results">
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
                {page ? <span>{page.totalCount.toLocaleString()} matches</span> : null}
              </div>

              {!queryIsSettled || (loading && !liveResults.length) ? (
                <p className="global-search__empty">Searching…</p>
              ) : null}

              {queryIsSettled && error ? (
                <p className="global-search__empty" role="alert">Could not load search results.</p>
              ) : null}

              {queryIsSettled && !error && liveResults.length ? (
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
                      <SongArtwork
                        song={song}
                        wrapClassName="global-search__art"
                        fallbackClassName="global-search__art-fallback"
                        imageClassName="global-search__art-image"
                        disableNowPlayingStyle
                      />
                      <span className="global-search__copy">
                        <strong>{song.title?.trim() || song.fileName?.trim() || "Untitled Track"}</strong>
                        <span>{song.artistName?.trim() || "Unknown Artist"}</span>
                      </span>
                      <span className="global-search__duration">{formatSeconds(song.durationSeconds)}</span>
                    </button>
                  ))}
                </div>
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
