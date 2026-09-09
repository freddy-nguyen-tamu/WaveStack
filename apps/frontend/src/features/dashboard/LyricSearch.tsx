import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoadingStatus } from "../../components/LoadingStatus";

type LyricSearchProps = {
  lyrics: string;
  loadingLabel?: string;
  children?: ReactNode;
};

export function LyricSearch({ lyrics, loadingLabel, children }: LyricSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [scrollRequest, setScrollRequest] = useState(0);
  const restoreFocusRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeMatchRef = useRef<HTMLElement>(null);
  const inputId = useId();

  const matches = useMemo(() => {
    if (!open || !query.trim()) return [];
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Array.from(lyrics.matchAll(new RegExp(literal, "giu")), match => ({
      start: match.index!, end: match.index! + match[0].length
    }));
  }, [lyrics, open, query]);
  const current = matches.length ? selected % matches.length : 0;
  const searching = open && Boolean(query.trim());

  function openSearch() {
    setOpen(true);
    setFocusRequest(value => value + 1);
  }

  function closeSearch() {
    restoreFocusRef.current = true;
    setOpen(false);
    setSelected(0);
  }

  function navigate(direction: number) {
    if (matches.length) {
      setSelected((current + direction + matches.length) % matches.length);
      setScrollRequest(value => value + 1);
    }
  }

  useEffect(() => {
    function handleFind(event: KeyboardEvent) {
      const modals = document.querySelectorAll(".song-modal-backdrop");
      if (sectionRef.current?.closest(".song-modal-backdrop") !== modals[modals.length - 1]) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSearch();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSearch();
      }
    }
    window.addEventListener("keydown", handleFind, true);
    return () => window.removeEventListener("keydown", handleFind, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      if (restoreFocusRef.current) {
        buttonRef.current?.focus({ preventScroll: true });
        restoreFocusRef.current = false;
      }
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusRequest]);

  // Scroll once for a new query or explicit navigation; manual scrolling never re-triggers it.
  useLayoutEffect(() => {
    const match = activeMatchRef.current;
    const modal = sectionRef.current?.closest<HTMLElement>(".song-modal");
    if (!match || !modal || !open) return;
    const bounds = modal.getBoundingClientRect();
    const target = match.getBoundingClientRect();
    const inset = (toolbarRef.current?.getBoundingClientRect().height ?? 0) + 16;
    if (target.top < bounds.top + inset || target.bottom > bounds.bottom - 16) {
      modal.scrollTop += target.top - bounds.top - inset;
    }
  }, [matches, current, open, scrollRequest]);

  const highlightedLyrics: ReactNode[] = [];
  let end = 0;
  matches.forEach((match, index) => {
    highlightedLyrics.push(lyrics.slice(end, match.start));
    highlightedLyrics.push(
      <mark key={match.start} ref={index === current ? activeMatchRef : undefined}
        className={index === current ? "lyric-find__match lyric-find__match--active" : "lyric-find__match"}>
        {lyrics.slice(match.start, match.end)}
      </mark>
    );
    end = match.end;
  });
  highlightedLyrics.push(lyrics.slice(end));

  return (
    <section ref={sectionRef} className={searching ? "song-modal__lyrics-panel lyric-find--searching" : "song-modal__lyrics-panel"} aria-label="Lyrics">
      <div ref={toolbarRef} className="lyric-find__toolbar">
        <h3>Lyrics</h3>
        {open ? (
          <div className="lyric-find__controls" role="search" aria-label="Find in this song's lyrics">
            <label className="sr-only" htmlFor={inputId}>Find in lyrics</label>
            <input ref={inputRef} id={inputId} type="text" value={query} placeholder="Find in lyrics"
              autoComplete="off" spellCheck={false}
              onChange={event => { setQuery(event.target.value); setSelected(0); }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
                }
              }}
            />
            <span className="lyric-find__count" aria-live="polite" aria-atomic="true">
              {query.trim() ? `${matches.length ? current + 1 : 0}/${matches.length}` : ""}
            </span>
            <button type="button" aria-label="Previous lyric match" title="Previous match" disabled={!matches.length} onClick={() => navigate(-1)}><ArrowUp aria-hidden="true" /></button>
            <button type="button" aria-label="Next lyric match" title="Next match" disabled={!matches.length} onClick={() => navigate(1)}><ArrowDown aria-hidden="true" /></button>
            <button type="button" aria-label="Close lyric search" title="Close search" onClick={closeSearch}><X aria-hidden="true" /></button>
          </div>
        ) : (
          <button ref={buttonRef} type="button" className="lyric-find__open" aria-label="Find in lyrics" title="Find in lyrics (Ctrl+F)" onClick={openSearch}><Search aria-hidden="true" /></button>
        )}
      </div>
      {loadingLabel ? <LoadingStatus label={loadingLabel} /> : null}
      {lyrics ? <pre className="song-modal__lyrics-text">{highlightedLyrics}</pre> : children}
    </section>
  );
}
