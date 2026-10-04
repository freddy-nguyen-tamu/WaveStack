import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { LoadingStatus } from "../../components/LoadingStatus";

type LyricSearchProps = {
  lyrics: string;
  loadingLabel?: string;
  children?: ReactNode;
};

type FloatingSearchStyle = Pick<CSSProperties, "top" | "left" | "width">;

export function LyricSearch({ lyrics, loadingLabel, children }: LyricSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [floating, setFloating] = useState(false);
  const [floatingStyle, setFloatingStyle] = useState<FloatingSearchStyle>({});
  const sectionRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeMatchRef = useRef<HTMLElement>(null);
  const isComposingRef = useRef(false);
  const pendingEmptyCloseRef = useRef<number | null>(null);
  const deleteIntentRef = useRef(false);
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

  function updateFloatingPosition() {
    const modal = sectionRef.current?.closest<HTMLElement>(".song-modal");

    if (!modal) {
      return;
    }

    const modalBounds = modal.getBoundingClientRect();
    const horizontalInset = window.innerWidth <= 640 ? 12 : 20;
    const width = Math.max(240, Math.min(420, modalBounds.width - horizontalInset * 2));

    setFloatingStyle({
      top: Math.max(12, modalBounds.top + 12),
      left: Math.max(12, modalBounds.right - width - horizontalInset),
      width
    });
  }

  function openSearch(floatWhenOutOfView = false) {
    const modal = sectionRef.current?.closest<HTMLElement>(".song-modal");
    const toolbar = toolbarRef.current;
    let shouldFloat = false;

    if (floatWhenOutOfView && modal && toolbar) {
      const modalBounds = modal.getBoundingClientRect();
      const toolbarBounds = toolbar.getBoundingClientRect();
      shouldFloat =
        toolbarBounds.bottom < modalBounds.top + 8 ||
        toolbarBounds.top > modalBounds.bottom - 8;
    }

    setFloating(shouldFloat);
    if (shouldFloat) {
      updateFloatingPosition();
    }
    setOpen(true);
    setFocusRequest(value => value + 1);
  }

  function cancelPendingEmptyClose() {
    if (pendingEmptyCloseRef.current !== null) {
      window.clearTimeout(pendingEmptyCloseRef.current);
      pendingEmptyCloseRef.current = null;
    }
  }

  function closeSearch() {
    cancelPendingEmptyClose();
    setOpen(false);
    setQuery("");
    setFloating(false);
    setSelected(0);
  }

  function scheduleCloseAfterConfirmedDeletion() {
    cancelPendingEmptyClose();

    // Vietnamese and other IMEs can briefly report an empty input while they
    // replace the previous text with a composed form. Give that replacement a
    // short window to arrive; any subsequent input/composition event cancels
    // this close. A genuine Backspace/Delete/Cut to empty remains empty and
    // therefore closes exactly as before.
    pendingEmptyCloseRef.current = window.setTimeout(() => {
      pendingEmptyCloseRef.current = null;
      const input = inputRef.current;

      if (!isComposingRef.current && input && input.value === "") {
        closeSearch();
      }
    }, 80);
  }

  function navigate(direction: number) {
    if (matches.length) {
      setSelected((current + direction + matches.length) % matches.length);
      setScrollRequest(value => value + 1);
    }
  }

  useEffect(() => () => cancelPendingEmptyClose(), []);

  useEffect(() => {
    function handleFind(event: KeyboardEvent) {
      const modals = document.querySelectorAll(".song-modal-backdrop");
      if (sectionRef.current?.closest(".song-modal-backdrop") !== modals[modals.length - 1]) return;

      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSearch(true);
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
    if (!open) return;

    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [open, focusRequest]);

  useEffect(() => {
    if (!open || !floating) {
      return;
    }

    updateFloatingPosition();
    window.addEventListener("resize", updateFloatingPosition);

    return () => window.removeEventListener("resize", updateFloatingPosition);
  }, [open, floating]);

  // Scroll only when a match is chosen. Opening/closing the find UI itself never moves the modal.
  useLayoutEffect(() => {
    const match = activeMatchRef.current;
    const modal = sectionRef.current?.closest<HTMLElement>(".song-modal");
    if (!match || !modal || !open || !query.trim()) return;

    const bounds = modal.getBoundingClientRect();
    const target = match.getBoundingClientRect();
    const inset = floating ? 76 : (toolbarRef.current?.getBoundingClientRect().height ?? 0) + 16;

    if (target.top < bounds.top + inset || target.bottom > bounds.bottom - 16) {
      modal.scrollTop += target.top - bounds.top - inset;
    }
  }, [matches, current, open, query, scrollRequest, floating]);

  const highlightedLyrics: ReactNode[] = [];
  let end = 0;
  matches.forEach((match, index) => {
    highlightedLyrics.push(lyrics.slice(end, match.start));
    highlightedLyrics.push(
      <mark
        key={match.start}
        ref={index === current ? activeMatchRef : undefined}
        className={index === current ? "lyric-find__match lyric-find__match--active" : "lyric-find__match"}
      >
        {lyrics.slice(match.start, match.end)}
      </mark>
    );
    end = match.end;
  });
  highlightedLyrics.push(lyrics.slice(end));

  const searchControls = open ? (
    <div className="lyric-find__controls" role="search" aria-label="Find in this song's lyrics">
      <input
        ref={inputRef}
        id={inputId}
        aria-label="Find in lyrics"
        type="text"
        value={query}
        placeholder="Find in lyrics"
        autoComplete="off"
        spellCheck={false}
        onCompositionStart={() => {
          isComposingRef.current = true;
          deleteIntentRef.current = false;
          cancelPendingEmptyClose();
        }}
        onCompositionEnd={event => {
          isComposingRef.current = false;
          deleteIntentRef.current = false;
          cancelPendingEmptyClose();
          // Keep React state aligned with the IME's final committed value.
          // Composition itself never auto-closes the find UI, even if an IME
          // briefly or finally commits an empty intermediate value.
          setQuery(event.currentTarget.value);
          setSelected(0);
        }}
        onChange={event => {
          cancelPendingEmptyClose();

          const nextQuery = event.target.value;
          const nativeEvent = event.nativeEvent as InputEvent;
          const inputType = nativeEvent.inputType ?? "";
          const composing = nativeEvent.isComposing || isComposingRef.current;
          const explicitDeletion = inputType.startsWith("delete") || deleteIntentRef.current;

          setQuery(nextQuery);
          setSelected(0);
          deleteIntentRef.current = false;

          // Auto-close only for a stable, explicit user deletion to empty.
          // Do not treat IME replacement/composition transitions as deletion.
          if (nextQuery === "" && query !== "" && explicitDeletion && !composing) {
            scheduleCloseAfterConfirmedDeletion();
          }
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;

          deleteIntentRef.current = event.key === "Backspace" || event.key === "Delete";

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
      <button type="button" aria-label="Previous lyric match" title="Previous match" disabled={!matches.length} onClick={() => navigate(-1)}>
        <ArrowUp aria-hidden="true" />
      </button>
      <button type="button" aria-label="Next lyric match" title="Next match" disabled={!matches.length} onClick={() => navigate(1)}>
        <ArrowDown aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Close lyric search"
        title="Close search"
        onClick={() => closeSearch()}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  ) : null;

  return (
    <section ref={sectionRef} className={searching ? "song-modal__lyrics-panel lyric-find--searching" : "song-modal__lyrics-panel"} aria-label="Lyrics">
      {open && floating ? (
        <div className="lyric-find__floating" style={floatingStyle}>
          {searchControls}
        </div>
      ) : null}

      <div ref={toolbarRef} className="lyric-find__toolbar">
        <h3>Lyrics</h3>
        {open ? (
          floating ? null : searchControls
        ) : (
          <button
            type="button"
            className="lyric-find__open"
            aria-label="Find in lyrics"
            title="Find in lyrics (Ctrl+F)"
            onClick={() => openSearch(false)}
          >
            <Search aria-hidden="true" />
          </button>
        )}
      </div>
      {loadingLabel ? <LoadingStatus label={loadingLabel} /> : null}
      {lyrics ? (
        <pre
          className="song-modal__lyrics-text"
          aria-label="Song lyrics"
        >
          {highlightedLyrics}
        </pre>
      ) : children}
    </section>
  );
}
